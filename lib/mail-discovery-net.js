import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { domainToASCII } from 'node:url';

const excluded = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) excluded.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
]) excluded.addSubnet(address, prefix, 'ipv6');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const fakeV4 = new BlockList();
fakeV4.addSubnet('198.18.0.0', 15, 'ipv4');

function failure(code = 'UNAVAILABLE') {
  return Object.assign(new Error('Mailbox discovery could not reach a public service.'), { code });
}

export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) return !excluded.check(address, 'ipv4');
  // IPv4-mapped, NAT64, link-local, ULA and transition addresses never qualify.
  return family === 6 && globalV6.check(address, 'ipv6') && !excluded.check(address, 'ipv6');
}

export function normalizeMailHost(value) {
  if (typeof value !== 'string' || /[\s\p{Cc}]/u.test(value)) return undefined;
  const host = domainToASCII(value.replace(/\.$/, '').toLowerCase());
  if (!host || host.length > 253 || isIP(host) || !host.includes('.')) return undefined;
  const labels = host.split('.');
  if (!labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return undefined;
  if (['localhost', 'local', 'internal', 'invalid', 'test', 'onion'].includes(labels.at(-1))) return undefined;
  return host;
}

export function withDiscoveryAbort(promise, signal) {
  if (signal?.aborted) {
    // The caller may already have started an async DNS lookup. Observe its
    // eventual rejection even when cancellation wins before we attach a race.
    Promise.resolve(promise).catch(() => {});
    return Promise.reject(failure('ABORTED'));
  }
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(failure('ABORTED'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export async function resolvePublicHost(host, { signal, lookup = dnsLookup, dohLookup } = {}) {
  if (signal?.aborted) throw failure('ABORTED');
  const literal = isIP(host);
  let addresses;
  if (literal) addresses = [{ address: host, family: literal }];
  else {
    const normalized = normalizeMailHost(host);
    if (!normalized) throw failure('UNSAFE_HOST');
    addresses = await withDiscoveryAbort(lookup(normalized, { all: true, verbatim: true }), signal);
    // TUN clients can synthesize 198.18/15 answers. Never allow those addresses
    // through the public-IP gate. Re-resolve only that specific condition via
    // certificate-validated DoH at a pinned public endpoint instead. Explicit
    // lookup injections stay entirely offline unless a DoH test double is also
    // provided; these options are not exposed in user/plugin configuration.
    const fake = item => isIP(item?.address) === 4 && fakeV4.check(item.address, 'ipv4');
    if (Array.isArray(addresses) && addresses.some(fake) &&
        addresses.every(item => fake(item) || isPublicAddress(item?.address)) &&
        (lookup === dnsLookup || dohLookup)) {
      addresses = await withDiscoveryAbort((dohLookup || resolvePublicDoh)(normalized, { signal }), signal);
    }
  }
  if (!Array.isArray(addresses) || !addresses.length || addresses.some(item => !isPublicAddress(item.address))) {
    throw failure('UNSAFE_HOST');
  }
  const chosen = addresses.find(item => isIP(item.address) === 4) || addresses[0];
  return { address: chosen.address, family: isIP(chosen.address) };
}

// Cloudflare's official JSON DoH API:
// https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/dns-json/
// AliDNS official public resolver and JSON DoH API: https://alidns.com/
export async function resolvePublicDoh(host, { signal, request = httpsRequest } = {}) {
  const domain = normalizeMailHost(host);
  if (!domain || signal?.aborted) throw failure('UNSAFE_HOST');
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 4000);
  try {
    const providers = [
      { url: 'https://cloudflare-dns.com/dns-query', address: '1.1.1.1', questionArray: true },
      { url: 'https://dns.alidns.com/resolve', address: '223.5.5.5', questionArray: false },
    ];
    // Different networks can block individual public resolvers. Race complete,
    // validated answers under ONE budget; a failed resolver never cancels its
    // peer, and no private/Fake-IP result can win the race.
    return await Promise.any(providers.map(async provider => {
      const child = new AbortController();
      const cancel = () => child.abort();
      controller.signal.addEventListener('abort', cancel, { once: true });
      if (controller.signal.aborted) cancel();
      try {
        const results = await Promise.all([1, 28].map(async type => {
          const url = `${provider.url}?name=${encodeURIComponent(domain)}&type=${type}`;
          const text = await fetchPublicText(url, {
            signal: child.signal, request, maxBytes: 32 * 1024, maxRedirects: 0,
            accept: 'application/dns-json',
            // Pin the resolver too; never recursively resolve the DoH service
            // through Fake-IP DNS. TLS/SNI retain its official DNS hostname.
            lookup: async () => [{ address: provider.address, family: 4 }],
          });
          let data;
          try { data = JSON.parse(text); } catch { throw failure('INVALID_RESPONSE'); }
          const question = provider.questionArray ?
            Array.isArray(data?.Question) && data.Question.length === 1 ? data.Question[0] : undefined :
            data?.Question && !Array.isArray(data.Question) ? data.Question : undefined;
          if (![0, 3].includes(data?.Status) || data.TC === true ||
              normalizeMailHost(question?.name) !== domain || question?.type !== type) throw failure('INVALID_RESPONSE');
          if (data.Status === 3) return [];
          if (data.Answer !== undefined && (!Array.isArray(data.Answer) || data.Answer.length > 64)) throw failure('INVALID_RESPONSE');
          return (data.Answer || []).filter(answer => answer.type === type).map(answer => ({
            address: answer.data, family: type === 1 ? 4 : 6,
          }));
        }));
        const addresses = results.flat();
        if (!addresses.length || addresses.some(item => !isPublicAddress(item.address) || isIP(item.address) !== item.family)) {
          throw failure('UNSAFE_HOST');
        }
        return addresses;
      } finally {
        child.abort();
        controller.signal.removeEventListener('abort', cancel);
      }
    }));
  } catch {
    throw failure(controller.signal.aborted ? 'ABORTED' : 'UNAVAILABLE');
  } finally {
    clearTimeout(timer);
    controller.abort();
    signal?.removeEventListener('abort', abort);
  }
}

export async function fetchPublicText(input, {
  signal, lookup = dnsLookup, request = httpsRequest, maxBytes = 128 * 1024, maxRedirects = 2,
  accept = 'application/xml, text/xml',
} = {}) {
  let url;
  try { url = new URL(input); } catch { throw failure('UNSAFE_URL'); }
  for (let redirects = 0; ; redirects++) {
    if (signal?.aborted) throw failure('ABORTED');
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
        !normalizeMailHost(url.hostname)) throw failure('UNSAFE_URL');
    const address = await resolvePublicHost(url.hostname, { signal, lookup });
    const result = await new Promise((resolve, reject) => {
      let settled = false;
      let req;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value);
      };
      const abort = () => {
        finish(failure('ABORTED'));
        req?.destroy();
      };
      try {
        req = request(url, {
          agent: false,
          rejectUnauthorized: true,
          minVersion: 'TLSv1.2',
          servername: url.hostname,
          headers: { accept, 'user-agent': 'dsh-feishu-bot/mail-discovery' },
          // HTTPS still validates the original hostname; DNS cannot be rebound after validation.
          lookup: (_host, options, callback) => {
            if (options?.all) callback(null, [address]);
            else callback(null, address.address, address.family);
          },
        }, response => {
          const status = response.statusCode;
          if ([301, 302, 303, 307, 308].includes(status)) {
            finish(null, { redirect: response.headers.location });
            response.destroy();
            return;
          }
          if (status !== 200) {
            finish(failure(status === 404 || status === 410 ? 'NOT_FOUND' : 'UNAVAILABLE'));
            response.destroy();
            return;
          }
          if (Number(response.headers['content-length']) > maxBytes ||
              (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
            finish(failure('INVALID_RESPONSE'));
            response.destroy();
            return;
          }
          const chunks = [];
          let bytes = 0;
          response.on('data', chunk => {
            bytes += chunk.length;
            if (bytes > maxBytes) { finish(failure('INVALID_RESPONSE')); response.destroy(); }
            else chunks.push(chunk);
          });
          response.on('end', () => finish(null, { text: Buffer.concat(chunks).toString('utf8') }));
          response.on('error', () => finish(failure()));
          response.on('aborted', () => finish(failure()));
        });
        req.on('error', () => finish(failure()));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort(); else req.end();
      } catch { finish(failure()); req?.destroy(); }
    });
    if ('text' in result) return result.text;
    if (!result.redirect || redirects >= maxRedirects) throw failure('INVALID_RESPONSE');
    try { url = new URL(result.redirect, url); } catch { throw failure('UNSAFE_URL'); }
  }
}
