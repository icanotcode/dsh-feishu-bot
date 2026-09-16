import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFeishuMessage } from '../lib/message-parser.js';
import { createFeishuEventReceiver } from '../lib/index.js';

function event(type, content) {
  return { sender: { sender_type: 'user', sender_id: { open_id: 'alice' } }, message: {
    message_type: type, content: JSON.stringify(content), message_id: 'om_source', chat_id: 'chat-a', chat_type: 'p2p', create_time: '1700000000000',
  } };
}
test('text compatibility and image/file/audio/video metadata use only source message resources', () => {
  assert.equal(parseFeishuMessage(event('text', { text: 'hello' })).userText, 'hello');
  for (const [type, content, kind] of [
    ['image', { image_key: 'img_key' }, 'image'], ['file', { file_key: 'file_key', file_name: '报告.pdf' }, 'file'],
    ['audio', { file_key: 'audio_key' }, 'audio'], ['media', { file_key: 'video_key', image_key: 'cover_key', file_name: 'video.mp4' }, 'video'],
  ]) {
    const parsed = parseFeishuMessage(event(type, content));
    assert.equal(parsed.attachments[0].kind, kind); assert.equal(parsed.messageId, 'om_source');
    assert.equal(parsed.timestamp, '2023-11-14T22:13:20.000Z'); assert.match(parsed.userText, /收到附件/);
    if (kind === 'video') assert.equal(parsed.attachments[1].cover, true);
  }
});
test('rich text parses direct and locale envelopes without dropping image captions', () => {
  const post = { title: '说明', content: [[{ tag: 'text', text: '@_user_1 看图' }, { tag: 'img', image_key: 'img_a' }], [{ tag: 'a', text: '参考', href: 'https://example.com' }]] };
  for (const value of [post, { zh_cn: post }, { en_us: post }]) {
    const source = event('post', value); source.message.chat_type = 'group'; source.message.mentions = [{ key: '@_user_1' }];
    const parsed = parseFeishuMessage(source);
    assert.match(parsed.userText, /说明\n 看图|说明\n看图/); assert.match(parsed.userText, /https:\/\/example.com/);
    assert.equal(parsed.attachments[0].key, 'img_a'); assert.equal(parsed.userText.includes('@_user_1'), false);
  }
});
test('malformed, unsupported and excessive attachments produce explicit failures', () => {
  for (const source of [event('image', {}), event('file', null), event('sticker', { file_key: 'x' }), event('post', {})]) assert.ok(parseFeishuMessage(source).attachmentError);
  const many = event('post', { content: [Array.from({ length: 11 }, (_, i) => ({ tag: 'img', image_key: `img_${i}` }))] });
  assert.match(parseFeishuMessage(many).attachmentError, /10/);
  const invalid = event('image', {}); invalid.message.content = 'not-json';
  assert.ok(parseFeishuMessage(invalid).attachmentError);
  assert.equal(parseFeishuMessage(event('text', { text: {} })), null);
});
test('authenticated webhook admission queues non-text metadata and acknowledges before any download', () => {
  const deliveries = [];
  const receive = createFeishuEventReceiver({ webhookRuntime: { dispatch: delivery => deliveries.push(delivery) } }, { source: 'test' });
  const payload = { header: { event_type: 'im.message.receive_v1', event_id: 'evt_image', tenant_key: 'tenant' }, event: event('image', { image_key: 'img_a' }) };
  assert.throws(() => receive(payload), /verification/);
  receive(payload, { authenticated: true }); receive(payload, { authenticated: true });
  assert.equal(deliveries.length, 1); assert.equal(deliveries[0].event.payload.parsed.attachments[0].key, 'img_a');
  payload.header.event_id = 'evt_bot'; payload.event.sender.sender_type = 'app';
  receive(payload, { authenticated: true }); assert.equal(deliveries.length, 1);
});
