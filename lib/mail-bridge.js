import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { userKey } from './history-store.js';
import { readOutgoingFile } from './media-files.js';
import { createMailUserFlow } from './mail-user-flow.js';
import { SMTP_LIMITS, sendSmtpMail, validateMailInput, SmtpMailError } from './smtp-mail.js';

export const feishuSkillInstructions = await readFile(new URL('../skills/feishu-assistant/SKILL.md', import.meta.url), 'utf8');
const object = properties => ({ type: 'object', properties, additionalProperties: false });
export const mailTools = [
  { name: 'feishu_mail_status', description: 'Check only the current Feishu user’s private email setup status. Never returns credentials. Use when the user asks to send email, not for unrelated chat.', parameters: object({}) },
  { name: 'feishu_mail_setup', description: 'Start the current user’s private email setup flow only when they request email capability. Return its next-step prompt and wait. Never accept or ask the model to handle an SMTP authorization code.', parameters: object({}) },
  { name: 'feishu_send_email', description: 'Send an email only at the current user’s explicit request, using that user’s verified personal mailbox and recipient. No arbitrary sender or recipient arguments. The account and recipient must have been configured in the current private Feishu chat. Attachments are relative paths in this user’s own workspace. SMTP acceptance does not prove delivery. Never retry an uncertain outcome automatically.',
    parameters: { ...object({ subject: { type: 'string' }, text: { type: 'string' }, attachmentPaths: { type: 'array', items: { type: 'string' } } }), required: ['subject', 'text'] } },
];
const privateChat = value => ['p2p', 'private'].includes(value);
const uncertainResult = () => ({ status: 'unknown', uncertain: true, message: '先前发送可能已被 SMTP 接受，不能自动重发。请先核对邮箱发件记录。' });

/** Adapter for the skill: identities come only from validated ingress and session bindings. */
export function createMailBridge(ctx, config, { flow = createMailUserFlow(ctx), send = sendSmtpMail, now = Date.now } = {}) {
  const secrets = new Map();
  const identityFor = parsed => ({ source: config.source, tenantId: parsed.tenantId || '', openId: parsed.senderId });
  const tokenOwner = parsed => `${userKey(identityFor(parsed))}:${parsed.chatId}:${parsed.messageId}`;
  function prune() {
    for (const [token, item] of secrets) if (item.expires <= now()) secrets.delete(token);
  }
  return {
    async prepareIngress(parsed) {
      prune();
      const text = parsed.userText.trim();
      const explicit = /^\/mail\s+code(?:\s+([\s\S]*))?$/i.exec(text);
      let secret = explicit?.[1] ?? (explicit ? '' : undefined);
      if (!explicit && privateChat(parsed.chatType) && !/^(?:\/mail(?:\s+(?:setup|status|reset|cancel))?|\/(?:new|whoami|help|status))$/i.test(text)) {
        const state = await flow.getIngressState(identityFor(parsed));
        if (state.stage === 'awaiting_code' && state.chatId === parsed.chatId) secret = text;
      }
      if (secret === undefined) return { parsed, sensitive: false };
      if (secrets.size >= 1000) throw new Error('Sensitive message queue is full');
      const token = randomUUID();
      // No group secret is retained, even transiently beyond this invocation.
      if (privateChat(parsed.chatType)) secrets.set(token, { value: secret, owner: tokenOwner(parsed), expires: now() + 10 * 60 * 1000 });
      // Drop content, attachment names and other untrusted fields that can carry a second copy.
      return { sensitive: true, parsed: {
        chatType: parsed.chatType, messageId: parsed.messageId, chatId: parsed.chatId, senderId: parsed.senderId,
        tenantId: parsed.tenantId, timestamp: parsed.timestamp, msgType: 'text',
        userText: '/mail code', content: { text: '[邮箱授权码已脱敏]' }, mailSecretToken: token,
      } };
    },
    discardIngress(parsed) { if (parsed?.mailSecretToken) secrets.delete(parsed.mailSecretToken); },
    takeSecret(parsed) {
      const item = secrets.get(parsed.mailSecretToken);
      if (!item || item.expires <= now() || item.owner !== tokenOwner(parsed)) return undefined;
      secrets.delete(parsed.mailSecretToken);
      return item.value;
    },
    handle: (identity, input) => flow.handle(identity, input),
    async execute(name, args, binding, target, { signal, checkActive }) {
      checkActive();
      if (!privateChat(target.chatType)) throw new Error('个人邮箱功能仅限机器人私聊，请从私聊提出请求。');
      if (name === 'feishu_mail_status') return flow.getStatus(binding.identity, { chatId: binding.chatId });
      if (name === 'feishu_mail_setup') return flow.handle(binding.identity, { text: '/mail setup', chatId: binding.chatId, chatType: target.chatType, signal });
      if (name !== 'feishu_send_email') throw new Error('Email tool unavailable');
      const account = await flow.getAccount(binding.identity);
      if (!account) throw new Error('请先调用 feishu_mail_setup，完成个人邮箱、授权码和收件邮箱配置。');
      if (account.chatId && account.chatId !== binding.chatId) throw new Error('请回到绑定邮箱的私聊发送邮件。');
      const paths = args.attachmentPaths ?? [];
      if (!Array.isArray(paths) || paths.length > SMTP_LIMITS.attachments) throw new Error('邮件最多添加 10 个附件。');
      const attachments = [];
      let bytes = 0;
      for (const path of paths) {
        checkActive();
        const file = await readOutgoingFile(binding.workspacePath, path, { signal, maxBytes: Math.max(0, SMTP_LIMITS.messageBytes - bytes) });
        bytes += file.size;
        attachments.push({ filename: file.filename, content: file.data });
      }
      const input = validateMailInput({ to: [account.recipient], subject: args.subject, text: args.text, attachments });
      const fingerprint = createHash('sha256').update(JSON.stringify({ messageId: target.messageId, from: account.config.from,
        to: input.to, subject: input.subject, text: input.text, attachments: input.attachments.map(item => [item.filename, createHash('sha256').update(item.content).digest('hex')]) })).digest('hex');
      target.mailCalls ??= new Map();
      if (target.mailCalls.has(fingerprint)) return target.mailCalls.get(fingerprint);
      const operation = (async () => {
        checkActive();
        const existing = binding.store.getEmailSend(fingerprint);
        if (existing) return existing.result ?? uncertainResult();
        if (!binding.store.claimEmailSend(fingerprint)) return binding.store.getEmailSend(fingerprint)?.result ?? uncertainResult();
        let result;
        try {
          checkActive();
          const current = await flow.getAccount(binding.identity);
          checkActive();
          if (!current || JSON.stringify(current) !== JSON.stringify(account)) throw new SmtpMailError('CONFIG_CHANGED', '邮箱绑定已变更或被清除，本次邮件未提交。');
          result = await send(account.config, account.password, input, { signal });
        } catch (error) {
          result = error instanceof SmtpMailError ? { status: error.uncertain ? 'unknown' : 'failed', uncertain: error.uncertain, message: error.message }
            : { status: 'unknown', uncertain: true, message: '邮件发送结果无法确认，请先核对发件记录；不会自动重发。' };
        }
        // Never replace a known SMTP receipt with an error that encourages a duplicate send.
        try { binding.store.completeEmailSend(fingerprint, result); }
        catch { ctx.logger.warn('feishu-bot: could not persist email receipt; automatic retry remains disabled'); }
        try { binding.store.appendMessage({ sessionId: binding.sessionId, role: 'assistant', text: `邮件提交记录：${JSON.stringify({ from: account.config.from, to: account.recipient, subject: input.subject, ...result })}`, timestamp: new Date(now()).toISOString(), turn: target.turn }); }
        catch { ctx.logger.warn('feishu-bot: could not append email receipt to history'); }
        return result;
      })();
      target.mailCalls.set(fingerprint, operation);
      return operation;
    },
    dispose() { secrets.clear(); },
  };
}
