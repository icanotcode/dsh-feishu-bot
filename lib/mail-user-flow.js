import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { userKey } from './history-store.js';
import { verifySmtp, probeSmtp, validateSmtpConfig } from './smtp-mail.js';
import { detectMailProvider } from './mail-provider.js';
import { discoverMailProvider } from './mail-discovery.js';
import { createMailWebSearch } from './mail-web-search.js';
import { createMailWebResearch } from './mail-web-research.js';

const EMAIL = /^[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const STAGES = new Set(['awaiting_email', 'awaiting_discovery', 'awaiting_server', 'awaiting_code', 'awaiting_recipient', 'ready']);
const PRIVATE_ONLY = '邮箱配置只支持与机器人的私聊，请在私聊中发送 /mail。不要在群聊中发送邮箱授权码。';
const EMAIL_PROMPT = '请提供你本人的发件邮箱地址（只发送一个邮箱地址），我会自动识别并查找邮箱提供商的配置，然后再询问授权码；你不需要填写服务器、端口或加密方式。';
const SERVER_PROMPT = '请按邮箱提供商的说明配置 SMTP 服务：/mail server 服务器地址 端口 tls|starttls。例如 /mail server smtp.example.com 465 tls。tls 表示直接使用 TLS，starttls 表示强制升级加密；不支持明文连接。';
const DISCOVERY_PROMPT = '我会自动查找这个邮箱的服务配置，并检查安全连接。找到后再请你提供授权码，无需填写服务器或端口。';
const RECIPIENT_PROMPT = '邮箱验证成功。请提供目标收件邮箱（只发送一个邮箱地址）。';
const UNAVAILABLE = '邮箱配置暂时不可用，请联系管理员检查凭据服务后重试。';

function email(value) {
  return typeof value === 'string' && value.length <= 254 && !/[\p{Cc}\u2028\u2029]/u.test(value) && EMAIL.test(value) && value.split('@')[0].length <= 64 ? value : null;
}
function validatedPendingRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['messageId', 'requestText', 'recipient'].includes(key)) ||
      typeof value.messageId !== 'string' || !value.messageId.trim() || value.messageId.length > 512 || /[\p{Cc}]/u.test(value.messageId) ||
      typeof value.requestText !== 'string' || !value.requestText.trim() || value.requestText.length > 64000 ||
      /[\p{Cc}&&[^\n\r\t]]/v.test(value.requestText) || /\/mail(?:\s|$)/i.test(value.requestText) ||
      (value.recipient !== undefined && !email(value.recipient))) throw new Error('Invalid pending email request');
  return { messageId: value.messageId, requestText: value.requestText, ...(value.recipient ? { recipient: value.recipient } : {}) };
}
function serverConfig(value, emailAddress) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['host', 'port', 'mode'].includes(key))) throw new Error('Invalid SMTP settings');
  const { host, port, mode } = validateSmtpConfig({ ...value, user: emailAddress, from: emailAddress });
  return { host, port, mode };
}
export function parseSmtpServerCommand(text) {
  if (typeof text !== 'string' || /[\p{Cc}\u2028\u2029]/u.test(text)) return undefined;
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 5 || parts[0].toLowerCase() !== '/mail' || parts[1].toLowerCase() !== 'server' || !/^\d+$/.test(parts[3])) return undefined;
  try { return serverConfig({ host: parts[2], port: Number(parts[3]), mode: parts[4].toLowerCase() }, 'smtp-check@example.com'); }
  catch { return undefined; }
}
function smtp(state) {
  // Preserve already verified accounts created before SMTP settings were explicit.
  const server = state.smtp ?? { host: 'smtp.feishu.cn', port: 465, mode: 'tls' };
  return { ...server, user: state.email, from: state.email };
}
function serverLabel(state) {
  const selected = smtp(state);
  return `${selected.host}:${selected.port}，${selected.mode.toUpperCase()}`;
}
function codePrompt(state) {
  if (!state.smtp) return SERVER_PROMPT;
  return `已选择 SMTP 服务（${serverLabel(state)}）。请在当前私聊直接发送邮箱授权码，也可以发送 /mail code 授权码。请使用当前邮箱提供商生成的 SMTP 授权码，不要发送邮箱登录密码或飞书应用 App Secret。`;
}
function verificationFailure(error) {
  switch (error?.code) {
    case 'AUTH_FAILED': return 'SMTP 身份验证失败。请确认邮箱地址正确、已启用 SMTP 服务，并使用当前邮箱生成的授权码。';
    case 'TLS_FAILED': return '无法通过 SMTP 服务器的 TLS 安全连接校验。请联系管理员检查服务器证书、系统时间和代理设置。';
    case 'CONNECTION_FAILED': return '无法连接 SMTP 服务器。请联系管理员检查服务器网络、DNS、代理及 SMTP 端口是否可访问。';
    case 'TIMEOUT': return '连接或验证 SMTP 服务器超时。请稍后重试，或联系管理员检查网络及代理设置。';
    case 'SMTP_FAILED': return 'SMTP 服务未能完成邮箱验证。请稍后重试，或联系管理员检查 SMTP 服务及网络。';
    default: return '邮箱验证失败。请检查邮箱地址、SMTP 服务和授权码后重试。';
  }
}
function refFor(identity) { return credentialRef(`FEISHU_USER_MAIL_${userKey(identity).toUpperCase()}`); }
function prompt(state) {
  return state.stage === 'awaiting_email' ? EMAIL_PROMPT : ['awaiting_server', 'awaiting_discovery'].includes(state.stage) ? DISCOVERY_PROMPT : state.stage === 'awaiting_code' ? codePrompt(state) : RECIPIENT_PROMPT;
}
function publicStatus(state) {
  return { stage: state?.stage ?? 'unbound', bound: Boolean(state?.password), ...(state?.email ? { email: state.email } : {}), ...(state?.recipient ? { recipient: state.recipient } : {}) };
}

/** Server-side gate. Secrets arrive through a one-use ingress channel, never normal message text. */
export function createMailUserFlow(ctx, { verify = verifySmtp, discover = discoverMailProvider, probe = probeSmtp, researchFactory = () => createMailWebResearch({ search: createMailWebSearch(ctx) }), now = () => new Date() } = {}) {
  const pending = new Map();
  const webResearch = new Map();
  function clearResearch(ref) {
    webResearch.get(ref)?.dispose?.();
    webResearch.delete(ref);
  }
  function researcher(ref) {
    if (!webResearch.has(ref)) {
      if (webResearch.size >= 100) clearResearch(webResearch.keys().next().value);
      webResearch.set(ref, researchFactory());
    }
    return webResearch.get(ref);
  }
  async function researchState(ref, chatId) {
    const state = await read(ref);
    if (!state || state.chatId !== chatId || state.stage !== 'awaiting_discovery') throw new Error('请在本人原私聊的邮箱查找步骤使用此工具。');
    return state;
  }
  function serial(identity, operation) {
    const ref = refFor(identity);
    const result = (pending.get(ref) ?? Promise.resolve()).then(() => operation(ref));
    const tail = result.catch(() => {});
    pending.set(ref, tail);
    void tail.then(() => { if (pending.get(ref) === tail) pending.delete(ref); });
    return result;
  }
  async function read(ref) {
    let resolved;
    try { resolved = await ctx.credentials.resolve(ref); } catch { throw new Error(UNAVAILABLE); }
    if (!resolved?.value) return null;
    try {
      const state = JSON.parse(resolved.value);
      if (!state || state.version !== 1 || !STAGES.has(state.stage) || typeof state.chatId !== 'string' || !state.chatId ||
          (state.stage !== 'awaiting_email' && !email(state.email)) ||
          (['awaiting_recipient', 'ready'].includes(state.stage) && (typeof state.password !== 'string' || !state.password || state.password.length > 8192 || /[\p{Cc}]/u.test(state.password))) ||
          (state.stage === 'ready' && !email(state.recipient))) throw new Error();
      if (state.smtp !== undefined) state.smtp = serverConfig(state.smtp, state.email);
      if (state.smtpDiscovered !== undefined && typeof state.smtpDiscovered !== 'boolean') throw new Error();
      if (state.pendingRequest !== undefined) {
        state.pendingRequest = validatedPendingRequest(state.pendingRequest);
        if (state.stage === 'ready') throw new Error();
      }
      // Normalize pending legacy bindings before ingress decides whether a
      // message must bypass normal history and enter the secret-only channel.
      if (!state.smtp && ['awaiting_server', 'awaiting_code'].includes(state.stage)) {
        const selected = detectMailProvider(state.email);
        if (selected) { state.smtp = selected; state.smtpDiscovered = true; state.stage = 'awaiting_code'; }
        else state.stage = 'awaiting_discovery';
      }
      return state;
    } catch { throw new Error(UNAVAILABLE); }
  }
  async function write(ref, state, signal) {
    // Environment-backed refs take priority over stored values and cannot be silently replaced.
    try {
      signal?.throwIfAborted();
      const previous = await ctx.credentials.resolve(ref);
      if (previous?.source === 'env') throw new Error();
      signal?.throwIfAborted();
      if (state) await ctx.credentials.set(ref, JSON.stringify({ ...state, version: 1, updatedAt: new Date(now()).toISOString() }));
      else await ctx.credentials.unset(ref);
      clearResearch(ref);
    } catch { throw new Error(UNAVAILABLE); }
  }
  return {
    getStatus(identity, { chatId } = {}) {
      return serial(identity, async ref => {
        const state = await read(ref);
        if (state && chatId !== undefined && state.chatId !== chatId) throw new Error('请回到绑定邮箱的私聊查询邮箱状态。');
        return publicStatus(state);
      });
    },
    // Ingress must never wait for an ongoing SMTP verification: Feishu expects a fast ACK.
    async getIngressState(identity) { const state = await read(refFor(identity)); return { stage: state?.stage ?? 'unbound', ...(state ? { chatId: state.chatId } : {}) }; },
    getAccount(identity) {
      return serial(identity, async ref => {
        const state = await read(ref);
        return state?.stage === 'ready' ? { config: smtp(state), password: state.password, recipient: state.recipient, chatId: state.chatId, ...(state.smtpDiscovered ? { publicOnly: true } : {}) } : null;
      });
    },
    discover(identity, { chatId, signal } = {}) {
      return serial(identity, async ref => {
        try {
          signal?.throwIfAborted();
          const state = await read(ref);
          if (!state || state.chatId !== chatId) throw new Error('Wrong private binding');
          if (state.stage !== 'awaiting_discovery') return { handled: true, reply: state.stage === 'ready' ? '邮箱配置已就绪。' : prompt(state) };
          const found = await discover(state.email, { signal });
          signal?.throwIfAborted();
          if (found.status !== 'found') return { handled: true, reply: '自动配置来源暂未找到可用服务。接下来我会搜索服务商的官方帮助网页。', webSearchRequired: true };
          let selected, source;
          const deadline = Date.now() + 10000;
          // Try only published candidates, without credentials. A dead primary
          // endpoint must not prevent a working official alternate from being used.
          for (const candidate of (found.candidates ?? [found]).slice(0, 5)) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) break;
            signal?.throwIfAborted();
            try {
              const config = serverConfig(candidate.smtp, state.email);
              await probe({ ...config, user: state.email, from: state.email }, { signal, timeoutMs: Math.min(remaining, 3500) });
              selected = config;
              source = candidate.source;
              break;
            } catch { signal?.throwIfAborted(); }
          }
          if (!selected) return { handled: true, reply: '自动配置来源暂未找到可用服务。接下来我会搜索服务商的官方帮助网页。', webSearchRequired: true };
          signal?.throwIfAborted();
          const next = { ...state, stage: 'awaiting_code', smtp: selected, smtpDiscovered: true };
          await write(ref, next, signal);
          return { handled: true, reply: `已自动找到邮箱服务并检查安全连接。${codePrompt(next)}`, ...(source ? { source } : {}) };
        } catch {
          signal?.throwIfAborted();
          return { handled: true, reply: '自动配置来源暂未找到可用服务。接下来我会搜索服务商的官方帮助网页。', webSearchRequired: true };
        }
      });
    },
    webSearch(identity, { chatId, signal } = {}) {
      return serial(identity, async ref => {
        signal?.throwIfAborted();
        const state = await researchState(ref, chatId);
        const result = await researcher(ref).search(state.email, { signal });
        signal?.throwIfAborted();
        return { ...result, ...(result.status === 'found' ? {} : { reply: result.status === 'unavailable'
          ? '网页搜索暂不可用，请管理员检查 Harness 的 Web search 配置或网络。本次发送任务已保留，无需填写 SMTP 参数。'
          : '暂未找到能确认属于邮箱服务商的官方配置资料。本次发送任务已保留，可稍后 /mail retry。无需填写 SMTP 参数。' }) };
      });
    },
    webRead(identity, resultId, { chatId, signal } = {}) {
      return serial(identity, async ref => {
        signal?.throwIfAborted();
        const state = await researchState(ref, chatId);
        const result = await researcher(ref).read(state.email, resultId, { signal });
        signal?.throwIfAborted();
        return result;
      });
    },
    webApply(identity, proposal, { chatId, signal, checkActive = () => {} } = {}) {
      return serial(identity, async ref => {
        signal?.throwIfAborted();
        checkActive();
        const state = await researchState(ref, chatId);
        const checked = await researcher(ref).verify(state.email, proposal);
        const selected = serverConfig(checked.smtp, state.email);
        await probe({ ...selected, user: state.email, from: state.email }, { signal, timeoutMs: 10000 });
        signal?.throwIfAborted();
        checkActive();
        await write(ref, { ...state, stage: 'awaiting_code', smtp: selected, smtpDiscovered: true }, signal);
        return { handled: true, reply: `已核实官方网页配置并检查安全连接。${codePrompt({ ...state, smtp: selected })}`, source: checked.source };
      });
    },
    forget(identity) { return serial(identity, async ref => { await write(ref, null); return { stage: 'unbound', bound: false }; }); },
    handle(identity, { text = '', chatId, chatType, secret, requireSetup = false, pendingRequest, signal } = {}) {
      return serial(identity, async ref => {
        const done = reply => ({ handled: true, reply });
        async function complete(state, recipient, prefix) {
          const { pendingRequest: request, ...account } = state;
          await write(ref, { ...account, stage: 'ready', recipient }, signal);
          return request ? { handled: true, reply: `${prefix}我会继续处理刚才的发邮件请求。`, resume: { messageId: request.messageId, requestText: request.requestText } }
            : done(`${prefix}请明确告诉我需要发送的主题和正文；配置本身不会发送邮件。`);
        }
        try {
          signal?.throwIfAborted();
          const command = typeof text === 'string' ? text.trim() : '';
          const isCommand = /^\/mail(?:\s|$)/i.test(command);
          const isPrivate = ['p2p', 'private'].includes(chatType) && typeof chatId === 'string' && Boolean(chatId);
          if (!isPrivate) return isCommand || secret !== undefined || requireSetup ? done(PRIVATE_ONLY) : { handled: false };
          // Reset is identity-scoped recovery, including when the stored JSON is damaged.
          if (/^\/mail\s+reset$/i.test(command)) {
            await write(ref, null, signal);
            return done('已清除你的发件邮箱、授权码和收件邮箱。发送 /mail 可重新配置。');
          }
          const state = await read(ref);
          // Commands and pending prompts are tied to the original private conversation.
          if (state && state.chatId !== chatId) return isCommand || secret !== undefined || requireSetup || state.stage !== 'ready'
            ? done('请回到最初配置邮箱的机器人私聊继续操作。') : { handled: false };
          if (/^\/mail\s+status$/i.test(command)) {
            if (!state) return done('尚未绑定邮箱。发送 /mail 开始配置。');
            if (state.stage !== 'ready') return done(`邮箱配置尚未完成。${prompt(state)}`);
            return done(`当前发件邮箱：${state.email}\nSMTP 服务：${serverLabel(state)}${state.smtp ? '' : '（兼容旧版已验证配置）'}\n当前收件邮箱：${state.recipient}\n发送 /mail to 新邮箱 可更换收件人。发送 /mail server 服务器地址 端口 tls|starttls 可重新配置并验证 SMTP 服务。`);
          }
          if (/^\/mail\s+retry$/i.test(command)) {
            if (!state) return done('请先发送 /mail 并提供本人邮箱。');
            return state.stage === 'awaiting_discovery' ? { ...done(DISCOVERY_PROMPT), discover: true } : done(state.stage === 'ready' ? '邮箱配置已就绪。' : prompt(state));
          }
          if (/^\/mail\s+cancel$/i.test(command)) {
            if (state && state.stage !== 'ready') await write(ref, null, signal);
            return done(state?.stage === 'ready' ? '当前没有待完成的邮箱配置，已绑定邮箱保持不变。' : '已取消本次邮箱配置并清除未完成的绑定。发送 /mail 可重新开始。');
          }
          if (/^\/mail(?:\s+setup)?$/i.test(command)) {
            const request = pendingRequest === undefined ? undefined : validatedPendingRequest(pendingRequest);
            await write(ref, { stage: 'awaiting_email', chatId, ...(request ? { pendingRequest: request } : {}) }, signal);
            return done(EMAIL_PROMPT);
          }
          if (/^\/mail\s+server(?:\s|$)/i.test(command)) {
            if (!state?.email) return done(`请先发送 /mail，提供发件邮箱。${SERVER_PROMPT}`);
            const server = parseSmtpServerCommand(text);
            if (!server) return done(`SMTP 配置格式无效，原配置保持不变。${SERVER_PROMPT}`);
            const next = { stage: 'awaiting_code', chatId, email: state.email, smtp: server, ...(state.pendingRequest ? { pendingRequest: state.pendingRequest } : {}) };
            await write(ref, next, signal);
            return done(`SMTP 配置已更新，请重新验证授权码并设置收件人。${codePrompt(next)}`);
          }
          const to = command.match(/^\/mail\s+to(?:\s+([\s\S]*))?$/i);
          if (to) {
            if (!state || !['ready', 'awaiting_recipient'].includes(state.stage)) return done('请先发送 /mail，完成发件邮箱验证。');
            const recipient = /[\p{Cc}\u2028\u2029]/u.test(text) ? null : email(to[1]);
            if (!recipient) return done('请使用 /mail to 单个收件邮箱地址，不要添加名称、逗号或换行。');
            return await complete(state, recipient, `收件邮箱已设为 ${recipient}。`);
          }
          if (/^\/mail\s+code(?:\s|$)/i.test(command) || secret !== undefined) {
            if (state?.stage === 'awaiting_discovery') return done('正在等待自动查找邮箱服务配置，暂不使用本次授权码。找到后再请你提供授权码；可以发送 /mail retry 重试查找。');
            if (state?.stage !== 'awaiting_code') return done('当前不在授权码配置步骤。请先发送 /mail，提供发件邮箱。');
            if (typeof secret !== 'string' || !secret || secret.length > 8192 || /[\p{Cc}]/u.test(secret)) return done(codePrompt(state));
            try { signal?.throwIfAborted(); await verify(smtp(state), secret, { signal, ...(state.smtpDiscovered ? { publicOnly: true } : {}) }); }
            catch (error) {
              signal?.throwIfAborted();
              return done(`${verificationFailure(error)}未保存本次授权码。${codePrompt(state)}`);
            }
            signal?.throwIfAborted();
            const verified = { ...state, stage: 'awaiting_recipient', password: secret };
            if (state.pendingRequest?.recipient) return await complete(verified, state.pendingRequest.recipient, '邮箱验证成功。');
            await write(ref, verified, signal);
            return done(RECIPIENT_PROMPT);
          }
          if (isCommand) return done('邮箱命令：/mail、/mail retry、/mail server 服务器地址 端口 tls|starttls、/mail code 授权码、/mail status、/mail to 收件邮箱、/mail reset、/mail cancel。');
          if (!state) {
            if (!requireSetup) return { handled: false };
            const request = pendingRequest === undefined ? undefined : validatedPendingRequest(pendingRequest);
            await write(ref, { stage: 'awaiting_email', chatId, ...(request ? { pendingRequest: request } : {}) }, signal);
            return done(EMAIL_PROMPT);
          }
          if (state.stage === 'ready') return { handled: false };
          if (state.stage === 'awaiting_discovery') return { ...done(DISCOVERY_PROMPT), discover: true };
          if (state.stage === 'awaiting_code') return done(codePrompt(state));
          const address = /[\p{Cc}\u2028\u2029]/u.test(text) ? null : email(command);
          if (!address) return done(prompt(state));
          if (state.stage === 'awaiting_email') {
            const selected = detectMailProvider(address);
            const next = { ...state, stage: selected ? 'awaiting_code' : 'awaiting_discovery', email: address, ...(selected ? { smtp: selected, smtpDiscovered: true } : {}) };
            await write(ref, next, signal);
            return selected ? done(`已自动选择邮箱服务。${codePrompt(next)}`) : { ...done(DISCOVERY_PROMPT), discover: true };
          }
          return await complete(state, address, `邮箱配置完成。当前收件邮箱：${address}。`);
        } catch { signal?.throwIfAborted(); return done(UNAVAILABLE); }
      });
    },
  };
}
