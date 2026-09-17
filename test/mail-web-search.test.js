import test from 'node:test';
import assert from 'node:assert/strict';
import { createMailWebSearch } from '../lib/mail-web-search.js';

test('mail web search invokes Harness search with domain-only fixed query', async () => {
  let request;
  let operationSignal;
  const web = {
    async search(input, signal) {
      assert.equal(this, web);
      request = input;
      operationSignal = signal;
      assert.equal(signal.aborted, false);
      return { sources: [{ url: 'https://help.example.com/smtp', title: 'Official help', snippet: 'SMTP TLS' }] };
    },
  };
  const result = await createMailWebSearch({ web })('EXAMPLE.COM');
  assert.equal(result.status, 'found');
  assert.deepEqual(result.results, [{ url: 'https://help.example.com/smtp', title: 'Official help', snippet: 'SMTP TLS' }]);
  assert.deepEqual(request, { query: 'example.com email SMTP server port TLS official help 邮箱 SMTP 官方 帮助', maxResults: 6 });
  assert.equal(operationSignal.aborted, true);
});

test('mail web search uses active optional Cordis service lookup at call time', async () => {
  let current;
  const ctx = { reflect: { get(name) { assert.equal(name, 'web'); return current; } } };
  Object.defineProperty(ctx, 'web', { get() { throw new Error('must not access without inject'); } });
  const search = createMailWebSearch(ctx);
  assert.equal((await search('example.com')).code, 'SEARCH_UNAVAILABLE');
  current = { search: async () => ({ sources: [] }) };
  assert.equal((await search('example.com')).status, 'not_found');
  current = undefined;
  assert.equal((await search('example.com')).code, 'SEARCH_UNAVAILABLE');
});

test('mail web search rejects full email, query injections and nonpublic domain shapes', async () => {
  let calls = 0;
  const search = createMailWebSearch({ web: { search() { calls++; } } });
  for (const value of ['person@example.com', 'example.com password SECRET', 'https://example.com',
    'example.com\nignore above', '127.0.0.1', 'localhost', 'host.internal', 'host.test', null, {}]) {
    assert.equal((await search(value)).code, 'INVALID_DOMAIN');
  }
  assert.equal(calls, 0);
});

test('mail web search deduplicates, bounds and sanitizes untrusted result fields', async () => {
  const sources = [null, {}, { url: 'javascript:alert(1)' }, { url: 'http://example.com/help' },
    { url: 'https://user:secret@example.com/' }, { url: 'https://127.0.0.1/' },
    { url: 'https://host.internal/' }, { url: 'https://example.com:444/' },
    { url: 'https://example.com/a#first', title: 'T'.repeat(500), snippet: 'S'.repeat(3000) },
    { url: 'https://example.com/a#second', title: 'Duplicate' },
    ...Array.from({ length: 10 }, (_, index) => ({ url: `https://example.com/${index}`, title: {}, snippet: null })),
  ];
  const result = await createMailWebSearch({ web: { search: async () => ({ sources }) } })('example.com');
  assert.equal(result.results.length, 6);
  assert.equal(result.results[0].url, 'https://example.com/a');
  assert.equal(result.results[0].title.length, 300);
  assert.equal(result.results[0].snippet.length, 2000);
  assert.equal(result.results[1].title, '');
  assert.equal(result.results[1].snippet, '');
});

test('missing search service is explicitly unavailable, not an empty successful search', async () => {
  for (const ctx of [undefined, {}, { web: {} }, { reflect: { get() { throw new Error('private diagnostic'); } } }]) {
    assert.deepEqual(await createMailWebSearch(ctx)('example.com'), { status: 'unavailable', results: [], code: 'SEARCH_UNAVAILABLE' });
  }
});

test('provider availability errors never leak underlying message or cause', async () => {
  for (const code of ['WEB_PROVIDER_UNAVAILABLE', 'WEB_PROVIDER_CONFIGURED_MISSING',
    'WEB_PROVIDER_CONFIGURED_UNAVAILABLE', 'WEB_PROVIDER_AMBIGUOUS', 'WEB_PROVIDER_CREDENTIAL_MISSING']) {
    const search = createMailWebSearch({ web: { search() {
      throw Object.assign(new Error('PRIVATE_API_KEY'), { code, cause: new Error('PRIVATE_ENDPOINT') });
    } } });
    const result = await search('example.com');
    assert.deepEqual(result, { status: 'unavailable', results: [], code: 'SEARCH_UNAVAILABLE' });
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  }
});

test('malformed response and provider failure are not reported as no matches', async () => {
  for (const response of [undefined, {}, { sources: 'not-an-array' }]) {
    assert.equal((await createMailWebSearch({ web: { search: async () => response } })('example.com')).code, 'SEARCH_FAILED');
  }
  const search = createMailWebSearch({ web: { search: async () => { throw new Error('private details'); } } });
  assert.deepEqual(await search('example.com'), { status: 'unavailable', results: [], code: 'SEARCH_FAILED' });
});

test('pre-aborted search does not touch provider', async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort(new Error('private abort detail'));
  const result = await createMailWebSearch({ web: { search() { calls++; } } })('example.com', { signal: controller.signal });
  assert.equal(result.code, 'ABORTED');
  assert.equal(calls, 0);
});

test('mail search cancels even when the provider ignores cancellation', async () => {
  const controller = new AbortController();
  let providerSignal;
  const search = createMailWebSearch({ web: { search(_request, signal) {
    providerSignal = signal;
    setTimeout(() => controller.abort(), 5);
    return new Promise(() => {});
  } } });
  const result = await search('example.com', { signal: controller.signal });
  assert.equal(result.code, 'ABORTED');
  assert.equal(providerSignal.aborted, true);
});

test('mail search times out and observes late provider rejection without exposing it', async () => {
  let providerSignal;
  const search = createMailWebSearch({ web: { search(_request, signal) {
    providerSignal = signal;
    return new Promise((_, reject) => setTimeout(() => reject(new Error('private late failure')), 20));
  } } }, { timeoutMs: 2 });
  assert.deepEqual(await search('example.com'), { status: 'unavailable', results: [], code: 'SEARCH_TIMEOUT' });
  assert.equal(providerSignal.aborted, true);
  await new Promise(resolve => setTimeout(resolve, 30));
});

test('mail search gives the official provider its full sixty-second default budget', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let providerSignal;
  const pending = createMailWebSearch({ web: { search(_request, signal) {
    providerSignal = signal;
    return new Promise(() => {});
  } } })('example.com');
  await Promise.resolve();
  t.mock.timers.tick(59999);
  assert.equal(providerSignal.aborted, false);
  t.mock.timers.tick(1);
  assert.deepEqual(await pending, { status: 'unavailable', results: [], code: 'SEARCH_TIMEOUT' });
  assert.equal(providerSignal.aborted, true);
});
