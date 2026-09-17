import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { discoverMailProvider, parseMailAutoconfig } from '../lib/mail-discovery.js';
import { fetchPublicText, isPublicAddress, resolvePublicDoh, resolvePublicHost, withDiscoveryAbort } from '../lib/mail-discovery-net.js';

const email = 'private-localpart@custom-mail.example.org';
const domain = 'custom-mail.example.org';
const publicLookup = async () => [{ address: '8.8.8.8', family: 4 }];
const missing = async () => { throw Object.assign(new Error('private diagnostic details'), { code: 'ENODATA' }); };
const base = { resolveSrv: missing, lookup: publicLookup, fetchText: missing };
function xml({ host = 'smtp.hosting.example.org', socketType = 'SSL', username = '%EMAILADDRESS%', auth = 'password-cleartext', domains = domain, port = '465' } = {}) {
  return `<?xml version="1.0"?><clientConfig version="1.1"><emailProvider id="host">
  <domain>${domains}</domain><outgoingServer type="smtp"><hostname>${host}</hostname>
  <port>${port}</port><socketType>${socketType}</socketType><authentication>${auth}</authentication>
  <username>${username}</username></outgoingServer></emailProvider></clientConfig>`;
}

test('catalogue stays a fast path with no network calls', async () => {
  const fail = async () => { assert.fail('network was not needed'); };
  const result = await discoverMailProvider('test@qq.com', { resolveSrv: fail, lookup: fail, fetchText: fail });
  assert.equal(result.status, 'found');
  assert.equal(result.smtp.host, 'smtp.qq.com');
  assert.equal(result.source.kind, 'catalogue');
});

test('unknown provider discovers public SRV delegation and prefers implicit TLS', async () => {
  const queries = [];
  const result = await discoverMailProvider(email, { ...base, resolveSrv: async query => {
    queries.push(query);
    return [{ name: 'smtp.delegated.example.org.', port: query.startsWith('_submissions.') ? 2465 : 587, priority: 0, weight: 1 }];
  } });
  assert.deepEqual(result.smtp, { host: 'smtp.delegated.example.org', port: 2465, mode: 'tls' });
  assert.equal(result.source.kind, 'dns_srv');
  assert.deepEqual(queries.sort(), [`_submission._tcp.${domain}`, `_submissions._tcp.${domain}`].sort());
  assert.ok(queries.every(query => !query.includes('private-localpart')));
});

test('STARTTLS SRV is used when implicit TLS is absent', async () => {
  const result = await discoverMailProvider(email, { ...base, resolveSrv: async query => {
    if (query.startsWith('_submissions.')) return [];
    return [{ name: 'smtp.provider.example.org', port: 587, priority: 0, weight: 0 }];
  } });
  assert.equal(result.smtp.mode, 'starttls');
});

test('alternative authoritative candidates are ordered, deduplicated and bounded for connection fallback', async () => {
  const result = await discoverMailProvider(email, { ...base,
    resolveSrv: async () => Array.from({ length: 8 }, (_, index) => ({
      name: `smtp${index}.provider.example.org`, port: 465, priority: index, weight: 0,
    })),
    fetchText: async () => xml(),
  });
  assert.equal(result.candidates.length, 5);
  assert.deepEqual(result.candidates[0], { smtp: result.smtp, source: result.source });
  assert.equal(result.candidates[0].smtp.host, 'smtp0.provider.example.org');
  assert.equal(result.candidates[3].smtp.host, 'smtp3.provider.example.org');
  assert.equal(result.candidates[4].smtp.mode, 'starttls');
  const deduped = await discoverMailProvider(email, { ...base, fetchText: async () => xml() });
  assert.equal(deduped.candidates.length, 1);
  assert.equal(deduped.candidates[0].source.kind, 'autoconfig');
});

test('HTTPS provider configuration and ISPDB discover arbitrary mailbox domains without sending mailbox names', async () => {
  for (const source of ['autoconfig', 'well-known', 'ispdb']) {
    const requests = [];
    const result = await discoverMailProvider(email, { ...base, fetchText: async url => {
      requests.push(url);
      const matches = source === 'autoconfig' ? url.startsWith(`https://autoconfig.${domain}/`) :
        source === 'well-known' ? url.includes('/.well-known/') : url.startsWith('https://autoconfig.thunderbird.net/');
      if (!matches) return '';
      return xml();
    } });
    assert.equal(result.status, 'found');
    assert.equal(result.smtp.host, 'smtp.hosting.example.org');
    assert.equal(result.source.kind, source === 'ispdb' ? 'ispdb' : 'autoconfig');
    assert.ok(requests.every(url => !url.includes('private-localpart') && !url.includes('@') && !url.includes('?')));
  }
});

test('autoconfig rejects wrong domains, cleartext, OAuth-only, incompatible usernames, entities and malformed XML', () => {
  for (const document of [
    xml({ domains: 'other.example.org' }), xml({ socketType: 'plain' }), xml({ auth: 'OAuth2' }),
    xml({ username: '%EMAILLOCALPART%' }), xml({ username: 'attacker@example.org' }),
    xml({ host: '%EMAILLOCALPART%.example.org' }), xml({ port: '465.0' }), xml({ port: '65536' }),
    '<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' + xml(),
    xml().replace('</outgoingServer>', '</bad>'),
    xml().replace('<domain>', '<domain><nested>').replace('</domain>', '</nested></domain>'),
    ' '.repeat(128 * 1024 + 1),
  ]) assert.deepEqual(parseMailAutoconfig(document, email), []);
  assert.deepEqual(parseMailAutoconfig(xml({ host: 'smtp.%EMAILDOMAIN%', username: '%EMAILLOCALPART%@%EMAILDOMAIN%' }), email), [
    { host: `smtp.${domain}`, port: 465, mode: 'tls' },
  ]);
});

test('private SMTP destinations and mixed DNS answers are never accepted from any discovery source', async () => {
  const result = await discoverMailProvider(email, { ...base,
    resolveSrv: async () => [{ name: 'smtp.hidden.example.org', port: 465, priority: 0, weight: 0 }],
    fetchText: async () => xml(),
    lookup: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }],
  });
  assert.equal(result.status, 'not_found');
});

test('discovery has a bounded shared budget, handles cancellation and never returns network diagnostic text', async () => {
  const hanging = () => new Promise(() => {});
  const start = Date.now();
  const result = await discoverMailProvider(email, { ...base, timeoutMs: 30, resolveSrv: hanging, fetchText: hanging });
  assert.deepEqual(result, { status: 'unavailable' });
  assert.ok(Date.now() - start < 1500);
  const controller = new AbortController();
  controller.abort();
  assert.deepEqual(await discoverMailProvider(email, { ...base, signal: controller.signal }), { status: 'unavailable' });
  const errorResult = await discoverMailProvider(email, { ...base, fetchText: async () => { throw new Error('secret user@somewhere password raw log'); } });
  assert.deepEqual(errorResult, { status: 'unavailable' });
});

test('pre-cancelled async operations observe later rejection without an unhandled promise', async () => {
  const controller = new AbortController();
  controller.abort();
  const pending = new Promise((_resolve, reject) => setTimeout(() => reject(new Error('late DNS rejection')), 5));
  await assert.rejects(withDiscoveryAbort(pending, controller.signal), { code: 'ABORTED' });
  await new Promise(resolve => setTimeout(resolve, 15));
  const active = new AbortController();
  const lookup = resolvePublicHost('smtp.example.org', { signal: active.signal, lookup: () => new Promise(() => {}) });
  active.abort();
  await assert.rejects(lookup, { code: 'ABORTED' });
});

test('public-address policy rejects private, reserved, mapped and transition IP ranges', async () => {
  for (const address of [
    '127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.0.1', '169.254.169.254',
    '100.100.100.200', '0.0.0.0', '192.0.2.1', '198.18.0.1', '203.0.113.2',
    '224.0.0.1', '255.255.255.255', '::1', '::', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1',
    '64:ff9b::7f00:1', '2002:7f00:1::', '2001:db8::1', '2001::1', '3fff::1', 'not-an-ip',
  ]) assert.equal(isPublicAddress(address), false, address);
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) {
    assert.equal(isPublicAddress(address), true, address);
  }
  assert.deepEqual(await resolvePublicHost('smtp.example.org', { lookup: publicLookup }), { address: '8.8.8.8', family: 4 });
  await assert.rejects(resolvePublicHost('127.0.0.1'), { code: 'UNSAFE_HOST' });
});

function fakeRequest(responses, seen) {
  return (url, options, callback) => {
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = () => {
      const entry = { url: String(url), options };
      seen.push(entry);
      options.lookup(url.hostname, {}, (error, address, family) => { assert.ifError(error); entry.address = address; entry.family = family; });
      const data = responses.shift();
      assert.ok(data, 'unexpected extra HTTP request');
      const response = Readable.from([Buffer.from(data.body ?? '')]);
      response.statusCode = data.status ?? 200;
      response.headers = data.headers ?? {};
      queueMicrotask(() => callback(response));
    };
    return req;
  };
}

test('HTTPS fetch pins the validated DNS address while retaining TLS hostname verification', async () => {
  const seen = [];
  let lookups = 0;
  const value = await fetchPublicText('https://autoconfig.example.org/mail/config-v1.1.xml', {
    lookup: async () => { lookups++; return [{ address: lookups === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }]; },
    request: fakeRequest([{ body: xml() }], seen),
  });
  assert.equal(value, xml());
  assert.equal(lookups, 1);
  assert.equal(seen[0].address, '8.8.8.8');
  assert.equal(seen[0].options.servername, 'autoconfig.example.org');
  assert.equal(seen[0].options.rejectUnauthorized, true);
  assert.equal(seen[0].options.agent, false);
});

test('HTTPS redirects are revalidated; private, insecure and credentialed targets are blocked', async () => {
  for (const destination of ['http://unsafe.example.org/config', 'https://user:password@evil.example.org/config', 'https://internal.example.org/config', 'https://127.0.0.1/config']) {
    const seen = [];
    await assert.rejects(fetchPublicText('https://autoconfig.example.org/config', {
      lookup: async host => [{ address: host === 'internal.example.org' ? '10.0.0.1' : '8.8.8.8', family: 4 }],
      request: fakeRequest([{ status: 302, headers: { location: destination } }], seen),
    }));
    assert.equal(seen.length, 1);
  }
  const seen = [];
  assert.equal(await fetchPublicText('https://autoconfig.example.org/config', {
    lookup: publicLookup,
    request: fakeRequest([{ status: 302, headers: { location: 'https://provider.example.org/config' } }, { body: xml() }], seen),
  }), xml());
  assert.equal(seen.length, 2);
});

test('HTTPS rejects oversized bodies, error responses and redirect loops', async () => {
  for (const responses of [
    [{ body: 'x'.repeat(20) }], [{ status: 404 }],
    Array.from({ length: 3 }, () => ({ status: 302, headers: { location: '/loop' } })),
  ]) {
    await assert.rejects(fetchPublicText('https://autoconfig.example.org/config', {
      lookup: publicLookup, maxBytes: 10, request: fakeRequest(responses, []),
    }));
  }
});

test('TUN Fake-IP is re-resolved rather than allowed through the public-address gate', async () => {
  const lookup = async () => [{ address: '198.18.0.2', family: 4 }];
  // An injected DNS function must never cause real DoH network I/O by default.
  await assert.rejects(resolvePublicHost('smtp.example.org', { lookup }), { code: 'UNSAFE_HOST' });
  const seen = [];
  const result = await resolvePublicHost('smtp.example.org', { lookup, dohLookup: async (host, options) => {
    seen.push({ host, options });
    return [{ address: '8.8.8.8', family: 4 }];
  } });
  assert.deepEqual(result, { address: '8.8.8.8', family: 4 });
  assert.equal(seen[0].host, 'smtp.example.org');
  for (const address of ['198.18.0.3', '127.0.0.1', '10.0.0.1', '::ffff:127.0.0.1']) {
    await assert.rejects(resolvePublicHost('smtp.example.org', {
      lookup, dohLookup: async () => [{ address, family: 4 }],
    }), { code: 'UNSAFE_HOST' });
  }
  const unexpected = async () => { assert.fail('DoH must not override ordinary private DNS answers'); };
  await assert.rejects(resolvePublicHost('smtp.example.org', {
    lookup: async () => [{ address: '127.0.0.1', family: 4 }], dohLookup: unexpected,
  }), { code: 'UNSAFE_HOST' });
  await assert.rejects(resolvePublicHost('smtp.example.org', {
    lookup: async () => [{ address: '198.18.0.2', family: 4 }, { address: '127.0.0.1', family: 4 }], dohLookup: unexpected,
  }), { code: 'UNSAFE_HOST' });
});

function dnsJson(type, addresses = [], extra = {}) {
  return JSON.stringify({ Status: 0, Question: [{ name: 'smtp.example.org.', type }],
    Answer: addresses.map(address => ({ name: 'smtp.example.org.', type, data: address })), ...extra });
}

function dohRequest({ cloudflare = [], alidns = [] }, seen = []) {
  const fallback = () => Array.from({ length: 2 }, () => ({ status: 503 }));
  const cloudflareRequest = fakeRequest(cloudflare.length ? cloudflare : fallback(), seen);
  const alidnsRequest = fakeRequest(alidns.length ? alidns : fallback(), seen);
  return (url, options, callback) => url.hostname === 'cloudflare-dns.com' ?
    cloudflareRequest(url, options, callback) : alidnsRequest(url, options, callback);
}

function aliJson(type, addresses = [], extra = {}) {
  return dnsJson(type, addresses, { Question: { name: 'smtp.example.org.', type }, ...extra });
}

test('DoH connects only to pinned Cloudflare IP with verified hostname and sends only the domain', async () => {
  const seen = [];
  const addresses = await resolvePublicDoh('smtp.example.org', {
    request: dohRequest({ cloudflare: [
      { body: dnsJson(1, ['8.8.8.8']) },
      { body: dnsJson(28, ['2606:4700:4700::1111']) },
    ] }, seen),
  });
  assert.deepEqual(addresses, [{ address: '8.8.8.8', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }]);
  assert.equal(seen.length, 4);
  for (const entry of seen) {
    const url = new URL(entry.url);
    assert.equal(entry.address, url.hostname === 'cloudflare-dns.com' ? '1.1.1.1' : '223.5.5.5');
    assert.equal(entry.options.servername, url.hostname);
    assert.equal(entry.options.rejectUnauthorized, true);
    assert.equal(entry.options.headers.accept, 'application/dns-json');
    assert.ok(['cloudflare-dns.com', 'dns.alidns.com'].includes(url.hostname));
    assert.equal(url.searchParams.get('name'), 'smtp.example.org');
    assert.ok(!entry.url.includes('@'));
  }
});

test('DoH rejects private answers, unrelated questions, malformed data and redirects', async () => {
  for (const first of [
    { body: dnsJson(1, ['127.0.0.1']) },
    { body: dnsJson(1, ['198.18.0.1']) },
    { body: dnsJson(1, ['8.8.8.8'], { Question: [{ name: 'wrong.example.org', type: 1 }] }) },
    { body: 'invalid json' },
    { status: 302, headers: { location: 'https://different.example.org/resolve' } },
  ]) {
    const seen = [];
    await assert.rejects(resolvePublicDoh('smtp.example.org', {
      request: dohRequest({ cloudflare: [first, { body: dnsJson(28) }] }, seen),
    }));
    assert.ok(seen.length <= 4);
  }
});

test('DoH inherits cancellation and closes its in-flight HTTPS requests', async () => {
  const controller = new AbortController();
  let destroyed = 0;
  const pending = resolvePublicDoh('smtp.example.org', {
    signal: controller.signal,
    request: () => {
      const req = new EventEmitter();
      req.end = () => {};
      req.destroy = () => { destroyed++; };
      return req;
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { code: 'ABORTED' });
  assert.equal(destroyed, 4);
});

test('AliDNS public results win when Cloudflare fails without extending the shared budget', async () => {
  const seen = [];
  const addresses = await resolvePublicDoh('smtp.example.org', {
    request: dohRequest({
      cloudflare: [{ status: 503 }, { status: 503 }],
      alidns: [{ body: aliJson(1, ['8.8.4.4']) }, { body: aliJson(28) }],
    }, seen),
  });
  assert.deepEqual(addresses, [{ address: '8.8.4.4', family: 4 }]);
  const ali = seen.filter(entry => new URL(entry.url).hostname === 'dns.alidns.com');
  assert.equal(ali.length, 2);
  assert.ok(ali.every(entry => entry.address === '223.5.5.5' && entry.options.servername === 'dns.alidns.com'));
});

test('AliDNS rejects private answers and requires its exact question-object format', async () => {
  for (const body of [
    aliJson(1, ['127.0.0.1']), aliJson(1, ['198.18.0.1']),
    dnsJson(1, ['8.8.8.8']),
    aliJson(1, ['8.8.8.8'], { Question: { name: 'other.example.org', type: 1 } }),
    aliJson(1, ['8.8.8.8'], { Question: { name: 'smtp.example.org', type: 28 } }),
  ]) {
    await assert.rejects(resolvePublicDoh('smtp.example.org', {
      request: dohRequest({ alidns: [{ body }, { body: aliJson(28) }] }),
    }), { code: 'UNAVAILABLE' });
  }
});

test('invalid mailbox domains never trigger a network request', async () => {
  const fail = async () => { assert.fail('invalid mailbox triggered network'); };
  for (const address of ['x@127.0.0.1', 'x@localhost', 'x@foo.local', 'x@foo.test', 'x@@example.org', 'x@user:pass@example.org', 'x@https://example.org']) {
    assert.deepEqual(await discoverMailProvider(address, { resolveSrv: fail, fetchText: fail, lookup: fail }), { status: 'not_found' });
  }
});

test('official publisher URL guard applies before DNS and every redirected request', async () => {
  const seen = [], lookups = [];
  await assert.rejects(fetchPublicText('https://official.example.org/help', {
    validateUrl: url => url.hostname === 'official.example.org',
    lookup: async host => { lookups.push(host); return publicLookup(host); },
    request: fakeRequest([{ status: 302, headers: { location: 'https://other.example.com/help' } }], seen),
  }));
  assert.equal(seen.length, 1);
  assert.deepEqual(lookups, ['official.example.org']);
});
