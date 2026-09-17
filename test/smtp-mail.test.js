import test from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { createServer } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import { once } from 'node:events';
import { sendSmtpMail, verifySmtp, probeSmtp, validateSmtpConfig, validateMailInput, SmtpMailError, SMTP_LIMITS } from '../lib/smtp-mail.js';
import { smtpTestKey, smtpTestCertificate } from '../test-support/smtp-tls-fixture.mjs';

const config = { host: 'smtp.example.com', port: 465, mode: 'tls', user: 'sender@example.com', from: 'sender@example.com' };
const input = { to: ['recipient@example.com'], subject: '会议记录', text: '你好\n这是会议记录。' };
const password = 'test-only-authorization-code';
const code = expected => error => error instanceof SmtpMailError && error.code === expected;

function mockTransport(result = { accepted: input.to, rejected: [] }) {
  const state = { sends: [], verifies: 0, closes: 0 };
  state.transportFactory = options => {
    state.options = options;
    return {
      async sendMail(mail) { state.sends.push(mail); if (result instanceof Error) throw result; return result; },
      async verify() { state.verifies++; if (result instanceof Error) throw result; return true; },
      close() { state.closes++; },
    };
  };
  return state;
}

test('SMTP sends one TLS-authenticated message with a fixed envelope and memory attachments only', async () => {
  const state = mockTransport();
  const content = Buffer.from('测试附件');
  assert.deepEqual(await sendSmtpMail(config, password, { ...input, attachments: [{ filename: '报告.txt', content, contentType: 'text/plain' }] }, state), { status: 'accepted', accepted: input.to, rejected: [] });
  assert.equal(state.sends.length, 1); assert.equal(state.closes, 1);
  assert.deepEqual(state.options.auth, { user: config.user, pass: password });
  assert.equal(state.options.forceAuth, true);
  assert.equal(state.options.secure, true); assert.equal(state.options.tls.rejectUnauthorized, true);
  assert.equal(state.options.tls.minVersion, 'TLSv1.2'); assert.equal(state.options.ignoreTLS, false);
  assert.equal(state.options.opportunisticTLS, false); assert.equal(state.options.pool, false);
  assert.equal(state.options.disableFileAccess, true); assert.equal(state.options.disableUrlAccess, true);
  assert.equal(state.options.logger, false); assert.equal(state.options.debug, false);
  for (const timeout of ['connectionTimeout', 'greetingTimeout', 'socketTimeout', 'dnsTimeout']) assert.ok(state.options[timeout] > 0);
  assert.equal(state.sends[0].from, config.from); assert.deepEqual(state.sends[0].envelope, { from: config.from, to: input.to });
  assert.equal(state.sends[0].attachments[0].content, content); assert.equal(state.sends[0].textEncoding, 'base64');
});

test('STARTTLS is mandatory and verify authenticates without sending any email', async () => {
  const state = mockTransport();
  assert.deepEqual(await verifySmtp({ ...config, port: 587, mode: 'starttls' }, password, state), { verified: true });
  assert.equal(state.options.secure, false); assert.equal(state.options.requireTLS, true);
  assert.equal(state.options.ignoreTLS, false); assert.equal(state.options.opportunisticTLS, false);
  assert.equal(state.verifies, 1); assert.equal(state.sends.length, 0); assert.equal(state.closes, 1);
});

test('partial SMTP acceptance is returned separately without claiming inbox delivery or leaking response text', async () => {
  const state = mockTransport({ accepted: ['recipient@example.com'], rejected: [{ address: 'other@example.com' }], response: `250 ${password}`, messageId: password });
  const result = await sendSmtpMail(config, password, { ...input, cc: ['other@example.com'] }, state);
  assert.deepEqual(result, { status: 'partially_accepted', accepted: input.to, rejected: ['other@example.com'] });
  assert.ok(!JSON.stringify(result).includes(password)); assert.equal(result.delivered, undefined);
});

test('recipient normalization deduplicates to/cc/bcc and keeps Bcc out of visible recipients', async () => {
  const state = mockTransport({ accepted: [...input.to, 'hidden@example.com'], rejected: [] });
  await sendSmtpMail(config, password, { ...input, cc: ['RECIPIENT@example.com'], bcc: ['hidden@example.com'] }, state);
  assert.deepEqual(state.sends[0].to, input.to); assert.deepEqual(state.sends[0].cc, []);
  assert.deepEqual(state.sends[0].bcc, ['hidden@example.com']);
  assert.deepEqual(state.sends[0].envelope.to, [...input.to, 'hidden@example.com']);
});

test('malformed config and plaintext modes reject before transport creation', async () => {
  const transportFactory = () => assert.fail('No network for invalid configuration');
  for (const update of [{ host: 'smtp://example.com' }, { host: 'smtp.example.com\r\nsecret' }, { host: 'user:pass@example.com' }, { host: '-invalid.example.com' }, { port: '465' }, { port: 0 }, { port: 65536 }, { mode: 'plain' }, { user: 'sender\0secret' }, { from: 'sender@example.com\r\nBcc:steal@example.com' }, { from: 'Name <sender@example.com>' }]) {
    await assert.rejects(sendSmtpMail({ ...config, ...update }, password, input, { transportFactory }), code('INVALID_INPUT'));
  }
  assert.deepEqual(validateSmtpConfig({ ...config, host: 'SMTP.EXAMPLE.COM', arbitraryOption: true }), config);
});

test('forbidden transport/message injection and malformed recipients never reach transport', async () => {
  const transportFactory = () => assert.fail('No network for invalid email');
  for (const update of [
    { from: 'spoof@example.com' }, { headers: { bcc: 'steal@example.com' } }, { html: '<b>x</b>' }, { envelope: {} },
    { to: 'recipient@example.com' }, { to: [] }, { to: ['a@example.com,b@example.com'] }, { to: ['a@example.com\nBcc:b@example.com'] },
    { subject: 'hello\r\nBcc:steal@example.com' }, { text: 'bad\0text' },
    { attachments: [{ filename: 'x', path: '/etc/passwd' }] }, { attachments: [{ filename: 'x', href: 'https://example.com' }] },
    { attachments: [{ filename: 'x', content: 'https://example.com' }] }, { attachments: [{ filename: '../private.txt', content: Buffer.from('x') }] },
    { attachments: [{ filename: 'x\nInjected', content: Buffer.from('x') }] }, { attachments: [{ filename: 'x', content: Buffer.from('x'), contentType: 'text/plain\r\nX: hi' }] },
  ]) await assert.rejects(sendSmtpMail(config, password, { ...input, ...update }, { transportFactory }), code('INVALID_INPUT'));
  await assert.rejects(sendSmtpMail(config, password, undefined, { transportFactory }), code('INVALID_INPUT'));
});

test('recipient, text, attachment count and estimated MIME bytes are bounded before network', async () => {
  const transportFactory = () => assert.fail('No network for excessive email');
  await assert.rejects(sendSmtpMail(config, password, { ...input, cc: Array.from({ length: SMTP_LIMITS.recipients }, (_, i) => `user${i}@example.com`) }, { transportFactory }), code('INVALID_INPUT'));
  await assert.rejects(sendSmtpMail(config, password, { ...input, text: '字'.repeat(400000) }, { transportFactory }), code('TOO_LARGE'));
  await assert.rejects(sendSmtpMail(config, password, { ...input, attachments: Array(11).fill({ filename: 'x', content: Buffer.alloc(1) }) }, { transportFactory }), code('INVALID_INPUT'));
  await assert.rejects(sendSmtpMail(config, password, { ...input, attachments: [{ filename: 'large', content: Buffer.alloc(8 * 1024 * 1024) }] }, { transportFactory }), code('TOO_LARGE'));
});

test('authentication, TLS and provider failures contain no raw server text, credentials or causes', async () => {
  for (const [providerCode, expected, uncertain] of [['EAUTH', 'AUTH_FAILED', false], ['ETLS', 'TLS_FAILED', false], ['ECONNECTION', 'CONNECTION_FAILED', true], ['EENVELOPE', 'RECIPIENT_REJECTED', false], ['ESOCKET', 'CONNECTION_FAILED', true], ['ECONNRESET', 'CONNECTION_FAILED', true], ['EPIPE', 'CONNECTION_FAILED', true], ['ETIMEDOUT', 'TIMEOUT', true]]) {
    const state = mockTransport(Object.assign(new Error(`private response ${password}`), { code: providerCode, response: password, cause: new Error(password) }));
    await assert.rejects(sendSmtpMail(config, password, input, state), error => {
      assert.equal(error.code, expected); assert.equal(error.uncertain, uncertain);
      assert.equal(error.cause, undefined); assert.equal(error.response, undefined);
      assert.ok(!JSON.stringify(error).includes(password)); assert.ok(!String(error).includes(password)); return true;
    });
    assert.equal(state.sends.length, 1); assert.equal(state.closes, 1);
  }
});

test('verification network errors are sanitized and never claim an uncertain email submission', async () => {
  for (const [providerCode, expected] of [['ESOCKET', 'CONNECTION_FAILED'], ['ECONNRESET', 'CONNECTION_FAILED'], ['EPIPE', 'CONNECTION_FAILED'], ['ETIMEDOUT', 'TIMEOUT']]) {
    const state = mockTransport(Object.assign(new Error(password), { code: providerCode }));
    await assert.rejects(verifySmtp(config, password, state), error => error.code === expected && error.uncertain === false && !String(error).includes(password));
  }
});

test('unknown or missing acceptance never invents success and no automatic retry occurs', async () => {
  for (const result of [{}, { accepted: ['attacker@example.com'], rejected: [] }, { accepted: [], rejected: [] }]) {
    const state = mockTransport(result);
    await assert.rejects(sendSmtpMail(config, password, input, state), error => error.code === 'UNKNOWN_ACCEPTANCE' && error.uncertain === true);
    assert.equal(state.sends.length, 1);
  }
  const state = mockTransport({ accepted: [], rejected: input.to });
  assert.deepEqual(await sendSmtpMail(config, password, input, state), { status: 'rejected', accepted: [], rejected: input.to });
});

test('pre-cancelled requests do not create transport or expose the abort reason', async () => {
  const controller = new AbortController(); controller.abort(new Error(password));
  await assert.rejects(sendSmtpMail(config, password, input, { signal: controller.signal, transportFactory: () => assert.fail('cancelled') }), error => error.code === 'CANCELLED' && !error.uncertain && !String(error).includes(password));
});

test('timeout or cancellation during submission is uncertain, closes transport and never retries', async () => {
  for (const shouldAbort of [false, true]) {
    let sends = 0, closes = 0;
    const controller = new AbortController();
    const transportFactory = () => ({ sendMail() { sends++; if (shouldAbort) controller.abort(new Error(password)); return new Promise(() => {}); }, close() { closes++; } });
    await assert.rejects(sendSmtpMail(config, password, input, { transportFactory, signal: controller.signal, timeoutMs: 10 }), error => error.code === (shouldAbort ? 'CANCELLED' : 'TIMEOUT') && error.uncertain && !String(error).includes(password));
    assert.equal(sends, 1); assert.equal(closes, 1);
  }
});

test('missing credentials fail closed; verification timeouts do not claim submitted email', async () => {
  await assert.rejects(verifySmtp(config, '', { transportFactory: () => assert.fail('missing credential') }), code('NOT_CONFIGURED'));
  await assert.rejects(verifySmtp(config, password, { timeoutMs: 5, transportFactory: () => ({ verify: () => new Promise(() => {}) }) }), error => error.code === 'TIMEOUT' && error.uncertain === false);
  const parsed = validateMailInput(input); assert.deepEqual(parsed.to, input.to);
});

test('actual Nodemailer MIME compilation hides Bcc and encodes text and in-memory attachment without network', async () => {
  let message;
  const transportFactory = options => {
    const compiler = nodemailer.createTransport({
      name: 'test-memory-transport', version: '1.0',
      send(mail, callback) { mail.message.build((error, message) => callback(error, { message, envelope: mail.message.getEnvelope() })); },
    }, { disableFileAccess: options.disableFileAccess, disableUrlAccess: options.disableUrlAccess });
    return {
      async sendMail(mail) {
        const result = await compiler.sendMail(mail);
        message = result.message.toString();
        return { accepted: result.envelope.to, rejected: [] };
      },
      close: () => compiler.close(),
    };
  };
  await sendSmtpMail(config, password, { ...input, bcc: ['hidden@example.com'], attachments: [{ filename: 'note.txt', content: Buffer.from('attachment payload') }] }, { transportFactory });
  assert.match(message, /From: sender@example\.com/);
  assert.match(message, /To: recipient@example\.com/);
  assert.doesNotMatch(message, /Bcc:|hidden@example\.com/);
  assert.match(message, /Content-Transfer-Encoding: base64/);
  assert.ok(message.includes(Buffer.from(input.text).toString('base64')));
  assert.ok(message.includes(Buffer.from('attachment payload').toString('base64')));
});

async function smtpServer(t, onConnection) {
  const peers = new Set();
  const server = createServer(socket => {
    peers.add(socket); socket.on('error', () => {});
    socket.once('close', () => peers.delete(socket));
    onConnection(socket);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { for (const socket of peers) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { ...config, host: '127.0.0.1', port: server.address().port };
}

test('real SMTP socket cannot authenticate or send if STARTTLS is unavailable', async t => {
  let transcript = '';
  const local = await smtpServer(t, socket => {
    socket.write('220 test SMTP ready\r\n');
    socket.on('data', chunk => {
      const text = chunk.toString(); transcript += text;
      if (/EHLO/.test(text)) socket.write('250-test\r\n250 AUTH PLAIN LOGIN\r\n');
      else if (/STARTTLS/.test(text)) socket.write('454 TLS unavailable\r\n');
      else socket.write('500 unexpected command\r\n');
    });
  });
  await assert.rejects(sendSmtpMail({ ...local, mode: 'starttls' }, password, input, { timeoutMs: 2000 }), code('TLS_FAILED'));
  assert.match(transcript, /STARTTLS/); assert.doesNotMatch(transcript, /AUTH|MAIL FROM|RCPT TO|DATA/);
  assert.ok(!transcript.includes(password));
});

test('implicit TLS uses TLS ClientHello and cancellation destroys the actual connection', async t => {
  const controller = new AbortController();
  let firstByte, peerClosed;
  const local = await smtpServer(t, socket => {
    peerClosed = once(socket, 'close');
    socket.once('data', chunk => { firstByte = chunk[0]; controller.abort(new Error(password)); });
  });
  await assert.rejects(sendSmtpMail(local, password, input, { signal: controller.signal, timeoutMs: 2000 }), error => error.code === 'CANCELLED' && error.uncertain === true);
  assert.equal(firstByte, 22, 'TLS handshake record must precede any SMTP commands');
  await peerClosed;
});

test('verification timeout destroys an idle socket rather than leaving authentication running', async t => {
  let peerClosed;
  const local = await smtpServer(t, socket => { peerClosed = once(socket, 'close'); });
  await assert.rejects(verifySmtp({ ...local, mode: 'starttls' }, password, { timeoutMs: 50 }), error => error.code === 'TIMEOUT' && error.uncertain === false);
  await peerClosed;
});

async function tlsSmtpServer(t, { advertiseAuth = true, acceptAuth = true } = {}) {
  const peers = new Set();
  const transcript = [];
  let authenticated = false;
  const server = createTlsServer({ key: smtpTestKey, cert: smtpTestCertificate, minVersion: 'TLSv1.2' }, socket => {
    let pending = '';
    socket.write('220 loopback SMTP ready\r\n');
    socket.on('data', chunk => {
      pending += chunk.toString('utf8');
      let boundary;
      while ((boundary = pending.indexOf('\r\n')) !== -1) {
        const line = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        transcript.push(line);
        if (line.startsWith('EHLO ')) {
          socket.write(advertiseAuth ? '250-loopback\r\n250 AUTH PLAIN\r\n' : '250 loopback\r\n');
        } else if (line.startsWith('AUTH PLAIN ')) {
          const credentials = Buffer.from(line.slice('AUTH PLAIN '.length), 'base64').toString();
          authenticated = acceptAuth && credentials === `\0${config.user}\0${password}`;
          socket.write(authenticated ? '235 2.7.0 Authentication successful\r\n' : `535 5.7.8 Rejected private diagnostic ${password}\r\n`);
        } else if (line === 'QUIT') {
          socket.end('221 Bye\r\n');
        } else {
          socket.write('500 Unexpected command\r\n');
        }
      }
    });
  });
  server.on('connection', socket => {
    peers.add(socket); socket.on('error', () => {});
    socket.once('close', () => peers.delete(socket));
  });
  server.on('tlsClientError', () => {});
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { for (const socket of peers) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return {
    config: { ...config, host: '127.0.0.1', port: server.address().port },
    transcript,
    authenticated: () => authenticated,
    transportFactory: options => {
      assert.equal(options.tls.rejectUnauthorized, true);
      return nodemailer.createTransport({ ...options, tls: { ...options.tls, ca: smtpTestCertificate } });
    },
  };
}

test('real implicit TLS verification validates the certificate, performs EHLO and authenticates without sending', async t => {
  const local = await tlsSmtpServer(t);
  assert.deepEqual(await verifySmtp(local.config, password, { transportFactory: local.transportFactory, timeoutMs: 3000 }), { verified: true });
  assert.equal(local.authenticated(), true);
  assert.match(local.transcript[0], /^EHLO /);
  assert.ok(local.transcript.some(line => line.startsWith('AUTH PLAIN ')));
  assert.ok(local.transcript.every(line => !/^(?:MAIL FROM|RCPT TO|DATA)/.test(line)));
});

test('real SMTP 535 authentication rejection returns safe AUTH_FAILED with no server diagnostics', async t => {
  const local = await tlsSmtpServer(t, { acceptAuth: false });
  await assert.rejects(verifySmtp(local.config, password, { transportFactory: local.transportFactory, timeoutMs: 3000 }), error => {
    assert.equal(error.code, 'AUTH_FAILED'); assert.equal(error.uncertain, false);
    assert.equal(error.smtpCode, 535); assert.equal(error.enhancedCode, '5.7.8'); assert.equal(error.authMethod, 'PLAIN');
    assert.ok(!String(error).includes(password)); assert.ok(!JSON.stringify(error).includes(password));
    assert.equal(error.response, undefined); assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(local.authenticated(), false);
  assert.ok(local.transcript.some(line => line.startsWith('AUTH PLAIN ')));
});

test('a TLS SMTP server without AUTH advertisement cannot falsely verify the mailbox authorization code', async t => {
  const local = await tlsSmtpServer(t, { advertiseAuth: false, acceptAuth: false });
  await assert.rejects(verifySmtp(local.config, password, { transportFactory: local.transportFactory, timeoutMs: 3000 }), code('AUTH_FAILED'));
  assert.equal(local.authenticated(), false);
  assert.ok(local.transcript.some(line => line.startsWith('AUTH PLAIN ')));
});

test('real TLS verification rejects an untrusted SMTP certificate before authentication', async t => {
  const local = await tlsSmtpServer(t);
  await assert.rejects(verifySmtp(local.config, password, { timeoutMs: 3000 }), code('TLS_FAILED'));
  assert.equal(local.authenticated(), false);
  assert.deepEqual(local.transcript, []);
});


const resolveLoopback = async () => ({ address: '127.0.0.1', family: 4 });

test('SMTP discovery probe has no authentication configuration and never submits a message', async () => {
  const state = mockTransport();
  assert.deepEqual(await probeSmtp(config, state), { verified: true });
  assert.equal(state.options.auth, undefined);
  assert.equal(state.options.forceAuth, false);
  assert.equal(state.options.tls.rejectUnauthorized, true);
  assert.equal(state.verifies, 1); assert.equal(state.sends.length, 0);
  const authenticated = mockTransport();
  await verifySmtp(config, password, authenticated);
  assert.equal(authenticated.options.forceAuth, true);
  assert.deepEqual(authenticated.options.auth, { user: config.user, pass: password });
});

test('real TLS SMTP discovery checks EHLO without AUTH even when the server advertises authentication', async t => {
  const local = await tlsSmtpServer(t);
  assert.deepEqual(await probeSmtp(local.config, { resolveHost: resolveLoopback, transportFactory: local.transportFactory, timeoutMs: 3000 }), { verified: true });
  assert.match(local.transcript[0], /^EHLO /);
  assert.ok(local.transcript.every(line => !/^(?:AUTH|MAIL FROM|RCPT TO|DATA)/.test(line)));
  assert.equal(local.authenticated(), false);
});

test('SMTP discovery verifies the certificate before any SMTP commands', async t => {
  const local = await tlsSmtpServer(t);
  await assert.rejects(probeSmtp(local.config, { resolveHost: resolveLoopback, timeoutMs: 3000 }), code('TLS_FAILED'));
  assert.deepEqual(local.transcript, []);
});

test('SMTP discovery cannot downgrade if the server refuses STARTTLS', async t => {
  let transcript = '';
  const local = await smtpServer(t, socket => {
    socket.write('220 test SMTP ready\r\n');
    socket.on('data', chunk => {
      const text = chunk.toString(); transcript += text;
      if (/EHLO/.test(text)) socket.write('250-test\r\n250 AUTH PLAIN LOGIN\r\n');
      else if (/STARTTLS/.test(text)) socket.write('454 TLS unavailable\r\n');
    });
  });
  await assert.rejects(probeSmtp({ ...local, mode: 'starttls' }, { resolveHost: resolveLoopback, timeoutMs: 2000 }), code('TLS_FAILED'));
  assert.match(transcript, /STARTTLS/);
  assert.doesNotMatch(transcript, /AUTH|MAIL FROM|RCPT TO|DATA/);
});

test('SMTP discovery timeout and cancellation close raw sockets without attempting authentication', async t => {
  for (const cancel of [false, true]) {
    const controller = new AbortController();
    let closed;
    const local = await smtpServer(t, socket => {
      closed = once(socket, 'close');
      if (cancel) controller.abort();
    });
    await assert.rejects(probeSmtp({ ...local, mode: 'starttls' }, { resolveHost: resolveLoopback, signal: controller.signal, timeoutMs: cancel ? 2000 : 50 }), error => error.code === (cancel ? 'CANCELLED' : 'TIMEOUT') && !error.uncertain);
    await closed;
  }
});

test('SMTP discovery refuses private literal destinations by default, even if publicOnly false is requested', async () => {
  for (const host of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1']) {
    await assert.rejects(probeSmtp({ ...config, host }, { publicOnly: false, timeoutMs: 500 }), code('CONNECTION_FAILED'));
  }
});

test('publicOnly verification and submission connect to the validated IP and retain hostname TLS checks', async t => {
  const local = await tlsSmtpServer(t);
  const lookedUp = [];
  const resolveHost = async host => { lookedUp.push(host); return resolveLoopback(); };
  // The test certificate is issued for loopback, so another hostname must fail,
  // proving pinning an IP never substitutes it for certificate hostname checks.
  await assert.rejects(verifySmtp({ ...local.config, host: 'smtp.example.invalid' }, password, {
    publicOnly: true, resolveHost, transportFactory: local.transportFactory, timeoutMs: 2000,
  }), code('TLS_FAILED'));
  assert.deepEqual(lookedUp, ['smtp.example.invalid']);
  assert.deepEqual(local.transcript, []);
  await assert.rejects(sendSmtpMail({ ...config, host: '127.0.0.1' }, password, input, { publicOnly: true, timeoutMs: 500 }), error => error.code !== 'TIMEOUT');
});

test('aborted discovery DNS lookup cannot establish a late socket', async () => {
  const controller = new AbortController();
  let resolve;
  const lookup = new Promise(done => { resolve = done; });
  const pending = probeSmtp(config, { resolveHost: () => lookup, signal: controller.signal, timeoutMs: 2000 });
  controller.abort();
  await assert.rejects(pending, code('CANCELLED'));
  resolve({ address: '127.0.0.1', family: 4 });
  await new Promise(done => setImmediate(done));
});


test('publicOnly refuses loopback before opening sockets for probes, verification and submission', async t => {
  let connections = 0;
  const local = await smtpServer(t, () => { connections++; });
  await assert.rejects(probeSmtp(local, { timeoutMs: 500 }), code('CONNECTION_FAILED'));
  await assert.rejects(verifySmtp(local, password, { publicOnly: true, timeoutMs: 500 }), code('CONNECTION_FAILED'));
  await assert.rejects(sendSmtpMail(local, password, input, { publicOnly: true, timeoutMs: 500 }), code('CONNECTION_FAILED'));
  assert.equal(connections, 0);
});

test('SMTP authentication diagnostics retain only validated protocol fields and never raw AUTH payloads', async () => {
  for (const raw of [
    { responseCode: 454, response: `454 4.7.0 Temporary ${password}`, command: 'AUTH LOGIN', expected: [454, '4.7.0', 'LOGIN'] },
    { responseCode: 504, response: `504 Unsupported ${password}`, command: 'AUTH PLAIN', expected: [504, undefined, 'PLAIN'] },
    { responseCode: password, response: password, command: `AUTH PLAIN ${Buffer.from(password).toString('base64')}`, expected: [undefined, undefined, undefined] },
    { responseCode: 235, response: '235 2.7.0 Success', command: password, expected: [undefined, undefined, undefined] },
  ]) {
    const transport = mockTransport(Object.assign(new Error(password), { code: 'EAUTH', ...raw }));
    await assert.rejects(verifySmtp(config, password, transport), error => {
      assert.deepEqual([error.smtpCode, error.enhancedCode, error.authMethod], raw.expected);
      assert.doesNotMatch(JSON.stringify(error), new RegExp(`${password}|${Buffer.from(password).toString('base64')}`));
      assert.equal(error.command, undefined); assert.equal(error.response, undefined); assert.equal(error.cause, undefined);
      return true;
    });
  }
});
