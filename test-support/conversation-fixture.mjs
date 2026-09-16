import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHistoryStore } from '../lib/history-store.js';
import { installFeishuRuntime } from '../lib/runtime.js';

/** Real SQLite history with an explicitly driven Harness inbox/turn lifecycle. */
export async function createConversationFixture(t, options = {}) {
  const root = options.root ?? mkdtempSync(join(tmpdir(), 'feishu-conversation-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  let clock = options.now ?? Date.parse('2026-09-16T06:00:00Z');
  let sequence = 0;
  const listeners = new Map();
  const tools = new Map();
  const replies = [];
  const reactions = [];
  const warnings = [];
  const archived = new Set();
  const config = {
    source: 'test', workspacePath: workspace, historyRoot: join(root, 'history'),
    agentPreset: 'standard', permissionPreset: 'workspace-write', dailyResetTimezone: 'UTC', dailyResetHour: 4,
    authorizedUsers: [{ openId: 'alice', displayName: 'Alice' }, { openId: 'bob', displayName: 'Bob' }],
    ...options.config,
  };
  let rule;
  const fire = (name, payload) => [...listeners.get(name) ?? []].map(fn => fn(payload));
  const emit = async (name, payload) => { await Promise.all(fire(name, payload)); };
  const ctx = {
    logger: { warn: text => warnings.push(text), info() {}, debug() {} },
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
      return () => listeners.get(name)?.delete(fn);
    },
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    webhookRuntime: { register(value) { rule = value; return async () => {}; } },
    ...options.context,
  };
  const client = {
    withSignal: (_signal, run) => run(),
    replyMessage: async (...args) => { replies.push(args); },
    addMessageReaction: async (...args) => { reactions.push(['add', ...args]); return { reaction_id: `reaction-${reactions.length}` }; },
    deleteMessageReaction: async (...args) => { reactions.push(['delete', ...args]); },
    ...options.client,
  };
  const fixture = { root, config, ctx, listeners, tools, replies, reactions, warnings, client, emit, archived };
  function makeHost() {
    const agents = new Map();
    const calls = [];
    function createAgent(request) {
      const waiters = [];
      const events = [];
      const agent = {
        session: { id: request.sessionId, header: { cwd: request.workspacePath }, snapshotEvents: () => [...events] },
        queue: [], status: 'idle', turn: 0, events,
        followup(message) {
          agent.queue.push(message);
          fire('agent/inbox/inserted', { agent, message });
          if (agent.status !== 'running') { agent.status = 'running'; fire('agent/status', { agent, status: 'running' }); }
        },
        whenIdle: () => agent.status === 'idle' ? Promise.resolve() : new Promise(resolve => waiters.push(resolve)),
        cancel() {
          for (const message of agent.queue.splice(0)) fire('agent/inbox/discarded', { agent, message });
          agent.status = 'idle';
          fire('agent/status', { agent, status: 'idle' });
          for (const resolve of waiters.splice(0)) resolve();
        },
        async idle() {
          agent.status = 'idle';
          await emit('agent/status', { agent, status: 'idle' });
          for (const resolve of waiters.splice(0)) resolve();
        },
      };
      return agent;
    }
    const host = {
      agents, calls,
      isArchived: id => archived.has(id),
      async getOrCreate(request) {
        calls.push(request);
        if (!agents.has(request.sessionId)) agents.set(request.sessionId, createAgent(request));
        return { agent: agents.get(request.sessionId), dispose: async () => agents.delete(request.sessionId) };
      },
      async release(id) {
        const agent = agents.get(id);
        if (!agent || agent.status !== 'idle') return false;
        agents.delete(id);
        await emit('agent/disposed', { agent });
        return true;
      },
      async dispose() {
        for (const agent of agents.values()) agent.cancel();
        agents.clear();
      },
    };
    return host;
  }
  async function start() {
    fixture.history = await createHistoryStore({ root: config.historyRoot });
    for (const [openId, displayName] of options.profiles ?? [['alice', 'Alice'], ['bob', 'Bob']]) {
      const store = fixture.history.forUser({ source: config.source, tenantId: 'tenant', openId });
      if (!store.getProfile()) store.confirmProfile(displayName);
    }
    fixture.host = options.host ?? makeHost();
    fixture.agents = fixture.host.agents;
    fixture.dispose = await installFeishuRuntime(ctx, config, client, options.tools ?? [], options.executeTool ?? (async () => null), {
      history: fixture.history, host: fixture.host, now: () => clock, mediaApi: options.mediaApi,
    });
  }
  fixture.send = async ({ text = 'hello', senderId = 'alice', chatId = 'chat-a', messageId, deliveryId, tenantId = 'tenant', timestamp, signal, attachments, attachmentError, msgType } = {}) => {
    messageId ??= `message-${++sequence}`;
    deliveryId ??= `delivery-${messageId}`;
    await rule.run({ kind: 'feishu', source: config.source, deliveryId, receivedAt: clock,
      event: { payload: { parsed: { userText: text, senderId, chatId, messageId, tenantId, ...(timestamp ? { timestamp } : {}), ...(attachments ? { attachments } : {}), ...(attachmentError ? { attachmentError } : {}), ...(msgType ? { msgType } : {}) } } },
    }, signal ?? new AbortController().signal);
    return { messageId, deliveryId };
  };
  fixture.claim = async (agent, message = agent.queue.shift(), turn = ++agent.turn) => {
    agent.turn = turn;
    await emit('agent/inbox/claimed', { agent, message, turn });
    return { message, turn };
  };
  fixture.finish = async (agent, text = 'answer', turn = agent.turn, signal = new AbortController().signal) => {
    agent.events.push({ type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text }] } } });
    await emit('agent/turn-stopping', { agent, turn, signal });
    if (!agent.queue.length) await agent.idle();
  };
  fixture.idle = agent => agent.idle();
  fixture.advance = milliseconds => { clock += milliseconds; };
  fixture.setNow = value => { clock = value; };
  fixture.store = (openId = 'alice', tenantId = 'tenant') => fixture.history.forUser({ source: config.source, tenantId, openId });
  fixture.restart = async () => { await fixture.dispose(); await start(); };
  await start();
  t.after(async () => { await fixture.dispose(); rmSync(root, { recursive: true, force: true }); });
  return fixture;
}
