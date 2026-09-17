import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';

const CONSOLE = { label: '打开飞书开发者后台', url: 'https://open.feishu.cn/app' };
const SETTINGS = { label: '查看安装与配置说明', url: 'https://github.com/icanotcode/dsh-feishu-bot/blob/main/docs/setup.md' };
const check = (id, title, state, message, action) => ({ id, title, state, message, ...(action ? { action } : {}) });
function safeCallback(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash) return url.href;
  } catch { /* A saved URL or discovery result is not proof of reachability. */ }
  return null;
}

/** Inspect saved configuration. Never create sessions, authenticate SMTP, or send messages. */
export async function checkSetup({ ctx, config, service, getConnectionStatus = () => ({}), now = () => new Date() }) {
  const saved = await service.getConfig();
  const checks = [];
  const add = (...args) => checks.push(check(...args));
  const credentials = saved.configured.appId && saved.configured.appSecret;
  add('app', '飞书应用配置', credentials ? 'ok' : 'action', credentials ? '已保存 App ID 和 App Secret；后续检查将验证应用认证。' : '请填写并保存飞书应用的 App ID 和 App Secret。', credentials ? undefined : CONSOLE);
  if (credentials) {
    let valid = false;
    try { valid = (await service.testConnection()).success === true; } catch { /* Never expose provider errors. */ }
    add('credentials', '飞书应用认证', valid ? 'ok' : 'error', valid ? '已通过飞书应用认证；这不代表机器人权限、发布或消息收发已经通过。' : '飞书应用认证未通过，请检查已保存凭据及本机网络后重试。', valid ? undefined : CONSOLE);
  }
  try {
    if (!isAbsolute(saved.workspacePath) || !(await stat(saved.workspacePath)).isDirectory()) throw new Error();
    await access(saved.workspacePath, constants.R_OK | constants.X_OK | (saved.permissionPreset === 'workspace-write' ? constants.W_OK : 0));
    add('workspace', '项目目录', 'ok', '项目目录存在，当前进程具有所选权限需要的访问权限。');
  } catch { add('workspace', '项目目录', 'error', '请选择已存在且当前 Harness 进程可以访问的项目目录；检查不会自动创建目录。'); }
  if (typeof ctx.agentPresets?.resolve === 'function') {
    try {
      const preset = await ctx.agentPresets.resolve(saved.agentPreset || 'standard');
      // Harness resolves broken presets so settings can still display them.
      // A successful lookup alone therefore does not prove mountability.
      if (!preset || preset.broken !== undefined) throw new Error();
      add('agent', 'Agent 预设', 'ok', '已找到所选 Agent 预设；未创建会话或启动任务。');
    } catch { add('agent', 'Agent 预设', 'error', '所选 Agent 预设不可用，请在 Harness 设置中检查。'); }
  } else add('agent', 'Agent 预设', 'warning', '当前环境无法检查 Agent 预设，需要在 Harness 中确认。');
  try {
    const selection = config.model ?? ctx.agentDefaultModel?.currentSelection?.();
    const configured = Boolean(selection?.provider && selection?.model);
    add('model', '模型配置与余额', configured ? 'warning' : 'action', configured ? '已有模型选择；未发送付费模型请求，凭据、余额及实际回复能力仍需真实消息验收。' : '尚未确认可用的模型选择，请在 Harness 模型设置中完成配置。');
  } catch { add('model', '模型配置与余额', 'warning', '无法确认模型配置，请在 Harness 模型设置中检查；未发送付费请求。'); }
  let transport;
  try { transport = await getConnectionStatus(); } catch { transport = { state: 'error' }; }
  let callbackUrl;
  if (saved.connectionMode === 'websocket') {
    if (saved.serverTunnelRequired && !saved.sharedTunnel) {
      let tunnel;
      try { tunnel = await service.getTunnelStatus(); } catch { tunnel = { state: 'error' }; }
      add('tunnel', '共享公网隧道', tunnel?.running === true ? 'ok' : 'action', tunnel?.running === true
        ? '当前机器人使用长连接；已检测到其他 Webhook 机器人需要的共享隧道运行，尚未验证它们的公网回调。'
        : '当前机器人使用长连接，但其他机器人需要共享公网隧道，请在这里检查或尝试安全修复。');
    } else add('tunnel', '公网隧道', 'ok', '当前使用长连接，无需公网地址、隧道或 Webhook 验证令牌。');
    const connected = transport?.state === 'connected';
    add('connection', '飞书长连接', connected ? 'ok' : 'action', connected ? '飞书长连接已连接；仍需确认事件订阅并实际收发消息。' : '长连接尚未连接，请确认凭据、网络和飞书后台的长连接订阅方式。', connected ? undefined : CONSOLE);
  } else {
    const verification = saved.configured.verificationToken;
    const encryption = saved.configured.encryptKey;
    const authenticated = verification || encryption;
    add('webhookSecurity', 'Webhook 验证配置', authenticated ? 'ok' : 'action', verification ? (encryption ? '已保存验证令牌和加密密钥；请确保与飞书后台完全一致。' : '已保存验证令牌；若飞书后台启用了加密，还需保存相同的 Encrypt Key。') : encryption ? '已保存 Encrypt Key；可验证加密事件的签名，请确保飞书后台启用加密并使用相同密钥。' : '请保存飞书后台的 Verification Token，或启用加密并保存相同的 Encrypt Key，至少配置一种事件认证方式。', authenticated ? undefined : CONSOLE);
    let tunnel;
    try { tunnel = await service.getTunnelStatus(); } catch { tunnel = { state: 'error' }; }
    const running = tunnel?.running === true;
    add('tunnel', '公网隧道', running ? 'ok' : saved.tunnelProvider === 'custom' ? 'warning' : 'action', running ? '已检测到当前端口对应的隧道运行状态；尚未验证飞书公网回调。' : saved.sharedTunnel ? '公网隧道由所有机器人共享，请在默认机器人中检查或启动。' : saved.tunnelProvider === 'custom' ? '自定义公网入口由外部管理，插件无法验证其运行情况。' : '尚未确认隧道运行，可尝试安全修复；工具安装、账户授权需要管理员完成。');
    try { callbackUrl = safeCallback(await service.getWebhookUrl()) || undefined; } catch { /* Show fixed guidance below. */ }
    add('callback', 'HTTPS 回调地址', callbackUrl ? 'ok' : 'action', callbackUrl ? '已生成 HTTPS 回调地址；请在飞书后台保存并完成 URL 验证，此项不代表公网可达。' : '尚无可用 HTTPS 回调地址，请保存公网地址或启动隧道。', callbackUrl ? CONSOLE : undefined);
    add('connection', 'Webhook 监听', transport?.state === 'listening' ? 'ok' : 'action', transport?.state === 'listening' ? '本机 Webhook 已启用；监听状态不代表飞书事件已送达。' : '本机 Webhook 尚未确认启用，请检查当前机器人是否启用及插件运行状态。');
  }
  let web;
  try { web = typeof ctx.reflect?.get === 'function' ? ctx.reflect.get('web') : ctx.web; } catch { /* Optional service. */ }
  add('search', '可选联网搜索', 'warning', typeof web?.search === 'function' ? '已发现 Harness 搜索服务；未发送付费请求，未验证账户余额或服务是否可用。' : '未发现可用搜索服务；普通飞书会话可继续，未知邮箱服务商的网页搜索需要另行配置。');
  add('botCapability', '飞书机器人能力', 'action', '请在飞书后台启用机器人能力，并确认应用可用范围包含测试用户。', CONSOLE);
  add('events', '事件订阅与权限', 'action', '请订阅 im.message.receive_v1 并开通所需消息收发权限；如需附件等功能，按配置说明补齐对应权限。', CONSOLE);
  add('publish', '飞书应用发布', 'action', '请在飞书后台创建并发布当前配置版本；插件无法代替管理员完成审批。', CONSOLE);
  add('acceptance', '真实消息验收', 'action', '请在飞书私聊发送一条测试消息，按提示确认姓名，并确认 Harness 会话出现且机器人实际回复。自动检查不会替你发送消息。', SETTINGS);
  return { checkedAt: now().toISOString(), ready: false, checks, ...(callbackUrl ? { callbackUrl } : {}) };
}

/** Only request a saved, selected tunnel start. Never install, stop, or reconfigure anything. */
export async function repairSetup({ ctx, config, service, getConnectionStatus, now }) {
  const saved = await service.getConfig();
  const repaired = [];
  let result;
  const tunnelRequired = saved.connectionMode === 'webhook' || saved.serverTunnelRequired === true;
  if (!tunnelRequired || saved.tunnelProvider === 'custom') {
    result = check('repair', '安全修复', 'warning', '当前接入方式无需插件启动公网隧道；请根据检查结果完成配置。');
  } else if (saved.sharedTunnel) {
    result = check('repair', '安全修复', 'action', '隧道由所有机器人共享，请切换到默认机器人执行安全修复。');
  } else {
    try {
      const status = await service.getTunnelStatus();
      if (status.running || status.managed || status.state === 'external' || status.state === 'starting' || status.unknown || status.state === 'error') {
        result = check('repair', '安全修复', 'warning', '隧道正在运行、启动或状态尚不明确；保留现有进程，请按检查结果处理。');
      } else if (saved.tunnelProvider === 'cloudflare' && saved.cloudflareMode === 'named' && (!saved.cloudflareTunnelName || !saved.cloudflareConfigFile || !saved.publicBaseUrl)) {
        result = check('repair', '安全修复', 'action', '固定 Cloudflare 隧道尚未配置完整，请先保存隧道名称、配置文件和公网地址。');
      } else {
        const started = await service.startTunnel();
        if (started.success && started.status?.managed) {
          repaired.push('tunnel-start-requested');
          result = check('repair', '安全修复', 'ok', '已请求启动所选托管隧道；正在等待连接时请稍后重新检查。');
        } else result = check('repair', '安全修复', 'action', '未启动新的托管隧道；请检查工具安装、账户授权与已保存配置，现有外部隧道保持不变。');
      }
    } catch { result = check('repair', '安全修复', 'error', '无法安全启动隧道，请检查本机程序、网络和已保存配置后重试。'); }
  }
  const report = await checkSetup({ ctx, config, service, getConnectionStatus, now });
  return { ...report, checks: [result, ...report.checks], repaired };
}
