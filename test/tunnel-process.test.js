import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTunnelSupervisor } from '../lib/tunnel-supervisor.js';

test('real native child can stop, restart after exit, and dispose on this OS', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'tunnel-process-smoke-'));
  const children = [], booted = [];
  let time = 10000;
  // node receives "http" as its script, with the normal ngrok argv after it.
  // This exercises native spawning and process termination without a public tunnel.
  await writeFile(path.join(directory, 'http'), 'process.stdout.write("test-process-ready\\n"); setInterval(() => {}, 1000);\n');
  const supervisor = createTunnelSupervisor({
    config: { tunnelProvider: 'ngrok', connectionMode: 'webhook', tunnelAutoRestart: true, ngrokExecutablePath: process.execPath },
    getPort: () => 4321,
    detectNgrok: async () => ({ running: false, reachable: false }),
  }, {
    homedir: directory, now: () => time,
    spawn(command, args, options) {
      const child = spawn(command, args, { ...options, cwd: directory });
      children.push(child);
      booted.push(new Promise((resolve, reject) => {
        let output = '';
        const deadline = setTimeout(() => reject(new Error('Test child did not become ready')), 4000);
        child.stdout.on('data', data => { output += String(data); if (output.includes('test-process-ready')) { clearTimeout(deadline); resolve(); } });
        child.once('error', error => { clearTimeout(deadline); reject(error); });
        child.once('close', () => { clearTimeout(deadline); if (!output.includes('test-process-ready')) reject(new Error('Test child closed before ready')); });
      }));
      return child;
    },
  });
  try {
    assert.equal((await supervisor.start()).managed, true); await booted[0];
    let closed = false;
    children[0].once('close', () => { closed = true; });
    assert.equal((await supervisor.stop()).managed, false); assert.equal(closed, true);
    assert.equal((await supervisor.start()).managed, true); await booted[1];
    const exited = once(children[1], 'close'); children[1].kill('SIGKILL'); await exited;
    const backoff = await supervisor.status();
    assert.equal(backoff.state, 'backoff'); assert.equal(backoff.restartCount, 1); assert.equal(children.length, 2);
    time += 1000; await supervisor.reconcile(); await booted[2];
    assert.equal(children.length, 3); assert.equal((await supervisor.status()).managed, true);
    closed = false;
    children[2].once('close', () => { closed = true; });
    await supervisor.dispose(); assert.equal(closed, true);
    assert.equal((await supervisor.status()).managed, false);
  } finally {
    await supervisor.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
