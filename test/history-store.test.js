import test from 'node:test';
import assert from 'node:assert/strict';
import { linkSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHistoryStore, userKey } from '../lib/history-store.js';

const identity = { source: 'bot', tenantId: 'tenant', openId: 'alice' };
async function fixture(t) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'feishu-history-')));
  const manager = await createHistoryStore({ root });
  t.after(() => { manager.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, manager, user: manager.forUser(identity) };
}
function session(user, sessionId = 'session-1', chatId = 'private') {
  return user.ensureSession({ sessionId, chatId, dayKey: '2026-09-16' });
}

test('history session bindings and delivery/message dedup survive process reopen', async t => {
  const { root, manager, user } = await fixture(t);
  session(user); user.setCurrentSession('private', 'session-1');
  session(user, 'session-2');
  assert.equal(user.getCurrentSession('private').sessionId, 'session-1', 'ensureSession does not change the current binding');
  assert.equal(user.listCurrentSessions().length, 1);
  assert.equal(user.claimMessage('delivery'), true);
  const message = user.appendMessage({ sessionId: 'session-1', role: 'user', text: 'hello', feishuMessageId: 'om1' });
  manager.close();
  const reopened = await createHistoryStore({ root }); t.after(() => reopened.close());
  const restored = reopened.forUser(identity);
  assert.equal(restored.getCurrentSession('private').sessionId, 'session-1');
  assert.equal(restored.claimMessage('delivery'), false);
  assert.equal(restored.appendMessage({ sessionId: 'session-1', role: 'user', text: 'retry', feishuMessageId: 'om1' }).id, message.id);
  assert.equal(restored.getMessageByFeishuId('om1').id, message.id);
  assert.equal(restored.getMessageByFeishuId('unknown'), null);
  assert.equal(restored.searchMessages().length, 1);
  restored.closeSession('session-1', { reason: 'daily', closedAt: '2026-09-17T04:00:00+08:00' });
  assert.equal(restored.getCurrentSession('private'), null);
  assert.deepEqual(restored.listCurrentSessions(), []);
  assert.equal(restored.getSession('session-1').closeReason, 'daily');
  assert.equal(restored.getMessage(message.id).text, 'hello', 'closing context preserves history');
  restored.setCurrentSession('private', 'session-2');
  assert.equal(restored.getCurrentSession('private').sessionId, 'session-2');
  reopened.close();
});

test('history CRUD keeps creation timestamp and soft-deletion audit fields', async t => {
  const { root, manager, user } = await fixture(t); session(user);
  const original = user.appendMessage({ sessionId: 'session-1', role: 'assistant', text: 'draft', timestamp: '2020-01-01T00:00:00Z', turn: 1 });
  const updated = user.updateMessage(original.id, { text: 'corrected' });
  assert.equal(updated.text, 'corrected');
  assert.equal(updated.timestamp, '2020-01-01T00:00:00.000Z');
  assert.ok(updated.updatedAt > updated.timestamp);
  assert.equal(user.deleteMessage(original.id), true);
  assert.equal(user.deleteMessage(original.id), false);
  assert.equal(user.getMessage(original.id), null);
  assert.equal(user.updateMessage(original.id, { text: 'resurrect' }), null);
  assert.deepEqual(user.searchMessages(), []);
  manager.close();
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(root, userKey(identity), 'history.sqlite'));
  try {
    const row = db.prepare('SELECT * FROM messages WHERE id=?').get(original.id);
    assert.equal(row.text, 'corrected'); assert.ok(row.deletedAt); assert.equal(row.updatedAt, row.deletedAt);
  } finally { db.close(); }
});

test('history supports cross-session time and literal keyword searches with chat restriction', async t => {
  const { user } = await fixture(t); session(user); session(user, 'session-2'); session(user, 'group-session', 'group');
  const inputs = [
    ['session-1', 'design 100%_done', '2025-01-01T00:00:00Z'],
    ['session-2', 'design sequel', '2026-01-01T08:00:00+08:00'],
    ['group-session', 'design in group', '2026-02-01T00:00:00Z'],
  ];
  for (const [sessionId, text, timestamp] of inputs) user.appendMessage({ sessionId, role: 'user', text, timestamp });
  assert.equal(user.searchMessages({ query: 'design' }).length, 3);
  assert.equal(user.searchMessages({ query: 'design', chatId: 'private' }).length, 2);
  assert.equal(user.searchMessages({ query: '100%_' }).length, 1);
  assert.equal(user.searchMessages({ from: '2026-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' }).length, 1);
  assert.equal(user.searchMessages({ sessionId: 'session-1' }).length, 1);
  assert.equal(user.searchMessages({ limit: 1, offset: 1 })[0].text, 'design sequel');
  assert.throws(() => user.searchMessages({ from: 'yesterday' }), /timezone/);
  assert.throws(() => user.searchMessages({ limit: 201 }), /limit/);
});

test('user, tenant and source each isolate databases and CRUD', async t => {
  const { manager, user } = await fixture(t); session(user);
  const secret = user.appendMessage({ sessionId: 'session-1', role: 'user', text: 'private' });
  for (const otherIdentity of [{ ...identity, openId: 'bob' }, { ...identity, tenantId: 'other' }, { ...identity, source: 'other' }]) {
    const other = manager.forUser(otherIdentity); session(other);
    assert.deepEqual(other.searchMessages(), []);
    assert.equal(other.getMessage(secret.id), null);
    assert.equal(other.updateMessage(secret.id, { text: 'changed' }), null);
    assert.equal(other.deleteMessage(secret.id), false);
    assert.equal(other.claimMessage('same-delivery'), true);
  }
  assert.equal(user.getMessage(secret.id).text, 'private');
  assert.equal(manager.forUser(identity), user, 'one cached connection per user');
});

test('untrusted SQL and path fragments remain data, never filesystem paths or SQL', async t => {
  const { root, manager, user } = await fixture(t); session(user);
  const sql = "'; DROP TABLE messages; --";
  const message = user.appendMessage({ sessionId: 'session-1', role: 'note', text: sql, id: sql });
  assert.equal(user.searchMessages({ query: sql })[0].id, message.id);
  assert.equal(user.getMessage("x' OR 1=1 --"), null);
  const escaped = manager.forUser({ source: '../../../..', tenantId: '/absolute/path', openId: '../../escape' });
  session(escaped);
  assert.ok(readdirSync(root).every(name => /^[a-f0-9]{64}$/.test(name)));
  assert.equal(user.searchMessages().length, 1);
  assert.throws(() => user.setCurrentSession('other-chat', 'session-1'), /different-chat/);
  assert.throws(() => user.ensureSession({ sessionId: 'session-1', chatId: 'other', dayKey: '2026-09-16' }), /different chat/);
  assert.equal(user.getSession('session-1').chatId, 'private');
});

test('database and user directory are private and symbolic-link database paths are rejected', async t => {
  const { root, manager } = await fixture(t);
  const directory = path.join(root, userKey(identity));
  if (process.platform !== 'win32') {
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(directory, 'history.sqlite')).mode & 0o777, 0o600);
  }
  manager.close();
  const second = { ...identity, openId: 'symlink' };
  const secondDirectory = path.join(root, userKey(second)); mkdirSync(secondDirectory);
  const target = path.join(root, 'unrelated'); writeFileSync(target, 'private');
  try { symlinkSync(target, path.join(secondDirectory, 'history.sqlite')); }
  catch (error) { if (process.platform === 'win32' && error.code === 'EPERM') return; throw error; }
  const reopened = await createHistoryStore({ root }); t.after(() => reopened.close());
  assert.throws(() => reopened.forUser(second), /symbolic links/);
  reopened.close();
});

test('history creation and updates cap UTF-8 text at 512 KiB', async t => {
  const { user } = await fixture(t); session(user);
  const maximum = 'a'.repeat(512 * 1024);
  const row = user.appendMessage({ sessionId: 'session-1', role: 'note', text: maximum });
  assert.equal(row.text.length, maximum.length);
  assert.throws(() => user.appendMessage({ sessionId: 'session-1', role: 'user', text: maximum + 'a' }), /512 KiB/);
  assert.throws(() => user.updateMessage(row.id, { text: '汉'.repeat(200000) }), /512 KiB/);
  assert.equal(user.getMessage(row.id).text, maximum, 'failed update preserves original text');
});

test('persistent Feishu lookup returns only visible user messages', async t => {
  const { user } = await fixture(t); session(user);
  const message = user.appendMessage({ sessionId: 'session-1', role: 'user', text: 'hello', feishuMessageId: 'incoming' });
  user.appendMessage({ sessionId: 'session-1', role: 'assistant', text: 'reply', feishuMessageId: 'outgoing' });
  assert.equal(user.getMessageByFeishuId('incoming').id, message.id);
  assert.equal(user.getMessageByFeishuId('outgoing'), null);
  user.deleteMessage(message.id);
  assert.equal(user.getMessageByFeishuId('incoming'), null);
});

test('received user history moves from an audit session without losing identity or creation timestamp', async t => {
  const { user } = await fixture(t); session(user, 'audit'); session(user, 'active');
  user.closeSession('audit', { reason: 'received' });
  const original = user.appendMessage({ sessionId: 'audit', role: 'user', text: 'persist before waiting', feishuMessageId: 'incoming', timestamp: '2020-01-01T00:00:00Z' });
  const moved = user.moveUserMessage('incoming', 'active');
  assert.equal(moved.id, original.id);
  assert.equal(moved.timestamp, original.timestamp);
  assert.equal(moved.text, original.text);
  assert.equal(moved.sessionId, 'active');
  assert.ok(moved.updatedAt > original.updatedAt);
  assert.equal(user.getMessageByFeishuId('incoming').sessionId, 'active');
  assert.equal(user.searchMessages({ sessionId: 'audit' }).length, 0);
  assert.equal(user.searchMessages({ sessionId: 'active' }).length, 1);
});

test('moving received history rejects cross-chat, cross-user, missing, assistant and deleted records', async t => {
  const { manager, user } = await fixture(t); session(user); session(user, 'group', 'group');
  const original = user.appendMessage({ sessionId: 'session-1', role: 'user', text: 'private', feishuMessageId: 'incoming' });
  user.appendMessage({ sessionId: 'session-1', role: 'assistant', text: 'answer', feishuMessageId: 'outgoing' });
  const other = manager.forUser({ ...identity, openId: 'other' }); session(other, 'other-session');
  for (const destination of ['group', 'missing', 'other-session']) {
    assert.throws(() => user.moveUserMessage('incoming', destination), /Cannot move/);
  }
  assert.throws(() => other.moveUserMessage('incoming', 'other-session'), /Cannot move/);
  assert.throws(() => user.moveUserMessage('outgoing', 'session-1'), /Cannot move/);
  assert.throws(() => user.moveUserMessage('missing', 'session-1'), /Cannot move/);
  assert.equal(user.getMessage(original.id).sessionId, 'session-1');
  user.deleteMessage(original.id);
  assert.throws(() => user.moveUserMessage('incoming', 'session-1'), /Cannot move/);
});

test('existing database hardlinks are rejected before chmod or SQLite open', async t => {
  const { root, manager } = await fixture(t);
  const other = { ...identity, openId: 'hardlink-user' };
  const otherDirectory = path.join(root, userKey(other)); mkdirSync(otherDirectory);
  linkSync(path.join(root, userKey(identity), 'history.sqlite'), path.join(otherDirectory, 'history.sqlite'));
  assert.throws(() => manager.forUser(other), /hard links/);
});

test('cached databases reject newly linked journals and substituted directory ancestors', async t => {
  const { root, user } = await fixture(t); session(user);
  const userDirectory = path.join(root, userKey(identity));
  const journal = path.join(userDirectory, 'history.sqlite-journal');
  const unrelated = path.join(root, 'unrelated'); writeFileSync(unrelated, 'private');
  linkSync(unrelated, journal);
  assert.throws(() => user.searchMessages(), /hard links/);
  rmSync(journal);
  assert.deepEqual(user.searchMessages(), []);
  const relocated = userDirectory + '-moved';
  try { renameSync(userDirectory, relocated); }
  catch (error) {
    // Windows can itself prohibit replacing a directory holding an open SQLite
    // handle. In that case the attack is prevented before our path check runs.
    if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error;
    assert.equal(user.getSession('session-1').sessionId, 'session-1');
    t.diagnostic('Windows denied renaming the open database directory; original database remains usable.');
    return;
  }
  symlinkSync(relocated, userDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => user.searchMessages(), /symbolic links/);
  assert.throws(() => user.appendMessage({ sessionId: 'session-1', role: 'note', text: 'no' }), /symbolic links/);
});
