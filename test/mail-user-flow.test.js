import test from 'node:test';
import assert from 'node:assert/strict';
import { createMailUserFlow } from '../lib/mail-user-flow.js';

const alice = { source: 'bot-a', tenantId: 'tenant-a', openId: 'ou_alice' };
const bob = { ...alice, openId: 'ou_bob' };
function fixture(options = {}) {
  const values = new Map();
  const verified = [];
  const ctx = { credentials: {
    async resolve(ref) { return values.get(ref); },
    async set(ref, value) { values.set(ref, { value, source: 'store' }); },
    async unset(ref) { values.delete(ref); },
  } };
  const flow = createMailUserFlow(ctx, { verify: async (...args) => { verified.push(args); }, ...options });
  const handle = (text, extra = {}, identity = alice) => flow.handle(identity, { text, chatId: 'private-a', chatType: 'p2p', ...extra });
  async function ready(identity = alice, secret = 'smtp-only-secret') {
    await handle('/mail', {}, identity);
    await handle('sender@example.com', {}, identity);
    await handle('/mail code [removed]', { secret }, identity);
    await handle('recipient@example.com', {}, identity);
  }
  return { ctx, values, flow, handle, verified, ready };
}

test('ordinary conversation passes through until email is requested; mandatory gate is opt-in', async () => {
  const app = fixture();
  assert.deepEqual(await app.handle('你好'), { handled: false });
  assert.equal(app.values.size, 0);
  assert.match((await app.handle('帮我发邮件', { requireSetup: true })).reply, /飞书邮箱/);
  assert.equal((await app.flow.getStatus(alice)).stage, 'awaiting_email');
  assert.equal((await app.handle('先回答别的问题')).handled, true);
  assert.equal((await app.handle('/mail cancel')).handled, true);
  assert.deepEqual(await app.handle('现在聊别的'), { handled: false });
});

test('verified account and recipient survive restart in credentials, with no public secret', async () => {
  const app = fixture();
  await app.ready();
  assert.equal(app.values.size, 1);
  assert.match([...app.values.keys()][0], /^FEISHU_USER_MAIL_[A-F0-9]{64}$/);
  assert.deepEqual(app.verified[0], [{ host: 'smtp.feishu.cn', port: 465, mode: 'tls', user: 'sender@example.com', from: 'sender@example.com' }, 'smtp-only-secret', { signal: undefined }]);
  const restarted = createMailUserFlow(app.ctx);
  assert.deepEqual(await restarted.getStatus(alice), { stage: 'ready', bound: true, email: 'sender@example.com', recipient: 'recipient@example.com' });
  assert.deepEqual(await restarted.getIngressState(alice), { stage: 'ready', chatId: 'private-a' });
  assert.equal((await restarted.getAccount(alice)).password, 'smtp-only-secret');
  assert.equal((await restarted.getAccount(alice)).chatId, 'private-a');
  assert.deepEqual(await restarted.getStatus(alice, { chatId: 'private-a' }), await restarted.getStatus(alice));
  await assert.rejects(restarted.getStatus(alice, { chatId: 'private-other' }), /绑定邮箱的私聊/);
  assert.doesNotMatch(JSON.stringify(await app.handle('/mail status')), /smtp-only-secret/);
  assert.deepEqual(await app.handle('邮件正文'), { handled: false });
});

test('same sender remains separate across bots, tenants, and users', async () => {
  const app = fixture();
  await app.ready();
  for (const identity of [bob, { ...alice, source: 'bot-b' }, { ...alice, tenantId: 'tenant-b' }]) {
    assert.equal(await app.flow.getAccount(identity), null);
    assert.deepEqual(await app.flow.getStatus(identity), { stage: 'unbound', bound: false });
    await app.handle('/mail', {}, identity);
  }
  assert.equal(app.values.size, 4);
  assert.equal((await app.flow.getAccount(alice)).recipient, 'recipient@example.com');
});

test('groups cannot start, steal, reset, inspect or advance a private binding', async () => {
  const app = fixture();
  await app.ready();
  for (const command of ['/mail', '/mail setup', '/mail status', '/mail reset', '/mail cancel', '/mail to victim@example.com', '/mail code [removed]']) {
    assert.match((await app.handle(command, { chatType: 'group', chatId: 'group-a', secret: 'never-store' })).reply, /私聊/);
  }
  assert.equal((await app.flow.getAccount(alice)).recipient, 'recipient@example.com');
  assert.equal(app.verified.length, 1);
  assert.doesNotMatch(JSON.stringify([...app.values]), /never-store/);
  assert.deepEqual(await app.handle('正常群聊', { chatType: 'group' }), { handled: false });
});

test('a different private chat cannot consume a pending flow', async () => {
  const app = fixture();
  await app.handle('/mail');
  await app.handle('sender@example.com');
  for (const text of ['/mail', '/mail code [removed]', 'other@example.com']) {
    assert.match((await app.handle(text, { chatId: 'private-other', secret: 'wrong-chat-secret' })).reply, /最初/);
  }
  assert.equal(app.verified.length, 0);
  assert.equal((await app.flow.getStatus(alice)).stage, 'awaiting_code');
});

test('only explicit ingress secret is verified; arbitrary text never becomes a password', async () => {
  const app = fixture();
  await app.handle('/mail setup');
  await app.handle('sender@example.com');
  assert.match((await app.handle('plain-secret')).reply, /\/mail code/);
  assert.match((await app.handle('/mail code raw-unintercepted-secret')).reply, /\/mail code/);
  assert.equal(app.verified.length, 0);
  assert.doesNotMatch(JSON.stringify([...app.values]), /plain-secret|raw-unintercepted-secret/);
  await app.handle('[removed]', { secret: 'intercepted-secret' });
  assert.equal(app.verified[0][1], 'intercepted-secret');
  assert.equal((await app.flow.getStatus(alice)).stage, 'awaiting_recipient');
  assert.equal(await app.flow.getAccount(alice), null);
});

test('SMTP failures never persist or echo secrets and allow retry', async () => {
  let fail = true;
  const app = fixture({ verify: async (_, secret) => { if (fail) throw new Error(`server leaked ${secret}`); } });
  await app.handle('/mail');
  await app.handle('sender@example.com');
  const reply = await app.handle('/mail code [removed]', { secret: 'reject-secret' });
  assert.match(reply.reply, /验证失败/);
  assert.doesNotMatch(JSON.stringify(reply), /reject-secret|server leaked/);
  assert.doesNotMatch(JSON.stringify([...app.values]), /reject-secret/);
  assert.equal((await app.flow.getStatus(alice)).stage, 'awaiting_code');
  fail = false;
  await app.handle('/mail code [removed]', { secret: 'accepted-secret' });
  assert.equal((await app.flow.getStatus(alice)).stage, 'awaiting_recipient');
});

test('only one bare address is accepted for sender and recipient', async () => {
  const app = fixture();
  await app.handle('/mail');
  for (const text of ['Name <a@example.com>', 'a@example.com,b@example.com', 'a@example.com\r\nBcc:b@example.com', 'smtp://example.com', 'a@localhost']) {
    await app.handle(text);
    assert.equal((await app.flow.getStatus(alice)).stage, 'awaiting_email');
  }
  await app.handle('sender@example.com');
  await app.handle('/mail code [removed]', { secret: 'valid-secret' });
  await app.handle('a@example.com,b@example.com');
  assert.equal((await app.flow.getStatus(alice)).stage, 'awaiting_recipient');
  await app.handle('/mail to destination@example.com');
  assert.equal((await app.flow.getStatus(alice)).recipient, 'destination@example.com');
  await app.handle('/mail to evil@example.com\nBcc:b@example.com');
  assert.equal((await app.flow.getStatus(alice)).recipient, 'destination@example.com');
});

test('cancel clears incomplete secrets, reset clears complete binding, forget is identity-scoped', async () => {
  const app = fixture();
  await app.ready(bob, 'bob-secret');
  await app.handle('/mail');
  await app.handle('sender@example.com');
  await app.handle('/mail code [removed]', { secret: 'alice-secret' });
  await app.handle('/mail cancel');
  assert.equal(await app.flow.getAccount(alice), null);
  assert.doesNotMatch(JSON.stringify([...app.values]), /alice-secret/);
  await app.ready();
  await app.handle('/mail cancel');
  assert.ok(await app.flow.getAccount(alice));
  await app.handle('/mail reset');
  assert.equal(await app.flow.getAccount(alice), null);
  assert.equal((await app.flow.getAccount(bob)).password, 'bob-secret');
  await app.flow.forget(bob);
  assert.equal(app.values.size, 0);
});

test('environment-provided states cannot be overwritten or unset; storage errors are sanitized', async () => {
  const app = fixture();
  await app.ready();
  const ref = [...app.values.keys()][0];
  const original = app.values.get(ref).value;
  app.values.set(ref, { value: original, source: 'env' });
  for (const command of ['/mail reset', '/mail setup', '/mail to changed@example.com']) assert.match((await app.handle(command)).reply, /凭据服务/);
  assert.equal(app.values.get(ref).value, original);
  await assert.rejects(app.flow.forget(alice), /凭据服务/);
  app.ctx.credentials.resolve = async () => { throw new Error('database secret-password leaked'); };
  assert.doesNotMatch(JSON.stringify(await app.handle('/mail')), /secret-password/);
  await assert.rejects(app.flow.getAccount(alice), error => !error.message.includes('secret-password'));
});

test('per-user serialization keeps cancel behind verification and releases other users', async () => {
  let release;
  let started;
  const verifying = new Promise(resolve => { started = resolve; });
  const app = fixture({ verify: async () => { started(); await new Promise(resolve => { release = resolve; }); } });
  await app.handle('/mail');
  await app.handle('sender@example.com');
  const binding = app.handle('/mail code [removed]', { secret: 'in-flight-secret' });
  await verifying;
  assert.deepEqual(await app.flow.getIngressState(alice), { stage: 'awaiting_code', chatId: 'private-a' });
  const cancelled = app.handle('/mail cancel');
  assert.match((await app.handle('/mail', {}, bob)).reply, /飞书邮箱/);
  release();
  await binding;
  await cancelled;
  assert.equal((await app.flow.getStatus(alice)).stage, 'unbound');
  assert.doesNotMatch(JSON.stringify([...app.values]), /in-flight-secret/);
});

test('malformed persisted credentials fail closed with no leaked raw value', async () => {
  const app = fixture();
  await app.handle('/mail');
  const ref = [...app.values.keys()][0];
  app.values.set(ref, { source: 'store', value: '{secret-parse-failure' });
  const result = await app.handle('ordinary text');
  assert.equal(result.handled, true);
  assert.match(result.reply, /凭据服务/);
  assert.doesNotMatch(result.reply, /secret-parse-failure/);
  assert.match((await app.handle('/mail reset')).reply, /已清除/);
  assert.equal(app.values.size, 0);
});

test('aborting verification rejects the operation and never persists the password', async () => {
  const controller = new AbortController();
  let passedSignal;
  const app = fixture({ verify: async (_, secret, { signal }) => { passedSignal = signal; controller.abort(); } });
  await app.handle('/mail');
  await app.handle('sender@example.com');
  await assert.rejects(app.handle('/mail code', { secret: 'must-not-save', signal: controller.signal }), { name: 'AbortError' });
  assert.equal(passedSignal, controller.signal);
  assert.equal((await app.flow.getStatus(alice)).stage, 'awaiting_code');
  assert.doesNotMatch(JSON.stringify([...app.values]), /must-not-save/);
  await assert.rejects(app.handle('/mail reset', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal((await app.flow.getStatus(alice)).stage, 'awaiting_code');
});

test('aborting while checking writable credentials prevents the state mutation', async () => {
  const app = fixture();
  const controller = new AbortController();
  let reads = 0;
  app.ctx.credentials.resolve = async () => { if (++reads === 2) controller.abort(); return undefined; };
  await assert.rejects(app.handle('/mail', { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(app.values.size, 0);
});
