import test from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { downloadMessageResource, uploadMessageImage, uploadMessageFile, FeishuMediaError } from '../lib/feishu-media-api.js';

const client = () => ({ baseUrl: 'https://open.feishu.cn', getTenantToken: async () => 'private-tenant-token', requests: new AsyncLocalStorage() });
const download = { messageId: 'om_message', key: 'file_resource', type: 'file' };
const envelope = data => new Response(JSON.stringify({ code: 0, data }), { headers: { 'content-type': 'application/json' } });
const hasCode = code => error => error instanceof FeishuMediaError && error.code === code;

test('downloads original message resource as bounded bytes, using scoped token and no redirects', async t => {
  const c = client();
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://open.feishu.cn/open-apis/im/v1/messages/om_message/resources/file_resource?type=file');
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Authorization, 'Bearer private-tenant-token'); assert.equal(c.requests.getStore(), options.signal);
    return new Response(Buffer.from('payload'), { headers: { 'content-type': 'application/pdf; charset=binary' } });
  });
  const result = await downloadMessageResource(c, download);
  assert.ok(Buffer.isBuffer(result.data)); assert.equal(result.data.toString(), 'payload'); assert.equal(result.mimeType, 'application/pdf');
});

test('JSON files are preserved rather than interpreted as API envelopes', async t => {
  const contents = '{"code":234009,"msg":"ordinary user data"}';
  t.mock.method(globalThis, 'fetch', async () => new Response(contents, { headers: { 'content-type': 'application/json' } }));
  assert.equal((await downloadMessageResource(client(), download)).data.toString(), contents);
});

test('stream download enforces actual size without Content-Length and cancels overflow', async t => {
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(Buffer.from('123')); controller.enqueue(Buffer.from('456')); },
    cancel() { cancelled = true; },
  })));
  await assert.rejects(downloadMessageResource(client(), { ...download, maxBytes: 5 }), hasCode('TOO_LARGE'));
  assert.equal(cancelled, true);
});

test('oversized Content-Length rejects before body read and caller cannot raise hard limit', async t => {
  let cancelled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-length': String(100 * 1024 * 1024 + 1) } }));
  await assert.rejects(downloadMessageResource(client(), { ...download, maxBytes: 999999999 }), hasCode('TOO_LARGE'));
  assert.equal(cancelled, true);
});

test('image upload sends message image multipart with binary payload and sanitized basename', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://open.feishu.cn/open-apis/im/v1/images'); assert.equal(options.method, 'POST');
    assert.equal(options.body.get('image_type'), 'message'); assert.equal(options.body.get('image').name, '截图.png');
    assert.equal(Buffer.from(await options.body.get('image').arrayBuffer()).toString(), 'image-data');
    assert.equal(options.headers['Content-Type'], undefined); assert.equal(options.redirect, 'manual');
    return envelope({ image_key: 'img_v3_resource' });
  });
  assert.deepEqual(await uploadMessageImage(client(), { data: Buffer.from('image-data'), filename: 'C:\\private\\截图.png' }), { image_key: 'img_v3_resource' });
});

test('video file upload sends mp4 and duration in milliseconds; documents use their IM types', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://open.feishu.cn/open-apis/im/v1/files');
    const form = options.body;
    if (!calls++) { assert.equal(form.get('file_type'), 'mp4'); assert.equal(form.get('duration'), '3200'); assert.equal(form.get('file_name'), 'video.mp4'); }
    else { assert.equal(form.get('file_type'), 'stream'); assert.equal(form.get('duration'), null); }
    assert.equal(form.get('file').size, 4);
    return envelope({ file_key: 'file_v3_resource' });
  });
  assert.deepEqual(await uploadMessageFile(client(), { data: Buffer.from('data'), filename: 'video.mp4', fileType: 'mp4', duration: 3200 }), { file_key: 'file_v3_resource' });
  await uploadMessageFile(client(), { data: Buffer.from('data'), filename: 'archive.zip' });
});

test('empty, oversized and malformed uploads fail before acquiring credentials or fetching', async t => {
  const c = client(); c.getTenantToken = () => { assert.fail('must validate before credentials'); };
  t.mock.method(globalThis, 'fetch', () => { assert.fail('must validate before network'); });
  await assert.rejects(uploadMessageImage(c, { data: Buffer.alloc(0) }), hasCode('EMPTY_FILE'));
  await assert.rejects(uploadMessageImage(c, { data: Buffer.alloc(4), maxBytes: 3 }), hasCode('TOO_LARGE'));
  await assert.rejects(uploadMessageImage(c, { data: Buffer.alloc(10 * 1024 * 1024 + 1), maxBytes: 999999999 }), hasCode('TOO_LARGE'));
  await assert.rejects(uploadMessageFile(c, { data: Buffer.alloc(30 * 1024 * 1024 + 1), filename: 'file' }), hasCode('TOO_LARGE'));
  await assert.rejects(uploadMessageFile(c, { data: Buffer.from('x'), filename: 'file', fileType: 'exe' }), hasCode('INVALID_INPUT'));
  await assert.rejects(uploadMessageFile(c, { data: Buffer.from('x'), filename: 'file', duration: -1 }), hasCode('INVALID_INPUT'));
  await assert.rejects(uploadMessageFile(c, { data: Buffer.from('x'), filename: 'bad\r\nname' }), hasCode('INVALID_INPUT'));
  await assert.rejects(downloadMessageResource(c, { ...download, messageId: '../secret' }), hasCode('INVALID_INPUT'));
  await assert.rejects(downloadMessageResource(c, { ...download, key: 'file?url=secret' }), hasCode('INVALID_INPUT'));
  await assert.rejects(downloadMessageResource(c, { ...download, type: 'video' }), hasCode('INVALID_INPUT'));
});

test('provider permission codes are safe and raw provider errors never escape', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ code: 234009, msg: 'leaked private-tenant-token' }), { status: 400 }));
  await assert.rejects(downloadMessageResource(client(), download), error => {
    assert.equal(error.code, 'PERMISSION_DENIED'); assert.equal(error.providerCode, 234009); assert.equal(error.httpStatus, 400);
    assert.ok(!error.message.includes('private-tenant-token')); assert.equal(error.cause, undefined); return true;
  });
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('network leaked private-tenant-token'); });
  await assert.rejects(uploadMessageImage(client(), { data: Buffer.from('x') }), error => error.code === 'REQUEST_FAILED' && !String(error).includes('private-tenant-token'));
  const c = client(); c.getTenantToken = async () => { throw new Error('secret-app-credentials'); };
  await assert.rejects(downloadMessageResource(c, download), error => error.code === 'REQUEST_FAILED' && !String(error).includes('secret-app-credentials'));
});

test('redirect never follows provider to another origin', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_, options) => {
    calls++; assert.equal(options.redirect, 'manual');
    return new Response(null, { status: 302, headers: { location: 'https://attacker.example/steal' } });
  });
  await assert.rejects(downloadMessageResource(client(), download), hasCode('REDIRECT_REJECTED')); assert.equal(calls, 1);
});

test('explicit and request-context abort signals cancel body and prevent pre-cancelled auth requests', async t => {
  const explicit = new AbortController(), contextual = new AbortController(); let cancelled = false;
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(Buffer.from('partial')); setTimeout(() => explicit.abort(new Error('secret cancel reason')), 5); },
    cancel() { cancelled = true; },
  })));
  await assert.rejects(downloadMessageResource(client(), { ...download, signal: explicit.signal }), hasCode('CANCELLED')); assert.equal(cancelled, true);
  contextual.abort(); const c = client(); c.getTenantToken = () => { assert.fail('cancelled request must not authenticate'); };
  await assert.rejects(c.requests.run(contextual.signal, () => uploadMessageFile(c, { data: Buffer.from('x'), filename: 'file' })), hasCode('CANCELLED'));
});

test('timeout covers stalled body and stalled token acquisition', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({})));
  await assert.rejects(downloadMessageResource(client(), { ...download, timeoutMs: 10 }), hasCode('TIMEOUT'));
  const c = client(); c.getTenantToken = () => new Promise(() => {});
  await assert.rejects(uploadMessageImage(c, { data: Buffer.from('x'), timeoutMs: 10 }), hasCode('TIMEOUT'));
});

test('response JSON is bounded and missing upload keys fail safely', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('x'.repeat(65537)));
  await assert.rejects(uploadMessageImage(client(), { data: Buffer.from('x') }), hasCode('TOO_LARGE'));
  t.mock.method(globalThis, 'fetch', async () => envelope({}));
  await assert.rejects(uploadMessageFile(client(), { data: Buffer.from('x'), filename: 'file' }), error => error instanceof FeishuMediaError);
});
