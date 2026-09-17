import test from 'node:test';
import assert from 'node:assert/strict';
import { createMailUserFlow, parseSmtpServerCommand } from '../lib/mail-user-flow.js';

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
    await handle('/mail server smtp.example.com 465 tls', {}, identity);
    await handle('/mail code [removed]', { secret }, identity);
    await handle('recipient@example.com', {}, identity);
  }
  return { ctx, values, flow, handle, verified, ready };
}

test('ordinary conversation passes through until email is requested; mandatory gate is opt-in', async () => {
  const app = fixture();
  assert.deepEqual(await app.handle('你好'), { handled: false });
  assert.equal(app.values.size, 0);
  assert.match((await app.handle('帮我发邮件', { requireSetup: true })).reply, /发件邮箱/);
  assert.equal((await app.flow.getStatus(alice)).stage, 'awaiting_email');
  assert.equal((await app.handle('先回答别的问题')).handled, true);
  assert.equal((await app.handle('/mail cancel')).handled, true);
  assert.deepEqual(await app.handle('现在聊别的'), { handled: false });
});

test('unknown provider discovery probes without credentials then requests the code and retains the pending task', async () => {
  const calls = [];
  const app = fixture({
    discover: async (...args) => { calls.push(['discover', ...args]); return { status: 'found', smtp: { host: 'submission.company.example', port: 587, mode: 'starttls' } }; },
    probe: async (...args) => { calls.push(['probe', ...args]); return { verified: true }; },
  });
  await app.handle('/mail setup', { pendingRequest: { messageId: 'send-original', requestText: 'Send my report.', recipient: 'to@example.com' } });
  const step = await app.handle('sender@company.example');
  assert.equal(step.discover, true);
  assert.equal((await app.flow.getIngressState(alice)).stage, 'awaiting_discovery');
  await app.handle('/mail code', { secret: 'premature-secret' });
  assert.equal(app.verified.length, 0);
  const result = await app.flow.discover(alice, { chatId: 'private-a' });
  assert.match(result.reply, /授权码/);
  assert.equal(calls[0][1], 'sender@company.example');
  assert.equal(calls[1][1].host, 'submission.company.example');
  assert.doesNotMatch(JSON.stringify(calls), /premature-secret|password/);
  assert.equal((await app.flow.getStatus(alice)).stage, 'awaiting_code');
  assert.equal(app.verified.length, 0);
  const completed = await app.handle('/mail code', { secret: 'real-test-code' });
  assert.deepEqual(completed.resume, { messageId: 'send-original', requestText: 'Send my report.' });
  assert.equal(app.verified[0][2].publicOnly, true);
  assert.equal((await app.flow.getAccount(alice)).publicOnly, true);
  await app.flow.discover(alice, { chatId: 'private-a' });
  assert.equal(calls.length, 2, 'ready bindings are not reconfigured by a repeated discovery call');
});

test('unavailable discovery and failed TLS probing keep the task without asking for SMTP parameters', async () => {
  for (const probeFails of [false, true]) {
    const app = fixture({ discover: async () => probeFails ? { status: 'found', smtp: { host: 'smtp.company.example', port: 465, mode: 'tls' } } : { status: 'not_found' },
      probe: async () => { throw new Error('private diagnostic'); } });
    await app.handle('/mail setup', { pendingRequest: { messageId: 'send-original', requestText: 'Send the report.' } });
    await app.handle('sender@company.example');
    const failed = await app.flow.discover(alice, { chatId: 'private-a' });
    assert.equal(failed.webSearchRequired, true);
    assert.match(failed.reply, /搜索/);
    assert.doesNotMatch(failed.reply, /\/mail server|private diagnostic/);
    assert.equal((await app.flow.getStatus(alice)).stage, 'awaiting_discovery');
    assert.equal((await app.handle('/mail retry')).discover, true);
    assert.match(JSON.stringify([...app.values]), /send-original/);
    assert.equal(app.verified.length, 0);
    assert.equal(await app.flow.getAccount(alice), null);
  }
});

test('discovery probes published alternates without credentials when the primary endpoint is unavailable', async () => {
  const primary = { host: 'primary.example.com', port: 465, mode: 'tls' };
  const alternate = { host: 'alternate.example.com', port: 587, mode: 'starttls' };
  const tried = [];
  const app = fixture({ discover: async () => ({ status: 'found', smtp: primary, candidates: [{ smtp: primary }, { smtp: alternate }] }),
    probe: async config => { tried.push(config.host); if (config.host === primary.host) throw new Error('unavailable'); } });
  await app.handle('/mail'); await app.handle('sender@company.example');
  assert.match((await app.flow.discover(alice, { chatId: 'private-a' })).reply, /授权码/);
  assert.deepEqual(tried, [primary.host, alternate.host]);
  assert.equal(app.verified.length, 0);
  await app.handle('/mail code', { secret: 'test-code' });
  assert.equal(app.verified[0][0].host, alternate.host);
});

test('discovery is bound to the current user and private chat, and abort never saves a discovered server', async () => {
  const abort = new AbortController();
  let calls = 0;
  const app = fixture({ discover: async () => { calls++; abort.abort(); return { status: 'found', smtp: { host: 'smtp.company.example', port: 465, mode: 'tls' } }; }, probe: async () => assert.fail('cancelled before probing') });
  await app.handle('/mail'); await app.handle('sender@company.example');
  await app.flow.discover(bob, { chatId: 'private-a' });
  await app.flow.discover(alice, { chatId: 'different-private' });
  assert.equal(calls, 0);
  await assert.rejects(app.flow.discover(alice, { chatId: 'private-a', signal: abort.signal }), { name: 'AbortError' });
  assert.equal((await app.flow.getStatus(alice)).stage, 'awaiting_discovery');
  assert.doesNotMatch(JSON.stringify([...app.values]), /smtp.company.example/);
});

test('verified account and recipient survive restart in credentials, with no public secret', async () => {
  const app = fixture();
  await app.ready();
  assert.equal(app.values.size, 1);
  assert.match([...app.values.keys()][0], /^FEISHU_USER_MAIL_[A-F0-9]{64}$/);
  assert.deepEqual(app.verified[0], [{ host: 'smtp.example.com', port: 465, mode: 'tls', user: 'sender@example.com', from: 'sender@example.com' }, 'smtp-only-secret', { signal: undefined }]);
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
  await app.handle('/mail server smtp.example.com 465 tls');
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
  await app.handle('/mail server smtp.example.com 465 tls');
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
  await app.handle('/mail server smtp.example.com 465 tls');
  const reply = await app.handle('/mail code [removed]', { secret: 'reject-secret' });
  assert.match(reply.reply, /验证失败/);
  assert.doesNotMatch(JSON.stringify(reply), /reject-secret|server leaked/);
  assert.doesNotMatch(JSON.stringify([...app.values]), /reject-secret/);
  assert.equal((await app.flow.getStatus(alice)).stage, 'awaiting_code');
  fail = false;
  await app.handle('/mail code [removed]', { secret: 'accepted-secret' });
  assert.equal((await app.flow.getStatus(alice)).stage, 'awaiting_recipient');
});

test('explicit SMTP configuration supports arbitrary hosts and ports for TLS and STARTTLS', async () => {
  for (const [host, port, mode] of [
    ['mail.company.example', 465, 'tls'],
    ['smtp.provider.example', 587, 'starttls'],
    ['PRIVATE.SMTP.EXAMPLE', 2465, 'tls'],
  ]) {
    const app = fixture();
    assert.match((await app.handle('/mail')).reply, /邮箱提供商/);
    assert.equal((await app.handle('sender@example.com')).discover, true);
    assert.equal((await app.flow.getStatus(alice)).stage, 'awaiting_discovery');
    assert.equal((await app.handle('some arbitrary text')).discover, true);
    const result = await app.handle(`/mail server ${host} ${port} ${mode}`);
    assert.ok(result.reply.includes(`${host.toLowerCase()}:${port}`));
    assert.match(result.reply, /不要发送邮箱登录密码或飞书应用 App Secret/);
    assert.equal((await app.flow.getStatus(alice)).stage, 'awaiting_code');
    assert.ok((await app.handle('/mail status')).reply.includes(`${host.toLowerCase()}:${port}`));
    await app.handle('/mail code [removed]', { secret: 'test-only-authorization' });
    assert.deepEqual(app.verified[0][0], { host: host.toLowerCase(), port, mode, user: 'sender@example.com', from: 'sender@example.com' });
    await app.handle('recipient@example.com');
    const restarted = createMailUserFlow(app.ctx);
    const account = await restarted.getAccount(alice);
    assert.equal(account.config.host, host.toLowerCase());
    assert.equal(account.config.port, port);
    assert.equal(account.config.mode, mode);
    assert.ok((await app.handle('/mail status')).reply.includes(`${host.toLowerCase()}:${port}`));
  }
});

test('legacy pending states auto-select known providers before ingress intercepts the authorization code', async () => {
  for (const stage of ['awaiting_server', 'awaiting_code']) {
    const app = fixture();
    await app.handle('/mail');
    const ref = [...app.values.keys()][0];
    app.values.set(ref, { source: 'store', value: JSON.stringify({ version: 1, stage, chatId: 'private-a', email: '123456@QQ.COM' }) });
    const calls = [];
    const restarted = createMailUserFlow(app.ctx, { verify: async (...args) => { calls.push(args); } });
    assert.deepEqual(await restarted.getIngressState(alice), { stage: 'awaiting_code', chatId: 'private-a' });
    assert.equal((await restarted.getStatus(alice)).email, '123456@QQ.COM');
    const result = await restarted.handle(alice, { text: '/mail code', secret: 'new-authorization', chatId: 'private-a', chatType: 'p2p' });
    assert.match(result.reply, /邮箱验证成功/);
    assert.equal(calls[0][0].host, 'smtp.qq.com');
    assert.equal((await restarted.getStatus(alice)).stage, 'awaiting_recipient');
  }
});

test('legacy verified accounts retain their prior endpoint until explicitly reconfigured', async () => {
  const app = fixture();
  await app.handle('/mail');
  const ref = [...app.values.keys()][0];
  app.values.set(ref, { source: 'store', value: JSON.stringify({ version: 1, stage: 'ready', chatId: 'private-a', email: 'sender@example.com', password: 'old-authorization', recipient: 'old-recipient@example.com' }) });
  assert.equal((await app.flow.getAccount(alice)).config.host, 'smtp.feishu.cn');
  assert.match((await app.handle('/mail status')).reply, /兼容旧版已验证配置/);
  assert.match((await app.handle('/mail status')).reply, /\/mail server/);
  await app.handle('/mail server new.smtp.example 587 starttls');
  assert.equal((await app.flow.getStatus(alice)).stage, 'awaiting_code');
  assert.equal(await app.flow.getAccount(alice), null);
  assert.doesNotMatch(JSON.stringify([...app.values]), /old-authorization|old-recipient/);
  await app.handle('/mail code [removed]', { secret: 'new-authorization' });
  await app.handle('new-recipient@example.com');
  assert.equal((await app.flow.getAccount(alice)).config.host, 'new.smtp.example');
});

test('SMTP configuration parsing rejects unsafe forms and invalid edits leave the old account intact', async () => {
  const app = fixture();
  await app.ready();
  const before = JSON.stringify([...app.values]);
  for (const command of [
    '/mail server', '/mail server smtp.example.com 465', '/mail server smtp.example.com 465 tls extra',
    '/mail server smtp://example.com 465 tls', '/mail server https://secret@example.com 465 tls',
    '/mail server user:secret@example.com 465 tls', '/mail server smtp.example.com/path 465 tls',
    '/mail server smtp.example.com 0 tls', '/mail server smtp.example.com 65536 tls',
    '/mail server smtp.example.com 4.65 tls', '/mail server smtp.example.com 465 plain',
    '/mail server -example.com 465 tls', '/mail server smtp.example.com 465 tls\n',
  ]) {
    assert.equal(parseSmtpServerCommand(command), undefined);
    const result = await app.handle(command);
    assert.match(result.reply, /格式无效/);
    assert.doesNotMatch(result.reply, /user:secret|https:\/\/secret/);
    assert.equal(JSON.stringify([...app.values]), before);
  }
  assert.equal(parseSmtpServerCommand('arbitrary text'), undefined);
  assert.equal(parseSmtpServerCommand(null), undefined);
  assert.deepEqual(parseSmtpServerCommand(' /MAIL SERVER SMTP.EXAMPLE.COM 587 STARTTLS '), { host: 'smtp.example.com', port: 587, mode: 'starttls' });
});

test('SMTP settings and replacements are isolated by identity and original private chat', async () => {
  const app = fixture();
  await app.ready();
  await app.ready(bob, 'bob-secret');
  const before = (await app.flow.getAccount(alice)).config;
  assert.match((await app.handle('/mail server other.example.com 587 starttls', { chatId: 'private-other' })).reply, /最初/);
  assert.match((await app.handle('/mail server other.example.com 587 starttls', { chatType: 'group' })).reply, /私聊/);
  assert.deepEqual((await app.flow.getAccount(alice)).config, before);
  await app.handle('/mail server bob.example.com 587 starttls', {}, bob);
  assert.deepEqual((await app.flow.getAccount(alice)).config, before);
  assert.equal(await app.flow.getAccount(bob), null);
  await app.handle('/mail code [removed]', { secret: 'new-bob-secret' }, bob);
  await app.handle('bob-recipient@example.com', {}, bob);
  assert.equal((await app.flow.getAccount(bob)).config.host, 'bob.example.com');
  assert.equal((await app.flow.getAccount(alice)).config.host, 'smtp.example.com');
});

test('SMTP failures explain only allowlisted categories without leaking provider details or secrets', async () => {
  const replies = new Set();
  for (const [code, expected] of [
    ['AUTH_FAILED', /SMTP 身份验证失败/],
    ['TLS_FAILED', /TLS 安全连接校验/],
    ['CONNECTION_FAILED', /无法连接 SMTP 服务器/],
    ['TIMEOUT', /验证 SMTP 服务器超时/],
    ['SMTP_FAILED', /SMTP 服务未能完成邮箱验证/],
    ['PROVIDER_LEAK_secret', /邮箱验证失败/],
    [undefined, /邮箱验证失败/],
  ]) {
    const app = fixture({ verify: async () => {
      const error = new Error('provider-response-secret', { cause: new Error('provider-cause-secret') });
      error.code = code;
      throw error;
    } });
    await app.handle('/mail');
    await app.handle('123456@qq.com');
    await app.handle('/mail server smtp.qq.com 465 tls');
    const result = await app.handle('/mail code [removed]', { secret: 'reject-authorization-secret' });
    assert.match(result.reply, expected);
    assert.match(result.reply, /未保存本次授权码/);
    assert.match(result.reply, /smtp\.qq\.com:465/);
    assert.doesNotMatch(JSON.stringify(result), /provider-response-secret|provider-cause-secret|PROVIDER_LEAK_secret|reject-authorization-secret/);
    assert.doesNotMatch(JSON.stringify([...app.values]), /reject-authorization-secret/);
    assert.equal((await app.flow.getStatus(alice)).stage, 'awaiting_code');
    if (code && code !== 'PROVIDER_LEAK_secret') replies.add(result.reply);
  }
  assert.equal(replies.size, 5, 'operational failures must remain distinguishable');
});

test('only one bare address is accepted for sender and recipient', async () => {
  const app = fixture();
  await app.handle('/mail');
  for (const text of ['Name <a@example.com>', 'a@example.com,b@example.com', 'a@example.com\r\nBcc:b@example.com', 'smtp://example.com', 'a@localhost']) {
    await app.handle(text);
    assert.equal((await app.flow.getStatus(alice)).stage, 'awaiting_email');
  }
  await app.handle('sender@example.com');
  await app.handle('/mail server smtp.example.com 465 tls');
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
  await app.handle('/mail server smtp.example.com 465 tls');
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
  await app.handle('/mail server smtp.example.com 465 tls');
  const binding = app.handle('/mail code [removed]', { secret: 'in-flight-secret' });
  await verifying;
  assert.deepEqual(await app.flow.getIngressState(alice), { stage: 'awaiting_code', chatId: 'private-a' });
  const cancelled = app.handle('/mail cancel');
  assert.match((await app.handle('/mail', {}, bob)).reply, /发件邮箱/);
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
  await app.handle('/mail server smtp.example.com 465 tls');
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

test('known sender skips server questions while manual SMTP always overrides detection', async () => {
  const app = fixture();
  await app.handle('/mail');
  const selected = await app.handle('sender@foxmail.com');
  assert.match(selected.reply, /自动选择/);
  assert.match(selected.reply, /smtp.qq.com/);
  assert.match(selected.reply, /授权码/);
  assert.doesNotMatch(selected.reply, /mail server/);
  assert.equal((await app.flow.getStatus(alice)).stage, 'awaiting_code');
  await app.handle('/mail server mail.custom.example 587 starttls');
  await app.handle('/mail code', { secret: 'test-code' });
  assert.equal(app.verified[0][0].host, 'mail.custom.example');
});

test('original send request resumes once after verification when the recipient is already known', async () => {
  const app = fixture();
  const request = { messageId: 'original-message', requestText: '发送项目进度邮件给 receiver@example.com，主题进度，正文已完成。', recipient: 'receiver@example.com' };
  await app.handle('/mail setup', { pendingRequest: request });
  await app.handle('sender@qq.com');
  assert.equal(await app.flow.getAccount(alice), null);
  const result = await app.handle('/mail code', { secret: 'verified-code' });
  assert.deepEqual(result.resume, { messageId: request.messageId, requestText: request.requestText });
  assert.equal((await app.flow.getAccount(alice)).recipient, 'receiver@example.com');
  assert.doesNotMatch(JSON.stringify(result), /verified-code/);
  assert.doesNotMatch(JSON.stringify([...app.values]), /pendingRequest|original-message|项目进度/);
  assert.equal((await app.handle('/mail code', { secret: 'repeat-code' })).resume, undefined);
  assert.equal(app.verified.length, 1);
});

test('pending send survives manual server selection and restart until a valid recipient is provided', async () => {
  for (const recipientInput of ['recipient@example.com', '/mail to recipient@example.com']) {
    const app = fixture();
    const request = { messageId: 'original-message', requestText: '请发邮件：主题测试，正文内容。' };
    await app.handle('/mail setup', { pendingRequest: request });
    await app.handle('sender@company.example');
    await app.handle('/mail server mail.company.example 465 tls');
    assert.equal((await app.handle('/mail code', { secret: 'verified-code' })).resume, undefined);
    const restarted = createMailUserFlow(app.ctx);
    const handle = text => restarted.handle(alice, { text, chatId: 'private-a', chatType: 'p2p' });
    assert.equal((await handle('invalid mailbox')).resume, undefined);
    assert.equal((await restarted.getStatus(alice)).stage, 'awaiting_recipient');
    assert.deepEqual((await handle(recipientInput)).resume, request);
    assert.equal((await handle(recipientInput)).resume, undefined);
    assert.doesNotMatch(JSON.stringify([...app.values]), /pendingRequest|original-message/);
  }
});

test('verification failure keeps the request pending and cross-chat access cannot consume it', async () => {
  let fails = true;
  const app = fixture({ verify: async () => { if (fails) throw new Error('private-auth-secret'); } });
  const request = { messageId: 'original-message', requestText: '发送指定报告邮件。', recipient: 'recipient@example.com' };
  await app.handle('/mail setup', { pendingRequest: request });
  await app.handle('sender@qq.com');
  assert.equal((await app.handle('/mail code', { secret: 'private-code' })).resume, undefined);
  assert.equal((await app.flow.getStatus(alice)).stage, 'awaiting_code');
  assert.match(JSON.stringify([...app.values]), /original-message/);
  assert.doesNotMatch(JSON.stringify([...app.values]), /private-code|private-auth-secret/);
  const otherChat = await app.handle('/mail code', { secret: 'private-code', chatId: 'private-other' });
  assert.equal(otherChat.resume, undefined);
  assert.doesNotMatch(JSON.stringify(otherChat), /报告|original-message|recipient@example/);
  fails = false;
  assert.deepEqual((await app.handle('/mail code', { secret: 'verified-code' })).resume, { messageId: request.messageId, requestText: request.requestText });
});

test('cancel, reset and manual setup discard pending send and manual binding never resumes', async () => {
  for (const command of ['/mail cancel', '/mail reset', '/mail', '/mail setup']) {
    const app = fixture();
    await app.handle('', { requireSetup: true, pendingRequest: { messageId: 'old-message', requestText: '发送之前的请求。', recipient: 'old@example.com' } });
    await app.handle('sender@qq.com');
    await app.handle(command);
    assert.doesNotMatch(JSON.stringify([...app.values]), /old-message|old@example.com|pendingRequest/);
    await app.handle('/mail');
    await app.handle('sender@qq.com');
    assert.equal((await app.handle('/mail code', { secret: 'verified-code' })).resume, undefined);
    assert.equal((await app.handle('recipient@example.com')).resume, undefined);
  }
});

test('malformed or secret-bearing pending request metadata fails closed', async () => {
  for (const pendingRequest of [
    null, {}, { messageId: '', requestText: 'send mail' },
    { messageId: 'msg', requestText: '/mail code private-code' },
    { messageId: 'msg', requestText: 'send mail', password: 'private-code' },
    { messageId: 'msg', requestText: 'send mail', recipient: 'a@example.com,b@example.com' },
    { messageId: 'msg', requestText: 'x'.repeat(64001) },
  ]) {
    const app = fixture();
    const result = await app.handle('', { requireSetup: true, pendingRequest });
    assert.match(result.reply, /凭据服务/);
    assert.doesNotMatch(JSON.stringify(result), /private-code/);
    assert.equal(app.values.size, 0);
  }
  const app = fixture();
  await app.handle('/mail');
  const ref = [...app.values.keys()][0];
  const stored = JSON.parse(app.values.get(ref).value);
  stored.pendingRequest = { messageId: 'msg', requestText: '/mail code private-code' };
  app.values.set(ref, { source: 'store', value: JSON.stringify(stored) });
  assert.match((await app.handle('sender@qq.com')).reply, /凭据服务/);
  await assert.rejects(app.flow.getIngressState(alice), /凭据服务/);
});

test('web evidence is isolated by user and chat, invalidated by reset, and failures never advance to code', async () => {
  const { createMailWebResearch } = await import('../lib/mail-web-research.js');
  let failProbe = true;
  const excerpt = 'SMTP smtp.company.example port 465 TLS';
  const app = fixture({ researchFactory: () => createMailWebResearch({
    resolveMx: async () => [],
    search: async () => ({ status: 'found', results: [{ url: 'https://company.example/help' }] }),
    fetchText: async () => excerpt,
  }), probe: async () => { if (failProbe) throw new Error('connection unavailable'); } });
  for (const identity of [alice, bob]) { await app.handle('/mail', {}, identity); await app.handle('same@company.example', {}, identity); }
  const found = await app.flow.webSearch(alice, { chatId: 'private-a' });
  await assert.rejects(app.flow.webRead(alice, found.results[0].id, { chatId: 'other-chat' }), /原私聊/);
  await assert.rejects(app.flow.webRead(bob, found.results[0].id, { chatId: 'private-a' }));
  const page = await app.flow.webRead(alice, found.results[0].id, { chatId: 'private-a' });
  const proposal = { pageId: page.pageId, host: 'smtp.company.example', port: 465, mode: 'tls', excerpt };
  await assert.rejects(app.flow.webApply(alice, proposal, { chatId: 'private-a' }));
  assert.equal((await app.flow.getStatus(alice)).stage, 'awaiting_discovery');
  failProbe = false;
  await assert.rejects(app.flow.webApply(alice, proposal, { chatId: 'private-a', checkActive: () => { throw new Error('ended'); } }), /ended/);
  assert.equal((await app.flow.getStatus(alice)).stage, 'awaiting_discovery');
  await app.handle('/mail reset'); await app.handle('/mail'); await app.handle('same@company.example');
  await assert.rejects(app.flow.webApply(alice, proposal, { chatId: 'private-a' }));
  assert.equal(app.verified.length, 0);
});

test('unavailable web service retains the request and never asks users for technical settings', async () => {
  const app = fixture();
  await app.handle('/mail setup', { pendingRequest: { messageId: 'pending-web', requestText: 'Send report.' } });
  await app.handle('sender@company.example');
  const result = await app.flow.webSearch(alice, { chatId: 'private-a' });
  assert.equal(result.status, 'unavailable');
  assert.match(result.reply, /已保留/);
  assert.doesNotMatch(result.reply, /\/mail server|465 tls/);
  assert.equal((await app.flow.getStatus(alice)).stage, 'awaiting_discovery');
  assert.match(JSON.stringify([...app.values]), /pending-web/);
});
