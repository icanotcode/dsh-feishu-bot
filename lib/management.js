import { mkdir, readFile, rename, writeFile, unlink, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { credentialRef } from '@deepseek-ai/dsh-credentials';

const PUBLIC_FIELDS = ['connectionMode', 'workspacePath', 'agentPreset', 'permissionPreset', 'ngrokDomain', 'publicBaseUrl'];
const MAX_BODY = 64 * 1024;
class ManagementError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function validateSettings(input) {
  const result = {};
  for (const key of PUBLIC_FIELDS) {
    if (!(key in input)) continue;
    if (typeof input[key] !== 'string' || input[key].length > 4096) throw new ManagementError(400, `${key} 必须是有效字符串`);
    const value = input[key].trim();
    if (['workspacePath', 'agentPreset', 'permissionPreset'].includes(key) && !value) throw new ManagementError(400, `${key} 不能为空`);
    if (key === 'connectionMode' && !['webhook', 'websocket'].includes(value)) throw new ManagementError(400, '请选择开发者服务器或长连接');
    if (key === 'workspacePath' && !isAbsolute(value)) throw new ManagementError(400, '工作目录必须是绝对路径');
    if (key === 'publicBaseUrl' && value) {
      let url;
      try { url = new URL(value); } catch { throw new ManagementError(400, '公网地址必须是完整 HTTPS URL'); }
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new ManagementError(400, '公网地址必须是没有路径的 HTTPS URL');
    }
    if (key === 'ngrokDomain' && value && !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(value)) throw new ManagementError(400, 'ngrok 域名格式无效');
    result[key] = key === 'publicBaseUrl' ? value.replace(/\/$/, '') : value;
  }
  return result;
}
async function readJsonBody(request) {
  if (!/^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/i.test(request.headers['content-type'] || '')) throw new ManagementError(415, '请求必须使用 application/json');
  const length = request.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BODY)) throw new ManagementError(413, '请求体过大');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > MAX_BODY) throw new ManagementError(413, '请求体过大');
    chunks.push(Buffer.from(chunk));
  }
  try {
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new ManagementError(400, '请求必须是有效 JSON 对象'); }
}
function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

/** Load persisted settings before the caller registers webhook rules. Secrets belong to the Harness credential provider. */
export async function createManagement(ctx, config, feishuClient, hooks = {}) {
  config.connectionMode ||= "webhook";
  const configFile = config.configFile || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'feishu-bot.json');
  config.verificationToken ||= 'FEISHU_VERIFICATION_TOKEN';
  config.encryptKey ||= 'FEISHU_ENCRYPT_KEY';
  config.ngrokAuthtokenEnv ||= 'NGROK_AUTHTOKEN';
  try {
    const stored = JSON.parse(await readFile(configFile, 'utf8'));
    if (!stored || typeof stored !== 'object' || Array.isArray(stored) || stored.version !== 1) throw new Error('invalid format');
    Object.assign(config, validateSettings(stored));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('飞书配置文件无法读取，请检查 JSON 格式与字段');
  }
  const refs = {
    appId: credentialRef(config.appIdEnv || 'FEISHU_APP_ID'),
    appSecret: credentialRef(config.appSecretEnv || 'FEISHU_APP_SECRET'),
    verificationToken: credentialRef(config.verificationToken),
    encryptKey: credentialRef(config.encryptKey),
    ngrokAuthtoken: credentialRef(config.ngrokAuthtokenEnv),
  };
  const resolve = async (field) => (await ctx.credentials.resolve(refs[field]))?.value || '';
  let writes = Promise.resolve();
  const service = {
    async getConfig() {
      const values = Object.fromEntries(await Promise.all(Object.keys(refs).map(async key => [key, await resolve(key)])));
      return {
        ...Object.fromEntries(PUBLIC_FIELDS.map(key => [key, config[key] || ''])),
        appId: values.appId, appSecret: '', verificationToken: '', encryptKey: '', ngrokAuthtoken: '',
        configured: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Boolean(value)])),
        path: config.path || '/webhook/feishu', scheduledTasks: [],
        capabilities: { scheduledTasks: false, ngrokProcessControl: false },
      };
    },
    updateConfig(input) {
      const operation = writes.then(async () => {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ManagementError(400, '配置必须是对象');
        const updates = validateSettings(input);
        if (updates.workspacePath) {
          let directory;
          try { directory = await stat(updates.workspacePath); } catch { throw new ManagementError(400, '工作目录不存在或无法访问'); }
          if (!directory.isDirectory()) throw new ManagementError(400, '工作目录必须是目录');
        }
        const secrets = [];
        for (const [field, ref] of Object.entries(refs)) {
          if (!(field in input)) continue;
          if (typeof input[field] !== 'string' || input[field].length > 8192) throw new ManagementError(400, `${field} 必须是有效字符串`);
          if (!input[field].trim()) continue; // A blank password input preserves the saved credential.
          const value = input[field].trim();
          const current = await ctx.credentials.resolve(ref);
          if (current?.source === 'env' && current.value !== value) throw new ManagementError(409, `${field} 由进程环境变量提供，请先在启动环境中修改`);
          if (current?.value !== value) secrets.push([ref, value]);
        }
        const next = { version: 1, ...Object.fromEntries(PUBLIC_FIELDS.filter(key => config[key] !== undefined).map(key => [key, config[key]])), ...updates };
        await mkdir(dirname(configFile), { recursive: true, mode: 0o700 });
        const temporary = `${configFile}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
          for (const [ref, value] of secrets) await ctx.credentials.set(ref, value);
          await rename(temporary, configFile);
        } finally { await unlink(temporary).catch(() => {}); }
        Object.assign(config, updates);
        if (feishuClient) { feishuClient.cachedToken = null; feishuClient.tokenExpireTime = 0; }
        await hooks.onConfigChanged?.();
        return { success: true };
      });
      writes = operation.catch(() => {});
      return operation;
    },
    async testConnection(input = {}) {
      const appId = typeof input.appId === 'string' && input.appId.trim() || await resolve('appId');
      const appSecret = typeof input.appSecret === 'string' && input.appSecret.trim() || await resolve('appSecret');
      if (!appId || !appSecret) return { success: false, message: '请先配置 App ID 和 App Secret' };
      try {
        const response = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ app_id: appId, app_secret: appSecret }), signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) return { success: false, message: `飞书接口返回 HTTP ${response.status}` };
        const data = await response.json();
        if (data.code !== 0 || !data.tenant_access_token) return { success: false, message: `飞书认证失败（错误码 ${Number.isInteger(data.code) ? data.code : '未知'}），请检查应用凭据` };
        return { success: true, message: '飞书应用认证成功' };
      } catch (error) { return { success: false, message: error.name === 'TimeoutError' || error.name === 'AbortError' ? '飞书连接超时，请重试' : '无法连接飞书，请检查网络后重试' }; }
    },
    async getNgrokStatus() {
      try {
        const response = await fetch('http://127.0.0.1:4040/api/tunnels', { signal: AbortSignal.timeout(1500) });
        if (!response.ok) throw new Error();
        const data = await response.json();
        // Only report tunnels pointing at this Harness listener, never unrelated local services.
        const port = ctx.webServer.port;
        const tunnel = (Array.isArray(data.tunnels) ? data.tunnels : []).find(item => {
          if (typeof item.public_url !== 'string' || !item.public_url.startsWith('https://') || !port) return false;
          try {
            const target = new URL(String(item.config?.addr).includes('://') ? item.config.addr : `http://${item.config?.addr}`);
            return ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname) && Number(target.port || 80) === port;
          } catch { return false; }
        });
        return { running: Boolean(tunnel), url: tunnel?.public_url || null, managed: false, message: tunnel ? '已检测到现有 ngrok 隧道' : '未检测到指向当前 Harness 端口的 HTTPS 隧道' };
      } catch { return { running: false, url: null, managed: false, message: '未检测到本机 ngrok 服务' }; }
    },
    async startNgrok() { return { success: false, message: '插件仅检测现有 ngrok 隧道。请在终端启动 ngrok 后刷新状态' }; },
    async stopNgrok() { return { success: false, message: '隧道由外部进程管理，请在启动 ngrok 的终端停止它' }; },
    async getWebhookUrl() {
      const base = config.publicBaseUrl || (await service.getNgrokStatus()).url;
      return base ? `${base.replace(/\/$/, '')}${config.path || '/webhook/feishu'}` : null;
    },
  };
  const routes = {
    '/connection/status': { GET: () => hooks.getConnectionStatus?.() ?? { mode: config.connectionMode, state: 'starting', message: '正在初始化连接' } },
    '/config': { GET: () => service.getConfig(), POST: body => service.updateConfig(body) },
    '/test': { POST: body => service.testConnection(body) },
    '/ngrok/status': { GET: () => service.getNgrokStatus() },
    '/ngrok/start': { POST: body => service.startNgrok(body) },
    '/ngrok/stop': { POST: () => service.stopNgrok() },
    '/webhook-url': { GET: async () => ({ url: await service.getWebhookUrl() }) },
  };
  for (const [suffix, methods] of Object.entries(routes)) {
    const path = `/api/feishu-bot${suffix}`;
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler: async (request, response) => {
      try {
        // Use the same Host/Origin fence and authenticated browser session as Harness's own management APIs.
        const rejection = ctx.connection.requestRejection(request);
        if (rejection !== undefined) { sendJson(response, rejection, { success: false, message: '请从已登录的 Harness 页面访问此管理接口' }); return; }
        const action = methods[request.method];
        if (!action) { response.setHeader('allow', Object.keys(methods).join(', ')); throw new ManagementError(405, '请求方法不支持'); }
        const body = request.method === 'POST' ? await readJsonBody(request) : undefined;
        sendJson(response, 200, await action(body));
      } catch (error) {
        // Provider errors may include secret values: only our validated messages are public.
        sendJson(response, error instanceof ManagementError ? error.status : 500, { success: false, message: error instanceof ManagementError ? error.message : '飞书配置操作失败，请检查本机存储与服务状态' });
      }
    } }), `feishu-bot management: ${path}`);
  }
  return service;
}
