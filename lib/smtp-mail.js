import { connect, isIP } from 'node:net';
import nodemailer from 'nodemailer';

export const SMTP_LIMITS = Object.freeze({ recipients: 20, attachments: 10, textBytes: 1024 * 1024, messageBytes: 10 * 1024 * 1024 });
const CONTROL = /[\x00-\x1f\x7f]/;
const EMAIL = /^[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

export class SmtpMailError extends Error {
  constructor(code, message, { uncertain = false } = {}) {
    super(message);
    this.name = 'SmtpMailError';
    this.code = code;
    this.uncertain = uncertain;
  }
}

function invalid(message) { throw new SmtpMailError('INVALID_INPUT', message); }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function plain(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || CONTROL.test(value)) invalid(`Invalid ${label}`);
  return value.trim();
}
function address(value) {
  const email = plain(value, 254, 'email address');
  if (!EMAIL.test(email) || email.slice(0, email.indexOf('@')).length > 64) invalid('Use a single email address without a display name');
  return email;
}

/** Only administrator-owned connection settings. No URL, proxy or arbitrary Nodemailer options. */
export function validateSmtpConfig(config) {
  if (!object(config)) invalid('SMTP configuration is required');
  const host = plain(config.host, 253, 'SMTP host').toLowerCase();
  if (!isIP(host) && !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) invalid('SMTP host must be a hostname or IP address');
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) invalid('SMTP port must be between 1 and 65535');
  if (!['tls', 'starttls'].includes(config.mode)) invalid('SMTP requires TLS or STARTTLS');
  return { host, port: config.port, mode: config.mode, user: plain(config.user, 320, 'SMTP username'), from: address(config.from) };
}

/** Accept bytes only. The caller must read attachments through the current user's checked workspace. */
export function validateMailInput(input) {
  if (!object(input) || Object.keys(input).some(key => !['to', 'cc', 'bcc', 'subject', 'text', 'attachments'].includes(key))) invalid('Unsupported email fields');
  const result = {};
  const seen = new Set();
  let recipientCount = 0;
  for (const field of ['to', 'cc', 'bcc']) {
    const values = input[field] ?? [];
    if (!Array.isArray(values) || values.length > SMTP_LIMITS.recipients || (field === 'to' && !values.length)) invalid('Email to must contain recipients; use arrays of email addresses');
    recipientCount += values.length;
    result[field] = values.map(address).filter(value => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
  }
  if (recipientCount > SMTP_LIMITS.recipients) invalid(`At most ${SMTP_LIMITS.recipients} recipients are allowed`);
  result.subject = plain(input.subject, 200, 'email subject');
  if (typeof input.text !== 'string' || !input.text.trim() || input.text.includes('\0')) invalid('Email text is required');
  const textBytes = Buffer.byteLength(input.text);
  if (textBytes > SMTP_LIMITS.textBytes) throw new SmtpMailError('TOO_LARGE', 'Email text exceeds 1 MiB');
  result.text = input.text;
  const attachments = input.attachments ?? [];
  if (!Array.isArray(attachments) || attachments.length > SMTP_LIMITS.attachments) invalid('At most 10 attachments are allowed');
  // Base64 with line breaks is below 1.4x; reserve headers and multipart boundaries separately.
  let estimatedBytes = Math.ceil(textBytes * 1.4) + 64 * 1024;
  result.attachments = attachments.map(item => {
    if (!object(item) || Object.keys(item).some(key => !['filename', 'content', 'contentType'].includes(key))) invalid('Attachments require in-memory bytes only');
    const filename = plain(item.filename, 180, 'attachment filename');
    if (/[\\/]/.test(filename) || filename === '.' || filename === '..') invalid('Attachment filename must not contain a path');
    if (!Buffer.isBuffer(item.content)) invalid('Attachment content must be a Buffer');
    const attachment = { filename, content: item.content };
    if (item.contentType !== undefined) {
      if (typeof item.contentType !== 'string' || !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(item.contentType) || item.contentType.length > 128) invalid('Invalid attachment content type');
      attachment.contentType = item.contentType;
    }
    estimatedBytes += Math.ceil(item.content.byteLength * 1.4) + 4096;
    if (estimatedBytes > SMTP_LIMITS.messageBytes) throw new SmtpMailError('TOO_LARGE', 'Email with encoded attachments exceeds 10 MiB');
    return attachment;
  });
  return result;
}

function safeFailure(error, sending) {
  if (error instanceof SmtpMailError) return error;
  if (error?.code === 'EAUTH') return new SmtpMailError('AUTH_FAILED', 'SMTP authentication failed; check the account and authorization code');
  if (['ETLS', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN'].includes(error?.code)) return new SmtpMailError('TLS_FAILED', 'SMTP TLS or certificate verification failed');
  if (['EDNS', 'ECONNECTION', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(error?.code)) return new SmtpMailError('CONNECTION_FAILED', 'Cannot connect to the SMTP server');
  if (error?.code === 'EENVELOPE') return new SmtpMailError('RECIPIENT_REJECTED', 'SMTP rejected the sender or recipients');
  return new SmtpMailError('SMTP_FAILED', sending ? 'SMTP submission failed; acceptance may be uncertain. Do not automatically retry.' : 'SMTP connection or authentication check failed', { uncertain: sending });
}

async function operate(config, password, input, { transportFactory = options => nodemailer.createTransport(options), signal, timeoutMs = 60000 } = {}) {
  const checked = validateSmtpConfig(config);
  if (typeof password !== 'string' || !password || password.length > 4096 || CONTROL.test(password)) throw new SmtpMailError('NOT_CONFIGURED', 'SMTP authorization code is missing or invalid');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) invalid('Invalid SMTP timeout');
  const mail = input === undefined ? undefined : validateMailInput(input);
  if (signal?.aborted) throw new SmtpMailError('CANCELLED', 'SMTP operation cancelled before submission');
  let transport, timer, abort, started = false, stopped = false;
  const sockets = new Set();
  // Public Nodemailer getSocket hook: retain the raw socket so cancellation also stops
  // DNS/connect/TLS work. Nodemailer wraps it with TLS for both supported modes.
  const getSocket = (options, callback) => {
    if (stopped || signal?.aborted) return callback(new SmtpMailError('CANCELLED', 'SMTP operation cancelled'));
    let socket, connectionTimer;
    let returned = false;
    const finish = (error) => {
      if (returned) return;
      returned = true;
      clearTimeout(connectionTimer);
      if (error) { socket?.destroy(); callback(error); }
      else if (stopped || signal?.aborted) { socket.destroy(); callback(new SmtpMailError('CANCELLED', 'SMTP operation cancelled')); }
      else callback(null, { connection: socket, secured: false });
    };
    try {
      socket = connect({ host: checked.host, port: checked.port });
      sockets.add(socket);
      socket.once('connect', () => finish());
      socket.on('error', error => finish(error));
      socket.once('close', () => { sockets.delete(socket); clearTimeout(connectionTimer); });
      connectionTimer = setTimeout(() => finish(new SmtpMailError('CONNECTION_FAILED', 'SMTP connection timed out')), options.connectionTimeout);
    } catch (error) { finish(error); }
  };
  try {
    transport = transportFactory({
      host: checked.host, port: checked.port, secure: checked.mode === 'tls',
      requireTLS: checked.mode === 'starttls', ignoreTLS: false, opportunisticTLS: false,
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2', ...(isIP(checked.host) ? {} : { servername: checked.host }) },
      auth: { user: checked.user, pass: password },
      connectionTimeout: Math.min(timeoutMs, 15000), greetingTimeout: Math.min(timeoutMs, 15000),
      socketTimeout: Math.min(timeoutMs, 30000), dnsTimeout: Math.min(timeoutMs, 15000),
      pool: false, logger: false, debug: false, transactionLog: false,
      disableFileAccess: true, disableUrlAccess: true, maxRecipients: SMTP_LIMITS.recipients,
      getSocket,
    });
    const interrupted = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new SmtpMailError('TIMEOUT', mail ? 'SMTP timed out; acceptance may be uncertain. Do not automatically retry.' : 'SMTP verification timed out', { uncertain: Boolean(mail && started) })), timeoutMs);
      abort = () => reject(new SmtpMailError('CANCELLED', mail ? 'SMTP submission interrupted; acceptance may be uncertain. Do not automatically retry.' : 'SMTP verification cancelled', { uncertain: Boolean(mail && started) }));
      signal?.addEventListener('abort', abort, { once: true });
    });
    if (signal?.aborted) throw new SmtpMailError('CANCELLED', 'SMTP operation cancelled before submission');
    started = true;
    const operation = mail ? transport.sendMail({
      ...mail, from: checked.from, envelope: { from: checked.from, to: [...mail.to, ...mail.cc, ...mail.bcc] },
      // Bound encoded body size and avoid quoted-printable expansion of Unicode text.
      textEncoding: 'base64', disableFileAccess: true, disableUrlAccess: true,
    }) : transport.verify();
    const response = await Promise.race([operation, interrupted]);
    if (!mail) return { verified: true };
    // Return only addresses the caller supplied, never raw SMTP responses or server-provided text.
    const requested = new Map([...mail.to, ...mail.cc, ...mail.bcc].map(value => [value.toLowerCase(), value]));
    const knownAddresses = values => [...new Set((Array.isArray(values) ? values : []).map(value => typeof value === 'string' ? value : value?.address).filter(value => typeof value === 'string' && requested.has(value.toLowerCase())).map(value => requested.get(value.toLowerCase())))];
    const accepted = knownAddresses(response?.accepted);
    const rejected = knownAddresses(response?.rejected).filter(value => !accepted.includes(value));
    if (accepted.length + rejected.length !== requested.size) throw new SmtpMailError('UNKNOWN_ACCEPTANCE', 'SMTP did not report all recipients; do not automatically retry', { uncertain: true });
    return { status: accepted.length ? (rejected.length ? 'partially_accepted' : 'accepted') : 'rejected', accepted, rejected };
  } catch (error) {
    throw safeFailure(error, Boolean(mail && started));
  } finally {
    stopped = true;
    clearTimeout(timer);
    if (abort) signal?.removeEventListener('abort', abort);
    for (const socket of sockets) socket.destroy();
    try { transport?.close?.(); } catch { /* Cleanup must not expose provider errors or override submission outcome. */ }
  }
}

/** Authenticates only; never submits a message or verifies actual recipient delivery. */
export function verifySmtp(config, password, options) { return operate(config, password, undefined, options); }
/** One attempt only; SMTP acceptance is not proof of delivery to an inbox. */
export function sendSmtpMail(config, password, input, options) {
  if (input === undefined) return Promise.reject(new SmtpMailError('INVALID_INPUT', 'Email content is required'));
  return operate(config, password, input, options);
}
