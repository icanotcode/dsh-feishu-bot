import { isAbsolute, resolve } from 'node:path';

export const MANAGED_SESSION_PREFIX = 'feishu-user-';
export class ArchivedSessionError extends Error {
  constructor() {
    super('The Feishu session was archived in Harness');
    this.name = 'ArchivedSessionError';
  }
}
const PROTECTION = Symbol.for('@icanotcode/dsh-feishu-bot.session-protection');

/** Adapt the Harness lifecycle without treating a writable workspace as read isolation. */
export function createSessionHost(ctx, {
  allowedTools = [],
  isAuthorized = () => false,
  onBind = () => {},
} = {}) {
  const allowed = new Set(allowedTools);
  if (allowed.has('run_code')) throw new Error('Managed sessions cannot allow run_code');
  const owned = new Map();
  const inflight = new Map();
  const retiring = new Map();
  const protectedAgents = new Set();
  let closing = false;
  let disposal;
  const managed = id => typeof id === 'string' && id.startsWith(MANAGED_SESSION_PREFIX);
  const isArchived = id => ctx.workspaceRegistry.archivedSessionIds.includes(id);
  const authorized = id => {
    try { return !closing && isAuthorized(id) === true; } catch { return false; }
  };
  const deny = execution => {
    const id = execution.agent?.session.id;
    if (!managed(id)) return;
    if (!authorized(id)) return 'This Feishu session is not authorized.';
    if (!allowed.has(execution.name)) return 'This capability is unavailable in isolated Feishu sessions.';
  };

  // This guard is active before any resumed agent can start, including UI resumes.
  const removeGuard = ctx.tools.guard(deny);
  function protect(agent) {
    if (!managed(agent.session.id) || protectedAgents.has(agent)) return;
    const scope = agent.ctx;
    // An empty inherited surface is intentional. Safe tools registered directly
    // in this scope stay visible; safe inherited tools are explicitly selected.
    const inherited = [...allowed].filter(name => scope.tools.get(name, agent));
    scope.tools.restrict({ allow: inherited });
    let protection = agent[PROTECTION];
    if (!protection) {
      scope.tools.presentAs('native');
      protection = { guard: deny, allowed };
      Object.defineProperty(agent, PROTECTION, { value: protection });
      // The agent owns this guard beyond plugin unload. A new plugin instance
      // transfers its authorization check synchronously, only after installing
      // its global guard and restriction; no unprotected execution window opens.
      scope.tools.guard(execution => protection.guard(execution));
      // Some presets install tools directly on the agent after setup, bypassing
      // inherited-surface restrictions (notably the standard subagent tool).
      // Filter the final model assembly as well; execution still has its own
      // independent guard, so hiding a schema is never the security boundary.
      scope.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const assembly = await next();
        return { ...assembly, tools: assembly.tools.filter(tool => protection.allowed.has(tool.name)) };
      });
    } else {
      // Restrictions intersect across reloads: a plugin upgrade cannot silently
      // broaden an existing UI-owned session's inherited capability surface.
      protection.guard = deny;
      protection.allowed = allowed;
    }
    protectedAgents.add(agent);
    onBind(agent);
  }
  let removeCreated;
  try {
    removeCreated = ctx.on('agent/created', ({ agent }) => protect(agent));
    for (const agent of ctx.agents.list()) protect(agent);
  } catch (error) {
    closing = true;
    // Construction is synchronous. Installed per-agent guards remain denied;
    // release global registrations so a later plugin retry can take over.
    for (const remove of [removeCreated, removeGuard]) {
      try { Promise.resolve(remove?.()).catch(() => {}); } catch {}
    }
    throw error;
  }

  function checkRequest(request) {
    if (!managed(request.sessionId) || !authorized(request.sessionId)) throw new Error('Unauthorized Feishu session');
    if (isArchived(request.sessionId)) throw new ArchivedSessionError();
    if (!isAbsolute(request.workspacePath)) throw new TypeError('Session workspace must be absolute');
  }
  function checkWorkspace(header, request) {
    if (header?.cwd && resolve(header.cwd) !== resolve(request.workspacePath)) {
      throw new Error('Stored session workspace does not match its owner');
    }
  }
  async function attachToWorkspace(request) {
    // Deleting a workspace in Harness removes only its registration. Restore
    // membership on incoming activity, including live reuse and durable resume.
    const workspace = await ctx.workspaceRegistry.create(request.workspacePath);
    checkRequest(request);
    await workspace.attachSession(request.sessionId);
    checkRequest(request);
  }
  async function open(request) {
    checkRequest(request);
    const live = ctx.agents.get(request.sessionId);
    if (live) {
      checkWorkspace(live.session.header, request);
      protect(live);
      ctx.permissionPresets.resolve(request.permissionPreset);
      ctx.permissionPresets.set(live.session, request.permissionPreset);
      ctx.sessionTitle.rename(live.session, request.title);
      await attachToWorkspace(request);
      return owned.get(request.sessionId) ?? { agent: live, dispose: async () => {} };
    }
    const stored = await ctx.sessionPersistence.stat(request.sessionId);
    checkRequest(request);
    if (stored) checkWorkspace(stored.header, request);
    const presetId = stored?.header.agentPreset ?? request.agentPreset;
    const preset = await ctx.agentPresets.resolve(presetId);
    await ctx.agentPresets.standingKeyFor(preset.id);
    ctx.permissionPresets.resolve(request.permissionPreset);
    const selection = request.model ?? ctx.agentDefaultModel.currentSelection();
    const { provider, model, maxTokens } = selection;
    const agentOptions = { provider, model, ...(maxTokens === undefined ? {} : { maxTokens }) };
    const setup = async (scope, agent) => {
      checkRequest(request);
      await ctx.agentPresets.mount(scope, preset.id);
      protect(agent);
      if (!stored) scope.on('agent/request', async ({ agent: current }, next) => {
        const value = await next();
        if (current.session.requestHeader() !== undefined || value.provider !== provider || value.model !== model) return value;
        const { reasoningEffort: _inherited, ...base } = value;
        return { ...base, ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }) };
      });
      const prepared = await request.setup?.(scope, agent);
      return { commit() { checkRequest(request); prepared?.commit?.(); } };
    };
    const handle = stored
      ? await ctx.agents.resume({ resumeSessionId: request.sessionId, agentOptions, setup })
      : await (async () => {
        const workspace = await ctx.workspaceRegistry.create(request.workspacePath);
        checkRequest(request);
        const created = await ctx.agents.create({
          sessionId: request.sessionId,
          meta: { cwd: workspace.path, agentPreset: preset.id },
          agentOptions,
          setup,
        });
        try { await workspace.attachSession(request.sessionId); }
        catch (error) { await created.dispose(); throw error; }
        return created;
      })();
    try {
      checkRequest(request);
      ctx.permissionPresets.set(handle.agent.session, request.permissionPreset);
      ctx.sessionTitle.rename(handle.agent.session, request.title);
      if (stored) await attachToWorkspace(request);
      // Publish durable session storage before callers persist ownership/use it.
      await ctx.sessionPersistence.flush();
      owned.set(request.sessionId, handle);
      return handle;
    } catch (error) {
      await handle.dispose();
      throw error;
    }
  }

  async function release(sessionId) {
    const handle = owned.get(sessionId);
    if (!handle || handle.agent.status !== 'idle') return false;
    // Idle disposal releases in-memory context while Harness keeps its durable
    // session log. Never dispose an agent owned by the Harness UI or a busy one.
    await handle.dispose();
    if (owned.get(sessionId) === handle) owned.delete(sessionId);
    protectedAgents.delete(handle.agent);
    return true;
  }
  function getOrCreate(request) {
    // Let an already-started open finish for retirement, but never admit a
    // new open while its durable archive operation is still in progress.
    if (retiring.has(request.sessionId)) return retiring.get(request.sessionId).then(retired => {
      if (retired) throw new ArchivedSessionError();
      return getOrCreate(request);
    });
    try { checkRequest(request); } catch (error) { return Promise.reject(error); }
    if (!inflight.has(request.sessionId)) {
      const pending = open(request).finally(() => inflight.delete(request.sessionId));
      inflight.set(request.sessionId, pending);
    }
    return inflight.get(request.sessionId);
  }
  async function retireSession(sessionId) {
    const opening = inflight.get(sessionId);
    if (opening) await Promise.allSettled([opening]);
    const busy = () => {
      const live = ctx.agents.get(sessionId);
      return live !== undefined && live.status !== 'idle';
    };
    if (busy()) return false;
    if (!isArchived(sessionId)) {
      // Failed persistence reads propagate. A definite absence is already
      // retired, allowing old database-only records to be reconciled safely.
      const stored = ctx.agents.get(sessionId) ? true : await ctx.sessionPersistence.stat(sessionId);
      if (busy()) return false;
      if (stored || ctx.agents.get(sessionId)) await ctx.workspaceRegistry.archiveSession(sessionId);
    }
    // The UI can start a turn while persistence is being written. Archiving
    // never cancels it; retain its binding until a later idle retry succeeds.
    if (busy()) return false;
    await release(sessionId);
    return true;
  }

  async function disposeSessions(matches) {
    await Promise.allSettled([...inflight].filter(([id]) => matches(id)).map(([, pending]) => pending));
    await Promise.allSettled([...retiring].filter(([id]) => matches(id)).map(([, pending]) => pending));
    const agents = [...protectedAgents].filter(agent => matches(agent.session.id));
    for (const agent of agents) agent.cancel({ kind: 'disposed' });
    await Promise.allSettled(agents.map(agent => agent.whenIdle()));
    const handles = [...owned].filter(([id]) => matches(id));
    await Promise.allSettled(handles.map(([, handle]) => handle.dispose()));
    for (const [id, handle] of handles) if (owned.get(id) === handle) owned.delete(id);
    for (const agent of agents) protectedAgents.delete(agent);
  }

  return {
    isArchived,
    getLive(sessionId) {
      if (!managed(sessionId)) throw new Error('Only managed Feishu sessions can be inspected');
      return ctx.agents.get(sessionId);
    },
    release,
    getOrCreate,
    disposeSessions,
    // The caller supplies only IDs confirmed closed in that user's history.
    // This is permanent display retirement, unlike release's resumable unload.
    retire(sessionId) {
      if (!managed(sessionId)) return Promise.reject(new Error('Only managed Feishu sessions can be retired'));
      if (closing) return Promise.reject(new Error('Feishu session host is closing'));
      if (!retiring.has(sessionId)) {
        const pending = retireSession(sessionId).finally(() => retiring.delete(sessionId));
        retiring.set(sessionId, pending);
      }
      return retiring.get(sessionId);
    },
    dispose() {
      disposal ??= (async () => {
        closing = true;
        await Promise.allSettled([...inflight.values()]);
        await Promise.allSettled([...retiring.values()]);
        for (const agent of protectedAgents) agent.cancel({ kind: 'disposed' });
        await Promise.allSettled([...protectedAgents].map(agent => agent.whenIdle()));
        await Promise.allSettled([...owned.values()].map(handle => handle.dispose()));
        await removeCreated();
        await removeGuard();
        owned.clear();
        protectedAgents.clear();
      })();
      return disposal;
    },
  };
}
