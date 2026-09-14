import test from 'node:test';
import assert from 'node:assert/strict';
import * as realSdk from '@larksuiteoapi/node-sdk';
import { createTransport } from '../lib/transport.js';

const APP_ID = 'cli_0123456789abcdef';
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function setup(options = {}) {
  const clients = [];
  const deliveries = [];
  const logs = [];
  const values = { FEISHU_APP_ID: APP_ID, FEISHU_APP_SECRET: 'unit-test-secret' };
  const config = { connectionMode: 'websocket' };
  class WSClient {
    constructor(params) { this.params = params; this.state = 'idle'; this.closed = 0; clients.push(this); }
    start({ eventDispatcher }) { this.dispatcher = eventDispatcher; this.state = 'connecting'; return options.start?.(this); }
    getConnectionStatus() { return { state: this.state }; }
    close(params) { assert.equal(params.force, true); this.closed++; this.state = 'idle'; }
    change(state) {
      this.state = state;
      ({ connected: this.params.onReady, reconnecting: this.params.onReconnecting, failed: this.params.onError })[state]?.();
    }
  }
  const sdk = { ...realSdk, WSClient };
  const ctx = {
    credentials: { resolve: async ref => values[ref] ? { value: values[ref] } : undefined },
    logger: { warn: (...args) => logs.push(args) },
  };
  const transport = createTransport(ctx, config, options.onEvent || ((...args) => deliveries.push(args)), { loadSdk: options.loadSdk || (async () => sdk) });
  return { transport, config, ctx, sdk, clients, deliveries, logs, values };
}

test('webhook default does not read credentials or load SDK', async () => {
  const transport = createTransport({ credentials: { resolve() { throw new Error('must not read'); } } }, {}, () => {}, { loadSdk() { throw new Error('must not load'); } });
  assert.equal((await transport.reconcile()).state, 'listening');
  assert.equal(transport.status().mode, 'webhook');
  transport.dispose();
  assert.equal(transport.status().state, 'stopped');
});

test('missing credentials and invalid App ID do not construct a connection', async () => {
  const api = setup();
  delete api.values.FEISHU_APP_SECRET;
  assert.equal((await api.transport.reconcile()).state, 'waiting_configuration');
  api.values.FEISHU_APP_SECRET = 'secret';
  api.values.FEISHU_APP_ID = 'invalid';
  assert.equal((await api.transport.reconcile()).state, 'error');
  assert.equal(api.clients.length, 0);
});

test('start is nonblocking and status follows actual connection transitions', async () => {
  const pending = deferred();
  const api = setup({ start: () => pending.promise });
  assert.equal((await api.transport.reconcile()).state, 'connecting');
  const [client] = api.clients;
  assert.equal(client.params.autoReconnect, true);
  client.change('connected');
  assert.equal(api.transport.status().state, 'connected');
  client.change('reconnecting');
  assert.equal(api.transport.status().state, 'reconnecting');
  client.change('connected');
  assert.equal(api.transport.status().state, 'connected');
  api.transport.dispose();
  pending.resolve();
  await tick();
  assert.equal(client.closed, 1);
  assert.equal(api.transport.status().state, 'stopped');
});

test('real SDK dispatcher flattened event retains IDs and shares authenticated ingress', async () => {
  const api = setup();
  await api.transport.reconcile();
  const envelope = {
    schema: '2.0',
    header: { event_type: 'im.message.receive_v1', event_id: 'event-id', create_time: '123', app_id: APP_ID },
    event: { sender: { sender_id: { open_id: 'ou_test' } }, message: { message_id: 'message-id', chat_id: 'chat-id', message_type: 'text', content: '{"text":"hello"}' } },
  };
  await api.clients[0].dispatcher.invoke(envelope, { needCheck: false });
  assert.deepEqual(api.deliveries, [[envelope, { authenticated: true }]]);
  assert.equal(Object.getOwnPropertySymbols(api.deliveries[0][0].event).length, 0);
  api.transport.dispose();
});

test('unchanged settings reuse the connection; changed credentials replace and close it', async () => {
  const api = setup();
  await api.transport.reconcile();
  await api.transport.reconcile();
  assert.equal(api.clients.length, 1);
  api.values.FEISHU_APP_SECRET = 'rotated-secret';
  await api.transport.reconcile();
  assert.equal(api.clients.length, 2);
  assert.equal(api.clients[0].closed, 1);
  api.config.connectionMode = 'webhook';
  assert.equal((await api.transport.reconcile()).state, 'listening');
  assert.equal(api.clients[1].closed, 1);
  api.clients[0].change('connected');
  assert.equal(api.transport.status().state, 'listening');
  await api.clients[0].dispatcher.handles.get('im.message.receive_v1')({ message: {} });
  assert.equal(api.deliveries.length, 0);
  api.transport.dispose();
});

test('switching mode or disposing during credential/SDK resolution cannot resurrect a client', async () => {
  for (const stage of ['credentials', 'sdk']) {
    for (const action of ['webhook', 'dispose']) {
      const pending = deferred();
      const api = setup(stage === 'sdk' ? { loadSdk: () => pending.promise } : {});
      if (stage === 'credentials') api.ctx.credentials.resolve = () => pending.promise;
      const starting = api.transport.reconcile();
      await tick();
      if (action === 'dispose') api.transport.dispose();
      else { api.config.connectionMode = 'webhook'; await api.transport.reconcile(); }
      pending.resolve(stage === 'sdk' ? api.sdk : { value: APP_ID });
      await starting;
      assert.equal(api.clients.length, 0);
      assert.equal(api.transport.status().state, action === 'dispose' ? 'stopped' : 'listening');
      api.transport.dispose();
    }
  }
});

test('configuration and asynchronous start failures surface status without exposing secrets', async () => {
  for (const failure of ['credentials', 'sdk', 'start']) {
    const error = new Error('unit-test-secret https://ticket.invalid/?token=secret');
    const api = setup(failure === 'sdk' ? { loadSdk: async () => { throw error; } } : failure === 'start' ? { start: () => Promise.reject(error) } : {});
    if (failure === 'credentials') api.ctx.credentials.resolve = async () => { throw error; };
    await api.transport.reconcile();
    await tick();
    assert.equal(api.transport.status().state, 'error');
    assert.doesNotMatch(JSON.stringify({ status: api.transport.status(), logs: api.logs }), /unit-test-secret|ticket.invalid/);
    api.transport.dispose();
  }
});

test('SDK failures and failed event dispatch use redacted diagnostics and allow retries', async () => {
  const api = setup({ onEvent: async () => { throw new Error('unit-test-secret'); } });
  await api.transport.reconcile();
  const client = api.clients[0];
  client.params.logger.error({ secret: 'unit-test-secret' });
  client.params.onError(new Error('unit-test-secret'));
  assert.equal(api.transport.status().state, 'error');
  await assert.rejects(client.dispatcher.handles.get('im.message.receive_v1')({ message: {} }), /Feishu event dispatch failed/);
  assert.doesNotMatch(JSON.stringify(api.logs), /unit-test-secret/);
  await api.transport.reconcile();
  assert.equal(api.clients.length, 2);
  assert.equal(client.closed, 1);
  api.transport.dispose();
});

test('published SDK close clears cache timers and cancels an in-flight endpoint lookup', async () => {
  const pending = deferred();
  let lookups = 0;
  const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };
  const client = new realSdk.WSClient({ appId: APP_ID, appSecret: 'fake-secret', logger, httpInstance: { request() { lookups++; return pending.promise; } } });
  await client.start({ eventDispatcher: new realSdk.EventDispatcher({ logger }) });
  assert.equal(lookups, 1);
  client.close({ force: true });
  pending.resolve({ code: 100004, msg: 'fake failure', data: {} });
  await tick();
  assert.equal(lookups, 1);
  assert.equal(client.getConnectionStatus().state, 'idle');
  assert.equal(client.pingInterval, undefined);
  assert.equal(client.reconnectInterval, undefined);
});
