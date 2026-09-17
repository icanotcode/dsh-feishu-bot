import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { userKey } from './history-store.js';
import { verifySmtp } from './smtp-mail.js';

const EMAIL = /^[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const STAGES = new Set(['awaiting_email', 'awaiting_code', 'awaiting_recipient', 'ready']);
const PRIVATE_ONLY = '邮箱配置只支持与机器人的私聊，请在私聊中发送 /mail。不要在群聊中发送邮箱授权码。';
const CODE_PROMPT = '请在当前私聊中发送 /mail code 授权码。请使用飞书邮箱的 SMTP 授权码，不要发送邮箱登录密码。';
const EMAIL_PROMPT = '请提供你本人的飞书邮箱地址（只发送一个邮箱地址）。';
const RECIPIENT_PROMPT = '邮箱验证成功。请提供目标收件邮箱（只发送一个邮箱地址）。';
const UNAVAILABLE = '邮箱配置暂时不可用，请联系管理员检查凭据服务后重试。';

function email(value) {
  return typeof value === 'string' && value.length <= 254 && !/[\p{Cc}\u2028\u2029]/u.test(value) && EMAIL.test(value) && value.split('@')[0].length <= 64 ? value : null;
}
function smtp(emailAddress) { return { host: 'smtp.feishu.cn', port: 465, mode: 'tls', user: emailAddress, from: emailAddress }; }
function refFor(identity) { return credentialRef(`FEISHU_USER_MAIL_${userKey(identity).toUpperCase()}`); }
function prompt(state) {
  return state.stage === 'awaiting_email' ? EMAIL_PROMPT : state.stage === 'awaiting_code' ? CODE_PROMPT : RECIPIENT_PROMPT;
}
function publicStatus(state) {
  return { stage: state?.stage ?? 'unbound', bound: Boolean(state?.password), ...(state?.email ? { email: state.email } : {}), ...(state?.recipient ? { recipient: state.recipient } : {}) };
}

/** Server-side gate. Secrets arrive through a one-use ingress channel, never normal message text. */
export function createMailUserFlow(ctx, { verify = verifySmtp, now = () => new Date() } = {}) {
  const pending = new Map();
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
        return state?.stage === 'ready' ? { config: smtp(state.email), password: state.password, recipient: state.recipient, chatId: state.chatId } : null;
      });
    },
    forget(identity) { return serial(identity, async ref => { await write(ref, null); return { stage: 'unbound', bound: false }; }); },
    handle(identity, { text = '', chatId, chatType, secret, requireSetup = false, signal } = {}) {
      return serial(identity, async ref => {
        const done = reply => ({ handled: true, reply });
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
            return done(`当前发件邮箱：${state.email}\n当前收件邮箱：${state.recipient}\n发送 /mail to 新邮箱 可更换收件人。`);
          }
          if (/^\/mail\s+cancel$/i.test(command)) {
            if (state && state.stage !== 'ready') await write(ref, null, signal);
            return done(state?.stage === 'ready' ? '当前没有待完成的邮箱配置，已绑定邮箱保持不变。' : '已取消本次邮箱配置并清除未完成的绑定。发送 /mail 可重新开始。');
          }
          if (/^\/mail(?:\s+setup)?$/i.test(command)) {
            await write(ref, { stage: 'awaiting_email', chatId }, signal);
            return done(EMAIL_PROMPT);
          }
          const to = command.match(/^\/mail\s+to(?:\s+([\s\S]*))?$/i);
          if (to) {
            if (!state || !['ready', 'awaiting_recipient'].includes(state.stage)) return done('请先发送 /mail，完成发件邮箱验证。');
            const recipient = /[\p{Cc}\u2028\u2029]/u.test(text) ? null : email(to[1]);
            if (!recipient) return done('请使用 /mail to 单个收件邮箱地址，不要添加名称、逗号或换行。');
            await write(ref, { ...state, stage: 'ready', recipient }, signal);
            return done(`收件邮箱已设为 ${recipient}。请明确告诉我需要发送的主题和正文；配置本身不会发送邮件。`);
          }
          if (/^\/mail\s+code(?:\s|$)/i.test(command) || secret !== undefined) {
            if (state?.stage !== 'awaiting_code') return done('当前不在授权码配置步骤。请先发送 /mail，提供发件邮箱。');
            if (typeof secret !== 'string' || !secret || secret.length > 8192 || /[\p{Cc}]/u.test(secret)) return done(CODE_PROMPT);
            try { signal?.throwIfAborted(); await verify(smtp(state.email), secret, { signal }); }
            catch {
              signal?.throwIfAborted();
              return done(`邮箱验证失败，未保存本次授权码。请检查邮箱地址、SMTP 服务和授权码后重试。${CODE_PROMPT}`);
            }
            signal?.throwIfAborted();
            await write(ref, { ...state, stage: 'awaiting_recipient', password: secret }, signal);
            return done(RECIPIENT_PROMPT);
          }
          if (isCommand) return done('邮箱命令：/mail、/mail status、/mail to 收件邮箱、/mail reset、/mail cancel。');
          if (!state) {
            if (!requireSetup) return { handled: false };
            await write(ref, { stage: 'awaiting_email', chatId }, signal);
            return done(EMAIL_PROMPT);
          }
          if (state.stage === 'ready') return { handled: false };
          if (state.stage === 'awaiting_code') return done(CODE_PROMPT);
          const address = /[\p{Cc}\u2028\u2029]/u.test(text) ? null : email(command);
          if (!address) return done(prompt(state));
          if (state.stage === 'awaiting_email') {
            await write(ref, { stage: 'awaiting_code', chatId, email: address }, signal);
            return done(CODE_PROMPT);
          }
          await write(ref, { ...state, stage: 'ready', recipient: address }, signal);
          return done(`邮箱配置完成。当前收件邮箱：${address}。请明确告诉我需要发送的主题和正文；配置本身不会发送邮件。`);
        } catch { signal?.throwIfAborted(); return done(UNAVAILABLE); }
      });
    },
  };
}
