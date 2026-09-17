import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkSetup, repairSetup } from '../lib/setup-check.js';

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'feishu-setup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const saved = { workspacePath: directory, agentPreset: 'standard', permissionPreset: 'workspace-write', connectionMode: 'webhook', tunnelProvider: 'ngrok', configured: { appId: true, appSecret: true, verificationToken: true }, ...overrides };
  const calls = [];
  const input = {
    ctx: { agentPresets: { resolve: async id => ({ id }) }, agentDefaultModel: { currentSelection: () => ({ provider: 'example', model: 'test' }) }, web: { search: () => { throw new Error('must not issue a paid search'); } } },
    config: {},
    service: {
      getConfig: async () => saved,
      testConnection: async () => { calls.push('authenticate'); return { success: true }; },
      getTunnelStatus: async () => ({ running: true, managed: false, state: 'external' }),
      getWebhookUrl: async () => 'https://bot.example/webhook/feishu',
      startTunnel: async () => { calls.push('start'); return { success: true, status: { managed: true, state: 'starting' } }; },
    },
    getConnectionStatus: () => ({ state: 'listening' }),
    now: () => new Date('2026-09-17T00:00:00Z'),
  };
  return { input, saved, calls };
}
const row = (report, id) => report.checks.find(item => item.id === id);

test('setup reports evidence limits and required manual acceptance even with healthy local services', async t => {
  const { input, calls } = await fixture(t);
  const report = await checkSetup(input);
  assert.equal(report.ready, false);
  assert.equal(report.checkedAt, '2026-09-17T00:00:00.000Z');
  assert.equal(row(report, 'credentials').state, 'ok');
  assert.equal(row(report, 'workspace').state, 'ok');
  assert.equal(row(report, 'agent').state, 'ok');
  assert.equal(row(report, 'model').state, 'warning');
  assert.equal(row(report, 'search').state, 'warning');
  assert.match(row(report, 'connection').message, /不代表/);
  assert.match(row(report, 'callback').message, /不代表/);
  for (const id of ['botCapability', 'events', 'publish', 'acceptance']) assert.equal(row(report, id).state, 'action');
  assert.deepEqual(calls, ['authenticate']);
});

test('long connection skips tunnel and webhook credentials without a public URL', async t => {
  const { input, calls } = await fixture(t, { connectionMode: 'websocket', configured: {} });
  input.getConnectionStatus = () => ({ state: 'connected' });
  input.service.getTunnelStatus = input.service.getWebhookUrl = () => { throw new Error('must not inspect tunnels'); };
  const report = await repairSetup(input);
  assert.equal(row(report, 'connection').state, 'ok');
  assert.equal(row(report, 'tunnel').state, 'ok');
  assert.equal(row(report, 'webhookSecurity'), undefined);
  assert.equal(report.callbackUrl, undefined);
  assert.deepEqual(calls, []);
  assert.equal(report.ready, false);
});

test('missing directory remains absent and provider errors or unsafe URLs never enter reports', async t => {
  const { input, saved } = await fixture(t);
  saved.workspacePath = join(saved.workspacePath, 'never-create-me');
  input.service.testConnection = async () => { throw new Error('secret-provider-payload'); };
  input.ctx.agentPresets.resolve = async () => { throw new Error('secret-provider-payload'); };
  input.getConnectionStatus = () => ({ state: 'error', message: 'secret-provider-payload' });
  input.service.getTunnelStatus = async () => ({ state: 'error', message: 'secret-provider-payload' });
  input.service.getWebhookUrl = async () => 'https://user:secret-provider-payload@bot.example/webhook';
  const report = await checkSetup(input);
  assert.equal(row(report, 'workspace').state, 'error');
  assert.equal(row(report, 'credentials').state, 'error');
  assert.equal(row(report, 'agent').state, 'error');
  assert.equal(report.callbackUrl, undefined);
  assert.ok(!JSON.stringify(report).includes('secret-provider-payload'));
  const { stat } = await import('node:fs/promises');
  await assert.rejects(stat(saved.workspacePath), { code: 'ENOENT' });
});

test('repairs only request an idle selected managed tunnel and preserve other settings', async t => {
  const { input, saved, calls } = await fixture(t);
  const before = JSON.stringify(saved);
  input.service.getTunnelStatus = async () => ({ running: false, managed: false, state: 'idle' });
  const report = await repairSetup(input);
  assert.deepEqual(report.repaired, ['tunnel-start-requested']);
  assert.deepEqual(calls, ['start', 'authenticate']);
  assert.equal(JSON.stringify(saved), before);
  assert.equal(report.ready, false);
});

test('repairs do not duplicate managed, external, starting or unknown tunnels', async t => {
  const { input, calls } = await fixture(t);
  for (const status of [{ state: 'external' }, { running: true }, { managed: true, state: 'backoff' }, { state: 'starting' }, { unknown: true }, { state: 'error' }]) {
    input.service.getTunnelStatus = async () => status;
    assert.deepEqual((await repairSetup(input)).repaired, []);
  }
  assert.ok(!calls.includes('start'));
});

test('repairs leave shared, custom and incomplete fixed Cloudflare configurations untouched', async t => {
  for (const override of [{ sharedTunnel: true }, { tunnelProvider: 'custom' }, { tunnelProvider: 'cloudflare', cloudflareMode: 'named' }]) {
    const { input, calls } = await fixture(t, override);
    input.service.getTunnelStatus = async () => ({ state: 'idle' });
    const report = await repairSetup(input);
    assert.deepEqual(report.repaired, []);
    assert.ok(!calls.includes('start'));
  }
});

test('start failures are sanitized and never reported as a repair success', async t => {
  const { input } = await fixture(t);
  input.service.getTunnelStatus = async () => ({ state: 'idle' });
  input.service.startTunnel = async () => { throw new Error('secret-command-env'); };
  const report = await repairSetup(input);
  assert.equal(row(report, 'repair').state, 'error');
  assert.deepEqual(report.repaired, []);
  assert.ok(!JSON.stringify(report).includes('secret-command-env'));
});

test('encrypted signed events do not require a separate verification token', async t => {
  const { input, saved } = await fixture(t);
  saved.configured.verificationToken = false;
  saved.configured.encryptKey = true;
  const report = await checkSetup(input);
  assert.equal(row(report, 'webhookSecurity').state, 'ok');
  assert.match(row(report, 'webhookSecurity').message, /签名/);
  saved.configured.encryptKey = false;
  assert.equal(row(await checkSetup(input), 'webhookSecurity').state, 'action');
});

test('a resolvable but broken Harness preset does not pass readiness checking', async t => {
  const { input } = await fixture(t);
  input.ctx.agentPresets.resolve = async id => ({ id, broken: 'provider diagnostic must remain private' });
  const report = await checkSetup(input);
  assert.equal(row(report, 'agent').state, 'error');
  assert.ok(!JSON.stringify(report).includes('provider diagnostic'));
});

test('explicit repair restarts a manually stopped supervisor without changing guardian preference', async t => {
  const { input, saved, calls } = await fixture(t);
  saved.tunnelAutoRestart = false;
  // stop() confirms process termination before clearing ownership. Its actual
  // snapshot is idle/paused/managed:false, never managed:true and stopped.
  input.service.getTunnelStatus = async () => ({ state: 'idle', paused: true, managed: false, running: false });
  const report = await repairSetup(input);
  assert.deepEqual(report.repaired, ['tunnel-start-requested']);
  assert.ok(calls.includes('start'));
  assert.equal(saved.tunnelAutoRestart, false);
});

test('default websocket bot can repair the shared tunnel required by other webhook bots', async t => {
  const { input, calls } = await fixture(t, { connectionMode: 'websocket', serverTunnelRequired: true });
  input.getConnectionStatus = () => ({ state: 'connected' });
  input.service.getTunnelStatus = async () => ({ state: 'idle', managed: false, running: false });
  input.service.getWebhookUrl = () => { throw new Error('current websocket bot has no callback'); };
  const report = await repairSetup(input);
  assert.ok(calls.includes('start'));
  assert.deepEqual(report.repaired, ['tunnel-start-requested']);
  assert.equal(row(report, 'connection').state, 'ok');
  assert.match(row(report, 'tunnel').message, /其他机器人/);
  assert.equal(report.callbackUrl, undefined);
  assert.equal(row(report, 'webhookSecurity'), undefined);
});

test('websocket bot without shared tunnel demand does not inspect or start tunnels', async t => {
  const { input, calls } = await fixture(t, { connectionMode: 'websocket', serverTunnelRequired: false });
  input.service.getTunnelStatus = () => { throw new Error('no tunnel inspection expected'); };
  input.service.getWebhookUrl = () => { throw new Error('no webhook URL expected'); };
  const report = await repairSetup(input);
  assert.ok(!calls.includes('start'));
  assert.deepEqual(report.repaired, []);
  assert.equal(row(report, 'tunnel').state, 'ok');
});
