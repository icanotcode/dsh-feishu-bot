import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { FeishuClient, feishuTools } from '../lib/index.js';
import { installFeishuRuntime } from '../lib/runtime.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function runtime({ add = async () => ({ reaction_id: 'own-reaction' }), remove = async () => {}, reply = async () => {} } = {}) {
  const listeners = new Map();
  const tools = [];
  const calls = [];
  const warnings = [];
  const signals = new AsyncLocalStorage();
  let rule;
  const ctx = {
    logger: { warn: message => warnings.push(message) },
    on(name, handler) { listeners.set(name, handler); return () => listeners.delete(name); },
    tools: { register(tool) { tools.push(tool); return () => {}; } },
    webhookRuntime: { register(value) { rule = value; return async () => {}; } }
  };
  const client = {
    withSignal: (signal, run) => signals.run(signal, run),
    addMessageReaction: async (...args) => { calls.push(['add', ...args]); return add(signals.getStore(), ...args); },
    deleteMessageReaction: async (...args) => { calls.push(['delete', ...args]); return remove(signals.getStore()); },
    replyMessage: async (...args) => { calls.push(['reply', ...args]); return reply(signals.getStore()); }
  };
  const dispose = installFeishuRuntime(ctx, { source: 'test', workspacePath: '/tmp' }, client, feishuTools, async () => ({}));
  const agent = { session: { id: 'session', snapshotEvents: () => [{ type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'Done' }] } } }] } };
  const emit = (name, extra = {}) => listeners.get(name)({ agent, ...extra });
  return {
    calls, warnings, dispose, emit, tools, agent,
    start({ sessionAgent = agent, deliveryId = 'delivery', messageId = 'message' } = {}) {
      const result = rule.run({ source: 'test', deliveryId, event: { payload: { parsed: { userText: 'hello', messageId, chatId: 'chat', senderId: 'user' } } } }, new AbortController().signal);
      assert.equal(typeof result.prompt, 'string');
      const inserted = emit('agent/inbox/inserted', { agent: sessionAgent, message: { source: { kind: 'webhook', provider: 'feishu', source: 'test', ruleId: rule.id, deliveryId } } });
      assert.equal(inserted, undefined, 'reaction requests must not delay message acceptance');
    },
    stop(signal = new AbortController().signal) { return emit('agent/turn-stopping', { turn: 1, signal }); }
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

test('adds Typing while working and removes only its returned reaction after the final reply', async () => {
  const app = runtime();
  app.start();
  await tick();
  assert.deepEqual(app.calls, [['add', 'message', 'Typing']]);
  await app.stop();
  await app.stop();
  await app.dispose();
  assert.deepEqual(app.calls, [['add', 'message', 'Typing'], ['reply', 'message', 'Done'], ['delete', 'message', 'own-reaction']]);
});

test('reaction permission failure does not prevent a final reply or reject shutdown', async () => {
  const app = runtime({ add: async () => { throw new Error('forbidden'); } });
  app.start();
  await tick();
  await app.stop();
  await app.dispose();
  assert.equal(app.warnings.length, 1);
  assert.match(app.warnings[0], /im:message.reactions:write_only/);
  assert.deepEqual(app.calls.map(call => call[0]), ['add', 'reply']);
});

test('a late successful add is removed even when the reply has already finished', async () => {
  const slow = deferred();
  const app = runtime({ add: () => slow.promise });
  app.start();
  await tick();
  await app.stop();
  assert.deepEqual(app.calls.map(call => call[0]), ['add', 'reply']);
  slow.resolve({ reaction_id: 'late-own-reaction' });
  await app.dispose();
  assert.deepEqual(app.calls.at(-1), ['delete', 'message', 'late-own-reaction']);
});

test('cancelled turns remove reactions with an independent, non-aborted cleanup signal', async () => {
  let cleanupSignal;
  const app = runtime({ remove: async signal => { cleanupSignal = signal; } });
  app.start();
  await tick();
  const cancelled = AbortSignal.abort();
  await app.stop(cancelled);
  await app.dispose();
  assert.notEqual(cleanupSignal, cancelled);
  assert.equal(cleanupSignal.aborted, false);
  assert.deepEqual(app.calls.map(call => call[0]), ['add', 'delete']);
});

for (const event of ['agent/status', 'agent/disposed', 'agent/error']) {
  test(`${event} clears reactions without needing a turn-stopping event`, async () => {
    const app = runtime();
    app.start();
    await tick();
    app.emit(event, { status: 'idle' });
    await tick();
    assert.deepEqual(app.calls.map(call => call[0]), ['add', 'delete']);
    await app.dispose();
    assert.equal(app.calls.filter(call => call[0] === 'delete').length, 1);
  });
}

test('plugin shutdown waits for cleanup of an in-flight add', async () => {
  const slow = deferred();
  const app = runtime({ add: () => slow.promise });
  app.start();
  await tick();
  let disposed = false;
  const shutdown = app.dispose().then(() => { disposed = true; });
  await tick();
  assert.equal(disposed, false);
  slow.resolve({ reaction_id: 'late-shutdown-reaction' });
  await shutdown;
  assert.deepEqual(app.calls.at(-1), ['delete', 'message', 'late-shutdown-reaction']);
});

test('idle cancellation clears a late add even after its session mapping has been removed', async () => {
  const slow = deferred();
  const app = runtime({ add: () => slow.promise });
  app.start();
  await tick();
  app.emit('agent/status', { status: 'idle' });
  await app.stop();
  assert.deepEqual(app.calls.map(call => call[0]), ['add']);
  slow.resolve({ reaction_id: 'late-cancelled-reaction' });
  await tick();
  assert.deepEqual(app.calls.at(-1), ['delete', 'message', 'late-cancelled-reaction']);
  await app.dispose();
  assert.equal(app.calls.length, 2);
});

test('concurrent sessions clean up only their own message and reaction IDs', async () => {
  const first = deferred();
  const second = deferred();
  const app = runtime({ add: (_signal, messageId) => messageId === 'message' ? first.promise : second.promise });
  const other = { session: { ...app.agent.session, id: 'other-session' } };
  app.start();
  app.start({ sessionAgent: other, deliveryId: 'other-delivery', messageId: 'other-message' });
  await tick();
  second.resolve({ reaction_id: 'other-reaction' });
  await tick();
  app.emit('agent/status', { agent: other, status: 'idle' });
  await tick();
  assert.deepEqual(app.calls.filter(call => call[0] === 'delete'), [['delete', 'other-message', 'other-reaction']]);
  first.resolve({ reaction_id: 'first-reaction' });
  await app.stop();
  await app.dispose();
  assert.deepEqual(app.calls.filter(call => call[0] === 'delete'), [
    ['delete', 'other-message', 'other-reaction'],
    ['delete', 'message', 'first-reaction']
  ]);
  assert.deepEqual(app.calls.filter(call => call[0] === 'reply'), [['reply', 'message', 'Done']]);
});

test('an explicit reply suppresses the automatic reply while still cleaning up Typing', async () => {
  const app = runtime();
  app.start();
  await tick();
  const tool = app.tools.find(tool => tool.name === 'feishu_reply_message');
  await tool.execute({ messageId: 'message', text: 'Explicit reply' }, { signal: new AbortController().signal });
  await app.stop();
  await app.dispose();
  assert.deepEqual(app.calls.map(call => call[0]), ['add', 'delete']);
});

test('reply failure still clears Typing and reaction deletion failure stays contained', async () => {
  const app = runtime({ reply: async () => { throw new Error('reply network failure'); }, remove: async () => { throw new Error('cleanup network failure'); } });
  app.start();
  await tick();
  await app.stop();
  await app.dispose();
  assert.deepEqual(app.calls.map(call => call[0]), ['add', 'reply', 'delete']);
  assert.equal(app.warnings.length, 2);
});
