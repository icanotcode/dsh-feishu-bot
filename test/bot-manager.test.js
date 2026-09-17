import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { createBotManager } from '../lib/bot-manager.js';
import { createManagement } from '../lib/management.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'feishu-bot-manager-'));
  const project = join(directory, 'legacy-project');
  await mkdir(project);
  const values = new Map([['LEGACY_APP_ID', 'cli_legacy'], ['LEGACY_APP_SECRET', 'legacy-secret']]);
  const routes = new Map();
  const configs = new Map();
  const runtimes = new Map();
  const transports = new Map();
  const receivers = new Map();
  const calls = [];
  const busy = new Set();
  const runtimeHooks = new Map();
  const pendingDeliveries = [];
  const controls = { holdDeliveries: new Set(), beforeCredentialSet: null, beforeRuntimeStop: null, runtimeDisposeFailures: new Set(), allowCleanupFailure: false };
  let serial = 0;
  let manager;
  const base = {
    source: 'feishu', path: '/webhook/feishu', configFile: join(directory, 'legacy-settings.json'),
    historyRoot: join(directory, 'legacy-history'), workspacePath: project,
    connectionMode: 'webhook', tunnelProvider: 'custom', publicBaseUrl: 'https://server.example',
    agentPreset: 'standard', permissionPreset: 'workspace-write',
    appIdEnv: 'LEGACY_APP_ID', appSecretEnv: 'LEGACY_APP_SECRET', verificationToken: 'LEGACY_VERIFY', encryptKey: 'LEGACY_ENCRYPT',
  };
  const ctx = {
    credentials: {
      resolve: async ref => values.has(ref) ? { value: values.get(ref), source: 'file' } : undefined,
      set: async (ref, value) => { await controls.beforeCredentialSet?.(ref, value); values.set(ref, value); },
    },
    webhookRuntime: { dispatch: delivery => { pendingDeliveries.push(delivery); if (!controls.holdDeliveries.has(delivery.source)) runtimeHooks.get(delivery.source)?.onDeliveryStart(delivery); } },
    logger: { warn: (...args) => calls.push(['warn', ...args]) },
    connection: { requestRejection: req => req.headers.host === 'localhost:3080' && req.headers.cookie === 'authenticated' ? undefined : 403 },
    webServer: { port: 3080, register: route => {
      assert.ok(!routes.has(route.path), `Duplicate route ${route.path}`);
      routes.set(route.path, route.handler);
      return () => routes.delete(route.path);
    } },
  };
  const supervisor = {
    reconcile: async () => { calls.push(['tunnel-reconcile']); },
    status: async () => ({ state: 'running', provider: 'custom', url: 'https://server.example', running: true }),
    start: async () => { calls.push(['tunnel-start']); return { state: 'running' }; },
    stop: async () => { calls.push(['tunnel-stop']); return { state: 'idle' }; },
    dispose: async () => { calls.push(['tunnel-dispose']); },
  };
  const dependencies = {
    createManagement: (context, config, client, hooks) => createManagement(context, config, client, { ...hooks, tunnelSupervisor: supervisor }),
    createClient: (context, config) => { configs.set(config.source, config); return { source: config.source }; },
    installRuntime: async (context, config, client, options) => {
      const token = ++serial;
      calls.push(['runtime-start', config.source, token, options.allowLegacyHistory]);
      runtimeHooks.set(config.source, options);
      const runtime = async () => {
        calls.push(['runtime-stop', config.source, token]);
        await controls.beforeRuntimeStop?.(config.source);
        if (controls.runtimeDisposeFailures.has(config.source)) throw new Error('Simulated runtime disposal failure');
      };
      runtime.isBusy = () => busy.has(config.source);
      runtime.reconcile = async () => { calls.push(['runtime-reconcile', config.source]); };
      runtimes.set(config.source, runtime);
      return runtime;
    },
    createReceiver: (context, config) => (...args) => { receivers.set(config.source, args); context.webhookRuntime.dispatch({ source: config.source, deliveryId: `delivery-${++serial}` }); },
    createHandler: (context, config, receive) => async (req, res) => {
      await receive('message', config.source);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ source: config.source }));
    },
    createTransport: (context, config, receive) => {
      const transport = {
        status: () => ({ mode: config.connectionMode, state: config.connectionMode === 'websocket' ? 'connected' : 'listening' }),
        reconcile: async () => { calls.push(['transport-reconcile', config.source]); },
        dispose: () => { calls.push(['transport-stop', config.source]); },
        receive,
      };
      transports.set(config.source, transport);
      return transport;
    },
    hub: { dispose: async () => { calls.push(['hub-dispose']); } },
  };
  const request = async (path, method = 'GET', body, headers = {}) => {
    const req = Readable.from(body === undefined ? [] : [typeof body === 'string' ? body : JSON.stringify(body)]);
    req.method = method;
    req.headers = { host: 'localhost:3080', cookie: 'authenticated', 'content-type': 'application/json', ...headers };
    let result;
    const res = { setHeader() {}, writeHead(status) { this.status = status; }, end(text) { result = { status: this.status, body: JSON.parse(text) }; } };
    const handler = routes.get(path);
    assert.ok(handler, `No route ${path}`);
    await handler(req, res);
    return result;
  };
  const freshProject = async (name = `project-${++serial}`) => {
    const path = join(directory, name);
    await mkdir(path, { recursive: true });
    return path;
  };
  const add = async (input = {}) => {
    const result = await request('/api/feishu-bot/bots', 'POST', { name: 'Project bot', workspacePath: await freshProject(), ...input });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body.bot;
  };
  const restart = async () => {
    await manager?.dispose();
    manager = await createBotManager(ctx, { ...base }, dependencies);
    return manager;
  };
  manager = await createBotManager(ctx, { ...base }, dependencies);
  t.after(async () => { try { await manager?.dispose(); } catch (error) { if (!controls.allowCleanupFailure) throw error; } finally { await rm(directory, { recursive: true, force: true }); } });
  return { directory, base, values, routes, configs, runtimes, transports, receivers, calls, busy, runtimeHooks, pendingDeliveries, controls, ctx, dependencies, request, freshProject, add, restart, get manager() { return manager; } };
}
const botPath = (id, suffix = '/config') => `/api/feishu-bot/bots/${id}${suffix}`;

test('legacy default preserves configuration, credentials, history, source and callback aliases', async t => {
  const f = await fixture(t);
  const list = await f.request('/api/feishu-bot/bots');
  assert.equal(list.status, 200);
  assert.equal(list.body.defaultBotId, 'default');
  assert.equal(list.body.bots.length, 1);
  const config = f.configs.get('feishu');
  for (const key of ['source', 'path', 'configFile', 'historyRoot', 'workspacePath', 'appIdEnv', 'appSecretEnv', 'verificationToken', 'encryptKey']) assert.equal(config[key], f.base[key]);
  assert.deepEqual(f.calls.filter(([action]) => action === 'runtime-start').map(call => call.at(-1)), [true]);
  assert.deepEqual((await f.request('/api/feishu-bot/config')).body, (await f.request(botPath('default'))).body);
  assert.equal((await f.request('/api/feishu-bot/webhook-url')).body.url, 'https://server.example/webhook/feishu');
  assert.equal((await f.request('/webhook/feishu', 'POST', {})).body.source, 'feishu');
  await f.request('/api/feishu-bot/config', 'POST', { appSecret: 'updated-legacy-secret' });
  assert.equal(f.values.get('LEGACY_APP_SECRET'), 'updated-legacy-secret');
});

test('new robots have independent projects, config files, credentials, sources and callback routing', async t => {
  const f = await fixture(t);
  const first = await f.add({ name: 'Project A' });
  const second = await f.add({ name: 'Project B' });
  const sources = [first, second].map(bot => `feishu:${bot.id}`);
  for (const [i, bot] of [first, second].entries()) {
    const config = f.configs.get(sources[i]);
    assert.equal(config.path, `/webhook/feishu/${bot.id}`);
    assert.equal(config.workspacePath, bot.workspacePath);
    assert.notEqual(config.historyRoot, f.base.historyRoot);
    assert.notEqual(config.configFile, f.base.configFile);
    assert.notEqual(config.appIdEnv, f.base.appIdEnv);
    const save = await f.request(botPath(bot.id), 'POST', { appId: `cli_project_${i}`, appSecret: `project-secret-${i}`, verificationToken: `project-verification-${i}`, encryptKey: `project-encrypt-${i}` });
    assert.equal(save.status, 200);
    assert.equal(f.values.get(config.appSecretEnv), `project-secret-${i}`);
    assert.equal((await f.request(config.path, 'POST', {})).body.source, sources[i]);
    assert.deepEqual(f.receivers.get(sources[i]), ['message', sources[i]]);
    const visible = (await f.request(botPath(bot.id))).body;
    assert.equal(visible.appId, `cli_project_${i}`);
    assert.equal(visible.appSecret, '');
    assert.equal(visible.sharedTunnel, true);
  }
  assert.equal(f.values.get('LEGACY_APP_SECRET'), 'legacy-secret');
  assert.notEqual(f.configs.get(sources[0]).historyRoot, f.configs.get(sources[1]).historyRoot);
  assert.deepEqual(f.calls.filter(([action]) => action === 'runtime-start').map(call => call.at(-1)), [true, false, false]);
});

test('cross-bot application IDs are unique including concurrent credential saves', async t => {
  const f = await fixture(t);
  const first = await f.add();
  const second = await f.add();
  assert.equal((await f.request(botPath(first.id), 'POST', { appId: 'cli_legacy', appSecret: 'must-not-save' })).status, 409);
  assert.equal(f.values.has(f.configs.get(`feishu:${first.id}`).appSecretEnv), false);
  const results = await Promise.all([first, second].map(bot => f.request(botPath(bot.id), 'POST', { appId: 'cli_race', appSecret: `secret-${bot.id}` })));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const visible = await Promise.all([first, second].map(bot => f.request(botPath(bot.id))));
  assert.equal(visible.filter(result => result.body.appId === 'cli_race').length, 1);
});

test('project uniqueness compares canonical directories and rejects aliases on create and save', async t => {
  const f = await fixture(t);
  const first = await f.add();
  const alias = join(f.directory, 'project-alias');
  await symlink(first.workspacePath, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await f.request('/api/feishu-bot/bots', 'POST', { name: 'Duplicate', workspacePath: alias })).status, 409);
  const second = await f.add();
  assert.equal((await f.request(botPath(second.id), 'POST', { workspacePath: alias })).status, 409);
  assert.equal((await f.request(botPath(second.id))).body.workspacePath, second.workspacePath);
  assert.equal((await f.request('/api/feishu-bot/bots')).body.bots.length, 3);
});

test('default websocket and secondary webhook share one global tunnel and use separate callback paths', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/feishu-bot/config', 'POST', { connectionMode: 'websocket' })).status, 200);
  assert.equal((await f.request('/api/feishu-bot/config')).body.serverTunnelRequired, false);
  const bot = await f.add({ connectionMode: 'webhook' });
  assert.equal((await f.request('/api/feishu-bot/config')).body.serverTunnelRequired, true);
  assert.equal((await f.request('/api/feishu-bot/webhook-url')).body.url, null);
  assert.equal((await f.request(botPath(bot.id, '/webhook-url'))).body.url, `https://server.example/webhook/feishu/${bot.id}`);
  assert.equal((await f.request('/api/feishu-bot/tunnel/status')).body.state, 'configured');
  assert.equal((await f.request(botPath(bot.id, '/tunnel/start'), 'POST', {})).status, 409);
  assert.equal((await f.request('/api/feishu-bot/tunnel/start', 'POST', {})).status, 200);
  assert.equal(f.calls.filter(([action]) => action === 'tunnel-start').length, 1);
  assert.equal((await f.request(botPath(bot.id, '/meta'), 'POST', { enabled: false })).status, 200);
  assert.equal((await f.request('/api/feishu-bot/config')).body.serverTunnelRequired, false);
});

test('disabling one bot stops only its runtime, preserves settings and rejects new ingress; busy tasks block changes', async t => {
  const f = await fixture(t);
  const bot = await f.add();
  const source = `feishu:${bot.id}`;
  const path = f.configs.get(source).path;
  f.busy.add(source);
  assert.equal((await f.request(botPath(bot.id, '/meta'), 'POST', { enabled: false })).status, 409);
  assert.equal((await f.request(botPath(bot.id), 'POST', { connectionMode: 'websocket' })).status, 409);
  assert.equal((await f.request(botPath(bot.id), 'POST', { appSecret: 'must-not-save' })).status, 409);
  f.busy.delete(source);
  assert.equal((await f.request(botPath(bot.id, '/meta'), 'POST', { enabled: false, name: 'Stopped project' })).status, 200);
  assert.equal((await f.request(path, 'POST', {})).status, 503);
  assert.equal((await f.request('/webhook/feishu', 'POST', {})).status, 200);
  assert.equal((await f.request(botPath(bot.id, '/connection/status'))).body.state, 'disabled');
  assert.deepEqual(f.calls.filter(([action]) => action === 'runtime-stop').map(call => call[1]), [source]);
  assert.equal((await f.request(botPath(bot.id))).status, 200);
  assert.equal((await f.request(botPath(bot.id, '/meta'), 'POST', { enabled: true })).status, 200);
  assert.equal((await f.request(path, 'POST', {})).status, 200);
});

test('catalog restart restores names, disabled bots, projects, independent credentials and transport selection', async t => {
  const f = await fixture(t);
  const bot = await f.add({ name: 'Persisted project', connectionMode: 'websocket' });
  await f.request(botPath(bot.id), 'POST', { appId: 'cli_persisted', appSecret: 'persisted-secret' });
  await f.request(botPath(bot.id, '/meta'), 'POST', { enabled: false });
  const refs = { ...f.configs.get(`feishu:${bot.id}`) };
  await f.restart();
  const list = (await f.request('/api/feishu-bot/bots')).body;
  assert.equal(list.bots.length, 2);
  const restored = list.bots.find(row => row.id === bot.id);
  assert.equal(restored.name, 'Persisted project');
  assert.equal(restored.enabled, false);
  assert.equal(restored.workspacePath, resolve(bot.workspacePath));
  assert.equal(restored.connectionMode, 'websocket');
  const config = f.configs.get(`feishu:${bot.id}`);
  for (const key of ['source', 'path', 'configFile', 'historyRoot', 'appIdEnv', 'appSecretEnv', 'verificationToken', 'encryptKey']) assert.equal(config[key], refs[key]);
  assert.equal((await f.request(botPath(bot.id))).body.appId, 'cli_persisted');
  assert.equal((await f.request(config.path, 'POST', {})).status, 503);
  assert.ok(!(await readFile(`${f.base.configFile}.bots.json`, 'utf8')).includes('persisted-secret'));
});

test('catalog and every bot management route enforce auth before mutation and disposal removes all routes', async t => {
  const f = await fixture(t);
  const bot = await f.add();
  const count = f.values.size;
  for (const path of ['/api/feishu-bot/bots', '/api/feishu-bot/config', botPath('default'), botPath(bot.id), botPath(bot.id, '/meta'), botPath(bot.id, '/tunnel/start')]) {
    assert.equal((await f.request(path, 'POST', { appSecret: 'must-not-save', enabled: false }, { cookie: '' })).status, 403);
    assert.equal((await f.request(path, 'GET', undefined, { host: 'public.example' })).status, 403);
  }
  assert.equal(f.values.size, count);
  assert.equal((await f.request('/api/feishu-bot/bots', 'POST', '{')).status, 400);
  assert.equal((await f.request('/api/feishu-bot/bots', 'DELETE')).status, 405);
  await f.manager.dispose();
  assert.equal(f.routes.size, 0);
  assert.equal(f.calls.filter(([action]) => action === 'tunnel-dispose').length, 1);
  assert.equal(f.calls.filter(([action]) => action === 'hub-dispose').length, 1);
});


test('failed route registration rolls back new bot catalog, slot, routes and its initial settings', async t => {
  const f = await fixture(t);
  await f.add();
  const catalogPath = `${f.base.configFile}.bots.json`;
  const before = await readFile(catalogPath, 'utf8');
  const routesBefore = [...f.routes.keys()].sort();
  const register = f.ctx.webServer.register;
  let failedId;
  f.ctx.webServer.register = route => {
    const match = route.path.match(/^\/api\/feishu-bot\/bots\/(bot_[a-f0-9]{32})\/config$/);
    if (match) { failedId = match[1]; throw new Error('Simulated route registration failure'); }
    return register(route);
  };
  const result = await f.request('/api/feishu-bot/bots', 'POST', { name: 'Failed project', workspacePath: await f.freshProject() });
  assert.equal(result.status, 500);
  assert.ok(failedId);
  assert.equal(await readFile(catalogPath, 'utf8'), before);
  assert.deepEqual([...f.routes.keys()].sort(), routesBefore);
  assert.equal((await f.request('/api/feishu-bot/bots')).body.bots.length, 2);
  await assert.rejects(readFile(join(`${catalogPath}.data`, failedId, 'config.json')), { code: 'ENOENT' });
  f.ctx.webServer.register = register;
  assert.equal((await f.request('/webhook/feishu', 'POST', {})).status, 200);
  assert.ok((await f.add()).id);
});

test('missing persisted secondary settings cannot fall back to the default project on restart', async t => {
  const f = await fixture(t);
  const bot = await f.add();
  const config = f.configs.get(`feishu:${bot.id}`);
  await unlink(config.configFile);
  const starts = f.calls.filter(([action]) => action === 'runtime-start').length;
  await assert.rejects(f.restart(), { code: 'ENOENT' });
  assert.equal(f.calls.filter(([action]) => action === 'runtime-start').length, starts);
  assert.equal(f.routes.size, 0, 'failed initialization cleans default routes before returning');
});

test('an assigned application ID cannot be replaced and rejected changes preserve credentials and history identity', async t => {
  const f = await fixture(t);
  const bot = await f.add();
  const config = f.configs.get(`feishu:${bot.id}`);
  assert.equal((await f.request(botPath(bot.id), 'POST', { appId: 'cli_original', appSecret: 'original-secret' })).status, 200);
  const saved = await readFile(config.configFile, 'utf8');
  const changed = await f.request(botPath(bot.id), 'POST', { appId: 'cli_replacement', appSecret: 'replacement-secret', connectionMode: 'websocket' });
  assert.equal(changed.status, 409);
  assert.match(changed.body.message, /新增机器人/);
  assert.equal(f.values.get(config.appIdEnv), 'cli_original');
  assert.equal(f.values.get(config.appSecretEnv), 'original-secret');
  assert.equal(await readFile(config.configFile, 'utf8'), saved);
  assert.equal((await f.request(botPath(bot.id), 'POST', { appId: ' cli_original ', appSecret: '' })).status, 200);
  const next = await f.add();
  assert.equal((await f.request(botPath(next.id), 'POST', { appId: 'cli_replacement' })).status, 200);
});

function gate() {
  let release, entered;
  const pending = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { entered = resolve; });
  return { pending, reached, release, entered };
}

test('configuration saves pause only the target bot ingress until the write and reconciliation complete', async t => {
  const f = await fixture(t);
  const bot = await f.add();
  const config = f.configs.get(`feishu:${bot.id}`);
  const saving = gate();
  f.controls.beforeCredentialSet = async ref => {
    if (ref !== config.appSecretEnv) return;
    saving.entered();
    await saving.pending;
  };
  const save = f.request(botPath(bot.id), 'POST', { appSecret: 'updated-secret' });
  await saving.reached;
  try {
    assert.equal((await f.request(config.path, 'POST', {})).status, 503);
    assert.equal((await f.request('/webhook/feishu', 'POST', {})).status, 200);
    assert.throws(() => f.transports.get(config.source).receive('late-connection-event'), /temporarily unavailable/);
  } finally { saving.release(); }
  assert.equal((await save).status, 200);
  assert.equal((await f.request(config.path, 'POST', {})).status, 200);
});

test('disabling pauses target ingress during runtime shutdown while other bots continue serving', async t => {
  const f = await fixture(t);
  const bot = await f.add();
  const config = f.configs.get(`feishu:${bot.id}`);
  const stopping = gate();
  f.controls.beforeRuntimeStop = async source => {
    if (source !== config.source) return;
    stopping.entered();
    await stopping.pending;
  };
  const disable = f.request(botPath(bot.id, '/meta'), 'POST', { enabled: false });
  await stopping.reached;
  try {
    assert.equal((await f.request(config.path, 'POST', {})).status, 503);
    assert.equal((await f.request('/webhook/feishu', 'POST', {})).status, 200);
  } finally { stopping.release(); }
  assert.equal((await disable).status, 200);
  assert.equal((await f.request(config.path, 'POST', {})).status, 503);
});

test('queued delivery blocks disabling and credential changes before runtime has received it', async t => {
  const f = await fixture(t);
  const bot = await f.add();
  const config = f.configs.get(`feishu:${bot.id}`);
  f.controls.holdDeliveries.add(config.source);
  assert.equal((await f.request(config.path, 'POST', {})).status, 200);
  assert.equal(f.busy.has(config.source), false, 'runtime itself has not started processing');
  assert.equal((await f.request(botPath(bot.id, '/meta'), 'POST', { enabled: false })).status, 409);
  assert.equal((await f.request(botPath(bot.id), 'POST', { appSecret: 'must-not-save' })).status, 409);
  assert.equal(f.values.has(config.appSecretEnv), false);
  const pending = f.pendingDeliveries.find(delivery => delivery.source === config.source);
  assert.ok(pending);
  f.runtimeHooks.get(config.source).onDeliveryStart(pending);
  assert.equal((await f.request(botPath(bot.id, '/meta'), 'POST', { enabled: false })).status, 200);
});

test('one bot disposal failure does not prevent other runtimes, management routes, tunnel and hub cleanup', async t => {
  const f = await fixture(t);
  const bot = await f.add();
  f.controls.runtimeDisposeFailures.add(`feishu:${bot.id}`);
  f.controls.allowCleanupFailure = true;
  await assert.rejects(f.manager.dispose(), AggregateError);
  assert.equal(f.routes.size, 0);
  assert.equal(f.calls.filter(([action]) => action === 'runtime-stop').length, 2);
  assert.equal(f.calls.filter(([action]) => action === 'tunnel-dispose').length, 1);
  assert.equal(f.calls.filter(([action]) => action === 'hub-dispose').length, 1);
});
