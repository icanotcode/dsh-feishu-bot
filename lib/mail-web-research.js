import { randomUUID } from 'node:crypto';
import { resolveMx as dnsResolveMx } from 'node:dns/promises';
import { Parser } from 'htmlparser2';
import { getDomain } from 'tldts';
import { fetchPublicText, normalizeMailHost, withDiscoveryAbort } from './mail-discovery-net.js';

const MAX_RESULTS = 12;
const MAX_PAGES = 6;
const TTL = 10 * 60 * 1000;
const HIDDEN = new Set(['script', 'style', 'noscript', 'template', 'form', 'head', 'svg', 'iframe', 'object']);
const USER_CONTENT = new Set(['community', 'forum', 'forums', 'answers', 'questions']);
const BLOCK = new Set(['p', 'div', 'section', 'article', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'br', 'hr']);
const fail = code => Object.assign(new Error('Official mailbox configuration could not be verified.'), { code });
const normalizeText = text => text.replace(/\s+/gu, ' ').trim();
const registered = host => getDomain(host, { allowPrivateDomains: true });

function mailbox(email) {
  if (typeof email !== 'string' || email.length > 254 || /[\s\p{Cc}]/u.test(email)) return;
  const parts = email.split('@');
  const domain = parts.length === 2 && parts[0] && normalizeMailHost(parts[1]);
  if (!domain || !registered(domain)) return;
  return { key: `${parts[0]}@${domain}`, domain };
}

function officialUrl(input, allowed) {
  try {
    const url = new URL(input);
    const host = normalizeMailHost(url.hostname);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
        !host || !allowed.has(registered(host))) return;
    // A provider's community is user-authored content, not an authority for
    // selecting the server which will later receive an authorization code.
    const pathSegments = decodeURIComponent(url.pathname).toLowerCase().split('/');
    if (host.split('.').some(label => USER_CONTENT.has(label)) ||
        pathSegments.some(segment => USER_CONTENT.has(segment))) return;
    url.hash = '';
    return url.href;
  } catch { return; }
}

/** HTML is data, never instructions. The caller must label this output untrusted. */
export function mailPageText(html) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > 256 * 1024) throw fail('INVALID_PAGE');
  const chunks = [];
  const hidden = [];
  const parser = new Parser({
    onopentag(name, attributes) {
      hidden.push(Boolean(hidden.at(-1) || HIDDEN.has(name) || Object.hasOwn(attributes, 'hidden') ||
        attributes['aria-hidden']?.toLowerCase() === 'true' ||
        /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attributes.style || '')));
      if (!hidden.at(-1) && BLOCK.has(name)) chunks.push('\n');
    },
    ontext(text) { if (!hidden.at(-1)) chunks.push(text); },
    onclosetag(name) {
      const wasHidden = hidden.pop();
      if (!wasHidden) chunks.push(BLOCK.has(name) ? '\n' : ' ');
    },
  }, { decodeEntities: true });
  parser.end(html);
  return chunks.join('').replace(/[\t\r ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 32 * 1024);
}

/**
 * Search adapter receives a DOMAIN ONLY and must perform a real web search.
 * Each instance belongs to one bot/user binding; mailbox-keyed evidence must
 * never be shared between user bindings, even when they use the same mailbox.
 * MX identifies possible publishers only; it is never used as an SMTP endpoint.
 * SMTP probes and saving settings belong to the caller, after verify succeeds.
 */
export function createMailWebResearch({
  search: searchWeb, fetchText = fetchPublicText, resolveMx = dnsResolveMx,
  now = Date.now, ttlMs = TTL, maxEntries = 100, timeoutMs,
  searchTimeoutMs = timeoutMs ?? 65000, readTimeoutMs = timeoutMs ?? 20000,
} = {}) {
  const records = new Map();
  const ttl = Math.min(TTL, Math.max(1, Number(ttlMs) || TTL));
  const limit = Math.min(100, Math.max(1, Number(maxEntries) || 100));
  const sweep = () => {
    for (const [key, record] of records) if (record.expires <= now()) records.delete(key);
  };
  const current = email => {
    sweep();
    const address = mailbox(email);
    const record = address && records.get(address.key);
    if (!record) throw fail('EVIDENCE_EXPIRED');
    return { address, record };
  };
  const budget = async (signal, milliseconds, ceiling, callback) => {
    if (signal?.aborted) throw fail('ABORTED');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, Math.min(ceiling, Math.max(1, Number(milliseconds) || ceiling)));
    try { return await withDiscoveryAbort(callback(controller.signal), controller.signal); }
    finally { clearTimeout(timer); controller.abort(); signal?.removeEventListener('abort', abort); }
  };

  return {
    async search(email, { signal } = {}) {
      const address = mailbox(email);
      if (!address) return { status: 'not_found', results: [] };
      if (typeof searchWeb !== 'function') return { status: 'unavailable', results: [] };
      try {
        return await budget(signal, searchTimeoutMs, 65000, async taskSignal => {
          sweep();
          const allowed = new Set([registered(address.domain)]);
          const smtpAllowed = new Set(allowed);
          const queries = [address.domain];
          const mxController = new AbortController();
          const cancelMx = () => mxController.abort();
          taskSignal.addEventListener('abort', cancelMx, { once: true });
          const mxTimer = setTimeout(cancelMx, 3000);
          try {
            const answers = await withDiscoveryAbort(resolveMx(address.domain, { signal: mxController.signal }), mxController.signal);
            if (Array.isArray(answers)) {
              for (const answer of answers.slice(0, 32).sort((a, b) => a.priority - b.priority)) {
                const host = normalizeMailHost(answer?.exchange);
                const domain = host && registered(host);
                if (!domain || queries.length >= 3) continue;
                // Microsoft publishes Exchange Online help on microsoft.com,
                // while delegated MX names use outlook.com / mx.microsoft.
                // This maps publisher identity only, never SMTP configuration.
                // https://learn.microsoft.com/en-us/microsoft-365/enterprise/urls-and-ip-address-ranges
                const microsoft = host.endsWith('.mail.protection.outlook.com') || host.endsWith('.mx.microsoft');
                const publisher = microsoft ? 'microsoft.com' : domain;
                // Official Microsoft endpoint documentation establishes the
                // office365.com service domain for this delegated MX identity.
                // It does not authorize arbitrary cross-domain SMTP endpoints.
                smtpAllowed.add(domain);
                if (microsoft) smtpAllowed.add('office365.com');
                allowed.add(domain);
                allowed.add(publisher);
                if (!queries.includes(publisher)) queries.push(publisher);
              }
            }
          } catch { /* The mailbox domain remains an authoritative publisher. */ }
          finally { clearTimeout(mxTimer); mxController.abort(); taskSignal.removeEventListener('abort', cancelMx); }
          if (taskSignal.aborted) throw fail('ABORTED');
          const searches = await Promise.allSettled(queries.map(domain =>
            withDiscoveryAbort(searchWeb(domain, { signal: taskSignal }), taskSignal)));
          if (taskSignal.aborted) throw fail('ABORTED');
          let unavailable = false;
          const results = [];
          const seen = new Set();
          for (const result of searches) {
            if (result.status !== 'fulfilled' || result.value?.status === 'unavailable') { unavailable = true; continue; }
            if (result.value?.status !== 'found' || !Array.isArray(result.value.results)) continue;
            for (const candidate of result.value.results.slice(0, 24)) {
              const url = typeof candidate?.url === 'string' && officialUrl(candidate.url, allowed);
              if (!url || url.length > 4096 || seen.has(url) || results.length >= MAX_RESULTS) continue;
              seen.add(url);
              results.push({
                id: randomUUID(), url,
                title: typeof candidate.title === 'string' ? candidate.title.slice(0, 300) : '',
                snippet: typeof candidate.snippet === 'string' ? candidate.snippet.slice(0, 1000) : '',
              });
            }
          }
          records.delete(address.key);
          while (records.size >= limit) records.delete(records.keys().next().value);
          records.set(address.key, { allowed, smtpAllowed, results, pages: new Map(), expires: now() + ttl });
          return { status: results.length ? 'found' : unavailable ? 'unavailable' : 'not_found',
            domain: address.domain, results, untrustedContent: true };
        });
      } catch { return { status: 'unavailable', results: [] }; }
    },

    async read(email, resultId, { signal } = {}) {
      const { address, record } = current(email);
      const result = record.results.find(item => item.id === resultId);
      if (!result) throw fail('UNKNOWN_RESULT');
      try {
        return await budget(signal, readTimeoutMs, 20000, async taskSignal => {
          const validateUrl = url => {
            if (!officialUrl(url instanceof URL ? url.href : url, record.allowed)) throw fail('UNOFFICIAL_SOURCE');
            return true;
          };
          const html = await withDiscoveryAbort(fetchText(result.url, {
            signal: taskSignal, maxBytes: 256 * 1024, maxRedirects: 2,
            accept: 'text/html, text/plain;q=0.9', validateUrl,
          }), taskSignal);
          const text = mailPageText(html);
          if (!text) throw fail('INVALID_PAGE');
          if (records.get(address.key) !== record || record.expires <= now()) throw fail('EVIDENCE_EXPIRED');
          const page = { pageId: randomUUID(), url: result.url, text, untrustedContent: true };
          while (record.pages.size >= MAX_PAGES) record.pages.delete(record.pages.keys().next().value);
          record.pages.set(page.pageId, page);
          return page;
        });
      } catch (error) {
        throw fail(['ABORTED', 'UNOFFICIAL_SOURCE', 'EVIDENCE_EXPIRED', 'INVALID_PAGE'].includes(error?.code) ? error.code : 'PAGE_UNAVAILABLE');
      }
    },

    verify(email, { pageId, host, port, mode, excerpt } = {}) {
      const { record } = current(email);
      const page = record.pages.get(pageId);
      if (!page) throw fail('UNKNOWN_PAGE');
      const normalizedHost = normalizeMailHost(host);
      if (!normalizedHost || !record.smtpAllowed.has(registered(normalizedHost)) || !Number.isInteger(port) || port < 1 || port > 65535 || !['tls', 'starttls'].includes(mode) ||
          typeof excerpt !== 'string' || excerpt.length < 10 || excerpt.length > 1500) throw fail('INVALID_EVIDENCE');
      const quote = normalizeText(excerpt);
      if (!normalizeText(page.text).includes(quote)) throw fail('INVALID_EVIDENCE');
      // Token boundaries reject a proposed host that only appears as a prefix of
      // an unrelated hostname, and reject a port found inside a longer number.
      const hosts = quote.match(/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}\.?/gi) || [];
      const ports = quote.match(/\b\d{1,5}\b/g) || [];
      const encrypted = mode === 'starttls' ? /\bSTART[ -]?TLS\b/i.test(quote) : /\b(?:SSL|TLS)\b/i.test(quote);
      if (!hosts.some(value => normalizeMailHost(value) === normalizedHost) || !ports.includes(String(port)) || !encrypted) throw fail('INVALID_EVIDENCE');
      return { smtp: { host: normalizedHost, port, mode }, source: { kind: 'official_web', url: page.url } };
    },

    dispose() { records.clear(); },
  };
}
