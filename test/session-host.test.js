import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionHost } from '../lib/session-host.js';

const request = () => ({ sessionId: 'feishu-user-alice-1', workspacePath: '/users/alice', title: 'Alice', agentPreset: 'standard', permissionPreset: 'read-only' });
function fixture() {
  const live = new Map();
  const stored = new Map();
  const archived = new Set();
  const workspaces = new Map();
  const listeners = new Map();
  const globalGuards = new Set();
  const calls = [];
  function agent(id, header = { cwd: '/users/alice' }) {
    const guards = [];
    const hooks = new Map();
    const value = {
      status: 'idle',
      session: { id, header, requestHeader: () => undefined },
      cancel: cause => calls.push(['cancel', id, cause]),
      whenIdle: async () => { calls.push(['idle', id]); },
      ctx: {
        tools: {
          get: name => name === 'history' ? { name } : undefined,
          restrict: filter => calls.push(['restrict', id, filter]),
          presentAs: mode => calls.push(['presentAs', id, mode]),
          guard: guard => { guards.push(guard); return () => {}; },
        },
        on: (name, fn) => { hooks.set(name, fn); return () => hooks.delete(name); },
      },
      guards, hooks,
    };
    return value;
  }
  async function publish(options, resumed) {
    const id = options.sessionId ?? options.resumeSessionId;
    const value = agent(id, resumed ? stored.get(id).header : options.meta);
    calls.push([resumed ? 'resume' : 'create', options]);
    const prepared = await options.setup(value.ctx, value);
    prepared?.commit();
    live.set(id, value);
    stored.set(id, { header: value.session.header });
    listeners.get('agent/created')?.({ agent: value });
    return { agent: value, dispose: async () => { calls.push(['dispose', id]); live.delete(id); } };
  }
  const ctx = {
    tools: { guard: guard => { globalGuards.add(guard); return () => { calls.push(['removeGuard']); globalGuards.delete(guard); }; } },
    on: (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name); },
    agents: { list: () => [...live.values()], get: id => live.get(id), create: options => publish(options, false), resume: options => publish(options, true) },
    sessionPersistence: { stat: async id => stored.get(id), flush: async () => calls.push(['flush']) },
    agentPresets: { resolve: async id => ({ id }), standingKeyFor: async id => id, mount: async (_scope, id) => calls.push(['mount', id]) },
    permissionPresets: { resolve: name => ({ name }), set: (_session, name) => calls.push(['permission', name]) },
    sessionTitle: { rename: (_session, title) => calls.push(['title', title]) },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test-model' }) },
    workspaceRegistry: {
      get archivedSessionIds() { return [...archived]; },
      archiveSession: async id => {
        calls.push(['archive', id]);
        if (!live.has(id) && !stored.has(id)) throw new Error('Unknown session');
        archived.add(id);
      },
      create: async path => {
        if (!workspaces.has(path)) workspaces.set(path, { path, sessionIds: [], attachSession: async id => {
          calls.push(['attach', id]);
          const ids = workspaces.get(path).sessionIds;
          if (!ids.includes(id)) ids.push(id);
        } });
        return workspaces.get(path);
      },
    },
  };
  return { ctx, live, stored, archived, workspaces, listeners, globalGuards, calls, agent };
}

test('session creation composes protection before publication and concurrent callers share the agent', async () => {
  const f = fixture();
  const host = createSessionHost(f.ctx, { allowedTools: ['history'], isAuthorized: () => true });
  const [a, b] = await Promise.all([host.getOrCreate(request()), host.getOrCreate(request())]);
  assert.equal(a, b);
  assert.equal(f.calls.filter(([name]) => name === 'create').length, 1);
  assert.deepEqual(f.calls.find(([name]) => name === 'restrict')[2], { allow: ['history'] });
  assert.equal(f.calls.find(([name]) => name === 'presentAs')[2], 'native');
  assert.equal((await host.getOrCreate(request())).agent, a.agent);
  await host.dispose();
});

test('resume uses the durable identity and original preset instead of creating a new session', async () => {
  const f = fixture();
  f.stored.set(request().sessionId, { header: { cwd: '/users/alice', agentPreset: 'previous-preset' } });
  const host = createSessionHost(f.ctx, { isAuthorized: () => true });
  const handle = await host.getOrCreate(request());
  assert.equal(handle.agent.session.id, request().sessionId);
  assert.equal(f.calls.filter(([name]) => name === 'create').length, 0);
  assert.equal(f.calls.find(([name]) => name === 'resume')[1].resumeSessionId, request().sessionId);
  assert.ok(f.calls.some(([name, id]) => name === 'mount' && id === 'previous-preset'));
  await host.dispose();
});

test('failed persistence reads do not silently create fresh sessions', async () => {
  const f = fixture();
  f.ctx.sessionPersistence.stat = async () => { throw new Error('Storage unavailable'); };
  const host = createSessionHost(f.ctx, { isAuthorized: () => true });
  await assert.rejects(host.getOrCreate(request()), /Storage unavailable/);
  assert.equal(f.calls.filter(([name]) => name === 'create').length, 0);
  await host.dispose();
});

test('authorization is fail closed and revoked access blocks already live agents immediately', async () => {
  const f = fixture();
  const denied = createSessionHost(f.ctx);
  await assert.rejects(denied.getOrCreate(request()), /Unauthorized/);
  await denied.dispose();
  let authorized = true;
  const host = createSessionHost(f.ctx, { allowedTools: ['history'], isAuthorized: () => authorized });
  const { agent } = await host.getOrCreate(request());
  const guard = [...f.globalGuards][0];
  assert.equal(guard({ agent, name: 'history' }), undefined);
  for (const name of ['bash', 'run_code', 'spawn_agent', 'mcp_read', 'read_file']) assert.match(guard({ agent, name }), /unavailable/);
  authorized = false;
  assert.match(guard({ agent, name: 'history' }), /not authorized/);
  assert.equal(guard({ agent: f.agent('normal-session'), name: 'bash' }), undefined);
  await host.dispose();
});

test('UI-resumed managed sessions are protected before tools execute and stay denied after plugin unload', async () => {
  const f = fixture();
  const host = createSessionHost(f.ctx, { allowedTools: ['history'], isAuthorized: () => true });
  const agent = f.agent(request().sessionId);
  f.live.set(agent.session.id, agent);
  f.listeners.get('agent/created')({ agent });
  assert.equal(agent.guards.length, 1);
  assert.match(agent.guards[0]({ agent, name: 'bash' }), /unavailable/);
  await host.dispose();
  assert.match(agent.guards[0]({ agent, name: 'history' }), /not authorized/);
  assert.ok(f.calls.findIndex(([name]) => name === 'idle') < f.calls.findIndex(([name]) => name === 'removeGuard'));
});

test('stored workspace ownership mismatch and forged unmanaged ids are rejected', async () => {
  const f = fixture();
  f.stored.set(request().sessionId, { header: { cwd: '/users/bob' } });
  const host = createSessionHost(f.ctx, { isAuthorized: () => true });
  await assert.rejects(host.getOrCreate(request()), /does not match/);
  await assert.rejects(host.getOrCreate({ ...request(), sessionId: 'ordinary' }), /Unauthorized/);
  await host.dispose();
});

test('initial model removes inherited reasoning effort unless explicitly selected', async () => {
  const f = fixture();
  const host = createSessionHost(f.ctx, { isAuthorized: () => true });
  const { agent } = await host.getOrCreate(request());
  const hook = agent.hooks.get('agent/request');
  assert.deepEqual(await hook({ agent }, async () => ({ provider: 'test', model: 'test-model', reasoningEffort: 'high' })), { provider: 'test', model: 'test-model' });
  await host.dispose();
});

test('authorization revoked during setup rolls back unpublished creation', async () => {
  const f = fixture();
  let authorized = true;
  const host = createSessionHost(f.ctx, { isAuthorized: () => authorized });
  await assert.rejects(host.getOrCreate({ ...request(), setup: () => { authorized = false; } }), /Unauthorized/);
  assert.equal(f.live.size, 0);
  await host.dispose();
});

test('daily rotation releases only idle plugin-owned agents and leaves durable logs resumable', async () => {
  const f = fixture();
  const host = createSessionHost(f.ctx, { isAuthorized: () => true });
  const { agent } = await host.getOrCreate(request());
  agent.status = 'running';
  assert.equal(await host.release(agent.session.id), false);
  agent.status = 'idle';
  assert.equal(await host.release(agent.session.id), true);
  assert.equal(f.live.has(agent.session.id), false);
  assert.ok(f.stored.has(agent.session.id));
  const resumed = await host.getOrCreate(request());
  assert.notEqual(resumed.agent, agent);
  const ui = f.agent('feishu-user-ui');
  f.live.set(ui.session.id, ui);
  f.listeners.get('agent/created')({ agent: ui });
  assert.equal(await host.release(ui.session.id), false);
  assert.ok(f.live.has(ui.session.id));
  await host.dispose();
});

test('plugin reload transfers a surviving UI agent guard without duplicate native presentation', async () => {
  const f = fixture();
  const agent = f.agent(request().sessionId);
  f.live.set(agent.session.id, agent);
  const first = createSessionHost(f.ctx, { allowedTools: ['history'], isAuthorized: () => true });
  await first.dispose();
  assert.match(agent.guards[0]({ agent, name: 'history' }), /not authorized/);
  let authorized = false;
  const second = createSessionHost(f.ctx, { allowedTools: ['history'], isAuthorized: () => authorized });
  assert.match(agent.guards[0]({ agent, name: 'history' }), /not authorized/);
  authorized = true;
  assert.equal(agent.guards[0]({ agent, name: 'history' }), undefined);
  assert.match(agent.guards[0]({ agent, name: 'bash' }), /unavailable/);
  assert.equal(agent.guards.length, 1);
  assert.equal(f.calls.filter(([name]) => name === 'presentAs').length, 1);
  await second.dispose();
});

test('late agent-local preset tools are removed from model assembly and denied independently', async () => {
  const f = fixture();
  const host = createSessionHost(f.ctx, { allowedTools: ['history'], isAuthorized: () => true });
  const { agent } = await host.getOrCreate(request());
  const assembly = { sections: [{ name: 'original', text: 'keep' }], contexts: [], variables: {}, tools: [{ name: 'history' }, { name: 'subagent' }, { name: 'run_code' }] };
  const projected = await agent.hooks.get('system-prompt/assemble')(assembly, {}, async () => assembly);
  assert.deepEqual(projected.tools.map(tool => tool.name), ['history']);
  assert.equal(projected.sections, assembly.sections, 'model instruction sections are preserved');
  assert.match(agent.guards[0]({ agent, name: 'subagent' }), /unavailable/);
  await host.dispose();
});

test('live reuse refreshes display name and permission selection without replacing context', async () => {
  const f = fixture();
  const host = createSessionHost(f.ctx, { isAuthorized: () => true });
  const first = await host.getOrCreate(request());
  const next = await host.getOrCreate({ ...request(), title: 'Renamed user', permissionPreset: 'workspace-write' });
  assert.equal(first.agent, next.agent);
  assert.equal(f.calls.filter(([name]) => name === 'title').at(-1)[1], 'Renamed user');
  assert.equal(f.calls.filter(([name]) => name === 'permission').at(-1)[1], 'workspace-write');
  await host.dispose();
});

test('archived sessions cannot be reused or resumed, without cancelling the running turn', async () => {
  const f = fixture();
  const host = createSessionHost(f.ctx, { allowedTools: ['history'], isAuthorized: () => true });
  const { agent } = await host.getOrCreate(request());
  agent.status = 'running';
  f.archived.add(agent.session.id);
  assert.equal(host.isArchived(agent.session.id), true);
  await assert.rejects(host.getOrCreate(request()), { name: 'ArchivedSessionError' });
  assert.equal(agent.guards[0]({ agent, name: 'history' }), undefined, 'existing work keeps safe tools until completion');
  assert.equal(f.calls.some(([name]) => name === 'cancel'), false);
  agent.status = 'idle';
  await host.release(agent.session.id);
  await assert.rejects(host.getOrCreate(request()), { name: 'ArchivedSessionError' });
  assert.equal(f.calls.some(([name]) => name === 'resume'), false);
  assert.ok(f.stored.has(agent.session.id));
  await host.dispose();
});

test('deleted workspace registration is restored for a live session without replacing its context', async () => {
  const f = fixture();
  const host = createSessionHost(f.ctx, { isAuthorized: () => true });
  const first = await host.getOrCreate(request());
  f.workspaces.delete(request().workspacePath);
  first.agent.status = 'running';
  const next = await host.getOrCreate(request());
  assert.equal(next.agent, first.agent);
  assert.deepEqual(f.workspaces.get(request().workspacePath).sessionIds, [request().sessionId]);
  assert.equal(f.calls.filter(([name]) => name === 'create').length, 1);
  assert.equal(f.calls.some(([name]) => name === 'cancel'), false);
  await host.getOrCreate(request());
  assert.deepEqual(f.workspaces.get(request().workspacePath).sessionIds, [request().sessionId]);
  await host.dispose();
});

test('durable session resumes into a recreated workspace; archived sessions stay archived', async () => {
  const f = fixture();
  const host = createSessionHost(f.ctx, { isAuthorized: () => true });
  const first = await host.getOrCreate(request());
  await host.release(request().sessionId);
  f.workspaces.clear();
  const resumed = await host.getOrCreate(request());
  assert.notEqual(resumed.agent, first.agent);
  assert.equal(resumed.agent.session.id, first.agent.session.id);
  assert.deepEqual(f.workspaces.get(request().workspacePath).sessionIds, [request().sessionId]);
  f.archived.add(request().sessionId);
  f.workspaces.clear();
  await assert.rejects(host.getOrCreate(request()), { name: 'ArchivedSessionError' });
  assert.equal(f.workspaces.size, 0);
  await host.dispose();
});

test('workspace reattachment failure does not report a live session as ready', async () => {
  const f = fixture();
  const host = createSessionHost(f.ctx, { isAuthorized: () => true });
  await host.getOrCreate(request());
  f.ctx.workspaceRegistry.create = async () => { throw new Error('Registry unavailable'); };
  await assert.rejects(host.getOrCreate(request()), /Registry unavailable/);
  await host.dispose();
});

test('retirement archives and releases an idle owned agent without deleting its log', async () => {
  const f = fixture();
  const host = createSessionHost(f.ctx, { isAuthorized: () => true });
  const { agent } = await host.getOrCreate(request());
  assert.equal(host.getLive(agent.session.id), agent);
  const first = host.retire(agent.session.id);
  assert.equal(host.retire(agent.session.id), first);
  assert.equal(await first, true);
  assert.equal(f.archived.has(agent.session.id), true);
  assert.equal(host.getLive(agent.session.id), undefined);
  assert.ok(f.stored.has(agent.session.id));
  assert.equal(f.calls.filter(([name]) => name === 'dispose').length, 1);
  assert.equal(await host.retire(agent.session.id), true);
  assert.equal(f.calls.filter(([name]) => name === 'archive').length, 1);
  await assert.rejects(host.getOrCreate(request()), { name: 'ArchivedSessionError' });
  await host.dispose();
});

test('retirement defers busy agents without cancelling or hiding them', async () => {
  const f = fixture();
  const host = createSessionHost(f.ctx, { isAuthorized: () => true });
  const { agent } = await host.getOrCreate(request());
  agent.status = 'running';
  assert.equal(await host.retire(agent.session.id), false);
  assert.equal(f.archived.size, 0);
  assert.equal(f.calls.some(([name]) => name === 'cancel' || name === 'dispose'), false);
  agent.status = 'idle';
  assert.equal(await host.retire(agent.session.id), true);
  await host.dispose();
});

test('retirement handles UI-owned agents without taking their disposal capability', async () => {
  const f = fixture();
  const ui = f.agent(request().sessionId);
  f.live.set(ui.session.id, ui);
  const host = createSessionHost(f.ctx, { isAuthorized: () => true });
  ui.status = 'running';
  assert.equal(await host.retire(ui.session.id), false);
  assert.equal(f.archived.size, 0);
  ui.status = 'idle';
  assert.equal(await host.retire(ui.session.id), true);
  assert.equal(f.archived.has(ui.session.id), true);
  assert.equal(host.getLive(ui.session.id), ui);
  assert.equal(f.calls.some(([name]) => name === 'dispose' || name === 'cancel'), false);
  await host.dispose();
});

test('retirement archives unloaded durable sessions and accepts definite missing logs', async () => {
  const f = fixture();
  const host = createSessionHost(f.ctx);
  const id = request().sessionId;
  f.stored.set(id, { header: { cwd: request().workspacePath } });
  assert.equal(await host.retire(id), true);
  assert.equal(f.archived.has(id), true);
  assert.ok(f.stored.has(id));
  assert.equal(await host.retire('feishu-user-missing'), true);
  assert.equal(f.archived.has('feishu-user-missing'), false);
  assert.equal(f.calls.some(([name]) => name === 'resume' || name === 'create'), false);
  await assert.rejects(host.retire('ordinary'), /Only managed/);
  assert.throws(() => host.getLive('ordinary'), /Only managed/);
  assert.equal(f.calls.filter(([name]) => name === 'archive').length, 1);
  await host.dispose();
});

test('retirement propagates storage failures and keeps live handles for retry', async () => {
  const f = fixture();
  const host = createSessionHost(f.ctx, { isAuthorized: () => true });
  const { agent } = await host.getOrCreate(request());
  const archive = f.ctx.workspaceRegistry.archiveSession;
  f.ctx.workspaceRegistry.archiveSession = async () => { throw new Error('Archive storage failed'); };
  await assert.rejects(host.retire(agent.session.id), /Archive storage failed/);
  assert.equal(host.getLive(agent.session.id), agent);
  assert.equal(f.calls.some(([name]) => name === 'dispose'), false);
  f.ctx.workspaceRegistry.archiveSession = archive;
  assert.equal(await host.retire(agent.session.id), true);
  f.ctx.sessionPersistence.stat = async () => { throw new Error('Persistence unavailable'); };
  await assert.rejects(host.retire('feishu-user-unknown'), /Persistence unavailable/);
  await host.dispose();
});

test('retirement waits for an in-flight open and prevents concurrent reopening', async () => {
  const f = fixture();
  const host = createSessionHost(f.ctx, { isAuthorized: () => true });
  let releaseSetup;
  let notifySetup;
  const setupStarted = new Promise(resolve => { notifySetup = resolve; });
  const setupGate = new Promise(resolve => { releaseSetup = resolve; });
  const opening = host.getOrCreate({ ...request(), setup: async () => { notifySetup(); await setupGate; } });
  await setupStarted;
  const retiring = host.retire(request().sessionId);
  const reopening = assert.rejects(host.getOrCreate(request()), { name: 'ArchivedSessionError' });
  assert.equal(f.calls.some(([name]) => name === 'archive'), false);
  releaseSetup();
  await opening;
  assert.equal(await retiring, true);
  await reopening;
  assert.equal(f.calls.filter(([name]) => name === 'create').length, 1);
  assert.equal(f.calls.filter(([name]) => name === 'dispose').length, 1);
  await host.dispose();
});

test('a UI turn starting during archive is not disposed and retirement retries when idle', async () => {
  const f = fixture();
  const host = createSessionHost(f.ctx, { isAuthorized: () => true });
  const { agent } = await host.getOrCreate(request());
  const archive = f.ctx.workspaceRegistry.archiveSession;
  f.ctx.workspaceRegistry.archiveSession = async id => {
    await archive(id);
    agent.status = 'running';
  };
  assert.equal(await host.retire(agent.session.id), false);
  assert.equal(host.getLive(agent.session.id), agent);
  assert.equal(f.calls.some(([name]) => name === 'cancel' || name === 'dispose'), false);
  agent.status = 'idle';
  assert.equal(await host.retire(agent.session.id), true);
  assert.equal(f.calls.filter(([name]) => name === 'dispose').length, 1);
  await host.dispose();
});
