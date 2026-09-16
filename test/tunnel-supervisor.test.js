import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import { createTunnelSupervisor } from '../lib/tunnel-supervisor.js';

function fixture(overrides = {}, options = {}) {
  let time = 10000, port = 4321, detection = { running: false }, calls = [];
  const config = { connectionMode: 'webhook', tunnelProvider: 'ngrok', tunnelAutoRestart: false, publicBaseUrl: 'https://example.ngrok.app', ...overrides };
  const handles = new Map();
  const instance = createTunnelSupervisor({ config, getPort: () => port, resolveNgrokToken: async () => 'private-token', detectNgrok: async () => detection }, {
    homedir: path.join(tmpdir(), 'no-policy-fixture-home'), now: () => time,
    setTimeout(fn, delay) { const handle = {}; handles.set(handle, { fn, at: time + delay }); return handle; },
    clearTimeout(handle) { handles.delete(handle); },
    spawn(command, args, spawnOptions) {
      const child = new EventEmitter(); child.pid = calls.length + 100; child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = signal => { child.signalCode = signal; child.emit('exit', null, signal); child.emit('close', null, signal); return true; };
      calls.push({ command, args, options: spawnOptions, child }); return child;
    }, ...options,
  });
  return { instance, config, calls, handles, setPort: value => { port = value; }, detect: value => { detection = value; },
    advance: value => { time += value; },
    async tick(value = 5000) { time += value; const due = [...handles].filter(([, timer]) => timer.at <= time); for (const [id, timer] of due) { handles.delete(id); timer.fn(); } await instance.reconcile(); },
  };
}

test('native Linux, macOS and Windows argv uses current Harness port and credentials only in env', async t => {
  for (const platform of ['linux', 'darwin', 'win32']) await t.test(platform, async () => {
    const f = fixture({}, { platform });
    const result = await f.instance.start();
    assert.equal(result.state, 'starting'); assert.equal(result.running, false);
    assert.equal(f.calls[0].command, platform === 'win32' ? 'ngrok.exe' : 'ngrok');
    assert.deepEqual(f.calls[0].args, ['http', 'http://127.0.0.1:4321', '--url', 'https://example.ngrok.app', '--log', 'stdout', '--log-format', 'json']);
    assert.equal(f.calls[0].options.shell, false); assert.equal(f.calls[0].options.windowsHide, true);
    assert.equal(f.calls[0].options.env.NGROK_AUTHTOKEN, 'private-token');
    assert.ok(!JSON.stringify(result).includes('private-token'));
    await f.instance.dispose();
  });
});

test('simultaneous starts do not duplicate child and live process is not reported connected without readiness', async () => {
  const f = fixture(); await Promise.all([f.instance.start(), f.instance.start()]);
  assert.equal(f.calls.length, 1); assert.equal((await f.instance.status()).running, false);
  f.detect({ running: true, url: 'https://example.ngrok.app' });
  assert.equal((await f.instance.status()).state, 'running');
  await f.instance.dispose(); assert.equal(f.handles.size, 0);
});

test('external ngrok is shown even with guardian off, never killed, and auto guardian takes over after disappearance', async () => {
  const f = fixture(); f.detect({ running: true, reachable: true, url: 'https://example.ngrok.app' });
  assert.equal((await f.instance.status()).state, 'external'); await f.instance.start(); assert.equal(f.calls.length, 0);
  await f.instance.stop(); assert.equal((await f.instance.status()).state, 'external');
  f.config.tunnelAutoRestart = true; await f.instance.reconcile();
  f.detect({ running: false, reachable: false }); await f.tick(); assert.equal(f.calls.length, 1);
  await f.instance.dispose();
});

test('ambiguous or occupied ngrok inspection does not spawn or reveal error secrets', async () => {
  for (const detection of [{ unknown: true }, { running: false, reachable: true }, { running: true, url: 'https://other.ngrok.app' }]) {
    const f = fixture(); f.detect(detection); const status = await f.instance.start();
    assert.equal(status.state, 'error'); assert.equal(f.calls.length, 0); await f.instance.dispose();
  }
  const f = fixture({}, { spawn() { throw new Error('private-token malicious stderr'); } });
  const status = await f.instance.start(); assert.equal(status.state, 'error'); assert.ok(!JSON.stringify(status).includes('private-token'));
  await f.instance.dispose();
});

test('external ngrok status stops claiming readiness when inspection becomes unknown', async () => {
  const f = fixture(); f.detect({ running: true, url: 'https://example.ngrok.app' });
  assert.equal((await f.instance.status()).running, true);
  f.detect({ unknown: true });
  const status = await f.instance.status();
  assert.equal(status.state, 'error'); assert.equal(status.running, false); assert.equal(status.url, null);
  assert.equal(f.calls.length, 0);
  f.detect({ running: true, url: 'https://example.ngrok.app' });
  assert.equal((await f.instance.status()).state, 'external');
  await f.instance.dispose();
});

test('Cloudflare quick readiness accepts registration before the URL log', async () => {
  const f = fixture({ tunnelProvider: 'cloudflare' }); await f.instance.start();
  f.calls[0].child.stderr.write('INF Registered tunnel connection connIndex=0\n');
  assert.equal((await f.instance.status()).running, false);
  f.calls[0].child.stdout.write('https://late-url.trycloudflare.com\n');
  assert.equal((await f.instance.status()).running, true);
  await f.instance.dispose();
});

test('unexpected exits back off exponentially; disabling guardian cancels retry but preserves live child', async () => {
  const f = fixture({ tunnelAutoRestart: true }); await f.instance.reconcile();
  f.calls[0].child.emit('close', 1); let status = await f.instance.status();
  assert.equal(status.state, 'backoff'); assert.equal(status.nextRetryAt, 11000);
  f.advance(1000); await f.instance.reconcile(); assert.equal(f.calls.length, 2);
  f.config.tunnelAutoRestart = false; await f.instance.reconcile(); assert.equal((await f.instance.status()).managed, true);
  f.calls[1].child.emit('close', 1); status = await f.instance.status(); assert.equal(status.nextRetryAt, null);
  f.advance(60000); await f.instance.reconcile(); assert.equal(f.calls.length, 2); await f.instance.dispose();
});

test('manual stop pauses guardian, unrelated config keeps pause and off-on resumes', async () => {
  const f = fixture({ tunnelAutoRestart: true }); await f.instance.start();
  assert.equal((await f.instance.stop()).paused, true);
  f.config.agentPreset = 'other'; await f.tick(); assert.equal(f.calls.length, 1);
  f.config.tunnelAutoRestart = false; await f.instance.reconcile(); f.config.tunnelAutoRestart = true; await f.instance.reconcile();
  assert.equal(f.calls.length, 2); await f.instance.dispose();
});

test('provider, mode and port changes stop only owned child and use fresh configuration', async () => {
  const f = fixture({ tunnelAutoRestart: true }); await f.instance.start();
  f.setPort(7777); await f.instance.reconcile(); assert.equal(f.calls.length, 2); assert.ok(f.calls[0].child.signalCode);
  assert.ok(f.calls[1].args.includes('http://127.0.0.1:7777'));
  f.config.tunnelProvider = 'cloudflare'; await f.instance.reconcile(); assert.equal(f.calls[2].command, 'cloudflared');
  f.config.connectionMode = 'websocket'; await f.instance.reconcile(); assert.equal((await f.instance.status()).state, 'not_required');
  assert.ok(f.calls[2].child.signalCode); await f.instance.dispose();
});

test('Cloudflare quick URL is parsed but readiness waits for registration, disconnect and timeout retry', async () => {
  const f = fixture({ tunnelProvider: 'cloudflare', tunnelAutoRestart: true }, { healthTimeoutMs: 10000 }); await f.instance.start();
  const process = f.calls[0].child;
  process.stderr.write('https://unit-test.trycloudflare.com\n'); assert.equal((await f.instance.status()).running, false);
  process.stderr.write('INF Registered tunnel connection connIndex=0\n'); assert.equal((await f.instance.status()).running, true);
  assert.equal((await f.instance.status()).url, 'https://unit-test.trycloudflare.com');
  assert.equal(f.config.publicBaseUrl, 'https://example.ngrok.app');
  process.stderr.write('ERR Connection terminated connIndex=0\n'); assert.equal((await f.instance.status()).running, false);
  f.advance(10001); assert.equal((await f.instance.status()).state, 'backoff'); assert.ok(process.signalCode);
  await f.instance.dispose();
});

test('Cloudflare named tunnel copies policy privately, adjusts matching localhost service only, cleans up', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'supervisor-test-'));
  try {
    const source = path.join(directory, 'cloudflare.yml');
    const original = { tunnel: 'local-id', 'credentials-file': './credentials.json', ingress: [
      { hostname: 'feishu.example.com', service: 'http://localhost:80', originRequest: { connectTimeout: '30s', access: { required: true } } },
      { hostname: 'another.example.com', service: 'http://localhost:9000' }, { service: 'http_status:404' },
    ] };
    await writeFile(source, yaml.dump(original)); await writeFile(path.join(directory, 'credentials.json'), '{}');
    const f = fixture({ tunnelProvider: 'cloudflare', cloudflareMode: 'named', cloudflareTunnelName: 'local-id', cloudflareConfigFile: source, publicBaseUrl: 'https://feishu.example.com' });
    const status = await f.instance.start(); assert.equal(status.state, 'starting');
    const generated = f.calls[0].args[f.calls[0].args.indexOf('--config') + 1]; const copy = yaml.load(await readFile(generated, 'utf8'));
    assert.equal(copy.ingress[0].service, 'http://127.0.0.1:4321'); assert.deepEqual(copy.ingress[0].originRequest, original.ingress[0].originRequest);
    assert.deepEqual(copy.ingress[1], original.ingress[1]); assert.equal(copy['credentials-file'], path.join(directory, 'credentials.json'));
    assert.deepEqual(yaml.load(await readFile(source, 'utf8')), original);
    if (process.platform !== 'win32') assert.equal((await stat(generated)).mode & 0o777, 0o600);
    await f.instance.dispose(); await assert.rejects(stat(generated), { code: 'ENOENT' });
    original.ingress[0].service = 'http://remote.example.com:80'; await writeFile(source, yaml.dump(original));
    const bad = fixture({ tunnelProvider: 'cloudflare', cloudflareMode: 'named', cloudflareTunnelName: 'local-id', cloudflareConfigFile: source, publicBaseUrl: 'https://feishu.example.com' });
    assert.equal((await bad.instance.start()).state, 'error'); assert.equal(bad.calls.length, 0); await bad.instance.dispose();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('ngrok policy is reused without modification and shell shims are rejected', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'supervisor-policy-'));
  try {
    await mkdir(path.join(directory, '.config', 'ngrok'), { recursive: true });
    const policy = path.join(directory, '.config', 'ngrok', 'policy.yaml'); await writeFile(policy, 'original-policy');
    const f = fixture({}, { homedir: directory }); await f.instance.start(); assert.deepEqual(f.calls[0].args.slice(4, 6), ['--traffic-policy-file', policy]);
    assert.equal(await readFile(policy, 'utf8'), 'original-policy'); await f.instance.dispose();
    const bad = fixture({ ngrokExecutablePath: 'C:\\ngrok.cmd' }, { platform: 'win32' }); assert.equal((await bad.instance.start()).state, 'error'); assert.equal(bad.calls.length, 0); await bad.instance.dispose();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('dispose during async inspection cannot spawn afterwards', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; }); let spawned = false;
  const f = createTunnelSupervisor({ config: {}, getPort: () => 3080, detectNgrok: () => pending }, { spawn() { spawned = true; }, detectionTimeoutMs: 20 });
  const started = f.start(); await Promise.resolve(); const stopped = f.dispose(); release({ running: false });
  await started; await stopped; assert.equal(spawned, false);
});

test('ngrok stale local endpoint is not ready while agent reports disconnected', async () => {
  const f = fixture({ tunnelAutoRestart: true }, { healthTimeoutMs: 10000 }); await f.instance.start();
  f.detect({ running: true, url: 'https://example.ngrok.app' }); assert.equal((await f.instance.status()).running, true);
  f.calls[0].child.stdout.write(JSON.stringify({ msg: 'failed to reconnect session', err: 'secret-auth-token' }) + '\n');
  assert.equal((await f.instance.status()).running, false);
  f.advance(10001); assert.equal((await f.instance.status()).state, 'backoff');
  assert.ok(!JSON.stringify(await f.instance.status()).includes('secret-auth-token')); await f.instance.dispose();
});

test('repeated status polling does not postpone existing guardian timer', async () => {
  const f = fixture({ tunnelAutoRestart: true }); await f.instance.start();
  const first = [...f.handles.keys()][0]; f.advance(10); await f.instance.status();
  assert.equal([...f.handles.keys()][0], first); await f.instance.dispose();
});

test('native executable with spaces is passed intact and malformed public URLs do not spawn', async () => {
  const good = fixture({ ngrokExecutablePath: 'C:\\Program Files\\ngrok\\ngrok.exe' }, { platform: 'win32' });
  await good.instance.start(); assert.equal(good.calls[0].command, 'C:\\Program Files\\ngrok\\ngrok.exe'); await good.instance.dispose();
  for (const value of ['http://example.com', 'https://user:secret@example.com', 'https://example.com/webhook/feishu', 'https://example.com?token=secret']) {
    const f = fixture({ publicBaseUrl: value }); assert.equal((await f.instance.start()).state, 'error'); assert.equal(f.calls.length, 0); await f.instance.dispose();
  }
});

test('dispose waits for close and rejects safely if child cannot be stopped', async () => {
  let child;
  const supervisor = createTunnelSupervisor({ config: {}, getPort: () => 4321 }, {
    shutdownTimeoutMs: 5,
    spawn() { child = new EventEmitter(); child.pid = 1; child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => false; return child; },
  });
  await supervisor.start();
  await assert.rejects(supervisor.dispose(), /无法确认托管隧道已停止/);
  child.emit('close', 0);
  await supervisor.dispose();
});

test('normal reconcile with guardian off performs no external inspection', async () => {
  let count = 0;
  const supervisor = createTunnelSupervisor({ config: {}, getPort: () => 4321, detectNgrok: async () => { count++; return { running: false }; } });
  await supervisor.reconcile(); assert.equal(count, 0); await supervisor.status(); assert.equal(count, 1); await supervisor.reconcile(); assert.equal(count, 1);
  await supervisor.dispose();
});

test('configuration changed while resolving credentials does not launch stale provider or port', async () => {
  let release, entered;
  const pending = new Promise(resolve => { release = resolve; });
  const startedResolve = new Promise(resolve => { entered = resolve; });
  const config = { connectionMode: 'webhook', tunnelProvider: 'ngrok' }; let spawned = false;
  const supervisor = createTunnelSupervisor({ config, getPort: () => 4321, resolveNgrokToken: async () => { entered(); await pending; return 'secret'; } }, { spawn() { spawned = true; } });
  const first = supervisor.start(); await startedResolve; config.tunnelProvider = 'custom'; release(); await first;
  assert.equal(spawned, false); assert.equal((await supervisor.status()).state, 'unsupported'); await supervisor.dispose();
});

test('saving the generated Quick Tunnel URL or other provider settings preserves the running child', async () => {
  const f = fixture({ tunnelProvider: 'cloudflare', cloudflareMode: 'quick' }); await f.instance.start();
  f.calls[0].child.stderr.write('https://stable-for-process.trycloudflare.com\nINF Registered tunnel connection connIndex=0\n');
  f.config.publicBaseUrl = 'https://stable-for-process.trycloudflare.com';
  f.config.ngrokDomain = 'unused.ngrok.app'; f.config.cloudflareTunnelName = 'unused-name';
  await f.instance.reconcile();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].child.signalCode, undefined);
  assert.equal((await f.instance.status()).url, f.config.publicBaseUrl);
  await f.instance.dispose();
});

test('close during managed ngrok inspection immediately establishes backoff and discards stale API results', async t => {
  for (const result of [{ running: false }, { running: true, url: 'https://example.ngrok.app' }]) await t.test(result.running ? 'stale endpoint' : 'no endpoint', async () => {
    let time = 10000, probes = 0, spawnCount = 0, child, release, entered;
    const probing = new Promise(resolve => { entered = resolve; });
    const pending = new Promise(resolve => { release = resolve; });
    const supervisor = createTunnelSupervisor({
      config: { tunnelAutoRestart: true, publicBaseUrl: 'https://example.ngrok.app' }, getPort: () => 4321,
      detectNgrok: async () => { if (++probes === 2) { entered(); return pending; } return { running: false }; },
    }, {
      now: () => time,
      spawn() {
        spawnCount++; child = new EventEmitter(); child.pid = spawnCount;
        child.stdout = new PassThrough(); child.stderr = new PassThrough();
        child.kill = () => { child.emit('close', 0); return true; }; return child;
      },
    });
    try {
      await supervisor.start();
      const reading = supervisor.status(); await probing;
      child.emit('close', 1); release(result);
      const status = await reading;
      assert.equal(status.state, 'backoff'); assert.equal(status.running, false);
      assert.equal(status.restartCount, 1); assert.equal(status.nextRetryAt, 11000); assert.equal(spawnCount, 1);
      await supervisor.reconcile(); assert.equal(spawnCount, 1);
      time = 11000; await supervisor.reconcile(); assert.equal(spawnCount, 2);
      assert.equal((await supervisor.status()).state, 'starting');
    } finally { release(result); await supervisor.dispose(); }
  });
});
