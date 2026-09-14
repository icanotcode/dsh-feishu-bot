import { createHash } from 'node:crypto';
import { credentialRef } from '@deepseek-ai/dsh-credentials';

const RECEIVE_MESSAGE = 'im.message.receive_v1';
const MESSAGES = {
  listening: 'Webhook 已启用，等待飞书向请求地址推送事件。',
  starting: '正在准备飞书长连接。',
  connecting: '正在连接飞书，请稍候。',
  connected: '飞书长连接已连接。',
  reconnecting: '飞书连接已断开，正在自动重连。',
  waiting_configuration: '请先保存飞书 App ID 和 App Secret。',
  stopped: '飞书长连接已停止。',
  error: '飞书长连接失败，请检查应用凭据、飞书订阅方式和网络后重新保存。',
};

// EventDispatcher flattens a v2 envelope to {...header, ...event}.
// Reconstruct it before sharing the webhook's validation/dispatch/deduplication.
function normalizeMessage(data) {
  if (data?.header && data?.event) return data;
  const { schema, event_id, event_type, create_time, token, app_id, tenant_key, ...event } = data || {};
  return {
    schema: schema || '2.0',
    header: Object.fromEntries(Object.entries({ event_id, event_type: event_type || RECEIVE_MESSAGE, create_time, token, app_id, tenant_key }).filter(([, value]) => value !== undefined)),
    event: Object.fromEntries(Object.entries(event)),
  };
}

/** Own one SDK connection. reconcile() starts asynchronously; status() reports
 * SDK lifecycle state, never assumes that start() resolving means connected.
 * The host calls reconcile after loading/saving config and dispose on unload.
 */
export function createTransport(ctx, config, onEvent, { loadSdk = () => import('@larksuiteoapi/node-sdk') } = {}) {
  let active;
  let revision = 0;
  let disposed = false;
  let state = config.connectionMode === 'websocket' ? 'starting' : 'listening';

  const mode = () => config.connectionMode === 'websocket' ? 'websocket' : 'webhook';
  const current = record => !disposed && active === record && mode() === 'websocket';
  const warn = message => ctx.logger?.warn?.(message);
  function close(record) {
    if (!record) return;
    try { record.client?.close({ force: true }); }
    catch { warn('飞书长连接关闭失败。'); }
  }
  function stop() {
    const previous = active;
    active = undefined;
    close(previous);
  }
  function status() {
    let reported = state;
    if (disposed) reported = 'stopped';
    else if (mode() === 'webhook') reported = 'listening';
    else if (active?.client && state !== 'error') {
      const sdkState = active.client.getConnectionStatus().state;
      reported = ({ connected: 'connected', connecting: 'connecting', reconnecting: 'reconnecting', failed: 'error', idle: 'stopped' })[sdkState] || state;
    }
    return { mode: mode(), state: reported, message: MESSAGES[reported] };
  }

  async function reconcile() {
    const attempt = ++revision;
    if (disposed) return status();
    if (mode() === 'webhook') {
      stop();
      state = 'listening';
      return status();
    }
    if (!active) state = 'starting';
    try {
      const [appId, appSecret] = await Promise.all([
        ctx.credentials.resolve(credentialRef(config.appIdEnv || 'FEISHU_APP_ID')),
        ctx.credentials.resolve(credentialRef(config.appSecretEnv || 'FEISHU_APP_SECRET')),
      ]);
      if (disposed || attempt !== revision) return status();
      if (!appId?.value || !appSecret?.value) {
        stop();
        state = 'waiting_configuration';
        return status();
      }
      if (!/^cli_[0-9a-fA-F]{16}$/.test(appId.value)) {
        stop();
        state = 'error';
        return status();
      }
      const identity = createHash('sha256').update(JSON.stringify([appId.value, appSecret.value])).digest('hex');
      if (active?.identity === identity && !['error', 'stopped'].includes(status().state)) return status();
      stop();
      state = 'starting';
      const module = await loadSdk();
      if (disposed || attempt !== revision) return status();
      const sdk = module.WSClient ? module : module.default;
      // These lifecycle APIs also identify SDK releases with safe shutdown of
      // in-flight handshakes and SDK-owned cache/reconnect timers.
      if (!sdk?.WSClient?.prototype.getConnectionStatus || !sdk.WSClient.prototype.close) throw new Error('unsupported SDK');
      const record = { identity, client: undefined, warned: false };
      active = record;
      const setState = next => { if (current(record)) state = next; };
      // SDK errors may carry credentials, tickets or event bodies. Only emit
      // fixed diagnostics; lifecycle comes from callbacks and SDK snapshots.
      const diagnostic = () => {
        if (current(record) && !record.warned) {
          record.warned = true;
          warn('飞书 SDK 报告连接或事件处理异常，请检查连接状态。');
        }
      };
      const logger = { trace() {}, debug() {}, info() {}, warn: diagnostic, error: diagnostic };
      const eventDispatcher = new sdk.EventDispatcher({ logger }).register({
        [RECEIVE_MESSAGE]: async data => {
          if (!current(record)) return;
          try {
            // onEvent acknowledges queue admission, not the Agent's reply.
            await onEvent(normalizeMessage(data), { authenticated: true });
          } catch {
            diagnostic();
            // Preserve SDK's 500 acknowledgement so Feishu can retry.
            throw new Error('Feishu event dispatch failed');
          }
        },
      });
      record.client = new sdk.WSClient({
        appId: appId.value,
        appSecret: appSecret.value,
        domain: sdk.Domain?.Feishu,
        autoReconnect: true,
        handshakeTimeoutMs: 15000,
        logger,
        onReady: () => setState('connected'),
        onReconnected: () => { record.warned = false; setState('connected'); },
        onReconnecting: () => setState('reconnecting'),
        onError: () => { setState('error'); diagnostic(); },
      });
      state = 'connecting';
      // Do not await network activity in plugin setup or a settings save.
      Promise.resolve(record.client.start({ eventDispatcher })).catch(() => {
        if (current(record)) {
          state = 'error';
          diagnostic();
          stop();
        }
      });
    } catch {
      if (!disposed && attempt === revision) {
        stop();
        state = 'error';
        warn('飞书长连接启动失败，请检查 SDK 安装、凭据和网络配置。');
      }
    }
    return status();
  }

  function dispose() {
    disposed = true;
    revision++;
    stop();
    state = 'stopped';
  }
  return { reconcile, status, dispose };
}
