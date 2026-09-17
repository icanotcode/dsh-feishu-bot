import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createManagement, ManagementError } from '../lib/management.js';

async function fixture(t, values = new Map(), hooks = {}, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'feishu-management-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const routes = new Map();
  const disposers = [];
  const ctx = {
    credentials: { resolve: async ref => values.has(ref) ? { value: values.get(ref), source: 'file' } : undefined, set: async (ref, value) => values.set(ref, value) },
    connection: { requestRejection: req => req.headers.host === 'localhost:3080' && req.headers.cookie === 'authenticated' ? undefined : 403 },
    webServer: { port: 3080, register: route => { routes.set(route.path, route.handler); return () => routes.delete(route.path); } },
    effect: effect => { const dispose = effect(); disposers.push(dispose); return dispose; },
  };
  const config = { configFile: join(dir, 'settings.json'), path: '/webhook/feishu', workspacePath: dir, agentPreset: 'standard', permissionPreset: 'workspace-write', ...overrides };
  const client = { cachedToken: 'old-token', tokenExpireTime: 999999 };
  const service = await createManagement(ctx, config, client, hooks);
  t.after(async () => { for (const dispose of disposers.reverse()) await dispose?.(); });
  const request = async (path, method = 'GET', body, headers = {}) => {
    const req = Readable.from(body === undefined ? [] : [typeof body === 'string' ? body : JSON.stringify(body)]);
    req.method = method;
    req.headers = { host: 'localhost:3080', cookie: 'authenticated', 'content-type': 'application/json', ...headers };
    let result;
    const res = { setHeader() {}, writeHead(status) { this.status = status; }, end(text) { result = { status: this.status, body: JSON.parse(text) }; } };
    await routes.get(`${hooks.routePrefix ?? '/api/feishu-bot'}${path}`)(req, res);
    return result;
  };
  return { dir, config, ctx, service, values, request, client, routes, disposers };
}

test('configuration persists across recreation, keeps blank secrets and never returns them', async t => {
  const f = await fixture(t);
  const saved = await f.request('/config', 'POST', { appId: 'cli_example', appSecret: 'secret-example', verificationToken: 'verification-example', encryptKey: 'encrypt-example', workspacePath: f.dir, publicBaseUrl: 'https://bot.example.com/' });
  assert.equal(saved.status, 200);
  assert.equal(f.client.cachedToken, null);
  assert.equal((await f.request('/config', 'POST', { appSecret: '', verificationToken: '' })).body.success, true);
  const visible = (await f.request('/config')).body;
  assert.equal(visible.appId, 'cli_example');
  assert.equal(visible.appSecret, '');
  assert.equal(visible.configured.appSecret, true);
  assert.equal(f.values.get('FEISHU_APP_SECRET'), 'secret-example');
  const disk = await readFile(f.config.configFile, 'utf8');
  assert.ok(!disk.includes('secret-example'));
  assert.ok(!disk.includes('verification-example'));
  const reloaded = { ...f.config, publicBaseUrl: '' };
  const next = await createManagement(f.ctx, reloaded, {});
  assert.equal(await next.getWebhookUrl(), 'https://bot.example.com/webhook/feishu');
});

test('all management routes reject untrusted requests before reads or writes', async t => {
  const f = await fixture(t);
  for (const path of ['/config', '/test', '/ngrok/start', '/ngrok/stop', '/ngrok/status', '/tunnel/status', '/tunnel/start', '/tunnel/stop', '/webhook-url', '/connection/status']) {
    const result = await f.request(path, 'POST', { appSecret: 'must-not-save' }, { host: 'public-tunnel.example' });
    assert.equal(result.status, 403);
  }
  assert.equal(f.values.size, 0);
  assert.equal((await f.request('/config', 'GET', undefined, { cookie: '' })).status, 403);
  assert.equal((await f.request('/config', 'DELETE')).status, 405);
  assert.equal((await f.request('/config', 'POST', '{')).status, 400);
  assert.equal((await f.request('/config', 'POST', {}, { 'content-length': '70000' })).status, 413);
  assert.equal((await f.request('/config', 'POST', {}, { 'content-type': 'text/plain' })).status, 415);
});

test('Cloudflare and custom providers persist without ngrok fallback or unverified connection claims', async t => {
  const f = await fixture(t);
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Must not probe ngrok for this provider'); });
  assert.equal((await f.request('/config')).body.tunnelProvider, 'ngrok');
  f.ctx.webServer.port = 4567;
  for (const provider of ['cloudflare', 'custom']) {
    assert.equal((await f.request('/config', 'POST', { tunnelProvider: provider, publicBaseUrl: '' })).status, 200);
    assert.equal(await f.service.getWebhookUrl(), null);
    assert.equal((await f.request('/tunnel/status')).body.state, provider === 'custom' ? 'unconfigured' : 'idle');
    assert.equal((await f.request('/config', 'POST', { publicBaseUrl: 'https://tunnel.example/' })).status, 200);
    const status = (await f.request('/tunnel/status')).body;
    assert.equal(status.provider, provider);
    assert.equal(status.state, provider === 'custom' ? 'configured' : 'idle');
    assert.equal(status.running, provider === 'custom' ? null : false);
    assert.equal(status.port, 4567);
    assert.equal(status.managed, false);
    assert.equal((await f.request('/config')).body.harnessPort, 4567);
    assert.equal(await f.service.getWebhookUrl(), 'https://tunnel.example/webhook/feishu');
    const loaded = { ...f.config, tunnelProvider: 'ngrok', publicBaseUrl: '' };
    const restarted = await createManagement(f.ctx, loaded, {});
    assert.equal(loaded.tunnelProvider, provider);
    assert.equal(await restarted.getWebhookUrl(), 'https://tunnel.example/webhook/feishu');
    f.service = restarted;
    f.config = loaded;
  }
  assert.equal(globalThis.fetch.mock.calls.length, 0);
});

test('provider validation is atomic and websocket mode never probes tunnels or offers a callback URL', async t => {
  const f = await fixture(t);
  t.mock.method(globalThis, 'fetch', () => { throw new Error('No tunnel required'); });
  for (const tunnelProvider of ['invalid', '', null, 1]) {
    assert.equal((await f.request('/config', 'POST', { tunnelProvider, publicBaseUrl: 'https://other.example' })).status, 400);
    assert.equal(f.config.publicBaseUrl, undefined);
  }
  for (const publicBaseUrl of ['http://example.com', 'https://example.com/path', 'https://user:pass@example.com', 'https://example.com?q=1']) {
    assert.equal((await f.request('/config', 'POST', { tunnelProvider: 'cloudflare', publicBaseUrl })).status, 400);
    assert.equal(f.config.tunnelProvider, 'ngrok');
  }
  for (const tunnelProvider of ['ngrok', 'cloudflare', 'custom']) {
    await f.service.updateConfig({ connectionMode: 'websocket', tunnelProvider, publicBaseUrl: 'https://saved.example' });
    assert.equal(await f.service.getWebhookUrl(), null);
    const status = await f.service.getTunnelStatus();
    assert.equal(status.state, 'not_required');
    assert.equal(status.url, null);
  }
  assert.equal(globalThis.fetch.mock.calls.length, 0);
});

test('connection test uses saved credentials, has a deadline and does not return tokens', async t => {
  const f = await fixture(t, new Map([['FEISHU_APP_ID', 'cli_saved'], ['FEISHU_APP_SECRET', 'saved-secret']]));
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal');
    assert.deepEqual(JSON.parse(options.body), { app_id: 'cli_saved', app_secret: 'saved-secret' });
    assert.ok(options.signal instanceof AbortSignal);
    return { ok: true, json: async () => ({ code: 0, tenant_access_token: 'never-return-token' }) };
  });
  const result = await f.service.testConnection({ appId: '', appSecret: '' });
  assert.equal(result.success, true);
  assert.ok(!JSON.stringify(result).includes('never-return-token'));
});

test('ngrok reports matching external tunnels without duplicating or stopping their process', async t => {
  const f = await fixture(t);
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ tunnels: [
    { public_url: 'https://wrong.example.com', config: { addr: 'http://localhost:9000' } },
    { public_url: 'https://right.example.com', config: { addr: 'http://localhost:3080' } },
  ] }) }));
  assert.equal((await f.service.getNgrokStatus()).url, 'https://right.example.com');
  assert.equal(await f.service.getWebhookUrl(), 'https://right.example.com/webhook/feishu');
  const started = await f.service.startNgrok();
  assert.equal(started.success, true);
  assert.equal(started.status.managed, false);
  assert.equal(started.status.state, 'external');
  const stopped = await f.service.stopNgrok();
  assert.equal(stopped.status.managed, false);
  assert.equal(stopped.status.running, true);
  assert.match(stopped.message, /外部/);
});

test('tunnel controls use saved settings, preserve booleans and paths, and never expose tokens', async t => {
  const calls = [];
  let f;
  const supervisor = {
    reconcile: async () => calls.push(['reconcile', f.config.tunnelAutoRestart]),
    start: async (...args) => { calls.push(['start', args, f.config.tunnelProvider]); return { state: 'starting', managed: true, message: 'starting' }; },
    stop: async () => { calls.push(['stop']); return { state: 'idle', paused: true, managed: false }; },
    status: async () => ({ provider: f.config.tunnelProvider, managed: true, state: 'running', url: 'https://actual.trycloudflare.com' }),
    dispose: async () => calls.push(['dispose']),
  };
  f = await fixture(t, new Map(), { tunnelSupervisor: supervisor });
  assert.equal((await f.service.getConfig()).tunnelAutoRestart, false);
  assert.equal((await f.service.getConfig()).capabilities.tunnelProcessControl, true);
  const body = { tunnelAutoRestart: true, tunnelProvider: 'cloudflare', cloudflareMode: 'named',
    cloudflareTunnelName: 'my-bot', cloudflareConfigFile: join(f.dir, 'tunnel config.yml'),
    ngrokTrafficPolicyFile: '~/.config/ngrok/policy.yaml', ngrokAuthtoken: 'secret-ngrok-value' };
  assert.equal((await f.request('/config', 'POST', body)).status, 200);
  const saved = JSON.parse(await readFile(f.config.configFile, 'utf8'));
  assert.equal(saved.tunnelAutoRestart, true);
  assert.equal(saved.cloudflareConfigFile, body.cloudflareConfigFile);
  assert.equal(JSON.stringify(saved).includes('secret-ngrok-value'), false);
  assert.equal((await f.service.getConfig()).ngrokAuthtoken, '');
  assert.equal((await f.request('/tunnel/start', 'POST', { provider: 'ngrok', command: 'arbitrary', port: 80 })).body.success, true);
  assert.deepEqual(calls.at(-1), ['start', [], 'cloudflare']);
  assert.equal((await f.request('/tunnel/stop', 'POST', {})).body.status.paused, true);
  await f.service.updateConfig({ cloudflareMode: 'quick', publicBaseUrl: 'https://old.trycloudflare.com' });
  assert.equal(await f.service.getWebhookUrl(), 'https://actual.trycloudflare.com/webhook/feishu');
  await f.service.updateConfig({ tunnelAutoRestart: false });
  assert.equal(calls.at(-1)[1], false);
  assert.equal(calls.filter(([name]) => name === 'stop').length, 1, 'saving the switch delegates reconciliation, not an implicit stop');
  await f.service.updateConfig({ tunnelProvider: 'ngrok' });
  const startsBefore = calls.filter(([name]) => name === 'start').length;
  const switching = f.service.updateConfig({ tunnelProvider: 'cloudflare' });
  const legacyStart = f.service.startNgrok();
  await switching;
  assert.equal((await legacyStart).success, false, 'legacy route validates the provider after queued saves');
  assert.equal(calls.filter(([name]) => name === 'start').length, startsBefore);
});

test('invalid tunnel settings are rejected before saves, secret changes or reconciliation', async t => {
  let reconciles = 0;
  const f = await fixture(t, new Map(), { tunnelSupervisor: { reconcile: async () => reconciles++, dispose: async () => {} } });
  for (const input of [
    { tunnelAutoRestart: 'true' }, { tunnelAutoRestart: 1 }, { cloudflareMode: 'remote' },
    { cloudflareTunnelName: 'name --token secret' }, { cloudflareConfigFile: './relative.yml' },
    { ngrokExecutablePath: 'ngrok --config evil' }, { ngrokTrafficPolicyFile: '/tmp/a\nb' },
  ]) {
    assert.equal((await f.request('/config', 'POST', { ...input, ngrokAuthtoken: 'must-not-save' })).status, 400);
  }
  assert.equal(f.config.tunnelAutoRestart, false);
  assert.equal(f.values.size, 0);
  assert.equal(reconciles, 0);
});

test('ngrok detection distinguishes absent agent, unknown state and a different upstream', async t => {
  const f = await fixture(t);
  t.mock.method(globalThis, 'fetch', async () => { throw Object.assign(new Error('refused'), { cause: { code: 'ECONNREFUSED' } }); });
  assert.equal((await f.service.getNgrokStatus()).unknown, false);
  globalThis.fetch.mock.mockImplementation(async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); });
  assert.equal((await f.service.getNgrokStatus()).unknown, true);
  globalThis.fetch.mock.mockImplementation(async () => ({ ok: true, json: async () => ({ tunnels: [{ public_url: 'https://other.example', config: { addr: 'http://localhost:3080' } }] }) }));
  f.config.publicBaseUrl = 'https://expected.example';
  const status = await f.service.getNgrokStatus();
  assert.equal(status.running, false);
  assert.equal(status.reachable, true);
});

test('validation rejects invalid directory and environment override without partial config mutation', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/config', 'POST', { workspacePath: '/not-an-existing-feishu-test-directory' })).status, 400);
  assert.equal((await f.request('/config', 'POST', { publicBaseUrl: 'javascript:alert(1)' })).status, 400);
  f.ctx.credentials.resolve = async () => ({ value: 'inherited-secret', source: 'env' });
  assert.equal((await f.request('/config', 'POST', { appSecret: 'replacement', agentPreset: 'minimal' })).status, 409);
  assert.equal(f.config.agentPreset, 'standard');
  assert.equal(f.values.size, 0);
});

test('connection selection persists, validates and reconciles only after successful saves', async t => {
  let reconciles = 0;
  const f = await fixture(t, new Map(), {
    onConfigChanged: () => { reconciles++; },
    getConnectionStatus: () => ({ mode: 'websocket', state: 'unconfigured', message: 'missing credentials' }),
  });
  assert.equal((await f.request('/config')).body.connectionMode, 'webhook');
  assert.equal((await f.request('/config', 'POST', { connectionMode: 'invalid' })).status, 400);
  assert.equal(reconciles, 0);
  assert.equal((await f.request('/config', 'POST', { connectionMode: 'websocket' })).status, 200);
  assert.equal(reconciles, 1);
  assert.equal(f.config.connectionMode, 'websocket');
  assert.equal((await f.request('/connection/status')).body.state, 'unconfigured');
  const loaded = { ...f.config, connectionMode: 'webhook' };
  await createManagement(f.ctx, loaded, {});
  assert.equal(loaded.connectionMode, 'websocket');
  assert.equal((await f.service.updateConfig({ connectionMode: 'webhook' })).success, true);
  assert.equal(reconciles, 2);
});

test('legacy user settings and daily reset retain types, persist and support midnight and an empty list', async t => {
  let changed = 0;
  const f = await fixture(t, new Map(), { onConfigChanged: () => { changed++; } });
  const initial = await f.service.getConfig();
  assert.deepEqual(initial.authorizedUsers, []);
  assert.equal(initial.dailyResetHour, 4);
  assert.equal(initial.dailyResetTimezone, 'Asia/Macau');
  const authorizedUsers = [{ openId: 'ou_alice', displayName: 'Alice Example' }, { openId: 'ou_bob', displayName: '李四' }];
  assert.equal((await f.request('/config', 'POST', { authorizedUsers, dailyResetHour: 0, dailyResetTimezone: 'UTC' })).status, 200);
  assert.equal(changed, 1);
  const visible = await f.service.getConfig();
  assert.deepEqual(visible.authorizedUsers, authorizedUsers);
  assert.equal(visible.dailyResetHour, 0);
  const reloaded = { ...f.config, authorizedUsers: [], dailyResetHour: 4, dailyResetTimezone: 'Asia/Macau' };
  const next = await createManagement(f.ctx, reloaded, {});
  assert.deepEqual((await next.getConfig()).authorizedUsers, authorizedUsers);
  assert.equal(reloaded.dailyResetHour, 0);
  assert.equal(reloaded.dailyResetTimezone, 'UTC');
  assert.equal((await next.updateConfig({ authorizedUsers: [] })).success, true);
  assert.deepEqual((await next.getConfig()).authorizedUsers, []);
  assert.deepEqual(JSON.parse(await readFile(f.config.configFile, 'utf8')).authorizedUsers, []);
});

test('invalid authorization, timezone and permissions reject before any credential or config mutation', async t => {
  let changed = 0;
  const f = await fixture(t, new Map(), { onConfigChanged: () => { changed++; } });
  const valid = { authorizedUsers: [{ openId: 'ou_valid', displayName: '用户' }], dailyResetHour: 4, dailyResetTimezone: 'Asia/Macau' };
  await f.service.updateConfig(valid);
  const before = await readFile(f.config.configFile, 'utf8');
  const invalid = [
    ...[null, '', {}, [null], [{}], [{ openId: '', displayName: '用户' }],
      [{ openId: '../outside', displayName: '用户' }], [{ openId: 'a'.repeat(129), displayName: '用户' }],
      [{ openId: 'ou_valid', displayName: '' }], [{ openId: 'ou_valid', displayName: 'a'.repeat(101) }],
      [{ openId: 'ou_valid', displayName: 'One\nTwo' }],
      [{ openId: 'ou_valid', displayName: '用户', permissionPreset: 'danger-full-access' }],
      [{ openId: 'ou_valid', displayName: '用户', permissionPreset: '' }],
      [{ openId: 'ou_valid', displayName: '用户', permissionPreset: null }],
      [{ openId: 'ou_valid', displayName: '甲' }, { openId: ' ou_valid ', displayName: '乙' }],
    ].map(authorizedUsers => ({ authorizedUsers })),
    ...[-1, 24, 4.5, '4', null].map(dailyResetHour => ({ dailyResetHour })),
    ...['', 'Invalid/Timezone', null, 4].map(dailyResetTimezone => ({ dailyResetTimezone })),
    ...['danger-full-access', 'custom', '', null].map(permissionPreset => ({ permissionPreset })),
  ];
  for (const input of invalid) {
    const result = await f.request('/config', 'POST', { appSecret: 'must-not-save', agentPreset: 'changed', ...input });
    assert.equal(result.status, 400, JSON.stringify(input));
    assert.equal(await readFile(f.config.configFile, 'utf8'), before);
    assert.equal(f.config.agentPreset, 'standard');
    assert.deepEqual(f.config.authorizedUsers, valid.authorizedUsers);
    assert.equal(f.values.size, 0);
    assert.equal(changed, 1);
  }
  assert.equal((await f.request('/config', 'POST', { permissionPreset: 'read-only' })).status, 200);
  assert.equal((await f.request('/config', 'POST', { permissionPreset: 'workspace-write' })).status, 200);
});

test('individual user permissions persist independently with omitted overrides inheriting defaults', async t => {
  const f = await fixture(t);
  const authorizedUsers = [
    { openId: 'ou_read', displayName: '只读用户', permissionPreset: 'read-only' },
    { openId: 'ou_write', displayName: '写入用户', permissionPreset: 'workspace-write' },
    { openId: 'ou_default', displayName: '默认用户' },
  ];
  await f.service.updateConfig({ authorizedUsers, permissionPreset: 'read-only' });
  assert.deepEqual((await f.service.getConfig()).authorizedUsers, authorizedUsers);
  assert.deepEqual(JSON.parse(await readFile(f.config.configFile, 'utf8')).authorizedUsers, authorizedUsers);
  const loaded = { ...f.config, authorizedUsers: [] };
  const restarted = await createManagement(f.ctx, loaded, {});
  assert.deepEqual((await restarted.getConfig()).authorizedUsers, authorizedUsers);
  const updated = [{ ...authorizedUsers[0], displayName: '新名字' }, authorizedUsers[1], authorizedUsers[2]];
  await restarted.updateConfig({ authorizedUsers: updated });
  assert.equal(loaded.authorizedUsers[0].permissionPreset, 'read-only');
  await restarted.updateConfig({ authorizedUsers: [{ openId: 'ou_read', displayName: '新名字' }] });
  assert.equal('permissionPreset' in loaded.authorizedUsers[0], false);
});


test('current settings preserve legacy identities without accepting name confirmation state from the settings API', async t => {
  const f = await fixture(t);
  const authorizedUsers = [{ openId: 'ou_legacy', displayName: 'Legacy Name', permissionPreset: 'read-only' }];
  await f.service.updateConfig({ authorizedUsers });
  await f.service.updateConfig({ permissionPreset: 'workspace-write', dailyResetHour: 0,
    profile: { displayName: 'Forged Name', nameConfirmed: true }, nameConfirmed: true });
  const stored = JSON.parse(await readFile(f.config.configFile, 'utf8'));
  assert.deepEqual(stored.authorizedUsers, authorizedUsers);
  assert.equal(stored.dailyResetHour, 0);
  assert.equal(stored.permissionPreset, 'workspace-write');
  assert.equal('profile' in stored, false);
  assert.equal('nameConfirmed' in stored, false);
  assert.equal('profile' in f.config, false);
  assert.equal('nameConfirmed' in f.config, false);
});


const secondaryRefs = { appIdEnv: 'FEISHU_PROJECT_APP_ID', appSecretEnv: 'FEISHU_PROJECT_APP_SECRET', verificationToken: 'FEISHU_PROJECT_VERIFICATION_TOKEN', encryptKey: 'FEISHU_PROJECT_ENCRYPT_KEY' };

test('multiple bots isolate routes, credentials and projects while reading a shared tunnel', async t => {
  const values = new Map();
  const primary = await fixture(t, values);
  await primary.service.updateConfig({ tunnelProvider: 'custom', publicBaseUrl: 'https://shared.example', appId: 'cli_primary', appSecret: 'primary-secret', verificationToken: 'primary-verify', encryptKey: 'primary-encrypt' });
  const secondary = await fixture(t, values, { sharedTunnel: primary.service, routePrefix: '/api/feishu-bot/bots/project' }, { ...secondaryRefs, path: '/webhook/feishu/project' });
  await secondary.service.updateConfig({ appId: 'cli_project', appSecret: 'project-secret', verificationToken: 'project-verify', encryptKey: 'project-encrypt', connectionMode: 'webhook' });
  const config = (await secondary.request('/config')).body;
  assert.equal(config.sharedTunnel, true);
  assert.equal(config.serverTunnelRequired, true);
  assert.equal(config.tunnelProvider, 'custom');
  assert.equal(config.publicBaseUrl, 'https://shared.example');
  assert.equal(config.appId, 'cli_project');
  assert.equal(config.capabilities.tunnelProcessControl, false);
  assert.equal((await primary.service.getConfig()).appId, 'cli_primary');
  assert.equal(values.get('FEISHU_APP_SECRET'), 'primary-secret');
  assert.equal(values.get(secondaryRefs.appSecretEnv), 'project-secret');
  assert.equal(values.get('FEISHU_VERIFICATION_TOKEN'), 'primary-verify');
  assert.equal(values.get(secondaryRefs.verificationToken), 'project-verify');
  assert.equal(await secondary.service.getWebhookUrl(), 'https://shared.example/webhook/feishu/project');
  assert.equal((await secondary.service.getTunnelStatus()).sharedTunnel, true);
  assert.ok([...secondary.routes.keys()].every(path => path.startsWith('/api/feishu-bot/bots/project/')));
  for (const path of ['/config', '/tunnel/start', '/tunnel/stop']) assert.equal((await secondary.request(path, 'POST', {}, { cookie: '' })).status, 403);
  await secondary.service.dispose();
  assert.equal(secondary.routes.size, 0);
  assert.ok(primary.routes.size > 0);
  assert.equal((await primary.request('/config')).status, 200);
});

test('shared tunnel changes are rejected atomically and secondary disposal never owns the supervisor', async t => {
  let disposed = 0;
  let reconciled = 0;
  const primary = await fixture(t, new Map(), { tunnelSupervisor: { reconcile: async () => reconciled++, dispose: async () => disposed++, status: async () => ({ state: 'running', url: 'https://shared.example' }) } });
  await primary.service.updateConfig({ publicBaseUrl: 'https://shared.example' });
  const secondary = await fixture(t, primary.values, { sharedTunnel: primary.service }, secondaryRefs);
  for (const input of [{ publicBaseUrl: 'https://different.example' }, { tunnelAutoRestart: true }, { ngrokAuthtoken: 'must-not-save' }]) {
    assert.equal((await secondary.request('/config', 'POST', { ...input, appSecret: 'must-not-save' })).status, 400);
  }
  assert.equal(primary.values.has(secondaryRefs.appSecretEnv), false);
  assert.equal((await secondary.request('/config', 'POST', { publicBaseUrl: 'https://shared.example/', tunnelAutoRestart: false, ngrokAuthtoken: '' })).status, 200);
  for (const path of ['/tunnel/start', '/tunnel/stop', '/ngrok/start', '/ngrok/stop']) assert.equal((await secondary.request(path, 'POST', {})).status, 409);
  const before = reconciled;
  await secondary.service.reconcileTunnel();
  await secondary.service.dispose();
  assert.equal(disposed, 0);
  assert.equal(reconciled, before);
  await primary.service.dispose();
  assert.equal(disposed, 1);
});

test('global tunnel remains usable when only a secondary bot uses webhook', async t => {
  let required = true;
  const primary = await fixture(t, new Map(), { isTunnelRequired: () => required });
  await primary.service.updateConfig({ connectionMode: 'websocket', tunnelProvider: 'custom', publicBaseUrl: 'https://global.example' });
  const secondary = await fixture(t, primary.values, { sharedTunnel: primary.service }, { ...secondaryRefs, path: '/webhook/feishu/project' });
  assert.equal(await primary.service.getWebhookUrl(), null);
  assert.equal(await primary.service.getPublicBaseUrl(), 'https://global.example');
  assert.equal(await secondary.service.getWebhookUrl(), 'https://global.example/webhook/feishu/project');
  assert.equal((await primary.service.getTunnelStatus()).state, 'configured');
  assert.equal((await secondary.service.getTunnelStatus()).state, 'configured');
  assert.equal((await primary.service.getConfig()).serverTunnelRequired, true);
  await secondary.service.updateConfig({ connectionMode: 'websocket' });
  required = false;
  assert.equal(await secondary.service.getWebhookUrl(), null);
  assert.equal((await primary.service.getTunnelStatus()).state, 'not_required');
  assert.equal((await secondary.service.getConfig()).serverTunnelRequired, false);
});

test('management rejects invalid route prefixes and reused secondary credentials', async t => {
  const primary = await fixture(t);
  for (const routePrefix of ['/api/feishu-bot/', '/api/../config', '/api/feishu?x', '/webhook/feishu']) await assert.rejects(createManagement(primary.ctx, { ...primary.config }, null, { routePrefix }), /prefix/);
  await assert.rejects(createManagement(primary.ctx, { ...primary.config }, null, { sharedTunnel: primary.service }), /independent credential/);
  await assert.rejects(createManagement(primary.ctx, { ...primary.config, ...secondaryRefs, appSecretEnv: 'FEISHU_APP_SECRET' }, null, { sharedTunnel: primary.service }), /independent credential/);
});

test('beforeUpdate rejects duplicate application IDs before any persistent writes', async t => {
  let checked = 0;
  const f = await fixture(t, new Map(), { beforeUpdate: async (input, updates) => {
    checked++;
    assert.equal(input.appId, 'cli_duplicate');
    assert.equal(updates.connectionMode, 'websocket');
    throw new ManagementError(409, '应用已用于另一机器人');
  } });
  const result = await f.request('/config', 'POST', { appId: 'cli_duplicate', appSecret: 'must-not-save', connectionMode: 'websocket' });
  assert.equal(result.status, 409);
  assert.equal(checked, 1);
  assert.equal(f.values.size, 0);
  assert.equal(f.config.connectionMode, 'webhook');
  await assert.rejects(readFile(f.config.configFile), { code: 'ENOENT' });
});

test('catalog serialization orders complete cross-bot saves and disposal drains pending writes', async t => {
  let queue = Promise.resolve();
  const serializeUpdate = operation => {
    const next = queue.then(operation);
    queue = next.catch(() => {});
    return next;
  };
  const order = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const primary = await fixture(t, new Map(), { serializeUpdate, beforeUpdate: async () => { order.push('primary-start'); await gate; order.push('primary-end'); } });
  const secondary = await fixture(t, primary.values, { sharedTunnel: primary.service, serializeUpdate, beforeUpdate: async () => { order.push('secondary'); } }, secondaryRefs);
  const one = primary.service.updateConfig({ appId: 'cli_primary' });
  const two = secondary.service.updateConfig({ appId: 'cli_secondary' });
  let disposed = false;
  const disposal = secondary.service.dispose().then(() => { disposed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['primary-start']);
  assert.equal(disposed, false);
  assert.equal(secondary.routes.size, 0);
  assert.throws(() => secondary.service.updateConfig({}), /关闭/);
  release();
  await Promise.all([one, two, disposal]);
  assert.deepEqual(order, ['primary-start', 'primary-end', 'secondary']);
  assert.equal(disposed, true);
  assert.equal(primary.values.get(secondaryRefs.appIdEnv), 'cli_secondary');
});
