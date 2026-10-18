import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFeishuMessage } from '../lib/message-parser.js';
import { quoteFromStore, quoteFromApi } from '../lib/quote-context.js';

const baseEvent = {
  sender: { sender_type: 'user', sender_id: { open_id: 'ou_test' } },
  message: { chat_type: 'p2p', chat_id: 'oc_test', message_id: 'om_new', message_type: 'text', content: '{"text":"这条怎么样"}' },
};

test('解析器透传引用消息的 parent_id / root_id', () => {
  const quoted = parseFeishuMessage({ ...baseEvent, message: { ...baseEvent.message, parent_id: 'om_parent', root_id: 'om_root' } });
  assert.equal(quoted.parentId, 'om_parent');
  assert.equal(quoted.rootId, 'om_root');
  const plain = parseFeishuMessage(baseEvent);
  assert.equal(plain.parentId, undefined);
});

const storeWith = (record, chatId) => ({
  getAnyMessageByFeishuId: id => (record && record.feishuMessageId === id ? record : undefined),
  getSession: sessionId => ({ sessionId, chatId }),
});

test('引用补全：同聊天的历史消息（含机器人回复）被注入', () => {
  const record = { feishuMessageId: 'om_parent', sessionId: 's1', role: 'assistant', text: '这是机器人此前的回答' };
  const out = quoteFromStore({ chatId: 'oc_test', store: storeWith(record, 'oc_test') }, 'om_parent');
  assert.match(out, /用户引用的消息（即机器人此前的回复）/);
  assert.match(out, /这是机器人此前的回答/);
});

test('引用补全：跨聊天的引用不注入', () => {
  const record = { feishuMessageId: 'om_parent', sessionId: 's1', role: 'user', text: '别的聊天的话' };
  const out = quoteFromStore({ chatId: 'oc_test', store: storeWith(record, 'oc_other') }, 'om_parent');
  assert.equal(out, '');
});

test('引用补全：超长引用截断到 500 字', () => {
  const record = { feishuMessageId: 'om_parent', sessionId: 's1', role: 'user', text: '长'.repeat(600) };
  const out = quoteFromStore({ chatId: 'oc_test', store: storeWith(record, 'oc_test') }, 'om_parent');
  assert.ok(out.includes('…'));
  assert.ok(out.length < 560);
});

test('引用补全：API 兜底解析文本消息，失败静默', async () => {
  const client = { async getMessage() { return { items: [{ body: { content: '{"text":"历史里的旧消息"}' } }] }; } };
  const out = await quoteFromApi(client, 'om_old');
  assert.match(out, /历史里的旧消息/);
  const broken = { async getMessage() { throw new Error('network'); } };
  assert.equal(await quoteFromApi(broken, 'om_old'), '');
});
