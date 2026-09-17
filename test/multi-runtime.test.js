import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntimeHub } from '../lib/runtime-hub.js';
import { installFeishuRuntime } from '../lib/runtime.js';
import { createHistoryStore } from '../lib/history-store.js';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'feishu-multiple-bots-'));
  const tools = new Map(), guards = new Set(), listeners = new Map(), agents = new Map(), stored = new Map(), rules = new Map();
  const archived = new Set(), registrations = new Map(), canceled = [], uploads = [], downloads = [], bots = [], attempts = [];
  const emit = async (name, value) => { for (const callback of [...listeners.get(name) || []]) await callback(value); };
  const on = (name, callback) => {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(callback);
    return () => listeners.get(name).delete(callback);
  };
  async function publish(options) {
    const id = options.sessionId ?? options.resumeSessionId;
    const ownGuards = [], waiters = [];
    const agent = {
      session: { id, header: options.meta ?? stored.get(id).header, requestHeader: () => undefined, snapshotEvents: () => agent.events },
      queue: [], events: [], status: 'idle', turn: 0,
      ctx: { tools: { get: name => tools.get(name), restrict() {}, presentAs() {}, guard: callback => { ownGuards.push(callback); return () => {}; } }, on() {} },
      followup(message) { agent.queue.push(message); agent.status = 'running'; },
      whenIdle() { return agent.status === 'idle' ? Promise.resolve() : new Promise(resolve => waiters.push(resolve)); },
      cancel() { canceled.push(id); agent.status = 'idle'; for (const resolve of waiters.splice(0)) resolve(); },
      async idle() { agent.status = 'idle'; for (const resolve of waiters.splice(0)) resolve(); await emit('agent/status', { agent, status: 'idle' }); },
      ownGuards,
    };
    const prepared = await options.setup(agent.ctx, agent);
    prepared?.commit();
    agents.set(id, agent); stored.set(id, { header: agent.session.header });
    await emit('agent/created', { agent });
    return { agent, dispose: async () => { agents.delete(id); await emit('agent/disposed', { agent }); } };
  }
  const ctx = {
    logger: { warn() {} }, on,
    tools: {
      register(tool) {
        assert.equal(tools.has(tool.name), false, `tool registered twice: ${tool.name}`);
        tools.set(tool.name, tool); registrations.set(tool.name, (registrations.get(tool.name) || 0) + 1);
        return () => tools.delete(tool.name);
      },
      guard(callback) { guards.add(callback); return () => guards.delete(callback); },
    },
    webhookRuntime: { register(rule) { assert.equal(rules.has(rule.id), false); rules.set(rule.id, rule); return () => rules.delete(rule.id); } },
    agents: { list: () => [...agents.values()], get: id => agents.get(id), create: publish, resume: publish },
    sessionPersistence: { stat: async id => stored.get(id), flush: async () => {} },
    agentPresets: { resolve: async id => ({ id }), standingKeyFor: async id => id, mount: async () => {} },
    permissionPresets: { resolve: () => ({}), set() {} }, sessionTitle: { rename() {} },
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
    workspaceRegistry: { get archivedSessionIds() { return [...archived]; }, archiveSession: async id => archived.add(id), create: async path => ({ path, attachSession: async () => {} }) },
  };
  const hub = createRuntimeHub(ctx, { defaultSource: 'bot-a' });
  async function add(source, options = {}) {
    const workspacePath = join(root, source, 'project'); mkdirSync(workspacePath, { recursive: true });
    const config = { source, workspacePath, historyRoot: join(root, source, 'history'), dailyResetHour: 4, dailyResetTimezone: 'UTC' };
    const history = await createHistoryStore({ root: config.historyRoot });
    const attempt = { source, closed: 0 }; attempts.push(attempt);
    const closeHistory = history.close.bind(history);
    history.close = () => { attempt.closed++; return closeHistory(); };
    const store = history.forUser({ source, tenantId: 'tenant', openId: 'same-user' }); store.confirmProfile('Alex');
    const replies = [];
    const client = { source, withSignal: (_signal, callback) => callback(), replyMessage: async (...args) => { replies.push(args); return { message_id: `reply-${source}` }; }, addMessageReaction: async () => ({}), deleteMessageReaction: async () => {}, ...options.client };
    const mediaApi = {
      downloadMessageResource: async (value, input) => { downloads.push([value.source, input.messageId]); return { data: Buffer.from(value.source) }; },
      uploadMessageFile: async (value, input) => { uploads.push([value.source, input.data.toString()]); return { file_key: `file-${value.source}` }; },
    };
    const dispose = await installFeishuRuntime(ctx, config, client, [{ name: 'feishu_shared_test', parameters: { type: 'object', properties: {} } }], async (_tool, _args, value) => value.source,
      { hub, history, mediaApi, now: () => Date.parse('2026-09-17T06:00:00Z'), ...options.runtimeOptions });
    const bot = { source, store, dispose, replies, workspacePath, async send({ messageId = 'same-message', text = source, attachments } = {}) {
      await rules.get(`feishu-message-handler:${source}`).run({ source, event: { payload: { parsed: { userText: text, messageId, senderId: 'same-user', tenantId: 'tenant', chatId: 'same-chat', attachments } } } }, new AbortController().signal);
      return agents.get(store.getCurrentSession('same-chat')?.sessionId);
    } };
    bots.push(bot); return bot;
  }
  const execute = async (name, agent, args = {}) => {
    for (const guard of [...guards, ...agent?.ownGuards || []]) {
      const rejection = guard({ name, agent }); if (rejection) throw new Error(rejection);
    }
    return tools.get(name).execute(args, { agent, signal: new AbortController().signal, callId: `${agent?.session.id}-${name}` });
  };
  const claim = async agent => { const message = agent.queue.shift(); await emit('agent/inbox/claimed', { agent, message, turn: ++agent.turn }); };
  const finish = async (agent, text) => {
    agent.events.push({ type: 'assistant/message', data: { turn: agent.turn, message: { content: [{ type: 'text', text }] } } });
    await emit('agent/turn-stopping', { agent, turn: agent.turn, signal: new AbortController().signal }); await agent.idle();
  };
  t.after(async () => { for (const bot of bots) await bot.dispose(); await hub.dispose(); rmSync(root, { recursive: true, force: true }); });
  return { add, execute, claim, finish, tools, guards, registrations, agents, stored, canceled, uploads, downloads, hub, ctx, listeners, rules, attempts };
}

test('two bots with identical sender/chat/message IDs isolate sessions, history, replies and shared credentials', async t => {
  const f = await fixture(t), a = await f.add('bot-a'), b = await f.add('bot-b');
  assert.equal(a.dispose.isBusy(), false); assert.equal(b.dispose.isBusy(), false);
  const [agentA, agentB] = await Promise.all([a.send(), b.send()]);
  assert.equal(a.dispose.isBusy(), true); assert.equal(b.dispose.isBusy(), true);
  assert.ok(agentA && agentB); assert.notEqual(agentA.session.id, agentB.session.id);
  assert.notEqual(agentA.session.header.cwd, agentB.session.header.cwd);
  assert.equal(f.guards.size, 1); assert.ok([...f.registrations.values()].every(count => count === 1));
  assert.equal(a.store.searchMessages({ query: 'bot-b' }).length, 0);
  assert.equal(b.store.searchMessages({ query: 'bot-a' }).length, 0);
  await a.send(); await b.send(); assert.equal(agentA.queue.length, 1); assert.equal(agentB.queue.length, 1);
  assert.equal((await f.execute('feishu_history_search', agentA, { query: 'bot-b' })).data.length, 0);
  await assert.rejects(f.execute('feishu_shared_test', agentA), /unavailable/);
  assert.equal((await f.execute('feishu_shared_test', { session: { id: 'ordinary-session' } })).data, 'bot-a');
  await assert.rejects(f.execute('feishu_history_search', { session: { id: 'feishu-user-unknown' } }), /not authorized/);
  await f.claim(agentA); await f.claim(agentB);
  await f.finish(agentA, 'answer-a');
  assert.equal(a.dispose.isBusy(), false); assert.equal(b.dispose.isBusy(), true);
  await f.finish(agentB, 'answer-b');
  assert.deepEqual(a.replies, [['same-message', 'answer-a']]); assert.deepEqual(b.replies, [['same-message', 'answer-b']]);
});

test('attachments and workspace tools use the owning bot client and project', async t => {
  const f = await fixture(t), a = await f.add('bot-a'), b = await f.add('bot-b');
  const attachments = [{ kind: 'file', key: 'same-key', filename: 'same.txt' }];
  const [agentA, agentB] = await Promise.all([a.send({ attachments }), b.send({ attachments })]);
  assert.deepEqual(f.downloads.sort(), [['bot-a', 'same-message'], ['bot-b', 'same-message']]);
  await f.claim(agentA); await f.claim(agentB);
  for (const [agent, value] of [[agentA, 'a-private'], [agentB, 'b-private']]) {
    await f.execute('feishu_workspace_write', agent, { path: 'answer.txt', text: value });
    await f.execute('feishu_send_file', agent, { path: 'answer.txt', kind: 'file' });
  }
  assert.deepEqual(f.uploads, [['bot-a', 'a-private'], ['bot-b', 'b-private']]);
  assert.equal(a.replies[0][2], 'file'); assert.equal(b.replies[0][2], 'file');
  assert.match(JSON.stringify(a.replies), /file-bot-a/); assert.doesNotMatch(JSON.stringify(a.replies), /file-bot-b/);
  assert.match(JSON.stringify(b.replies), /file-bot-b/);
  await assert.rejects(f.execute('feishu_workspace_read', agentA, { path: agentB.session.header.cwd + '/answer.txt' }), /relative/);
});

test('stopping one bot cancels only its sessions and never changes the default shared credential target', async t => {
  const f = await fixture(t), a = await f.add('bot-a'), b = await f.add('bot-b');
  const agentA = await a.send(), agentB = await b.send(); await f.claim(agentA); await f.claim(agentB);
  await b.dispose();
  assert.ok(f.canceled.includes(agentB.session.id)); assert.ok(!f.canceled.includes(agentA.session.id));
  assert.equal(agentA.status, 'running'); assert.equal(f.guards.size, 1);
  assert.equal((await f.execute('feishu_history_search', agentA, { query: 'bot-a' })).data.length, 1);
  await assert.rejects(f.execute('feishu_history_search', agentB), /not authorized/);
  await f.finish(agentA, 'still-working'); assert.deepEqual(a.replies, [['same-message', 'still-working']]);
  assert.equal((await f.execute('feishu_shared_test', { session: { id: 'ordinary' } })).data, 'bot-a');
  const c = await f.add('bot-c'); await c.send(); await a.dispose();
  await assert.rejects(f.execute('feishu_shared_test', { session: { id: 'ordinary' } }), /No Feishu bot/);
});

test('hub rejects duplicate sources and cross-bot session claims and inspection', async t => {
  const f = await fixture(t);
  const a = f.hub.attach({ source: 'one', isAuthorized: () => true, allowedTools: [] });
  const b = f.hub.attach({ source: 'two', isAuthorized: () => true, allowedTools: [] });
  assert.throws(() => f.hub.attach({ source: 'one', isAuthorized: () => true, allowedTools: [] }), /unique/);
  a.claim('feishu-user-claimed');
  assert.throws(() => b.claim('feishu-user-claimed'), /another bot/);
  assert.throws(() => b.host.getLive('feishu-user-claimed'), /another bot/);
  assert.throws(() => b.host.retire('feishu-user-claimed'), /another bot/);
  assert.throws(() => a.claim('ordinary-session'), /ownership/);
  await a.host.dispose(); await b.host.dispose();
});

for (const point of ['tool', 'host event', 'runtime event', 'rule']) {
  test(`failed ${point} registration rolls back this bot and permits a same-source retry`, async t => {
    const f = await fixture(t);
    const other = ['runtime event', 'rule'].includes(point) ? await f.add('bot-a') : null;
    const otherAgent = other ? await other.send() : null;
    const counts = () => ({ tools: f.tools.size, guards: f.guards.size, rules: f.rules.size, listeners: [...f.listeners.values()].reduce((sum, values) => sum + values.size, 0) });
    const baseline = counts();
    let restore;
    if (point === 'tool') {
      const original = f.ctx.tools.register;
      f.ctx.tools.register = tool => { if (tool.name === 'feishu_history_get') throw new Error('injected tool failure'); return original(tool); };
      restore = () => { f.ctx.tools.register = original; };
    } else if (point.endsWith('event')) {
      const original = f.ctx.on;
      f.ctx.on = (name, handler) => {
        if (name === (point === 'host event' ? 'agent/created' : 'agent/inbox/discarded')) throw new Error('injected event failure');
        return original(name, handler);
      };
      restore = () => { f.ctx.on = original; };
    } else {
      const original = f.ctx.webhookRuntime.register;
      f.ctx.webhookRuntime.register = () => { throw new Error('injected rule failure'); };
      restore = () => { f.ctx.webhookRuntime.register = original; };
    }
    await assert.rejects(f.add('bot-b'), /injected/);
    assert.deepEqual(counts(), baseline);
    assert.equal(f.attempts.at(-1).closed, 1);
    if (otherAgent) {
      assert.equal(otherAgent.status, 'running'); assert.ok(!f.canceled.includes(otherAgent.session.id));
      assert.equal((await f.execute('feishu_history_search', otherAgent, { query: 'bot-a' })).data.length, 1);
    }
    restore();
    const retry = await f.add('bot-b');
    assert.ok(await retry.send());
    assert.equal(retry.dispose.isBusy(), true);
  });
}

test('busy tracking includes oversized-message replies outside the session admission lock', async t => {
  const f = await fixture(t);
  let sent, release;
  const started = new Promise(resolve => { sent = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  const observed = [];
  const bot = await f.add('bot-a', {
    client: { replyMessage: async () => { sent(); await hold; return { message_id: 'reply' }; } },
    runtimeOptions: { onDeliveryStart: delivery => observed.push(delivery.source) },
  });
  const task = bot.send({ text: 'x'.repeat(512 * 1024 + 1) });
  await started;
  assert.equal(bot.dispose.isBusy(), true);
  assert.deepEqual(observed, ['bot-a']);
  const rule = f.rules.get('feishu-message-handler:bot-a');
  await rule.run({ source: 'another-bot' }, new AbortController().signal);
  assert.deepEqual(observed, ['bot-a']);
  release(); await task;
  assert.equal(bot.dispose.isBusy(), false);
  assert.equal(f.agents.size, 0);
});
