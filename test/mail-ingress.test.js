import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createMailBridge } from '../lib/mail-bridge.js';
import { createFeishuEventReceiver, createFeishuWebhookHandler } from '../lib/index.js';

function payload(text, options = {}) {
  return { header: { event_type: 'im.message.receive_v1', event_id: options.id || 'event-a', token: 'verify-test', tenant_key: 'tenant' }, event: {
    sender: { sender_type: 'user', sender_id: { open_id: options.user || 'alice' } },
    message: { chat_type: options.chatType || 'p2p', chat_id: 'chat-a', message_id: options.id || 'message-a', message_type: options.type || 'text', content: JSON.stringify(options.content || { text }) },
  } };
}
function fixture(flow = { getIngressState: async () => ({ stage: 'unbound' }) }) {
  const config = { source: 'bot-a', verificationToken: 'TOKEN', maxBodyBytes: 64 * 1024 };
  const bridge = createMailBridge({}, config, { flow });
  const deliveries = [];
  const ctx = { logger: { warn() {} }, credentials: { resolve: async () => ({ value: 'verify-test' }) },
    prepareIngress: bridge.prepareIngress, discardIngress: bridge.discardIngress,
    webhookRuntime: { dispatch: delivery => deliveries.push(JSON.parse(JSON.stringify(delivery))) } };
  const receive = createFeishuEventReceiver(ctx, config);
  const handler = createFeishuWebhookHandler(ctx, config, receive);
  async function http(body) {
    const request = Readable.from([Buffer.from(JSON.stringify(body))]); request.method = 'POST'; request.complete = true; request.headers = { 'content-type': 'application/json' };
    const response = { setHeader() {}, writeHead(status) { this.status = status; }, end() {} };
    await handler(request, response); return response;
  }
  return { config, ctx, bridge, deliveries, receive, http };
}

test('SMTP authorization code is redacted before HTTP delivery persistence, snapshots or model admission', async () => {
  const f = fixture(); const secret = 'test-only-never-log-this-auth';
  const event = payload(`/mail code ${secret}`);
  assert.equal((await f.http(event)).status, 200);
  assert.equal(f.deliveries.length, 1);
  assert.equal(JSON.stringify(f.deliveries).includes(secret), false);
  assert.equal('raw' in f.deliveries[0].event.payload, false);
  const parsed = f.deliveries[0].event.payload.parsed;
  assert.equal(parsed.userText, '/mail code');
  assert.equal(f.bridge.takeSecret({ ...parsed, senderId: 'bob' }), undefined);
  assert.equal(f.bridge.takeSecret(parsed), secret);
  assert.equal(f.bridge.takeSecret(parsed), undefined);
});

test('plain or rich-text credentials are redacted only in the matching pending private flow', async () => {
  const f = fixture({ getIngressState: async identity => ({ stage: identity.openId === 'alice' ? 'awaiting_code' : 'unbound', chatId: 'chat-a' }) });
  await f.receive(payload('plain-secret'), { authenticated: true });
  await f.receive(payload('', { id: 'post-a', type: 'post', content: { title: 'rich-secret', content: [[{ tag: 'text', text: 'another-secret' }]] } }), { authenticated: true });
  await f.receive(payload('/unrecognized-code', { id: 'slash-a' }), { authenticated: true });
  await f.receive(payload('ordinary-message', { user: 'bob', id: 'bob-a' }), { authenticated: true });
  const stored = JSON.stringify(f.deliveries);
  assert.doesNotMatch(stored, /plain-secret|rich-secret|another-secret|unrecognized-code/);
  assert.match(stored, /ordinary-message/);
  assert.equal(f.bridge.takeSecret(f.deliveries[0].event.payload.parsed), 'plain-secret');
});

test('group credentials are discarded; invalid authentication never reaches sensitive ingress', async () => {
  const f = fixture();
  await f.receive(payload('/mail code group-secret', { chatType: 'group' }), { authenticated: true });
  const parsed = f.deliveries[0].event.payload.parsed;
  assert.equal(f.bridge.takeSecret(parsed), undefined);
  assert.doesNotMatch(JSON.stringify(f.deliveries), /group-secret/);
  const invalid = payload('/mail code private-secret', { id: 'invalid' }); invalid.header.token = 'wrong';
  assert.equal((await f.http(invalid)).status, 401);
  assert.equal(f.deliveries.length, 1);
});

test('pending authorization allows valid SMTP settings but still redacts malformed commands containing secrets', async () => {
  const f = fixture({ getIngressState: async () => ({ stage: 'awaiting_code', chatId: 'chat-a' }) });
  await f.receive(payload('/mail server smtp.example.com 587 starttls', { id: 'server-valid' }), { authenticated: true });
  assert.equal(f.deliveries[0].event.payload.parsed.userText, '/mail server smtp.example.com 587 starttls');
  await f.receive(payload('/mail server smtp.example.com 587 starttls accidental-secret', { id: 'server-invalid' }), { authenticated: true });
  assert.doesNotMatch(JSON.stringify(f.deliveries), /accidental-secret/);
  assert.equal(f.deliveries[1].event.payload.parsed.userText, '/mail code');
});

test('codes sent during provider discovery stay secret and only explicit retry commands reach the task handler', async () => {
  const f = fixture({ getIngressState: async () => ({ stage: 'awaiting_discovery', chatId: 'chat-a' }) });
  await f.receive(payload('early-private-code', { id: 'discovery-code' }), { authenticated: true });
  await f.receive(payload('/mail retry', { id: 'discovery-retry' }), { authenticated: true });
  assert.doesNotMatch(JSON.stringify(f.deliveries), /early-private-code/);
  assert.equal(f.deliveries[0].event.payload.parsed.userText, '/mail code');
  assert.equal(f.deliveries[1].event.payload.parsed.userText, '/mail retry');
});

test('concurrent HTTP/SDK retries are admitted once and failure is retryable without retaining a secret', async () => {
  const f = fixture();
  let release; const paused = new Promise(resolve => { release = resolve; });
  const prepare = f.ctx.prepareIngress;
  f.ctx.prepareIngress = async parsed => { await paused; return prepare(parsed); };
  const packet = payload('/mail code one-code');
  const first = f.receive(packet, { authenticated: true });
  const second = f.receive(packet, { authenticated: true });
  release(); await Promise.all([first, second]);
  assert.equal(f.deliveries.length, 1);
  const broken = fixture(); let attempted;
  broken.ctx.webhookRuntime.dispatch = delivery => { attempted = delivery.event.payload.parsed; throw new Error('not ready'); };
  await assert.rejects(() => broken.receive(payload('/mail code retry-code'), { authenticated: true }), error => error.status === 503);
  assert.equal(broken.bridge.takeSecret(attempted), undefined);
  broken.ctx.webhookRuntime.dispatch = delivery => broken.deliveries.push(delivery);
  await broken.receive(payload('/mail code retry-code'), { authenticated: true });
  assert.equal(broken.deliveries.length, 1);
  assert.equal(broken.bridge.takeSecret(broken.deliveries[0].event.payload.parsed), 'retry-code');
});
