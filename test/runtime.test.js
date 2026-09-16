import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createCipheriv, createHash } from 'node:crypto';
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values';
import { Config, createFeishuEventReceiver, createFeishuWebhookHandler, feishuTools, FeishuClient } from '../lib/index.js';
import { createConversationFixture } from '../test-support/conversation-fixture.mjs';

const logger = { info() {}, debug() {}, warn() {} };
const config = { source: 'test', maxBodyBytes: 4096, verificationToken: 'TOKEN', encryptKey: 'KEY', workspacePath: '/tmp', agentPreset: 'standard', permissionPreset: 'workspace-write' };
const event = () => ({ schema: '2.0', header: { event_type: 'im.message.receive_v1', event_id: 'event-1', token: 'test-token' }, event: { sender: { sender_type: 'user', sender_id: { open_id: 'ou_test' } }, message: { chat_type: 'p2p', chat_id: 'oc_test', message_id: 'om_test', message_type: 'text', content: '{"text":"hello"}' } } });
function ingress(values = { TOKEN: 'test-token' }) {
  const deliveries = [];
  const ctx = { logger, credentials: { resolve: async ref => values[ref] ? { value: values[ref] } : undefined }, webhookRuntime: { dispatch(delivery) { assert.notEqual(snapshotJsonValue(delivery), undefined); deliveries.push(delivery); } } };
  const handler = createFeishuWebhookHandler(ctx, config);
  return { deliveries, async send(payload, headers = {}) {
    const request = Readable.from([Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload))]);
    request.method = 'POST'; request.complete = true; request.headers = { 'content-type': 'application/json', ...headers };
    const response = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }, end(body) { this.body = body; } };
    await handler(request, response);
    return response;
  } };
}

test('challenge uses JSON and validates the configured verification token', async () => {
  const api = ingress();
  const accepted = await api.send({ type: 'url_verification', challenge: 'hello', token: 'test-token' });
  assert.equal(accepted.status, 200);
  assert.match(accepted.headers['content-type'], /application\/json/);
  assert.deepEqual(JSON.parse(accepted.body), { challenge: 'hello' });
  assert.equal((await api.send({ type: 'url_verification', challenge: 'hello' })).status, 401);
});

test('v2 header token, lossless delivery and duplicate retries', async () => {
  const api = ingress();
  assert.equal((await api.send(event())).status, 200);
  assert.equal((await api.send(event())).status, 200);
  assert.equal(api.deliveries.length, 1);
  const invalid = event(); delete invalid.header.token;
  assert.equal((await api.send(invalid)).status, 401);
  assert.equal((await ingress({}).send(event())).status, 503);
});

test('encrypted signed event decrypts and tampered signature is rejected', async () => {
  const api = ingress({ KEY: 'test-key' });
  const iv = Buffer.alloc(16, 1);
  const cipher = createCipheriv('aes-256-cbc', createHash('sha256').update('test-key').digest(), iv);
  const ciphertext = Buffer.concat([iv, cipher.update(JSON.stringify(event())), cipher.final()]);
  const body = JSON.stringify({ encrypt: ciphertext.toString('base64') });
  const headers = { 'x-lark-request-timestamp': '123', 'x-lark-request-nonce': 'nonce', 'x-lark-signature': createHash('sha256').update('123noncetest-key' + body).digest('hex') };
  assert.equal((await api.send(body, headers)).status, 200);
  assert.equal(api.deliveries.length, 1);
  headers['x-lark-signature'] = 'invalid';
  assert.equal((await api.send(body, headers)).status, 401);
});

test('real tool schemas, claimed session provenance and exactly one automatic reply', async t => {
  const app = await createConversationFixture(t, { tools: feishuTools });
  for (const tool of app.tools.values()) {
    assertSupportedJsonSchema(tool.parameters);
    assertSupportedJsonSchema(tool.output.schema);
  }
  assert.ok(app.tools.size > feishuTools.length);
  await app.send({ messageId: 'om_test' });
  const agent = [...app.agents.values()][0];
  const message = agent.queue[0];
  assert.equal(message.source.provider, 'feishu');
  assert.equal(message.source.kind, 'webhook');
  assert.match(message.source.ruleId, /feishu-message-handler/);
  const signal = new AbortController().signal;
  const get = app.tools.get('feishu_history_get');
  await assert.rejects(() => get.execute({}, { agent, signal }), /required/);
  const tool = app.tools.get('feishu_history_search');
  const value = await tool.execute({ query: 'hello' }, { agent, signal });
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value), []);
  assert.equal(tool.output.render({}, value)[0].type, 'text');
  assert.ok(value.data.length > 0);
  await app.emit('agent/inbox/claimed', { agent, turn: 1, message: { ...message, source: { ...message.source, provider: 'other-provider' } } });
  await app.emit('agent/turn-stopping', { agent, turn: 1, signal });
  assert.deepEqual(app.replies, [], 'unmatched provenance cannot claim an automatic reply');
  await app.claim(agent);
  await app.finish(agent, '最终答复');
  await app.emit('agent/turn-stopping', { agent, turn: 1, signal });
  assert.deepEqual(app.replies, [['om_test', '最终答复']]);
});

test('cached tenant token rotates immediately when credential values change', async () => {
  let secret = 'first'; let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ code: 0, tenant_access_token: `token-${++calls}`, expire: 7200 }) });
  try {
    const client = new FeishuClient({ credentials: { resolve: async ref => ({ value: ref === 'APP_ID' ? 'test-app' : secret }) } }, { appIdEnv: 'APP_ID', appSecretEnv: 'APP_SECRET' });
    assert.equal(await client.getTenantToken(), 'token-1');
    assert.equal(await client.getTenantToken(), 'token-1');
    secret = 'second';
    assert.equal(await client.getTenantToken(), 'token-2');
  } finally { globalThis.fetch = original; }
});

test('document, spreadsheet and task calls use the supported provider API contracts', async () => {
  const client = new FeishuClient({}, {});
  const requests = [];
  client.request = async (...args) => requests.push(args);
  await client.getDocumentContent('doc');
  await client.getSheetValues('sheet', 'tab!A1:B2');
  await client.completeTask('task');
  assert.equal(requests[0][1], '/open-apis/docx/v1/documents/doc/raw_content');
  assert.equal(requests[1][1], '/open-apis/sheets/v2/spreadsheets/sheet/values/tab!A1%3AB2');
  assert.equal(requests[2][0], 'PATCH');
  assert.deepEqual(requests[2][2].update_fields, ['completed_at']);
  assert.match(requests[2][2].task.completed_at, /^\d+$/);
  assert.equal(feishuTools.some(tool => tool.name === 'feishu_search_messages'), false);
});

test('plugin config imports with Schemastery and leaves model selection to the deployment', () => {
  const defaults = Config({});
  assert.equal(defaults.model, undefined);
  assert.equal(defaults.path, '/webhook/feishu');
  assert.equal(defaults.permissionPreset, 'workspace-write');
  assert.equal(defaults.tunnelProvider, 'ngrok');
  assert.equal(Config({ tunnelProvider: 'cloudflare' }).tunnelProvider, 'cloudflare');
  assert.throws(() => Config({ tunnelProvider: 'unsupported' }));
  assert.throws(() => Config({ model: {} }));
});

test('HTTP and SDK events share deduplication and inactive HTTP mode rejects ingress', async () => {
  const deliveries = [];
  const selected = { ...config, connectionMode: 'webhook' };
  const ctx = { logger, credentials: { resolve: async () => ({ value: 'test-token' }) }, webhookRuntime: { dispatch: item => deliveries.push(item) } };
  const receive = createFeishuEventReceiver(ctx, selected);
  const handler = createFeishuWebhookHandler(ctx, selected, receive);
  receive(event(), { authenticated: true });
  const send = async () => {
    const req = Readable.from([Buffer.from(JSON.stringify(event()))]);
    req.method = 'POST'; req.complete = true; req.headers = { 'content-type': 'application/json' };
    const res = { setHeader() {}, writeHead(status) { this.status = status; }, end() {} };
    await handler(req, res);
    return res.status;
  };
  assert.equal(await send(), 200);
  assert.equal(deliveries.length, 1);
  selected.connectionMode = 'websocket';
  assert.equal(await send(), 409);
  selected.connectionMode = 'webhook';
  assert.equal(await send(), 200);
  assert.equal(deliveries.length, 1);
});

test('encrypted URL verification accepts unsigned challenge without weakening event signatures', async () => {
  const encrypted = value => {
    const iv = Buffer.alloc(16, 7);
    const cipher = createCipheriv('aes-256-cbc', createHash('sha256').update('test-key').digest(), iv);
    return { encrypt: Buffer.concat([iv, cipher.update(JSON.stringify(value)), cipher.final()]).toString('base64') };
  };
  const api = ingress({ KEY: 'test-key', TOKEN: 'test-token' });
  const challenge = encrypted({ type: 'url_verification', challenge: 'encrypted-challenge', token: 'test-token' });
  const accepted = await api.send(challenge);
  assert.equal(accepted.status, 200);
  assert.deepEqual(JSON.parse(accepted.body), { challenge: 'encrypted-challenge' });
  assert.equal(api.deliveries.length, 0);
  assert.equal((await api.send(encrypted({ type: 'url_verification', challenge: 'x', token: 'wrong' }))).status, 401);
  assert.equal((await ingress({}).send(challenge)).status, 503);
  assert.equal((await api.send(challenge, { 'x-lark-request-timestamp': '1' })).status, 400);
  assert.equal((await api.send(challenge, { 'x-lark-request-timestamp': '1', 'x-lark-request-nonce': 'n', 'x-lark-signature': 'bad' })).status, 401);
  assert.equal((await api.send(encrypted(event()))).status, 400);
  assert.equal((await api.send({ ...encrypted(event()), type: 'url_verification', challenge: 'spoofed' })).status, 400);
  assert.equal(api.deliveries.length, 0);
});
