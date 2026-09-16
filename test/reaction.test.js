import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { FeishuClient, feishuTools } from '../lib/index.js';
import { createConversationFixture } from '../test-support/conversation-fixture.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function runtime(t, { add = async () => ({ reaction_id: 'own-reaction' }), remove = async () => {}, reply = async () => {} } = {}) {
  const calls = [];
  const signals = new AsyncLocalStorage();
  const app = await createConversationFixture(t, { tools: feishuTools, client: {
    withSignal: (signal, run) => signals.run(signal, run),
    addMessageReaction: async (...args) => { calls.push(['add', ...args]); return add(signals.getStore(), ...args); },
    deleteMessageReaction: async (...args) => { calls.push(['delete', ...args]); return remove(signals.getStore(), ...args); },
    replyMessage: async (...args) => { calls.push(['reply', ...args]); return reply(signals.getStore(), ...args); }
  } });
  const warnings = [];
  app.ctx.logger.warn = message => warnings.push(message);
  return { ...app, calls, warnings,
    async start(options = {}) {
      await app.send({ messageId: 'message', ...options });
      const agent = [...app.agents.values()].at(-1);
      await app.claim(agent);
      return agent;
    },
  };
}

test('reaction client uses the Feishu create/delete contracts and encodes path IDs', async () => {
  const client = new FeishuClient({}, {});
  const requests = [];
  client.request = async (...args) => { requests.push(args); return { reaction_id: 'own/id' }; };
  const added = await client.addMessageReaction('message/id');
  await client.deleteMessageReaction('message/id', added.reaction_id);
  assert.deepEqual(requests, [
    ['POST', '/open-apis/im/v1/messages/message%2Fid/reactions', { reaction_type: { emoji_type: 'Typing' } }],
    ['DELETE', '/open-apis/im/v1/messages/message%2Fid/reactions/own%2Fid']
  ]);
});

test('only a claimed message starts Typing, then the final reply removes its own reaction once', async t => {
  const app = await runtime(t);
  await app.send({ messageId: 'message' });
  const agent = [...app.agents.values()][0];
  await tick();
  assert.deepEqual(app.calls, [], 'queued messages must not claim they are already working');
  await app.emit('agent/inbox/inserted', { agent, message: agent.queue[0] });
  await tick();
  assert.deepEqual(app.calls, []);
  await app.claim(agent);
  await tick();
  assert.deepEqual(app.calls, [['add', 'message', 'Typing']]);
  await app.finish(agent, 'Done');
  await app.emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal });
  assert.deepEqual(app.calls, [['add', 'message', 'Typing'], ['reply', 'message', 'Done'], ['delete', 'message', 'own-reaction']]);
});

test('reaction permission failure does not prevent a final reply or reject shutdown', async t => {
  const app = await runtime(t, { add: async () => { throw new Error('forbidden'); } });
  const agent = await app.start();
  await tick();
  await app.finish(agent, 'Done');
  assert.equal(app.warnings.length, 1);
  assert.match(app.warnings[0], /reaction permission/);
  assert.deepEqual(app.calls.map(call => call[0]), ['add', 'reply']);
});

test('a late successful add is removed after the reply has already been sent', async t => {
  const slow = deferred();
  const app = await runtime(t, { add: () => slow.promise });
  const agent = await app.start();
  await tick();
  const finished = app.finish(agent, 'Done');
  await tick();
  assert.deepEqual(app.calls.map(call => call[0]), ['add', 'reply']);
  slow.resolve({ reaction_id: 'late-own-reaction' });
  await finished;
  assert.deepEqual(app.calls.at(-1), ['delete', 'message', 'late-own-reaction']);
});

test('cancelled turns send their cancellation result and clean up using an independent signal', async t => {
  let cleanupSignal;
  const app = await runtime(t, { remove: async signal => { cleanupSignal = signal; } });
  const agent = await app.start();
  await tick();
  const cancelled = AbortSignal.abort();
  await app.emit('agent/turn-stopping', { agent, turn: 1, signal: cancelled });
  assert.notEqual(cleanupSignal, cancelled);
  assert.equal(cleanupSignal.aborted, false);
  assert.deepEqual(app.calls.map(call => call[0]), ['add', 'reply', 'delete']);
  assert.match(app.calls.find(call => call[0] === 'reply')[2], /取消/);
});

for (const event of ['agent/status', 'agent/disposed', 'agent/error']) {
  test(`${event} sends a terminal result and clears reactions without turn-stopping`, async t => {
    const app = await runtime(t);
    const agent = await app.start();
    await tick();
    await app.emit(event, { agent, status: 'idle' });
    await tick();
    assert.deepEqual(app.calls.map(call => call[0]), ['add', 'reply', 'delete']);
    await app.emit(event, { agent, status: 'idle' });
    await tick();
    assert.equal(app.calls.filter(call => call[0] === 'delete').length, 1);
    assert.equal(app.calls.filter(call => call[0] === 'reply').length, 1);
  });
}

test('plugin shutdown waits for cleanup of an in-flight add', async t => {
  const slow = deferred();
  const app = await runtime(t, { add: () => slow.promise });
  await app.start();
  await tick();
  let disposed = false;
  const shutdown = app.dispose().then(() => { disposed = true; });
  await tick();
  assert.equal(disposed, false);
  slow.resolve({ reaction_id: 'late-shutdown-reaction' });
  await shutdown;
  assert.deepEqual(app.calls.at(-1), ['delete', 'message', 'late-shutdown-reaction']);
});

test('idle cancellation clears a late add even after the turn mapping has been removed', async t => {
  const slow = deferred();
  const app = await runtime(t, { add: () => slow.promise });
  const agent = await app.start();
  await tick();
  await app.emit('agent/status', { agent, status: 'idle' });
  await app.emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal });
  assert.deepEqual(app.calls.map(call => call[0]), ['add', 'reply']);
  slow.resolve({ reaction_id: 'late-cancelled-reaction' });
  await tick();
  assert.deepEqual(app.calls.at(-1), ['delete', 'message', 'late-cancelled-reaction']);
  assert.equal(app.calls.filter(call => call[0] === 'reply').length, 1);
});

test('concurrent users only reply to and clean up their own message and reaction IDs', async t => {
  const first = deferred();
  const second = deferred();
  const app = await runtime(t, { add: (_signal, messageId) => messageId === 'message' ? first.promise : second.promise });
  const alice = await app.start();
  const bob = await app.start({ senderId: 'bob', messageId: 'other-message' });
  assert.notEqual(alice.session.id, bob.session.id);
  await tick();
  second.resolve({ reaction_id: 'other-reaction' });
  await app.finish(bob, 'Bob done');
  assert.deepEqual(app.calls.filter(call => call[0] === 'delete'), [['delete', 'other-message', 'other-reaction']]);
  first.resolve({ reaction_id: 'first-reaction' });
  await app.finish(alice, 'Alice done');
  assert.deepEqual(app.calls.filter(call => call[0] === 'delete'), [
    ['delete', 'other-message', 'other-reaction'], ['delete', 'message', 'first-reaction']
  ]);
  assert.deepEqual(app.calls.filter(call => call[0] === 'reply'), [
    ['reply', 'other-message', 'Bob done'], ['reply', 'message', 'Alice done']
  ]);
});

test('sequential turns in one session keep their own original-message reply targets', async t => {
  const app = await runtime(t);
  const agent = await app.start();
  await app.send({ messageId: 'followup-message', text: 'followup' });
  assert.equal(app.agents.size, 1);
  await app.finish(agent, 'First result');
  await app.claim(agent);
  await app.finish(agent, 'Second result');
  assert.deepEqual(app.calls.filter(call => call[0] === 'reply'), [
    ['reply', 'message', 'First result'], ['reply', 'followup-message', 'Second result']
  ]);
  assert.deepEqual(app.calls.filter(call => call[0] === 'delete').map(call => call[1]), ['message', 'followup-message']);
});

test('isolated user cannot use shared reply API to redirect replies or suppress automatic delivery', async t => {
  const app = await runtime(t);
  const agent = await app.start();
  const tool = app.tools.get('feishu_reply_message');
  await assert.rejects(() => tool.execute({ messageId: 'another-users-message', text: 'Forged reply' }, {
    agent, signal: new AbortController().signal
  }), /Shared Feishu application tools are unavailable/);
  await app.finish(agent, 'Done');
  assert.deepEqual(app.calls.filter(call => call[0] === 'reply'), [['reply', 'message', 'Done']]);
  assert.equal(app.calls.filter(call => call[0] === 'delete').length, 1);
});

test('reply failure still clears Typing and reaction deletion failure stays contained', async t => {
  const app = await runtime(t, { reply: async () => { throw new Error('reply network failure'); }, remove: async () => { throw new Error('cleanup network failure'); } });
  const agent = await app.start();
  await app.finish(agent, 'Done');
  assert.deepEqual(app.calls.map(call => call[0]), ['add', 'reply', 'delete']);
  assert.equal(app.warnings.length, 2);
});
