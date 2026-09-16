import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createManagement } from '../lib/management.js';

async function fixture(t, values = new Map(), hooks = {}) {
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
  const config = { configFile: join(dir, 'settings.json'), path: '/webhook/feishu', workspacePath: dir, agentPreset: 'standard', permissionPreset: 'workspace-write' };
  const client = { cachedToken: 'old-token', tokenExpireTime: 999999 };
  const service = await createManagement(ctx, config, client, hooks);
  const request = async (path, method = 'GET', body, headers = {}) => {
    const req = Readable.from(body === undefined ? [] : [typeof body === 'string' ? body : JSON.stringify(body)]);
    req.method = method;
    req.headers = { host: 'localhost:3080', cookie: 'authenticated', 'content-type': 'application/json', ...headers };
    let result;
    const res = { setHeader() {}, writeHead(status) { this.status = status; }, end(text) { result = { status: this.status, body: JSON.parse(text) }; } };
    await routes.get(`/api/feishu-bot${path}`)(req, res);
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
  for (const path of ['/config', '/test', '/ngrok/start', '/ngrok/stop', '/ngrok/status', '/tunnel/status', '/webhook-url', '/connection/status']) {
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
    assert.equal((await f.request('/tunnel/status')).body.state, 'unconfigured');
    assert.equal((await f.request('/config', 'POST', { publicBaseUrl: 'https://tunnel.example/' })).status, 200);
    const status = (await f.request('/tunnel/status')).body;
    assert.equal(status.provider, provider);
    assert.equal(status.state, 'configured');
    assert.equal(status.running, null);
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

test('ngrok reports only real matching tunnels and external process control fails explicitly', async t => {
  const f = await fixture(t);
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ tunnels: [
    { public_url: 'https://wrong.example.com', config: { addr: 'http://localhost:9000' } },
    { public_url: 'https://right.example.com', config: { addr: 'http://localhost:3080' } },
  ] }) }));
  assert.equal((await f.service.getNgrokStatus()).url, 'https://right.example.com');
  assert.equal(await f.service.getWebhookUrl(), 'https://right.example.com/webhook/feishu');
  assert.equal((await f.service.startNgrok()).success, false);
  assert.equal((await f.service.stopNgrok()).success, false);
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
