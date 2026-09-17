import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationFixture } from '../test-support/conversation-fixture.mjs';
import { ArchivedSessionError } from '../lib/session-host.js';
import { userKey } from '../lib/history-store.js';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const tick = () => new Promise(resolve => setImmediate(resolve));

test('archiving the current Harness session routes the next message to a visible new session with history retained', async t => {
  const f = await createConversationFixture(t);
  await f.send({ text: 'remember before archive' });
  const old = [...f.agents.values()][0];
  await f.claim(old); await f.finish(old, 'old answer');
  f.archived.add(old.session.id);
  await f.send({ text: '/status' });
  assert.match(f.replies.at(-1)[1], /已在 Harness 归档/);
  assert.equal(f.host.calls.length, 1, 'status does not create a session');
  await f.send({ text: 'continue after archive', messageId: 'after-archive' });
  const current = f.store().getCurrentSession('chat-a');
  assert.notEqual(current.sessionId, old.session.id);
  assert.equal(f.archived.has(current.sessionId), false);
  assert.equal(f.archived.has(old.session.id), true, 'respect the user archive action');
  assert.equal(f.store().getSession(old.session.id).closeReason, 'harness-archived');
  assert.equal(f.store().searchMessages({ query: 'remember before archive' }).length, 1);
  assert.match(f.host.calls.at(-1).title, /^Alice/);
  const agent = f.agents.get(current.sessionId);
  await f.claim(agent); await f.finish(agent, 'visible answer');
  assert.deepEqual(f.replies.at(-1), ['after-archive', 'visible answer']);
  await f.send({ text: 'continue visible' });
  assert.equal(f.store().getCurrentSession('chat-a').sessionId, current.sessionId);
});

test('archive rotation waits for in-flight and queued work and never routes the new message to the hidden agent', async t => {
  const f = await createConversationFixture(t);
  await f.send({ text: 'running task', messageId: 'running' });
  const old = [...f.agents.values()][0];
  await f.claim(old);
  await f.send({ text: 'already queued', messageId: 'queued' });
  f.archived.add(old.session.id);
  let accepted = false;
  const next = f.send({ text: 'after archive', messageId: 'new' }).then(() => { accepted = true; });
  await tick();
  assert.equal(accepted, false);
  assert.equal(old.queue.length, 1);
  assert.equal(f.store().getMessageByFeishuId('new').text, 'after archive');
  await f.finish(old, 'running result');
  await tick();
  assert.equal(accepted, false);
  await f.claim(old); await f.finish(old, 'queued result');
  await next;
  assert.equal(f.agents.has(old.session.id), false);
  const current = f.store().getCurrentSession('chat-a');
  assert.notEqual(current.sessionId, old.session.id);
  assert.equal(f.agents.get(current.sessionId).queue.length, 1);
  assert.ok(f.replies.some(([id, text]) => id === 'running' && text === 'running result'));
  assert.ok(f.replies.some(([id, text]) => id === 'queued' && text === 'queued result'));
});

test('chat switching and restart keep only one current session without merging histories', async t => {
  const f = await createConversationFixture(t);
  await f.send({ text: 'old private context' });
  const old = [...f.agents.values()][0];
  await f.claim(old); await f.finish(old);
  await f.send({ text: 'other chat', chatId: 'group' });
  assert.equal(f.store().getCurrentSession('chat-a'), null);
  assert.equal(f.archived.has(old.session.id), true);
  const group = f.agents.get(f.store().getCurrentSession('group').sessionId);
  await f.claim(group); await f.finish(group);
  f.archived.add(old.session.id);
  await f.restart();
  await f.send({ text: 'after restart' });
  assert.notEqual(f.store().getCurrentSession('chat-a').sessionId, old.session.id);
  assert.equal(f.store().getCurrentSession('group'), null);
  assert.equal(f.archived.has(group.session.id), true);
  assert.equal(f.store().listCurrentSessions().length, 1);
  assert.equal(f.store().searchMessages({ chatId: 'chat-a', query: 'other chat' }).length, 0);
});

for (const phase of ['during-resume', 'after-resume']) test(`archive ${phase} retries admission once and queues the message exactly once`, async t => {
  const f = await createConversationFixture(t);
  await f.send({ text: 'first' });
  const old = [...f.agents.values()][0];
  await f.claim(old); await f.finish(old);
  const open = f.host.getOrCreate.bind(f.host);
  f.host.getOrCreate = async request => {
    if (request.sessionId === old.session.id) {
      if (phase === 'after-resume') {
        const handle = await open(request);
        f.archived.add(old.session.id);
        return handle;
      }
      f.archived.add(old.session.id);
      throw new ArchivedSessionError();
    }
    return open(request);
  };
  await f.send({ text: 'concurrent with archive', messageId: 'racing' });
  const current = f.store().getCurrentSession('chat-a');
  assert.notEqual(current.sessionId, old.session.id);
  assert.equal(f.agents.get(current.sessionId).queue.length, 1);
  assert.equal(f.store().getMessageByFeishuId('racing').sessionId, current.sessionId);
  assert.equal(f.store().searchMessages({ query: 'concurrent with archive' }).length, 1);
});

test('ordinary messages reuse one session and reply only to the message claimed by each turn', async t => {
  const f = await createConversationFixture(t);
  await f.send({ text: 'first', messageId: 'm1' });
  await f.send({ text: 'second', messageId: 'm2' });
  assert.equal(f.agents.size, 1);
  const agent = [...f.agents.values()][0];
  assert.equal(agent.queue.length, 2);
  assert.deepEqual(f.reactions, [], 'queued followups are not presented as active turns');
  await f.claim(agent);
  await f.finish(agent, 'first answer');
  assert.deepEqual(f.replies, [['m1', 'first answer']]);
  await f.claim(agent);
  await f.finish(agent, 'second answer');
  assert.deepEqual(f.replies, [['m1', 'first answer'], ['m2', 'second answer']]);
  assert.equal(f.store().searchMessages().length, 4);
  assert.ok(f.store().searchMessages().every(row => /^2026-/.test(row.timestamp)));
  assert.match(f.host.calls[0].title, /Alice/);
});

test('separate authorized users have separate sessions, directories, databases and safe tool identity', async t => {
  const f = await createConversationFixture(t);
  await f.send({ text: 'alice private', senderId: 'alice' });
  await f.send({ text: 'bob private', senderId: 'bob' });
  assert.equal(f.agents.size, 2);
  assert.notEqual(f.host.calls[0].workspacePath, f.host.calls[1].workspacePath);
  assert.match(f.host.calls[1].title, /Bob/);
  assert.deepEqual(f.store('alice').searchMessages().map(row => row.text), ['alice private']);
  assert.deepEqual(f.store('bob').searchMessages().map(row => row.text), ['bob private']);
  const historySearch = f.tools.get('feishu_history_search');
  const agent = f.agents.get(f.host.calls[1].sessionId);
  const result = await historySearch.execute({ query: 'alice' }, { agent, signal: new AbortController().signal });
  assert.equal(JSON.stringify(result).includes('alice private'), false);
});

test('one user switches chat only after active work finishes and histories stay isolated', async t => {
  const f = await createConversationFixture(t);
  await f.send({ text: 'private message', chatId: 'private' });
  const first = [...f.agents.values()][0];
  await f.claim(first);
  let secondAdmitted = false;
  const second = f.send({ text: 'group message', chatId: 'group' }).then(() => { secondAdmitted = true; });
  await tick();
  assert.equal(secondAdmitted, false);
  assert.equal(f.host.calls.length, 1);
  await f.finish(first, 'private answer');
  await second;
  assert.equal(f.store().getCurrentSession('private'), null);
  assert.equal(f.archived.has(first.session.id), true);
  assert.equal(f.store().listCurrentSessions().length, 1);
  const groupAgent = f.agents.get(f.store().getCurrentSession('group').sessionId);
  await f.claim(groupAgent); await f.finish(groupAgent, 'group answer');
  await f.send({ text: 'continue privately', chatId: 'private' });
  assert.notEqual(f.host.calls.at(-1).sessionId, first.session.id);
  assert.equal(f.store().getCurrentSession('group'), null);
  assert.equal(f.archived.has(groupAgent.session.id), true);
  assert.equal(f.store().listCurrentSessions().length, 1);
  assert.equal(f.store().searchMessages({ chatId: 'private', query: 'private message' }).length, 1);
  assert.equal(f.store().searchMessages({ chatId: 'private', query: 'group' }).length, 0);
});

test('/new preserves old work and queues next admission until all previous turns settle', async t => {
  const f = await createConversationFixture(t);
  await f.send({ text: 'old task', messageId: 'old' });
  const old = [...f.agents.values()][0];
  await f.claim(old);
  await f.send({ text: '/new', messageId: 'command' });
  assert.equal(f.store().getCurrentSession('chat-a'), null);
  let admitted = false;
  const next = f.send({ text: 'new task', messageId: 'new' }).then(() => { admitted = true; });
  await tick();
  assert.equal(admitted, false);
  assert.equal(f.host.calls.length, 1);
  const received = f.store().getMessageByFeishuId('new');
  assert.equal(received.text, 'new task', 'arrival is durable before the old task reaches idle');
  assert.equal(f.store().getSession(received.sessionId).chatId, 'chat-a');
  assert.equal(f.store().getSession(received.sessionId).closeReason, 'received');
  assert.equal(f.store().getMessageByFeishuId('command').text, '/new');
  const commandHistory = f.store().searchMessages({ chatId: 'chat-a', query: '/new' });
  assert.equal(commandHistory.length, 1, 'commands remain searchable alongside ordinary messages');
  assert.ok(f.store().searchMessages({ chatId: 'chat-a', query: '已切换到新会话' }).length > 0);
  await f.finish(old, 'old answer');
  await next;
  const current = f.store().getCurrentSession('chat-a');
  assert.notEqual(current.sessionId, old.session.id);
  assert.equal(f.store().getSession(old.session.id).closeReason, 'new');
  assert.equal(f.archived.has(old.session.id), true);
  assert.equal(f.store().listCurrentSessions().length, 1);
  assert.ok(f.replies.some(([id, text]) => id === 'old' && text === 'old answer'));
  assert.equal(f.store().searchMessages({ query: 'old task' }).length, 1);
  assert.equal(f.store().getMessageByFeishuId('new').sessionId, current.sessionId);
});

test('daily maintenance archives idle context and the next message gets a fresh session', async t => {
  const f = await createConversationFixture(t);
  await f.send({ text: 'yesterday' });
  const old = [...f.agents.values()][0];
  await f.claim(old); await f.finish(old, 'remember this');
  f.advance(24 * 60 * 60 * 1000);
  await f.dispose.maintenance();
  assert.equal(f.store().getCurrentSession('chat-a'), null);
  assert.equal(f.store().getSession(old.session.id).closeReason, 'daily-reset');
  assert.equal(f.agents.has(old.session.id), false, 'daily rotation releases the idle in-memory context');
  assert.equal(f.archived.has(old.session.id), true, 'daily rotation also hides the old durable Harness session');
  await f.send({ text: 'today' });
  assert.notEqual(f.store().getCurrentSession('chat-a').sessionId, old.session.id);
  assert.equal(f.store().searchMessages({ query: 'yesterday' }).length, 1);
});

test('daily reset does not interrupt running work and rotates after it reaches idle', async t => {
  const f = await createConversationFixture(t);
  await f.send({ text: 'long task' });
  const old = [...f.agents.values()][0];
  await f.claim(old);
  f.advance(24 * 60 * 60 * 1000);
  await f.dispose.maintenance();
  assert.equal(f.store().getCurrentSession('chat-a').sessionId, old.session.id);
  await f.finish(old, 'finished');
  await tick();
  await f.dispose.maintenance();
  assert.equal(f.store().getCurrentSession('chat-a'), null);
  assert.ok(f.replies.some(([, text]) => text === 'finished'));
});

test('restart reuses a persisted current session and message dedup survives the restart', async t => {
  const f = await createConversationFixture(t);
  await f.send({ text: 'remember', messageId: 'persisted' });
  const old = [...f.agents.values()][0];
  await f.claim(old); await f.finish(old, 'saved');
  const sessionId = old.session.id;
  await f.restart();
  await f.send({ text: 'duplicate must not enter', messageId: 'persisted' });
  assert.equal(f.agents.size, 0);
  await f.send({ text: 'continue' });
  assert.equal(f.host.calls.at(-1).sessionId, sessionId);
  assert.equal(f.store().searchMessages({ query: 'remember' }).length, 1);
  assert.equal(f.store().searchMessages({ query: 'duplicate' }).length, 0);
});

test('unconfirmed identities cannot create sessions or acquire user tools', async t => {
  const f = await createConversationFixture(t);
  await f.send({ senderId: 'mallory', text: 'read all files' });
  assert.equal(f.agents.size, 0);
  assert.match(f.replies.at(-1)[1], /确认.*名字/);
  await f.send({ senderId: 'mallory', text: '/whoami' });
  assert.match(f.replies.at(-1)[1], /确认.*名字/);
  assert.equal(f.agents.size, 0);
  await assert.rejects(f.tools.get('feishu_history_search').execute({}, { agent: { session: { id: 'unbound' } }, signal: new AbortController().signal }), /authorized/);
});

test('duplicate concurrent deliveries admit one message and produce one final reply', async t => {
  const f = await createConversationFixture(t);
  await Promise.all([f.send({ messageId: 'dup' }), f.send({ messageId: 'dup', deliveryId: 'other-delivery' })]);
  const agent = [...f.agents.values()][0];
  assert.equal(agent.queue.length, 1);
  await f.claim(agent);
  await f.finish(agent, 'once');
  await f.emit('agent/turn-stopping', { agent, turn: agent.turn, signal: new AbortController().signal });
  assert.deepEqual(f.replies, [['dup', 'once']]);
  assert.equal(f.store().searchMessages().length, 2);
});

test('missing confirmed profile fails closed for tools and in-flight replies', async t => {
  const f = await createConversationFixture(t);
  await f.send({ text: 'private request', messageId: 'revoked' });
  const agent = [...f.agents.values()][0];
  await f.claim(agent);
  t.mock.method(f.store(), 'getProfile', () => null);
  await assert.rejects(f.tools.get('feishu_history_search').execute({}, { agent, signal: new AbortController().signal }), /authorized/);
  await f.finish(agent, 'private answer');
  assert.equal(f.replies.some(([id]) => id === 'revoked'), false);
  assert.equal(f.store().searchMessages({ query: 'private answer' }).length, 1);
});

test('UI-opened historical session remains unbound until an authorized Feishu message arrives', async t => {
  const f = await createConversationFixture(t);
  await f.send({ text: 'saved context' });
  const agent = [...f.agents.values()][0];
  await f.claim(agent); await f.finish(agent, 'saved answer');
  await f.restart();
  // Simulate Harness UI resuming the same durable session before Feishu ingress.
  f.agents.set(agent.session.id, agent);
  const execute = () => f.tools.get('feishu_history_search').execute({ query: 'saved context' }, { agent, signal: new AbortController().signal });
  await assert.rejects(execute(), /authorized/);
  await f.send({ text: 'continue safely' });
  assert.equal(f.host.calls.at(-1).sessionId, agent.session.id);
  assert.ok(JSON.stringify(await execute()).includes('saved context'));
});

test('claimed durable inbox message restores its original reply target from SQLite after restart', async t => {
  const f = await createConversationFixture(t);
  await f.send({ text: 'durable queued message', messageId: 'durable' });
  const prior = [...f.agents.values()][0];
  const durableMessage = prior.queue[0];
  await f.restart();
  await f.send({ text: 'wake resumed session', messageId: 'wake' });
  const resumed = [...f.agents.values()][0];
  // Real Harness can claim a previously persisted inbox item during resume,
  // before the newly received message. This item has no runtime pending entry.
  await f.claim(resumed, durableMessage);
  await f.finish(resumed, 'restored answer');
  assert.ok(f.replies.some(([id, text]) => id === 'durable' && text === 'restored answer'));
  assert.equal(f.replies.some(([id, text]) => id === 'wake' && text === 'restored answer'), false);
});

test('a resumed unclaimed Harness inbox rebuilds its reply target from persistent message identity', async t => {
  const f = await createConversationFixture(t);
  await f.send({ text: 'unfinished persisted request', messageId: 'persisted-inbox', deliveryId: 'transport-attempt-one' });
  const old = [...f.agents.values()][0];
  const queued = old.queue[0];
  const sessionId = old.session.id;
  assert.equal(queued.source.deliveryId, 'persisted-inbox', 'routing identity must be the stable Feishu message ID');
  assert.equal(f.store().getMessageByFeishuId('persisted-inbox').sessionId, sessionId);
  assert.deepEqual(f.replies, []);

  // A process loss cannot emit Harness cancellation callbacks. Preserve its
  // serialized, not-yet-claimed inbox while closing the real SQLite connection;
  // bypass only the fake host's graceful cancel notifications for this restart.
  f.host.dispose = async () => { f.agents.clear(); };
  await f.restart();
  assert.deepEqual(f.replies, []);
  await f.send({ text: 'new arrival reattaches the current session', messageId: 'after-restart' });
  const resumed = f.agents.get(sessionId);
  assert.ok(resumed);
  assert.equal(f.store().searchMessages({ query: 'unfinished persisted request' }).length, 1);
  await f.claim(resumed, queued);
  await f.finish(resumed, 'Recovered original result');
  assert.deepEqual(f.replies, [['persisted-inbox', 'Recovered original result']]);
  await f.claim(resumed);
  await f.finish(resumed, 'New arrival result');
  assert.deepEqual(f.replies, [['persisted-inbox', 'Recovered original result'], ['after-restart', 'New arrival result']]);
  assert.equal(f.store().searchMessages({ query: 'Recovered original result' }).length, 1);
});

test('history write failure preserves final delivery and cleans up Typing', async t => {
  const f = await createConversationFixture(t);
  await f.send({ text: 'task before storage failure', messageId: 'disk-full' });
  const agent = [...f.agents.values()][0];
  await f.claim(agent);
  const store = f.store();
  const appendMessage = store.appendMessage.bind(store);
  t.mock.method(store, 'appendMessage', record => {
    if (record.role === 'assistant') throw new Error('simulated disk full');
    return appendMessage(record);
  });
  await f.finish(agent, 'Answer must still reach Feishu');
  assert.deepEqual(f.replies, [['disk-full', 'Answer must still reach Feishu']]);
  assert.ok(f.warnings.some(warning => /could not persist final answer/.test(warning)));
  assert.deepEqual(f.reactions.map(call => call[0]), ['add', 'delete']);
  assert.equal(agent.session.snapshotEvents().at(-1).data.message.content[0].text, 'Answer must still reach Feishu');
});

test('model admission failure retains incoming text for a later authorized history search', async t => {
  const f = await createConversationFixture(t);
  const getOrCreate = f.host.getOrCreate;
  f.host.getOrCreate = async () => { throw new Error('model unavailable'); };
  await f.send({ text: 'important original request survives model failure', messageId: 'failed-admission' });
  assert.equal(f.agents.size, 0);
  assert.match(f.replies.at(-1)[1], /原文已保存/);
  assert.equal(f.store().getMessageByFeishuId('failed-admission').text, 'important original request survives model failure');
  f.host.getOrCreate = getOrCreate;
  await f.send({ text: 'find my earlier request', messageId: 'retry-with-working-model' });
  const agent = [...f.agents.values()][0];
  const result = await f.tools.get('feishu_history_search').execute({ query: 'important original request' }, {
    agent, signal: new AbortController().signal,
  });
  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].text, 'important original request survives model failure');
  assert.equal(result.data[0].role, 'user');
});

test('reconciliation cancels an unconfirmed binding without cancelling another user', async t => {
  const f = await createConversationFixture(t);
  await f.send({ senderId: 'alice', messageId: 'alice-running' });
  const alice = [...f.agents.values()][0];
  await f.claim(alice);
  await f.send({ senderId: 'alice', messageId: 'alice-queued' });
  await f.send({ senderId: 'bob', messageId: 'bob-running' });
  const bob = [...f.agents.values()].find(agent => agent !== alice);
  await f.claim(bob);
  const cancelAlice = t.mock.method(alice, 'cancel');
  const cancelBob = t.mock.method(bob, 'cancel');
  t.mock.method(f.store(), 'getProfile', () => null);
  await f.dispose.reconcile();
  await tick();
  assert.equal(cancelAlice.mock.calls.length, 1);
  assert.equal(cancelBob.mock.calls.length, 0);
  assert.equal(alice.status, 'idle');
  assert.equal(alice.queue.length, 0);
  await assert.rejects(f.tools.get('feishu_history_search').execute({}, { agent: alice, signal: new AbortController().signal }), /authorized/);
  assert.equal(f.replies.some(([id]) => id.startsWith('alice-')), false);
  await f.finish(bob, 'Bob can continue');
  assert.deepEqual(f.replies, [['bob-running', 'Bob can continue']]);
  assert.ok(f.store().getMessageByFeishuId('alice-queued'));
});

test('individual user permissions override defaults and can be reduced while a session stays open', async t => {
  const f = await createConversationFixture(t, { config: { authorizedUsers: [
    { openId: 'alice', displayName: 'Alice', permissionPreset: 'read-only' },
    { openId: 'bob', displayName: 'Bob', permissionPreset: 'workspace-write' },
  ] } });
  await f.send({ senderId: 'alice' }); await f.send({ senderId: 'bob' });
  const alice = f.agents.get(f.host.calls[0].sessionId);
  const bob = f.agents.get(f.host.calls[1].sessionId);
  assert.equal(f.host.calls[0].permissionPreset, 'read-only');
  const write = f.tools.get('feishu_workspace_write');
  const exec = agent => ({ agent, signal: new AbortController().signal });
  await assert.rejects(write.execute({ path: 'notes.txt', text: 'alice' }, exec(alice)), /read-only/);
  await write.execute({ path: 'notes.txt', text: 'bob' }, exec(bob));
  f.config.authorizedUsers[1].permissionPreset = 'read-only';
  await assert.rejects(write.execute({ path: 'notes.txt', text: 'changed' }, exec(bob)), /read-only/);
});

test('changing the administrator workspace root rotates the old context without losing history', async t => {
  const f = await createConversationFixture(t);
  await f.send({ text: 'old workspace' });
  const old = [...f.agents.values()][0]; await f.claim(old); await f.finish(old, 'saved');
  const { mkdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  f.config.workspacePath = join(f.root, 'other-workspace'); await mkdir(f.config.workspacePath);
  await f.send({ text: 'new workspace' });
  assert.notEqual(f.host.calls.at(-1).sessionId, old.session.id);
  assert.equal(f.store().getSession(old.session.id).closeReason, 'workspace-changed');
  assert.equal(f.store().searchMessages({ query: 'old workspace' }).length, 1);
});

test('restart archives previously closed durable sessions even without an in-memory binding', async t => {
  const f = await createConversationFixture(t);
  await f.send({ text: 'keep this old history', messageId: 'old-history' });
  const old = [...f.agents.values()][0];
  await f.claim(old); await f.finish(old, 'old result');
  await tick(); // Drain the idle-triggered maintenance before simulating the old shutdown.
  f.store().closeSession(old.session.id, { reason: 'new' });
  assert.equal(f.archived.has(old.session.id), false);
  // Simulate an older runtime exiting without retiring the visible log.
  f.host.dispose = async () => { f.agents.clear(); };
  await f.restart();
  assert.equal(f.archived.has(old.session.id), true);
  assert.equal(f.persistedSessions.has(old.session.id), true);
  assert.equal(f.agents.size, 0);
  assert.equal(f.host.calls.length, 0, 'cleanup never resumes historical agents');
  assert.deepEqual(f.host.archiveCalls, [old.session.id]);
  assert.equal(f.store().getMessageByFeishuId('old-history').text, 'keep this old history');
  await f.send({ text: 'current task' });
  const current = f.store().getCurrentSession('chat-a');
  assert.notEqual(current.sessionId, old.session.id);
  assert.deepEqual([...f.persistedSessions.keys()].filter(id => !f.archived.has(id)), [current.sessionId]);
});

for (const restartBeforeBoundary of [true, false]) test(`persisted daily reset runs without new messages when restarted ${restartBeforeBoundary ? 'before' : 'after'} 04:00`, async t => {
  const f = await createConversationFixture(t, {
    now: Date.parse('2026-09-16T19:59:00Z'),
    config: { dailyResetTimezone: 'Asia/Macau', dailyResetHour: 4 },
  });
  await f.send({ text: 'before local four o’clock' });
  const old = [...f.agents.values()][0];
  await f.claim(old); await f.finish(old, 'saved before reset');
  const replyCount = f.replies.length;
  if (restartBeforeBoundary) {
    await f.restart();
    assert.equal(f.store().getCurrentSession('chat-a').sessionId, old.session.id);
    assert.equal(f.archived.has(old.session.id), false);
    f.advance(2 * 60 * 1000);
    await f.dispose.maintenance();
  } else {
    f.advance(2 * 60 * 1000);
    await f.restart();
  }
  assert.equal(f.store().getCurrentSession('chat-a'), null);
  assert.equal(f.store().getSession(old.session.id).closeReason, 'daily-reset');
  assert.equal(f.archived.has(old.session.id), true);
  assert.equal(f.host.calls.length, 0);
  assert.equal(f.replies.length, replyCount, 'scheduled cleanup sends no unsolicited reply');
  assert.equal(f.store().searchMessages({ query: 'before local' }).length, 1);
});

test('startup reconciles duplicate current sessions to one visible current without merging chats', async t => {
  const f = await createConversationFixture(t);
  await f.send({ text: 'private old context' });
  const first = [...f.agents.values()][0];
  await f.claim(first); await f.finish(first, 'private result');
  const key = userKey({ source: f.config.source, tenantId: 'tenant', openId: 'alice' });
  const newestId = `feishu-user-${key.slice(0, 16)}-legacy-newer`;
  f.store().ensureSession({ sessionId: newestId, chatId: 'group', dayKey: '2026-09-16', createdAt: '2026-09-16T06:00:01Z' });
  f.store().appendMessage({ sessionId: newestId, role: 'user', text: 'group-only secret' });
  f.store().setCurrentSession('group', newestId);
  f.persistedSessions.set(newestId, { header: { cwd: first.session.header.cwd } });
  assert.equal(f.store().listCurrentSessions().length, 2);
  f.host.dispose = async () => { f.agents.clear(); };
  await f.restart();
  assert.deepEqual(f.store().listCurrentSessions().map(session => session.sessionId), [newestId]);
  assert.equal(f.store().getSession(first.session.id).closeReason, 'duplicate-current');
  assert.equal(f.archived.has(first.session.id), true);
  assert.equal(f.archived.has(newestId), false);
  assert.deepEqual([...f.persistedSessions.keys()].filter(id => !f.archived.has(id)), [newestId]);
  assert.equal(f.store().searchMessages({ chatId: 'chat-a', query: 'group-only' }).length, 0);
  assert.equal(f.store().searchMessages({ chatId: 'group', query: 'group-only' }).length, 1);
});

test('archive failure blocks a second visible session and retries without losing either incoming message', async t => {
  const f = await createConversationFixture(t);
  await f.send({ text: 'old day' });
  const old = [...f.agents.values()][0];
  await f.claim(old); await f.finish(old, 'saved');
  const retire = f.host.retire.bind(f.host);
  f.host.retire = async id => {
    if (id === old.session.id) throw new Error('Archive storage unavailable');
    return retire(id);
  };
  f.advance(24 * 60 * 60 * 1000);
  await f.send({ text: 'keep failed admission', messageId: 'failed-archive' });
  assert.equal(f.host.calls.length, 1);
  assert.equal(f.archived.has(old.session.id), false);
  assert.equal(f.store().getCurrentSession('chat-a'), null);
  assert.match(f.replies.at(-1)[1], /原文已保存/);
  assert.equal(f.store().getMessageByFeishuId('failed-archive').text, 'keep failed admission');
  f.host.retire = retire;
  await f.send({ text: 'retry admission', messageId: 'retry-archive' });
  const current = f.store().getCurrentSession('chat-a');
  assert.notEqual(current.sessionId, old.session.id);
  assert.equal(f.archived.has(old.session.id), true);
  assert.deepEqual([...f.persistedSessions.keys()].filter(id => !f.archived.has(id)), [current.sessionId]);
  assert.equal(f.store().searchMessages({ query: 'keep failed admission' }).length, 1);
  assert.equal(f.store().getMessageByFeishuId('retry-archive').sessionId, current.sessionId);
});

test('closed historical work resumed by Harness delays new admission despite no runtime binding', async t => {
  const f = await createConversationFixture(t);
  await f.send({ text: 'old durable context' });
  const old = [...f.agents.values()][0];
  await f.claim(old); await f.finish(old, 'saved');
  await f.restart();
  f.store().closeSession(old.session.id, { reason: 'new' });
  old.status = 'running';
  f.agents.set(old.session.id, old); // A UI resume has no current runtime binding.
  await f.dispose.maintenance();
  assert.equal(f.archived.has(old.session.id), false);
  let admitted = false;
  const arrival = f.send({ text: 'wait for the historical task', messageId: 'delayed' }).then(() => { admitted = true; });
  await tick();
  assert.equal(admitted, false);
  assert.equal(f.host.calls.length, 0);
  assert.equal(f.store().getMessageByFeishuId('delayed').text, 'wait for the historical task');
  await f.idle(old);
  await arrival;
  const current = f.store().getCurrentSession('chat-a');
  assert.notEqual(current.sessionId, old.session.id);
  assert.equal(f.archived.has(old.session.id), true);
  assert.equal(f.store().getMessageByFeishuId('delayed').sessionId, current.sessionId);
});

test('cancellation after Harness creation keeps the durable current ID for the next admission', async t => {
  const f = await createConversationFixture(t);
  const controller = new AbortController();
  const open = f.host.getOrCreate.bind(f.host);
  f.host.getOrCreate = async request => {
    const handle = await open(request);
    controller.abort(new Error('Delivery cancelled after Harness publication'));
    return handle;
  };
  await f.send({ text: 'interrupted during admission', messageId: 'cancelled-create', signal: controller.signal });
  const current = f.store().getCurrentSession('chat-a');
  assert.ok(current);
  const published = f.agents.get(current.sessionId);
  assert.ok(published);
  assert.equal(published.queue.length, 0);
  assert.equal(f.store().getMessageByFeishuId('cancelled-create').text, 'interrupted during admission');
  f.host.getOrCreate = open;
  await f.send({ text: 'continue after cancellation', messageId: 'after-cancelled-create' });
  assert.equal(f.store().getCurrentSession('chat-a').sessionId, current.sessionId);
  assert.equal(f.agents.get(current.sessionId), published);
  assert.equal(published.queue.length, 1);
  assert.deepEqual([...f.persistedSessions.keys()].filter(id => !f.archived.has(id)), [current.sessionId]);
  assert.equal(f.store().getMessageByFeishuId('after-cancelled-create').sessionId, current.sessionId);
});

test('first verified delivery backfills a legacy identity and enables reset after a later silent restart', async t => {
  const f = await createConversationFixture(t, {
    profiles: [], now: Date.parse('2026-09-16T19:58:00Z'),
    config: { dailyResetTimezone: 'Asia/Macau', dailyResetHour: 4 },
  });
  f.store().confirmProfile('Alice');
  await f.send({ text: 'legacy history before migration' });
  const old = [...f.agents.values()][0];
  await f.claim(old); await f.finish(old, 'legacy saved');
  await tick();
  const identity = { source: f.config.source, tenantId: 'tenant', openId: 'alice' };
  const key = userKey(identity);
  const database = new DatabaseSync(join(f.config.historyRoot, key, 'history.sqlite'));
  try { database.exec('DELETE FROM user_identity'); } finally { database.close(); }
  await f.restart();
  const legacy = f.history.listStoredUsers({ source: f.config.source }).find(user => user.key === key);
  assert.equal(legacy.identity, null, 'startup discovery must not invent platform identity');
  assert.equal(legacy.store.getCurrentSession('chat-a').sessionId, old.session.id);
  await f.send({ text: 'authenticated user returns' });
  assert.deepEqual(f.history.listStoredUsers({ source: f.config.source }).find(user => user.key === key).identity, identity);
  assert.equal(f.store().getCurrentSession('chat-a').sessionId, old.session.id);
  const resumed = f.agents.get(old.session.id);
  await f.claim(resumed); await f.finish(resumed, 'confirmed migration');
  f.advance(4 * 60 * 1000);
  await f.restart();
  assert.equal(f.host.calls.length, 0, 'startup reset must not need another incoming message');
  assert.equal(f.store().getCurrentSession('chat-a'), null);
  assert.equal(f.store().getSession(old.session.id).closeReason, 'daily-reset');
  assert.equal(f.archived.has(old.session.id), true);
  assert.equal(f.store().searchMessages({ query: 'legacy history before migration' }).length, 1);
});
