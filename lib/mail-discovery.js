import { resolveSrv as dnsResolveSrv } from 'node:dns/promises';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { detectMailProvider } from './mail-provider.js';
import { fetchPublicText, normalizeMailHost, resolvePublicHost, withDiscoveryAbort } from './mail-discovery-net.js';

const asArray = value => value === undefined ? [] : Array.isArray(value) ? value : [value];
const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, parseAttributeValue: false, processEntities: false });
const NOT_FOUND = Object.freeze({ status: 'not_found' });

function emailDomain(email) {
  if (typeof email !== 'string' || email.length > 254 || /[\s\p{Cc}]/u.test(email)) return undefined;
  const parts = email.split('@');
  return parts.length === 2 && parts[0] ? normalizeMailHost(parts[1]) : undefined;
}

// This intentionally supports only authentication using the complete mailbox
// address. A provider requiring OAuth or a separate account name is not safe to
// configure automatically using the user's SMTP authorization code.
export function parseMailAutoconfig(xml, email) {
  const domain = emailDomain(email);
  if (!domain || typeof xml !== 'string' || Buffer.byteLength(xml) > 128 * 1024 ||
      /<!\s*(?:DOCTYPE|ENTITY)/i.test(xml) || XMLValidator.validate(xml) !== true) return [];
  let root;
  try { root = parser.parse(xml)?.clientConfig; } catch { return []; }
  if (!root || root['@_version'] !== '1.1' || Array.isArray(root.emailProvider)) return [];
  const provider = root.emailProvider;
  if (!provider || !asArray(provider.domain).some(value => typeof value === 'string' && value.toLowerCase() === domain)) return [];
  const candidates = [];
  for (const server of asArray(provider.outgoingServer).slice(0, 16)) {
    if (server?.['@_type'] !== 'smtp' || typeof server.hostname !== 'string' || typeof server.username !== 'string') continue;
    if (!asArray(server.authentication).some(auth => auth === 'password-cleartext' || auth === 'password-encrypted' || auth === 'plain')) continue;
    const username = server.username.replaceAll('%EMAILADDRESS%', email)
      .replaceAll('%EMAILLOCALPART%', email.split('@')[0]).replaceAll('%EMAILDOMAIN%', domain);
    if (username !== email) continue;
    const host = normalizeMailHost(server.hostname.replaceAll('%EMAILDOMAIN%', domain));
    const mode = server.socketType === 'SSL' ? 'tls' : server.socketType === 'STARTTLS' ? 'starttls' : undefined;
    const port = typeof server.port === 'string' && /^\d{1,5}$/.test(server.port) ? Number(server.port) : 0;
    if (!host || !mode || port < 1 || port > 65535) continue;
    candidates.push({ host, port, mode });
  }
  return candidates;
}

/** Discover settings without credentials, mailbox local parts, SMTP AUTH or MX guessing.
 * Sources: RFC 6186 / RFC 8314 DNS delegation and Thunderbird's HTTPS autoconfig.
 * Network dependencies are injectable for offline tests, never plugin/user settings.
 */
export async function discoverMailProvider(email, {
  signal, timeoutMs = 15000, sourceTimeoutMs = 4500,
  resolveSrv = dnsResolveSrv, lookup, fetchText = fetchPublicText,
} = {}) {
  if (signal?.aborted) return { status: 'unavailable' };
  const domain = emailDomain(email);
  if (!domain) return NOT_FOUND;
  const known = detectMailProvider(email);
  if (known) {
    const candidate = { smtp: known, source: { kind: 'catalogue' } };
    return { status: 'found', ...candidate, candidates: [candidate] };
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const budget = Math.min(15000, Math.max(1, Number(timeoutMs) || 15000));
  const timer = setTimeout(abort, budget);
  let unavailable = false;
  const sourceTask = async callback => {
    const child = new AbortController();
    const cancel = () => child.abort();
    controller.signal.addEventListener('abort', cancel, { once: true });
    const sourceTimer = setTimeout(cancel, Math.min(budget, Math.max(1, Number(sourceTimeoutMs) || 4500)));
    try {
      if (controller.signal.aborted) child.abort();
      return await withDiscoveryAbort(callback(child.signal), child.signal);
    } catch (error) {
      if (!['ENODATA', 'ENOTFOUND', 'NOT_FOUND', 'UNSAFE_HOST', 'UNSAFE_URL', 'INVALID_RESPONSE'].includes(error?.code)) unavailable = true;
      return undefined;
    } finally {
      clearTimeout(sourceTimer);
      child.abort();
      controller.signal.removeEventListener('abort', cancel);
    }
  };
  const srv = (label, mode) => sourceTask(async sourceSignal => {
    const records = await withDiscoveryAbort(resolveSrv(`${label}._tcp.${domain}`), sourceSignal);
    if (!Array.isArray(records)) return;
    const candidates = [];
    for (const record of records.slice(0, 32).sort((a, b) => a.priority - b.priority || b.weight - a.weight)) {
      const host = normalizeMailHost(record.name);
      if (!host || !Number.isInteger(record.port) || record.port < 1 || record.port > 65535) continue;
      try {
        await resolvePublicHost(host, { signal: sourceSignal, lookup });
        candidates.push({ smtp: { host, port: record.port, mode }, source: { kind: 'dns_srv', record: `${label}._tcp.${domain}` } });
        if (candidates.length >= 4) break;
      } catch { /* Another publicly delegated server may still be reachable. */ }
    }
    return candidates;
  });
  const xml = (url, kind) => sourceTask(async sourceSignal => {
    const contents = await withDiscoveryAbort(fetchText(url, { signal: sourceSignal, lookup }), sourceSignal);
    const candidates = [];
    for (const smtp of parseMailAutoconfig(contents, email)) {
      try {
        await resolvePublicHost(smtp.host, { signal: sourceSignal, lookup });
        candidates.push({ smtp, source: { kind, url } });
        if (candidates.length >= 4) break;
      } catch { /* Never connect to a private address returned by autoconfig. */ }
    }
    return candidates;
  });
  try {
    // Independent lookups share a hard budget. Deterministic ordering prefers
    // implicit TLS DNS delegation, then STARTTLS, provider HTTPS, then ISPDB.
    const results = await Promise.all([
      srv('_submissions', 'tls'), srv('_submission', 'starttls'),
      xml(`https://autoconfig.${domain}/mail/config-v1.1.xml`, 'autoconfig'),
      xml(`https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml`, 'autoconfig'),
      xml(`https://autoconfig.thunderbird.net/v1.1/${domain}`, 'ispdb'),
    ]);
    if (signal?.aborted) return { status: 'unavailable' };
    const seen = new Set();
    const candidates = results.flat().filter(candidate => {
      if (!candidate?.smtp) return false;
      const key = `${candidate.smtp.host}:${candidate.smtp.port}:${candidate.smtp.mode}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 5);
    return candidates.length ? { status: 'found', ...candidates[0], candidates } :
      unavailable || controller.signal.aborted ? { status: 'unavailable' } : NOT_FOUND;
  } finally {
    clearTimeout(timer);
    controller.abort();
    signal?.removeEventListener('abort', abort);
  }
}
