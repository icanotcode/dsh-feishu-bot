import { createSessionHost, MANAGED_SESSION_PREFIX } from './session-host.js';

/** One tool registry and protection boundary for all bot runtimes in a Harness. */
export function createRuntimeHub(ctx, { defaultSource, hostFactory = createSessionHost } = {}) {
  const runtimes = new Map();
  const owners = new Map();
  const registrations = new Map();
  let host;
  let allowed;
  let closing = false;
  let disposal;
  const managed = id => typeof id === 'string' && id.startsWith(MANAGED_SESSION_PREFIX);
  const owner = id => runtimes.get(owners.get(id));
  function attach({ source, isAuthorized, allowedTools }) {
    if (closing) throw new Error('Feishu runtime hub is closing');
    if (!source || runtimes.has(source)) throw new Error('Feishu runtime sources must be unique');
    const nextAllowed = [...allowedTools].sort();
    if (allowed && JSON.stringify(allowed) !== JSON.stringify(nextAllowed)) throw new Error('Feishu runtime tool policies must match');
    allowed ??= nextAllowed;
    const runtime = { source, isAuthorized, tools: new Map(), sessions: new Set(), closing: false };
    runtimes.set(source, runtime);
    const claim = id => {
      if (runtime.closing || closing || !managed(id)) throw new Error('Invalid Feishu session ownership');
      if (owners.has(id) && owners.get(id) !== source) throw new Error('Feishu session belongs to another bot');
      owners.set(id, source);
      runtime.sessions.add(id);
    };
    const assertOwner = id => {
      if (runtime.closing || closing || owners.get(id) !== source) throw new Error('Feishu session belongs to another bot or is unavailable');
    };
    function ensureHost() {
      host ??= hostFactory(ctx, {
        allowedTools: allowed,
        isAuthorized(id) {
          const current = owner(id);
          return !closing && Boolean(current && !current.closing && current.isAuthorized(id));
        },
      });
      return host;
    }
    function registerTool(tool) {
      if (runtime.closing || closing || runtime.tools.has(tool.name)) throw new Error('Duplicate or closed Feishu tool registration');
      const existing = registrations.get(tool.name);
      if (existing && JSON.stringify(existing.parameters) !== JSON.stringify(tool.parameters)) throw new Error('Feishu tool schemas must match across bots');
      if (!existing) {
        const unregister = ctx.tools.register({ ...tool, async execute(args, execution) {
          const id = execution.agent?.session.id;
          const selected = managed(id) ? owner(id) : runtimes.get(defaultSource);
          if (closing || !selected || selected.closing) throw new Error('No Feishu bot is configured for this session');
          if (managed(id) && !selected.isAuthorized(id)) throw new Error('No authorized Feishu user is bound to this session');
          const implementation = selected.tools.get(tool.name);
          if (!implementation) throw new Error('This Feishu capability is unavailable');
          return implementation.execute(args, execution);
        } });
        registrations.set(tool.name, { unregister, parameters: tool.parameters });
      }
      runtime.tools.set(tool.name, tool);
      let removed = false;
      return async () => {
        if (removed) return;
        removed = true;
        runtime.tools.delete(tool.name);
        if (![...runtimes.values()].some(value => value.tools.has(tool.name))) {
          const registration = registrations.get(tool.name);
          registrations.delete(tool.name);
          await registration?.unregister();
        }
      };
    }
    let runtimeDisposal;
    const facade = {
      isArchived(id) { assertOwner(id); return ensureHost().isArchived(id); },
      getLive(id) { assertOwner(id); return ensureHost().getLive(id); },
      getOrCreate(request) { assertOwner(request.sessionId); return ensureHost().getOrCreate(request); },
      release(id) { assertOwner(id); return ensureHost().release(id); },
      retire(id) { assertOwner(id); return ensureHost().retire(id); },
      dispose() {
        runtimeDisposal ??= (async () => {
          runtime.closing = true;
          try { await host?.disposeSessions(id => owners.get(id) === source); }
          finally {
            runtimes.delete(source);
            for (const id of runtime.sessions) if (owners.get(id) === source) owners.delete(id);
          }
        })();
        return runtimeDisposal;
      },
    };
    // Install protection only after runtime tools have been registered. Its
    // first session lookup happens during startup maintenance or admission.
    return { claim, registerTool, host: facade, protect: ensureHost };
  }
  return {
    attach,
    dispose() {
      disposal ??= (async () => {
        closing = true;
        await host?.dispose();
        for (const registration of registrations.values()) await registration.unregister();
        registrations.clear(); runtimes.clear(); owners.clear();
      })();
      return disposal;
    },
  };
}
