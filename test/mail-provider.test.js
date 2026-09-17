import test from 'node:test';
import assert from 'node:assert/strict';
import { detectMailProvider } from '../lib/mail-provider.js';

test('known exact mailbox domains select maintained SMTP settings with mandatory encryption', () => {
  for (const [address, host, port, mode] of [
    ['one@qq.com', 'smtp.qq.com', 465, 'tls'],
    ['one@FOXMAIL.COM', 'smtp.qq.com', 465, 'tls'],
    ['one@163.com', 'smtp.163.com', 465, 'tls'],
    ['one@126.com', 'smtp.126.com', 465, 'tls'],
    ['one@gmail.com', 'smtp.gmail.com', 465, 'tls'],
    ['one@googlemail.com', 'smtp.gmail.com', 465, 'tls'],
    ['one@icloud.com', 'smtp.mail.me.com', 587, 'starttls'],
    ['one@aol.com', 'smtp.aol.com', 587, 'starttls'],
  ]) assert.deepEqual(detectMailProvider(address), { host, port, mode });
});

test('unknown, deceptive, malformed and enterprise domains cannot redirect authorization codes', () => {
  for (const address of [null, '', 'user@qq.com.evil.example', 'user@sub.qq.com', 'user@company.example', 'user@gmail', 'user@QQ', '@qq.com', 'a@b@qq.com', 'a@ qq.com', 'a@qq.com\n', 'a@qq.com.', 'a@q_q.com']) {
    assert.equal(detectMailProvider(address), undefined, String(address));
  }
  const first = detectMailProvider('one@qq.com');
  first.host = 'evil.example';
  assert.equal(detectMailProvider('two@qq.com').host, 'smtp.qq.com');
});
