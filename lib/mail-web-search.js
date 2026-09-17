import { normalizeMailHost, withDiscoveryAbort } from './mail-discovery-net.js';

const unavailableCodes = new Set([
  'WEB_PROVIDER_UNAVAILABLE', 'WEB_PROVIDER_CONFIGURED_MISSING',
  'WEB_PROVIDER_CONFIGURED_UNAVAILABLE', 'WEB_PROVIDER_AMBIGUOUS',
  'WEB_PROVIDER_CREDENTIAL_MISSING',
]);

function failed(code) {
  return { status: 'unavailable', results: [], code };
}

function normalizeResults(sources) {
  const results = [];
  const seen = new Set();
  for (const source of sources.slice(0, 64)) {
    if (!source || typeof source.url !== 'string' || source.url.length > 4096) continue;
    let url;
    try { url = new URL(source.url); } catch { continue; }
    // These are only search results, not an assertion of official ownership.
    // The discovery caller must establish that relationship before fetching
    // and accepting a page. No insecure/userinfo/local URL is useful there.
    if (url.protocol !== 'https:' || url.username || url.password ||
        (url.port && url.port !== '443') || !normalizeMailHost(url.hostname)) continue;
    url.hash = '';
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    results.push({
      url: url.href,
      title: typeof source.title === 'string' ? source.title.slice(0, 300) : '',
      snippet: typeof source.snippet === 'string' ? source.snippet.slice(0, 2000) : '',
    });
    if (results.length === 6) break;
  }
  return results;
}

/** Use Harness's real search-provider seam; never substitute guessed web URLs.
 * The caller supplies only a mailbox domain. Credentials and full addresses
 * are not accepted, and there is no model-controlled search query.
 */
export function createMailWebSearch(ctx, { timeoutMs = 60000 } = {}) {
  return async function search(domain, { signal } = {}) {
    const normalized = normalizeMailHost(domain);
    if (!normalized) return failed('INVALID_DOMAIN');
    if (signal?.aborted) return failed('ABORTED');
    let web;
    try {
      // Cordis's documented optional-service lookup avoids making all Feishu
      // messaging depend on a search service being installed and active.
      web = typeof ctx?.reflect?.get === 'function' ? ctx.reflect.get('web') : ctx?.web;
    } catch { return failed('SEARCH_UNAVAILABLE'); }
    if (typeof web?.search !== 'function') return failed('SEARCH_UNAVAILABLE');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); },
      Math.min(60000, Math.max(1, Number(timeoutMs) || 60000)));
    try {
      if (signal?.aborted) abort();
      const result = await withDiscoveryAbort(Promise.resolve().then(() => {
        if (controller.signal.aborted) throw Object.assign(new Error('Search cancelled.'), { code: 'ABORTED' });
        return web.search({
          query: `${normalized} email SMTP server port TLS official help 邮箱 SMTP 官方 帮助`,
          maxResults: 6,
        }, controller.signal);
      }), controller.signal);
      if (!Array.isArray(result?.sources)) return failed('SEARCH_FAILED');
      const results = normalizeResults(result.sources);
      return { status: results.length ? 'found' : 'not_found', results };
    } catch (error) {
      // Provider messages can contain endpoint/authentication diagnostics.
      // Expose only fixed categories, without the original error or cause.
      if (signal?.aborted) return failed('ABORTED');
      if (timedOut) return failed('SEARCH_TIMEOUT');
      if (error?.code === 'WEB_ABORTED' || error?.code === 'ABORTED') return failed('ABORTED');
      return failed(unavailableCodes.has(error?.code) ? 'SEARCH_UNAVAILABLE' : 'SEARCH_FAILED');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      controller.abort();
    }
  };
}
