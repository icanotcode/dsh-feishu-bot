import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools';
import { mediaToolDefinitions, readOutgoingFile, saveIncomingFile } from '../lib/media-files.js';
import { executeUserTool } from '../lib/user-tools.js';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'feishu-media-')));
  const alice = join(root, 'alice');
  const bob = join(root, 'bob');
  await mkdir(alice); await mkdir(bob);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, alice, bob };
}

async function supportedLink(t, operation) {
  try { await operation(); return true; }
  catch (error) {
    if (['EPERM', 'ENOTSUP', 'EACCES'].includes(error.code)) { t.skip('Filesystem link operation is unavailable'); return false; }
    throw error;
  }
}

test('media tool schema conforms to Harness and does not offer arbitrary recipients', () => {
  assert.equal(mediaToolDefinitions.length, 1);
  const [tool] = mediaToolDefinitions;
  assert.equal(tool.name, 'feishu_send_file');
  assertSupportedJsonSchema(tool.parameters);
  assert.deepEqual(tool.parameters.required, ['path']);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.equal('chatId' in tool.parameters.properties, false);
});

test('uploads preserve binary bytes and use unique private files under message hashes', async t => {
  const { alice } = await fixture(t);
  const data = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const args = { data, filename: '报告?.bin', kind: 'file', messageId: 'message/../one' };
  const first = await saveIncomingFile(alice, args);
  const second = await saveIncomingFile(alice, args);
  const hash = createHash('sha256').update(args.messageId).digest('hex').slice(0, 16);
  assert.ok(first.path.startsWith(`incoming/${hash}/`));
  assert.equal(first.name, '报告_.bin');
  assert.notEqual(first.path, second.path);
  assert.equal(first.size, 256);
  assert.deepEqual(await readFile(join(alice, first.path)), data);
  const outgoing = await readOutgoingFile(alice, first.path);
  assert.deepEqual(outgoing.data, data);
  assert.equal(outgoing.size, data.length);
  assert.equal(outgoing.filename, first.path.split('/').at(-1));
  if (process.platform !== 'win32') {
    assert.equal((await stat(join(alice, first.path))).mode & 0o777, 0o600);
    assert.equal((await stat(join(alice, 'incoming', hash))).mode & 0o777, 0o700);
  }
});

test('uploads can be stored for read-only users while agent writes remain forbidden', async t => {
  const { alice } = await fixture(t);
  const uploaded = await saveIncomingFile(alice, { data: new Uint8Array([0, 255]), messageId: 'one', kind: 'image' });
  assert.equal(uploaded.name, 'image.bin');
  await assert.rejects(executeUserTool('feishu_workspace_write', { path: uploaded.path, text: 'overwrite' }, { workspacePath: alice }, { permissionPreset: 'read-only' }), /read-only/);
  assert.deepEqual((await readOutgoingFile(alice, uploaded.path)).data, Buffer.from([0, 255]));
});

test('upload filenames reject traversal, ADS and Windows device aliases on every platform', async t => {
  const { alice } = await fixture(t);
  for (const filename of ['../secret', 'a/b', 'a\\b', 'C:secret', 'file:stream', '\0bad', '.', '..', 'bad.', 'bad ', 'CON', 'nul.txt', 'COM1.log', 'lpt9', 'COM¹.txt', 'CONIN$', 'CONOUT$.txt', 'CLOCK$', 'CON .txt', '']) {
    await assert.rejects(saveIncomingFile(alice, { data: Buffer.from('x'), filename, messageId: 'one' }), /filename/);
  }
  const longName = '汉'.repeat(200) + '.pdf';
  const result = await saveIncomingFile(alice, { data: Buffer.from('pdf'), filename: longName, messageId: 'one' });
  assert.ok(Buffer.byteLength(result.name) <= 180);
  assert.ok(result.name.endsWith('.pdf'));
  assert.equal(result.name.includes('�'), false);
});

test('uploads reject nonbinary data, missing message IDs and oversized bytes before writing', async t => {
  const { alice } = await fixture(t);
  await assert.rejects(saveIncomingFile(alice, { data: 'text', messageId: 'one' }), /binary/);
  await assert.rejects(saveIncomingFile(alice, { data: Buffer.alloc(0) }), /message ID/);
  await assert.rejects(saveIncomingFile(alice, { data: Buffer.allocUnsafe(100 * 1024 * 1024 + 1), messageId: 'one' }), /100 MiB/);
  await assert.rejects(stat(join(alice, 'incoming')), { code: 'ENOENT' });
});

test('outgoing files reject other user paths, absolute paths, devices and directories', async t => {
  const { alice, bob } = await fixture(t);
  await writeFile(join(bob, 'secret'), 'secret');
  for (const input of ['../bob/secret', 'a/../../bob/secret', join(bob, 'secret'), 'C:\\secret', 'file:stream', 'nul.txt', 'COM¹.txt', 'CONIN$', 'a\0b']) {
    await assert.rejects(readOutgoingFile(alice, input), /relative|escapes|filename/);
  }
  await assert.rejects(readOutgoingFile(alice, ''), /regular|EISDIR|EPERM/);
});

test('outgoing reads enforce default and custom limits, allow empty files, and handle cancellation', async t => {
  const { alice } = await fixture(t);
  await writeFile(join(alice, 'small'), Buffer.from([0, 255, 5]));
  assert.equal((await readOutgoingFile(alice, 'small', { maxBytes: 3 })).size, 3);
  await assert.rejects(readOutgoingFile(alice, 'small', { maxBytes: 2 }), /exceeds/);
  await writeFile(join(alice, 'empty'), '');
  assert.deepEqual((await readOutgoingFile(alice, 'empty', { maxBytes: 0 })).data, Buffer.alloc(0));
  for (const maxBytes of [-1, 1.5, '30', Infinity, 100 * 1024 * 1024 + 1]) {
    await assert.rejects(readOutgoingFile(alice, 'small', { maxBytes }), /byte limit/);
  }
  const large = await open(join(alice, 'large'), 'w');
  await large.truncate(30 * 1024 * 1024 + 1); await large.close();
  await assert.rejects(readOutgoingFile(alice, 'large'), /exceeds/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readOutgoingFile(alice, 'small', { signal: controller.signal }), { name: 'AbortError' });
  let checks = 0;
  const signal = { throwIfAborted() { if (++checks === 4) throw new Error('cancelled during read'); } };
  await assert.rejects(readOutgoingFile(alice, 'small', { signal }), /cancelled during read/);
  await rename(join(alice, 'small'), join(alice, 'renamed'));
});

test('outgoing files reject hard links into another user directory', async t => {
  const { alice, bob } = await fixture(t);
  await writeFile(join(bob, 'secret'), 'secret');
  if (!await supportedLink(t, () => link(join(bob, 'secret'), join(alice, 'linked')))) return;
  await assert.rejects(readOutgoingFile(alice, 'linked'), /Linked files/);
});

test('outgoing files reject direct symbolic links into another user directory', async t => {
  const { alice, bob } = await fixture(t);
  await writeFile(join(bob, 'secret'), 'secret');
  if (!await supportedLink(t, () => symlink(join(bob, 'secret'), join(alice, 'linked'), 'file'))) return;
  await assert.rejects(readOutgoingFile(alice, 'linked'), /Linked files/);
});

test('uploads and outgoing reads reject symlink directories and replaced workspace roots', async t => {
  const { root, alice, bob } = await fixture(t);
  await writeFile(join(bob, 'secret'), 'secret');
  if (!await supportedLink(t, () => symlink(bob, join(alice, 'incoming'), process.platform === 'win32' ? 'junction' : 'dir'))) return;
  await assert.rejects(saveIncomingFile(alice, { data: Buffer.from('x'), filename: 'safe', messageId: 'one' }), /symbolic links/);
  await assert.rejects(readOutgoingFile(alice, 'incoming/secret'), /Linked files/);
  await rename(alice, join(root, 'alice-original'));
  await symlink(bob, alice, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(saveIncomingFile(alice, { data: Buffer.from('x'), filename: 'safe', messageId: 'one' }), /symbolic links/);
  await assert.rejects(readOutgoingFile(alice, 'secret'), /symbolic links/);
});

test('parallel uploads to one message directory never overwrite each other', async t => {
  const { alice } = await fixture(t);
  const saved = await Promise.all(Array.from({ length: 5 }, (_, i) => saveIncomingFile(alice, { data: Buffer.from([i]), filename: 'same.bin', messageId: 'same' })));
  assert.equal(new Set(saved.map(item => item.path)).size, 5);
  for (let i = 0; i < saved.length; i++) assert.deepEqual((await readOutgoingFile(alice, saved[i].path)).data, Buffer.from([i]));
});
