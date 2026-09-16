const MiB = 1024 * 1024;
const MAX_DOWNLOAD = 100 * MiB;
const MAX_IMAGE = 10 * MiB;
const MAX_FILE = 30 * MiB;
const MAX_RESPONSE = 64 * 1024;
const MAX_TIMEOUT = 120000;
const FILE_TYPES = new Set(['opus', 'mp4', 'pdf', 'doc', 'xls', 'ppt', 'stream']);
const MESSAGES = {
  INVALID_INPUT: '飞书附件参数无效', TOO_LARGE: '飞书附件超过大小限制', EMPTY_FILE: '不能上传空附件',
  CANCELLED: '飞书附件操作已取消', TIMEOUT: '飞书附件操作超时，请重试',
  PERMISSION_DENIED: '飞书附件权限不足，请检查应用资源及消息读取权限并发布应用版本',
  UNAUTHORIZED: '飞书附件认证失败，请检查应用凭据', RESOURCE_UNAVAILABLE: '当前消息中的附件不可获取',
  RATE_LIMITED: '飞书附件请求过于频繁，请稍后重试', REDIRECT_REJECTED: '飞书附件接口返回重定向，已拒绝携带凭据跳转',
  INVALID_RESPONSE: '飞书附件接口返回无效数据', REQUEST_FAILED: '飞书附件操作失败，请检查网络与应用配置',
};

export class FeishuMediaError extends Error {
  constructor(code, { providerCode, httpStatus } = {}) {
    super(MESSAGES[code] || MESSAGES.REQUEST_FAILED);
    this.name = 'FeishuMediaError'; this.code = code;
    if (Number.isSafeInteger(providerCode) && providerCode >= 0) this.providerCode = providerCode;
    if (Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599) this.httpStatus = httpStatus;
  }
}
const fail = (code, details) => { throw new FeishuMediaError(code, details); };
const bounded = (value, maximum) => {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value < 1) fail('INVALID_INPUT');
  return Math.min(value, maximum);
};
function identifier(value) {
  // Resource keys are opaque path segments, never paths or URLs supplied by a model.
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(value)) fail('INVALID_INPUT');
  return encodeURIComponent(value);
}
function filename(value, fallback) {
  if (value === undefined) value = fallback;
  if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) fail('INVALID_INPUT');
  const name = value.split(/[/\\]/).pop().trim();
  if (!name || name === '.' || name === '..' || Buffer.byteLength(name) > 1024) fail('INVALID_INPUT');
  return name;
}
function bytes(data, maximum, requested) {
  if (!(data instanceof Uint8Array)) fail('INVALID_INPUT');
  if (!data.byteLength) fail('EMPTY_FILE');
  if (data.byteLength > bounded(requested, maximum)) fail('TOO_LARGE');
  return data;
}
function abortError(signal) {
  return new FeishuMediaError(signal.reason?.name === 'TimeoutError' ? 'TIMEOUT' : 'CANCELLED');
}
function untilAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const aborted = () => { signal.removeEventListener('abort', aborted); reject(abortError(signal)); };
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(value => { signal.removeEventListener('abort', aborted); resolve(value); },
      error => { signal.removeEventListener('abort', aborted); reject(error); });
  });
}
async function readBounded(response, maximum, signal) {
  const length = response.headers.get('content-length');
  if (length && /^\d+$/.test(length) && Number(length) > maximum) {
    response.body?.cancel().catch(() => {}); fail('TOO_LARGE');
  }
  if (!response.body?.getReader) fail('INVALID_RESPONSE');
  const reader = response.body.getReader();
  const aborted = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', aborted, { once: true });
  let size = 0; const chunks = [];
  try {
    while (true) {
      if (signal.aborted) throw abortError(signal);
      const { done, value } = await untilAbort(reader.read(), signal);
      if (signal.aborted) throw abortError(signal);
      if (done) break;
      size += value.byteLength;
      if (size > maximum) { reader.cancel().catch(() => {}); fail('TOO_LARGE'); }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } finally {
    signal.removeEventListener('abort', aborted);
    reader.releaseLock();
  }
}
function providerFailure(httpStatus, providerCode) {
  const details = { httpStatus, providerCode };
  if (httpStatus === 401 || providerCode === 234002) fail('UNAUTHORIZED', details);
  if (httpStatus === 403 || [234009, 99991672, 99991679].includes(providerCode)) fail('PERMISSION_DENIED', details);
  if (httpStatus === 429) fail('RATE_LIMITED', details);
  if ([234003, 234004, 234005, 234008, 234043].includes(providerCode)) fail('RESOURCE_UNAVAILABLE', details);
  if ([234006, 234037].includes(providerCode)) fail('TOO_LARGE', details);
  fail('REQUEST_FAILED', details);
}
async function jsonResponse(response, signal) {
  let data;
  try { data = JSON.parse((await readBounded(response, MAX_RESPONSE, signal)).toString('utf8')); }
  catch (error) {
    if (error instanceof FeishuMediaError) throw error;
    if (!response.ok) providerFailure(response.status);
    fail('INVALID_RESPONSE');
  }
  if (!response.ok || data?.code !== 0) providerFailure(response.status, data?.code);
  if (!data.data || typeof data.data !== 'object') fail('INVALID_RESPONSE');
  return data.data;
}
async function request(client, endpoint, options, run) {
  const timeout = bounded(options.timeoutMs, MAX_TIMEOUT);
  const controller = new AbortController();
  const signals = [controller.signal, options.signal, client.requests?.getStore?.()].filter(Boolean);
  if (signals.some(signal => typeof signal?.addEventListener !== 'function')) fail('INVALID_INPUT');
  const signal = AbortSignal.any(signals);
  const deadline = setTimeout(() => controller.abort(new DOMException('Media request timed out', 'TimeoutError')), timeout);
  const operation = async () => {
    try {
      let base;
      try {
        base = new URL(client.baseUrl);
        if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error();
      } catch { fail('INVALID_INPUT'); }
      if (signal.aborted) throw abortError(signal);
      const token = await untilAbort(client.getTenantToken(), signal);
      if (typeof token !== 'string' || !token) fail('UNAUTHORIZED');
      const response = await untilAbort(fetch(`${base.origin}${endpoint}`, {
        method: options.body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}` },
        body: options.body, redirect: 'manual', signal,
      }), signal);
      if (response.status >= 300 && response.status < 400) { response.body?.cancel().catch(() => {}); fail('REDIRECT_REJECTED'); }
      return await run(response, signal);
    } catch (error) {
      if (error instanceof FeishuMediaError) throw error;
      if (signal.aborted) throw abortError(signal);
      fail('REQUEST_FAILED');
    } finally { clearTimeout(deadline); }
  };
  return typeof client.requests?.run === 'function' ? client.requests.run(signal, operation) : operation();
}

/** Download only a resource that Feishu confirms belongs to the supplied message. */
export async function downloadMessageResource(client, options) {
  const { messageId, key, type } = options;
  if (!['image', 'file'].includes(type)) fail('INVALID_INPUT');
  const maximum = bounded(options.maxBytes, MAX_DOWNLOAD);
  const endpoint = `/open-apis/im/v1/messages/${identifier(messageId)}/resources/${identifier(key)}?type=${type}`;
  return request(client, endpoint, { signal: options.signal, timeoutMs: options.timeoutMs }, async (response, signal) => {
    if (!response.ok) await jsonResponse(response, signal);
    const data = await readBounded(response, maximum, signal);
    // A legitimate JSON attachment is still a file, not an API envelope.
    const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const mimeType = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(contentType) ? contentType : 'application/octet-stream';
    return { data, mimeType };
  });
}

export async function uploadMessageImage(client, options) {
  const data = bytes(options.data, MAX_IMAGE, options.maxBytes);
  const form = new FormData();
  form.set('image_type', 'message'); form.set('image', new Blob([data]), filename(options.filename, 'image'));
  return request(client, '/open-apis/im/v1/images', { ...options, body: form }, async (response, signal) => {
    const result = await jsonResponse(response, signal);
    try { identifier(result.image_key); } catch { fail('INVALID_RESPONSE'); }
    return { image_key: result.image_key };
  });
}

export async function uploadMessageFile(client, options) {
  const data = bytes(options.data, MAX_FILE, options.maxBytes);
  const fileType = options.fileType || 'stream';
  if (!FILE_TYPES.has(fileType)) fail('INVALID_INPUT');
  if (options.duration !== undefined && (!Number.isSafeInteger(options.duration) || options.duration < 0 || options.duration > 2147483647)) fail('INVALID_INPUT');
  const name = filename(options.filename);
  const form = new FormData();
  form.set('file_type', fileType); form.set('file_name', name); form.set('file', new Blob([data]), name);
  if (options.duration !== undefined) form.set('duration', String(options.duration));
  return request(client, '/open-apis/im/v1/files', { ...options, body: form }, async (response, signal) => {
    const result = await jsonResponse(response, signal);
    try { identifier(result.file_key); } catch { fail('INVALID_RESPONSE'); }
    return { file_key: result.file_key };
  });
}
