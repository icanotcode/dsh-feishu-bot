import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, cp, symlink, realpath, readdir, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { findHarnessEntry } from '../scripts/harness-entry.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const packageName = '@example/feishu-test';
async function fixture(t) {
  // macOS may expose /var through a /private/var symlink. Compare canonical
  // fixture paths with the installer and realpath() on every platform.
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'dsh-publish-scripts-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const plugin = join(dir, 'plugin');
  const home = join(dir, 'home');
  const profile = join(home, 'profiles', 'web');
  await mkdir(profile, { recursive: true });
  await cp(join(root, 'scripts'), join(plugin, 'scripts'), { recursive: true });
  await writeFile(join(plugin, 'package.json'), JSON.stringify({ name: packageName, type: 'module' }));
  await symlink(resolve(root, 'node_modules'), join(plugin, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const env = { ...process.env, DSH_HOME: home, NGROK_URL: '' };
  const run = (script, args = [], extra = {}) => spawnSync(process.execPath, [join(plugin, 'scripts', script), ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 10000 });
  return { dir, plugin, profile, run };
}

test('installer reads package scope, preserves !!js YAML and backups, and is idempotent', async t => {
  const f = await fixture(t);
  const original = '# user comment\n- insert:\n    - id: existing\n      name: "@example/existing"\n      config:\n        enabled: !!js process.env.TEST_VALUE\n';
  await writeFile(join(f.profile, 'cordis.patch.yml'), original);
  await writeFile(join(f.profile, 'package.json'), '{"name":"my-profile","private":true}\n');
  const first = f.run('install.mjs');
  assert.equal(first.status, 0, first.stderr);
  assert.equal(await realpath(join(f.profile, 'node_modules', '@example', 'feishu-test')), f.plugin);
  const patch = await readFile(join(f.profile, 'cordis.patch.yml'), 'utf8');
  assert.ok(patch.startsWith(original));
  assert.ok(patch.includes(packageName));
  const files = await readdir(f.profile);
  assert.ok(files.some(name => name.startsWith('package.json.backup-')));
  assert.ok(files.some(name => name.startsWith('cordis.patch.yml.backup-')));
  const manifest = await readFile(join(f.profile, 'package.json'), 'utf8');
  assert.equal(JSON.parse(manifest).dependencies[packageName], `file:${f.plugin}`);
  const second = f.run('install.mjs');
  assert.equal(second.status, 0, second.stderr);
  assert.equal(await readFile(join(f.profile, 'cordis.patch.yml'), 'utf8'), patch);
  assert.equal(await readFile(join(f.profile, 'package.json'), 'utf8'), manifest);
  assert.deepEqual(await readdir(f.profile), files);
});

test('installer initializes an empty profile', async t => {
  const f = await fixture(t);
  const result = f.run('install.mjs');
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(await readFile(join(f.profile, 'package.json'), 'utf8'));
  assert.ok(manifest.dsh.profile.bundles.includes('@deepseek-ai/dsh-web-app'));
});

for (const [label, patch, dependency] of [
  ['legacy package', '- insert:\n    - id: old\n      name: "@deepseek-ai/dsh-feishu-bot"\n'],
  ['occupied id', '- insert:\n    - id: feishu-bot\n      name: "@someone/other"\n'],
  ['conflicting dependency', '[]\n', '^1.0.0'],
]) {
  test(`installer refuses ${label} without changing profile`, async t => {
    const f = await fixture(t);
    const manifest = JSON.stringify({ dependencies: dependency ? { [packageName]: dependency } : {} });
    await writeFile(join(f.profile, 'package.json'), manifest);
    await writeFile(join(f.profile, 'cordis.patch.yml'), patch);
    const result = f.run('install.mjs');
    assert.notEqual(result.status, 0);
    assert.equal(await readFile(join(f.profile, 'package.json'), 'utf8'), manifest);
    assert.equal(await readFile(join(f.profile, 'cordis.patch.yml'), 'utf8'), patch);
    assert.deepEqual((await readdir(f.profile)).sort(), ['cordis.patch.yml', 'package.json']);
  });
}

test('installer does not replace a conflicting installed directory', async t => {
  const f = await fixture(t);
  const link = join(f.profile, 'node_modules', '@example', 'feishu-test');
  await mkdir(link, { recursive: true });
  await writeFile(join(link, 'marker'), 'keep');
  const result = f.run('install.mjs');
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(join(link, 'marker'), 'utf8'), 'keep');
  await assert.rejects(access(join(f.profile, 'package.json')));
});

async function fakeNgrok(f) {
  const bin = join(f.dir, 'bin');
  await mkdir(bin);
  const output = join(f.dir, 'args.json');
  await writeFile(join(bin, 'ngrok'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.ARG_OUTPUT, JSON.stringify(process.argv.slice(2))); process.exit(Number(process.env.FAKE_EXIT || 0));\n`, { mode: 0o755 });
  return { PATH: bin, ARG_OUTPUT: output };
}

async function fakeCloudflared(f) {
  const bin = join(f.dir, 'bin');
  await mkdir(bin);
  const output = join(f.dir, 'cloudflare-args.json');
  await writeFile(join(bin, 'cloudflared'), `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.ARG_OUTPUT, JSON.stringify(process.argv.slice(2))); process.exit(Number(process.env.FAKE_EXIT || 0));\n`, { mode: 0o755 });
  return { PATH: bin, ARG_OUTPUT: output };
}

test('Cloudflare Quick Tunnel forwards only a loopback URL and validates the port', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const env = await fakeCloudflared(f);
  for (const [args, port] of [[[], '3080'], [['--port', '4321'], '4321']]) {
    const result = f.run('start-cloudflare.mjs', args, env);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(await readFile(env.ARG_OUTPUT, 'utf8')), ['tunnel', '--url', `http://127.0.0.1:${port}`]);
  }
});

test('Cloudflare named tunnel forwards existing configuration and propagates failure status', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const env = await fakeCloudflared(f);
  const config = join(f.dir, 'cloudflare config.yml');
  await writeFile(config, '{}');
  const result = f.run('start-cloudflare.mjs', ['--name', 'feishu-example', '--config', config], { ...env, FAKE_EXIT: '5' });
  assert.equal(result.status, 5, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(env.ARG_OUTPUT, 'utf8')), ['tunnel', '--config', config, 'run', 'feishu-example']);
});

test('Cloudflare rejects malformed arguments and conflicting Quick/named options without launching', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const env = await fakeCloudflared(f);
  for (const args of [['--port'], ['--port', '0'], ['--port', '65536'], ['--port', '3.5'], ['--port', 'invalid'], ['--unknown'], ['--config', 'some.yml'], ['--name', '--help'], ['--name', 'bad/name'], ['--name', 'example', '--port', '3080'], ['--name', 'example', '--config', join(f.dir, 'missing.yml')]]) {
    assert.notEqual(f.run('start-cloudflare.mjs', args, env).status, 0, JSON.stringify(args));
  }
  await assert.rejects(access(env.ARG_OUTPUT));
});

test('Cloudflare background startup catches early exit without claiming connection or saving a PID', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const env = await fakeCloudflared(f);
  const result = f.run('start-cloudflare.mjs', ['--background'], { ...env, FAKE_EXIT: '2' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /启动后退出/);
  assert.equal(result.stdout, '');
  await assert.rejects(access(join(f.plugin, '.runtime', 'cloudflared.pid')));
});

test('ngrok forwards explicit URL and default port without a private policy', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const env = await fakeNgrok(f);
  const result = f.run('start-ngrok.mjs', ['--url', 'https://example.ngrok.app'], env);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(env.ARG_OUTPUT, 'utf8')), ['http', '3080', '--url', 'https://example.ngrok.app']);
});

test('ngrok accepts environment URL, explicit port and optional policy, and propagates exit status', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const env = await fakeNgrok(f);
  const policy = join(f.dir, 'policy.yml');
  await writeFile(policy, '{}');
  const result = f.run('start-ngrok.mjs', ['--port', '8888', '--traffic-policy-file', policy], { ...env, NGROK_URL: 'https://example.ngrok.app', FAKE_EXIT: '7' });
  assert.equal(result.status, 7, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(env.ARG_OUTPUT, 'utf8')), ['http', '8888', '--url', 'https://example.ngrok.app', '--traffic-policy-file', policy]);
});

test('ngrok rejects invalid input before launching', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const env = await fakeNgrok(f);
  for (const args of [[], ['--url'], ['--url', 'http://example.com'], ['--url', 'https://example.com/path'], ['--url', 'https://example.com', '--port', '0'], ['--url', 'https://example.com', '--unknown']]) {
    assert.notEqual(f.run('start-ngrok.mjs', args, env).status, 0);
  }
  await assert.rejects(access(env.ARG_OUTPUT));
});

test('background launch detects early exit and does not claim success or save PID', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const env = await fakeNgrok(f);
  const result = f.run('start-ngrok.mjs', ['--url', 'https://example.ngrok.app', '--background'], { ...env, FAKE_EXIT: '2' });
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes('启动后退出'));
  assert.equal(result.stdout, '');
  await assert.rejects(access(join(f.plugin, '.runtime', 'ngrok.pid')));
});

test('Harness start accepts a JS entry path with spaces and forwards arguments and exit status', async t => {
  const f = await fixture(t);
  const binary = join(f.dir, 'fake harness.cjs');
  const output = join(f.dir, 'harness-args.json');
  await writeFile(binary, "require('node:fs').writeFileSync(process.env.ARG_OUTPUT, JSON.stringify(process.argv.slice(2))); process.exit(4);");
  const result = f.run('start.mjs', ['--port', '4321'], { DSH_BIN: binary, ARG_OUTPUT: output });
  assert.equal(result.status, 4, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), ['web', '--no-open', '--port', '4321']);
});

test('Windows resolves npm package JS instead of an extensionless shell shim', async t => {
  const f = await fixture(t);
  const bin = join(f.dir, 'npm prefix with spaces');
  const entry = join(bin, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
  await mkdir(join(bin, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true });
  await writeFile(join(bin, 'dsh'), '#!/bin/sh\nexit 99');
  await writeFile(join(bin, 'dsh.cmd'), '@echo off\nexit /b 99');
  await writeFile(entry, '');
  assert.equal(await findHarnessEntry({ env: { Path: bin }, platform: 'win32', home: f.dir }), entry);
});

test('Windows skips shell shims and resolves the local npm npx cache', async t => {
  const f = await fixture(t);
  const bin = join(f.dir, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'dsh'), '#!/bin/sh\nexit 99');
  const local = join(f.dir, 'Local AppData');
  const lib = join(local, 'npm-cache', '_npx', 'cached', 'node_modules', '@deepseek-ai', 'dsh', 'lib');
  await mkdir(lib, { recursive: true });
  await writeFile(join(lib, 'bin.js'), '');
  assert.equal(await findHarnessEntry({ env: { PATH: bin, LOCALAPPDATA: local }, platform: 'win32', home: f.dir }), join(lib, 'bin.js'));
});

test('Harness entry honors explicit JS and native executables and rejects Windows shell wrappers', async () => {
  for (const entry of ['C:/Harness/bin.js', 'C:/Harness/bin.cjs', 'C:/Harness/dsh.exe']) {
    assert.equal(await findHarnessEntry({ env: { DSH_BIN: entry }, platform: 'win32' }), entry);
  }
  for (const entry of ['C:/Harness/dsh', 'C:/Harness/dsh.cmd', 'C:/Harness/dsh.bat']) {
    await assert.rejects(findHarnessEntry({ env: { DSH_BIN: entry }, platform: 'win32' }), /DSH_BIN/);
  }
});
