import test from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHistoryStore } from '../lib/history-store.js';
import { ensurePrivateDirectory, executeUserTool, userTools } from '../lib/user-tools.js';
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools';

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'feishu-tools-')));
  const manager = await createHistoryStore({ root: path.join(root, 'history') });
  t.after(async () => { manager.close(); await rm(root, { recursive: true, force: true }); });
  const store = manager.forUser({ source: 'bot', openId: 'alice' });
  for (const [sessionId, chatId] of [['private-session', 'private'], ['old-session', 'private'], ['group-session', 'group']]) {
    store.ensureSession({ sessionId, chatId, dayKey: '2026-09-16' });
  }
  const workspacePath = await ensurePrivateDirectory(path.join(root, 'workspaces', 'alice'), { trustedRoot: root });
  const binding = { store, chatId: 'private', sessionId: 'private-session', workspacePath };
  const call = (name, args = {}, permissionPreset = 'workspace-write') => executeUserTool(name, args, binding, { permissionPreset });
  return { root, store, binding, call };
}

test('user tool schemas conform to the Harness tool contract', () => {
  for (const tool of userTools) assertSupportedJsonSchema(tool.parameters);
});

test('history tools restrict every CRUD operation to the current chat, even in read-only workspace mode', async t => {
  const { call, store, binding } = await fixture(t);
  const privateMessage = store.appendMessage({ sessionId: 'old-session', role: 'user', text: 'private archive' });
  const groupMessage = store.appendMessage({ sessionId: 'group-session', role: 'user', text: 'group secret' });
  assert.deepEqual((await call('feishu_history_search', { chatId: 'group' })).map(row => row.id), [privateMessage.id]);
  assert.deepEqual(await call('feishu_history_search', { sessionId: 'group-session' }), []);
  for (const name of ['feishu_history_get', 'feishu_history_update', 'feishu_history_delete']) {
    await assert.rejects(call(name, { id: groupMessage.id, text: 'overwrite' }), /not found in this chat/);
  }
  const note = await call('feishu_history_create', { text: 'remember me' }, 'read-only');
  assert.equal(note.role, 'note');
  assert.equal((await call('feishu_history_get', { id: privateMessage.id })).text, 'private archive');
  assert.equal((await call('feishu_history_update', { id: note.id, text: 'corrected' }, 'read-only')).text, 'corrected');
  assert.equal(await call('feishu_history_delete', { id: note.id }, 'read-only'), true);
  assert.equal(store.getMessage(groupMessage.id).text, 'group secret');
  binding.sessionId = 'group-session';
  await assert.rejects(call('feishu_history_create', { text: 'wrong chat' }), /session not found/);
});

test('history search previews are bounded and Unicode-safe without changing stored text', async t => {
  const { call, store } = await fixture(t);
  const text = '😀'.repeat(501) + 'tail';
  const original = store.appendMessage({ sessionId: 'old-session', role: 'user', text });
  const [preview] = await call('feishu_history_search', { query: 'tail' });
  assert.equal(preview.id, original.id);
  assert.equal(preview.timestamp, original.timestamp);
  assert.equal(preview.text, '😀'.repeat(500));
  assert.equal(preview.fullLength, 505);
  assert.equal(preview.truncated, true);
  assert.equal(store.getMessage(original.id).text, text);
  const short = store.appendMessage({ sessionId: 'private-session', role: 'note', text: 'short' });
  const [shortPreview] = await call('feishu_history_search', { query: 'short' });
  assert.equal(shortPreview.id, short.id);
  assert.equal(shortPreview.fullLength, 5);
  assert.equal(shortPreview.truncated, false);
});

test('history get paginates Unicode characters and reports completion explicitly', async t => {
  const { call, store } = await fixture(t);
  const text = '😀'.repeat(8001) + 'tail';
  const original = store.appendMessage({ sessionId: 'old-session', role: 'user', text });
  const first = await call('feishu_history_get', { id: original.id });
  assert.equal(first.text, '😀'.repeat(8000));
  assert.equal(first.fullLength, 8005);
  assert.equal(first.nextOffset, 8000);
  assert.equal(first.truncated, true);
  const last = await call('feishu_history_get', { id: original.id, offset: first.nextOffset, limit: 10 });
  assert.equal(last.text, '😀tail');
  assert.equal(last.nextOffset, null);
  assert.equal(last.truncated, true, 'a later page omits the earlier part of the record');
  const entire = await call('feishu_history_get', { id: original.id, limit: 20000 });
  assert.equal(entire.text, text);
  assert.equal(entire.nextOffset, null);
  assert.equal(entire.truncated, false);
  const beyond = await call('feishu_history_get', { id: original.id, offset: 9000 });
  assert.equal(beyond.text, '');
  assert.equal(beyond.nextOffset, null);
  for (const offset of [-1, 1.5, '0', Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(call('feishu_history_get', { id: original.id, offset }), /offset/);
  }
  for (const limit of [0, -1, 1.5, '10', 20001]) {
    await assert.rejects(call('feishu_history_get', { id: original.id, limit }), /limit/);
  }
});

test('workspace tools list, read, write only within user directory and enforce read-only permissions', async t => {
  const { call, binding } = await fixture(t);
  assert.deepEqual(await call('feishu_workspace_write', { path: 'notes/hello.txt', text: '你好，world' }), { written: true });
  assert.deepEqual(await call('feishu_workspace_list', { path: 'notes' }), [{ name: 'hello.txt', type: 'file' }]);
  assert.equal((await call('feishu_workspace_read', { path: 'notes/hello.txt' }, 'read-only')).text, '你好，world');
  await assert.rejects(call('feishu_workspace_write', { path: 'blocked/sub.txt', text: 'no' }, 'read-only'), /read-only/);
  await assert.rejects(stat(path.join(binding.workspacePath, 'blocked')), { code: 'ENOENT' });
  await assert.rejects(call('shell', { path: 'notes/hello.txt' }), /unavailable/);
  await call('feishu_workspace_write', { path: '..notes', text: 'safe relative name' });
  assert.equal((await call('feishu_workspace_read', { path: '..notes' })).text, 'safe relative name');
});

test('workspace tools reject absolute paths, traversal, Windows aliases and special path syntax', async t => {
  const { call, root } = await fixture(t);
  for (const attempted of ['../outside', 'sub/../../outside', '/etc/passwd', root, 'C:\\secret', '\\\\server\\share', 'C:/secret', 'file:stream', 'a\0b', 'a/.. /b', 'a./b', 'CON', 'nul.txt', 'COM1.log']) {
    await assert.rejects(call('feishu_workspace_read', { path: attempted }), /relative|escapes|Unsupported/);
    await assert.rejects(call('feishu_workspace_write', { path: attempted, text: 'escape' }), /relative|escapes|Unsupported/);
  }
  await assert.rejects(call('feishu_workspace_write', { path: '', text: 'root' }), /Expected a file/);
});

test('workspace reads and writes enforce the 512 KiB byte limit', async t => {
  const { call, binding } = await fixture(t);
  const maximum = 'a'.repeat(512 * 1024);
  await call('feishu_workspace_write', { path: 'maximum.txt', text: maximum });
  assert.equal((await call('feishu_workspace_read', { path: 'maximum.txt' })).text.length, maximum.length);
  await assert.rejects(call('feishu_workspace_write', { path: 'too-big.txt', text: maximum + 'a' }), /512 KiB/);
  await writeFile(path.join(binding.workspacePath, 'too-big.txt'), maximum + 'a');
  await assert.rejects(call('feishu_workspace_read', { path: 'too-big.txt' }), /512 KiB/);
  await assert.rejects(call('feishu_workspace_write', { path: 'unicode.txt', text: '汉'.repeat(200000) }), /512 KiB/);
});

test('workspace blocks hardlinks, symlink directories, and roots with replaced ancestors', async t => {
  const { call, root, binding } = await fixture(t);
  const outside = path.join(root, 'outside'); await mkdir(outside);
  const secret = path.join(outside, 'secret.txt'); await writeFile(secret, 'private');
  await link(secret, path.join(binding.workspacePath, 'hardlink.txt'));
  for (const name of ['feishu_workspace_read', 'feishu_workspace_write']) {
    await assert.rejects(call(name, { path: 'hardlink.txt', text: 'overwrite' }), /Linked files/);
  }
  await symlink(outside, path.join(binding.workspacePath, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(call('feishu_workspace_read', { path: 'linked/secret.txt' }), /Linked files/);
  await assert.rejects(call('feishu_workspace_write', { path: 'linked/new.txt', text: 'escape' }), /Linked files/);
  const originalParent = path.dirname(binding.workspacePath);
  const movedParent = originalParent + '-moved';
  await rename(originalParent, movedParent);
  await symlink(movedParent, originalParent, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(call('feishu_workspace_list'), /symbolic links/);
  assert.equal(await readFile(secret, 'utf8'), 'private');
});

test('administrator root aliases are canonicalized but user child symlinks remain forbidden', async t => {
  const { root } = await fixture(t);
  const actual = path.join(root, 'actual'); await mkdir(actual);
  const alias = path.join(root, 'alias');
  await symlink(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const canonical = await ensurePrivateDirectory(path.join(alias, 'user'), { trustedRoot: alias });
  assert.equal(canonical, path.join(actual, 'user'));
  await assert.rejects(ensurePrivateDirectory(path.join(root, 'escape'), { trustedRoot: alias }), /escapes/);
  await symlink(actual, path.join(actual, 'child-link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(ensurePrivateDirectory(path.join(alias, 'child-link', 'user'), { trustedRoot: alias }), /symbolic links/);
});
