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
  const removeCreated = ctx.on('agent/created', ({ agent }) => protect(agent));
  for (const agent of ctx.agents.list()) protect(agent);

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
  async function open(request) {
    checkRequest(request);
    const live = ctx.agents.get(request.sessionId);
    if (live) {
      checkWorkspace(live.session.header, request);
      protect(live);
      ctx.permissionPresets.resolve(request.permissionPreset);
      ctx.permissionPresets.set(live.session, request.permissionPreset);
      ctx.sessionTitle.rename(live.session, request.title);
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
      // Publish durable session storage before callers persist ownership/use it.
      await ctx.sessionPersistence.flush();
      owned.set(request.sessionId, handle);
      return handle;
    } catch (error) {
      await handle.dispose();
      throw error;
    }
  }

  return {
    isArchived,
    async release(sessionId) {
      const handle = owned.get(sessionId);
      if (!handle || handle.agent.status !== 'idle') return false;
      // Idle disposal releases in-memory context while Harness keeps its durable
      // session log. Never dispose an agent owned by the Harness UI or a busy one.
      await handle.dispose();
      if (owned.get(sessionId) === handle) owned.delete(sessionId);
      protectedAgents.delete(handle.agent);
      return true;
    },
    getOrCreate(request) {
      try { checkRequest(request); } catch (error) { return Promise.reject(error); }
      if (!inflight.has(request.sessionId)) {
        const pending = open(request).finally(() => inflight.delete(request.sessionId));
        inflight.set(request.sessionId, pending);
      }
      return inflight.get(request.sessionId);
    },
    dispose() {
      disposal ??= (async () => {
        closing = true;
        await Promise.allSettled([...inflight.values()]);
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
