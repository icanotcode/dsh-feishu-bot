import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createConversationFixture } from '../test-support/conversation-fixture.mjs';
import { createMailUserFlow } from '../lib/mail-user-flow.js';
import { SmtpMailError } from '../lib/smtp-mail.js';

async function fixture(t, options = {}) {
  const secrets = new Map();
  const credentials = { resolve: async ref => secrets.has(ref) ? { value: secrets.get(ref), source: 'file' } : undefined,
    set: async (ref, value) => secrets.set(ref, value), unset: async ref => secrets.delete(ref) };
  const verifications = [], sends = [];
  const flow = createMailUserFlow({ credentials }, { verify: async (...args) => { verifications.push(args); return { verified: true }; } });
  const app = await createConversationFixture(t, { context: { credentials }, mail: { flow,
    send: async (...args) => { sends.push(args); return options.send ? options.send(...args) : { status: 'accepted', accepted: args[2].to, rejected: [] }; } } });
  const execute = (name, agent, args = {}, callId = name) => app.tools.get(name).execute(args, { agent, callId, signal: new AbortController().signal });
  async function setup(user = 'alice', chatId = 'chat-a') {
    for (const text of ['/mail', `${user}@example.com`, '/mail server smtp.example.com 465 tls', `/mail code test-only-${user}-auth`, `recipient-${user}@example.com`]) await app.send({ senderId: user, chatId, text });
  }
  async function active(user = 'alice', chatId = 'chat-a', text = '请发送邮件：主题测试，正文你好', messageId) {
    await app.send({ senderId: user, chatId, text, messageId });
    const agent = app.agents.get(app.store(user).getCurrentSession(chatId).sessionId);
    await app.claim(agent); return agent;
  }
  return { ...app, setup, active, execute, secrets, sends, verifications, flow };
}

test('ordinary messages load the skill without requiring a mailbox; natural email requests can start isolated setup', async t => {
  const f = await fixture(t);
  await f.send({ text: '你好' });
  const agent = [...f.agents.values()][0];
  assert.match(JSON.stringify(agent.queue), /飞书薄代理入口/);
  await f.claim(agent);
  const status = await f.execute('feishu_mail_status', agent);
  assert.equal(status.data.stage, 'unbound');
  assert.equal(f.verifications.length, 0);
  const setup = await f.execute('feishu_mail_setup', agent);
  assert.match(setup.data.reply, /本人.*邮箱/);
  await f.finish(agent);
  await f.send({ text: 'alice@example.com' });
  await f.send({ text: '/mail server smtp.example.com 587 starttls' });
  await f.send({ text: 'test-only-plain-auth' });
  await f.send({ text: 'target@example.com' });
  assert.equal(f.verifications[0][1], 'test-only-plain-auth');
  assert.equal(f.verifications[0][0].host, 'smtp.example.com');
  assert.equal(f.verifications[0][0].port, 587);
  assert.equal(f.verifications[0][0].mode, 'starttls');
  assert.deepEqual(f.store().searchMessages({ query: 'test-only-plain-auth' }), []);
  assert.equal(JSON.stringify(f.replies).includes('test-only-plain-auth'), false);
  assert.equal(f.sends.length, 0, 'verification must never send a test email');
});

test('personal SMTP tools use the bound sender and recipient, constrain attachments, and deduplicate repeated calls', async t => {
  const f = await fixture(t); await f.setup();
  const agent = await f.active();
  const cwd = agent.session.header.cwd;
  await writeFile(join(cwd, 'report.txt'), 'report content');
  const args = { subject: 'Report', text: 'Please see the report.', attachmentPaths: ['report.txt'] };
  const first = await f.execute('feishu_send_email', agent, args, 'first');
  const second = await f.execute('feishu_send_email', agent, args, 'retry');
  assert.deepEqual(first, second); assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0][0].from, 'alice@example.com');
  assert.equal(f.sends[0][1], 'test-only-alice-auth');
  assert.deepEqual(f.sends[0][2].to, ['recipient-alice@example.com']);
  assert.equal(f.sends[0][2].attachments[0].content.toString(), 'report content');
  assert.equal(JSON.stringify(first).includes('test-only-alice-auth'), false);
  await assert.rejects(() => f.execute('feishu_send_email', agent, { ...args, to: ['attacker@example.com'] }), /additional|unexpected|unknown|allowed/i);
  await assert.rejects(() => f.execute('feishu_send_email', agent, { ...args, attachmentPaths: ['../outside.txt'] }), /escape|relative/i);
  const linked = join(cwd, 'linked.txt'); await symlink(join(cwd, 'report.txt'), linked, process.platform === 'win32' ? 'file' : undefined);
  await assert.rejects(() => f.execute('feishu_send_email', agent, { ...args, attachmentPaths: ['linked.txt'] }), /link/i);
  assert.equal(f.sends.length, 1);
  assert.equal(f.store().searchMessages({ query: '邮件提交记录' }).length, 1);
  assert.deepEqual(f.store().searchMessages({ query: 'test-only-alice-auth' }), []);
  await f.finish(agent);
  await assert.rejects(() => f.execute('feishu_send_email', agent, args), /正在处理/);
});

test('two users cannot send from each other’s mailbox or query mailbox details from a different chat', async t => {
  const f = await fixture(t); await f.setup('alice'); await f.setup('bob', 'chat-b');
  const alice = await f.active(); const bob = await f.active('bob', 'chat-b');
  await f.execute('feishu_send_email', alice, { subject: 'Alice', text: 'a' });
  await f.execute('feishu_send_email', bob, { subject: 'Bob', text: 'b' });
  assert.deepEqual(f.sends.map(call => [call[0].from, call[1], call[2].to[0]]), [
    ['alice@example.com', 'test-only-alice-auth', 'recipient-alice@example.com'],
    ['bob@example.com', 'test-only-bob-auth', 'recipient-bob@example.com'],
  ]);
  await f.finish(alice); await f.finish(bob);
  await f.send({ text: '普通群聊', chatId: 'group-a', chatType: 'group' });
  const group = f.agents.get(f.store().getCurrentSession('group-a').sessionId); await f.claim(group);
  await assert.rejects(() => f.execute('feishu_mail_status', group), /私聊/);
  await assert.rejects(() => f.execute('feishu_send_email', group, { subject: 'No', text: 'No' }), /私聊/);
  assert.equal(f.sends.length, 2);
});

test('uncertain SMTP results stay deduplicated across runtime restart and never claim delivered', async t => {
  const f = await fixture(t, { send: async () => { throw new SmtpMailError('TIMEOUT', 'SMTP提交结果不确定', { uncertain: true }); } });
  await f.setup(); const agent = await f.active('alice', 'chat-a', '请发邮件', 'email-message');
  const args = { subject: 'One attempt', text: 'one' };
  const first = await f.execute('feishu_send_email', agent, args);
  assert.equal(first.data.uncertain, true); assert.equal(first.data.status, 'unknown');
  await f.finish(agent); await f.restart();
  assert.equal((await f.flow.getStatus({ source: 'test', tenantId: 'tenant', openId: 'alice' })).stage, 'ready');
  // Replay the same source turn directly through a freshly created bridge: the SQLite ledger survives.
  const { createMailBridge } = await import('../lib/mail-bridge.js');
  const bridge = createMailBridge(f.ctx, f.config, { flow: f.flow, send: async () => assert.fail('must not send twice') });
  const current = f.store().getCurrentSession('chat-a');
  const result = await bridge.execute('feishu_send_email', args, { identity: { source: 'test', tenantId: 'tenant', openId: 'alice' }, store: f.store(), sessionId: current.sessionId, chatId: 'chat-a', workspacePath: agent.session.header.cwd },
    { messageId: 'email-message', turn: 'replay', chatType: 'p2p' }, { signal: new AbortController().signal, checkActive() {} });
  assert.deepEqual(result, first.data); assert.equal(f.sends.length, 1);
});
