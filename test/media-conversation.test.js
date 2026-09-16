import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createConversationFixture } from '../test-support/conversation-fixture.mjs';
import { FeishuMediaError } from '../lib/feishu-media-api.js';

const png = Buffer.from('89504e470d0a1a0a', 'hex'); // Stub bytes: the real attachment backend owns image decoding.
const ref = (data, name) => ({ attachmentId: createHash('sha256').update(data).digest('hex'), name, bytes: data.length });
const context = {
  attachments: {
    saveFile: async ({ data, name }) => ref(data, name),
    saveImage: async ({ data, name, mediaType }) => ({ ...ref(data, name), mediaType, width: 1, height: 1 }),
  },
  llm: { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) },
};
async function fixture(t, options = {}) {
  const uploads = [], downloads = [], sent = [];
  let callSequence = 0;
  const api = {
    downloadMessageResource: async (_client, input) => { downloads.push(input); return { data: input.type === 'image' ? png : Buffer.from('uploaded content'), mimeType: 'application/octet-stream' }; },
    uploadMessageImage: async (_client, input) => { uploads.push(['image', input]); return { image_key: 'img_uploaded' }; },
    uploadMessageFile: async (_client, input) => { uploads.push(['file', input]); return { file_key: 'file_uploaded' }; },
    ...options.mediaApi,
  };
  const app = await createConversationFixture(t, { ...options, context: options.context ?? context, mediaApi: api,
    client: { replyMessage: async (...args) => { sent.push(args); return { message_id: `out-${sent.length}` }; }, ...options.client },
  });
  return { ...app, uploads, downloads, sent, api,
    execute: (name, args, agent, extra = {}) => app.tools.get(name).execute(args, { agent, signal: new AbortController().signal, callId: `call-${++callSequence}`, ...extra }),
  };
}
const imageInput = { kind: 'image', key: 'img_source', filename: 'image' };
test('incoming files are private, durable in history and visible as native Harness attachments; duplicates do not redownload', async t => {
  const app = await fixture(t);
  await app.send({ messageId: 'om_file', text: '处理这个文件', attachments: [{ kind: 'file', key: 'file_source', filename: '报告.txt' }] });
  const agent = [...app.agents.values()][0];
  const blocks = agent.queue[0].content;
  assert.equal(blocks[1].type, 'file'); assert.equal(blocks[1].attachment.name, '报告.txt');
  const note = app.store().searchMessages({ query: '附件接收记录', chatId: 'chat-a' })[0];
  const record = JSON.parse(note.text.split('\n')[1])[0];
  assert.match(record.path, /^incoming\//); assert.equal(await readFile(join(agent.session.header.cwd, record.path), 'utf8'), 'uploaded content');
  assert.equal(app.downloads[0].messageId, 'om_file'); assert.equal(app.downloads[0].key, 'file_source');
  await app.send({ messageId: 'om_file', attachments: [{ kind: 'file', key: 'file_source', filename: '报告.txt' }] });
  assert.equal(app.downloads.length, 1);
  assert.equal(app.store('bob').searchMessages({ query: record.path }).length, 0);
});
test('name confirmation gates attachment download, and malformed media replies explicitly without model admission', async t => {
  const app = await fixture(t, { profiles: [] });
  await app.send({ text: 'Alex', attachments: [imageInput] });
  assert.equal(app.downloads.length, 0); assert.equal(app.agents.size, 0); assert.match(app.sent[0][1], /告诉我你的名字/);
  await app.send({ text: 'Alex' }); await app.send({ text: '确认' });
  await app.send({ attachmentError: '缺少资源标识' });
  assert.equal(app.agents.size, 0); assert.match(app.sent.at(-1)[1], /缺少资源标识/);
});
test('known vision models get image blocks; text-only or unknown models keep files without claiming vision', async t => {
  for (const modalities of [['text', 'image'], ['text'], undefined]) {
    const app = await fixture(t, { context: { ...context, llm: { resolveModelInfo: async () => ({ inputModalities: modalities }) } } });
    await app.send(); const agent = [...app.agents.values()][0]; agent.options = { provider: 'test', model: 'test' };
    await app.send({ attachments: [imageInput] });
    const blocks = agent.queue.at(-1).content;
    assert.equal(blocks[1].type, modalities?.includes('image') ? 'image' : 'file');
    if (!modalities?.includes('image')) assert.match(blocks[0].text, /不得声称已看过/);
    const note = app.store().searchMessages({ query: '附件接收记录' })[0];
    const path = JSON.parse(note.text.split('\n')[1])[0].path;
    if (modalities?.includes('image')) {
      const result = await app.execute('feishu_read_image', { path }, agent);
      assert.equal(app.tools.get('feishu_read_image').output.render({}, result)[0].type, 'image');
    } else await assert.rejects(app.execute('feishu_read_image', { path }, agent), /未确认支持看图/);
  }
});
test('download permission errors are visible, stored and never admitted as successful attachments', async t => {
  const app = await fixture(t, { mediaApi: { downloadMessageResource: async () => { throw new FeishuMediaError('PERMISSION_DENIED'); } } });
  await app.send({ attachments: [imageInput] });
  assert.match(app.sent.at(-1)[1], /权限不足/);
  assert.equal([...app.agents.values()][0].queue.length, 0);
  assert.match(app.store().searchMessages({ query: '附件接收记录' })[0].text, /error/);
});
test('generated document sends only to claimed source message and repeated tool execution is idempotent', async t => {
  const app = await fixture(t); await app.send({ messageId: 'om_first' }); await app.send({ messageId: 'om_next' });
  const agent = [...app.agents.values()][0];
  await app.execute('feishu_workspace_write', { path: '报告.md', text: '# 报告\n内容' }, agent);
  await assert.rejects(app.execute('feishu_send_file', { path: '报告.md' }, agent), /正在处理/);
  await app.claim(agent);
  const args = { path: '报告.md' }, exec = { callId: 'same-tool-call' };
  const results = await Promise.all([app.execute('feishu_send_file', args, agent, exec), app.execute('feishu_send_file', args, agent, exec)]);
  assert.deepEqual(results[0], results[1]); assert.equal(results[0].data.sent, true);
  assert.equal(app.uploads.length, 1); assert.equal(app.sent.length, 1);
  assert.equal(app.sent[0][0], 'om_first'); assert.equal(app.sent[0][2], 'file'); assert.equal(app.sent[0][3].uuid.length, 32);
  assert.equal(app.store().searchMessages({ query: '已发送附件' }).length, 1);
  await app.finish(agent); await app.claim(agent);
  await app.execute('feishu_send_file', args, agent, { callId: 'next-call' });
  assert.equal(app.sent.at(-1)[0], 'om_next');
  await app.finish(agent);
  await assert.rejects(app.execute('feishu_send_file', args, agent), /正在处理/);
});
test('image, MP4 video and OPUS audio upload correct media types and file fallback remains available', async t => {
  const app = await fixture(t); await app.send(); const agent = [...app.agents.values()][0]; await app.claim(agent);
  for (const [name, kind] of [['picture.png', 'image'], ['movie.mp4', 'video'], ['voice.opus', 'audio'], ['sound.mp3', 'file']]) {
    await writeFile(join(agent.session.header.cwd, name), kind === 'image' ? png : Buffer.from('test binary'));
    const result = await app.execute('feishu_send_file', { path: name, kind, ...(kind === 'video' ? { duration: 500 } : {}) }, agent);
    assert.equal(result.data.sent, true); assert.equal(app.sent.at(-1)[2], kind === 'video' ? 'media' : kind);
    if (kind === 'video') assert.deepEqual(app.sent.at(-1)[1], { file_key: 'file_uploaded', image_key: 'img_uploaded' });
  }
  assert.deepEqual(app.uploads.filter(([kind]) => kind === 'file').map(([, value]) => value.fileType), ['mp4', 'opus', 'stream']);
  await assert.rejects(app.execute('feishu_send_file', { path: 'sound.mp3', kind: 'audio' }, agent), /OPUS/);
  await assert.rejects(app.execute('feishu_send_file', { path: 'movie.mp4', kind: 'video', duration: -1 }, agent), /非负/);
});
test('send cannot read another user, stale active target or cancelled upload, and does not claim success', async t => {
  let release;
  const app = await fixture(t, { mediaApi: { uploadMessageFile: async () => new Promise(resolve => { release = () => resolve({ file_key: 'uploaded' }); }) } });
  await app.send(); const agent = [...app.agents.values()][0]; await app.claim(agent);
  await writeFile(join(agent.session.header.cwd, 'own.txt'), 'content');
  await assert.rejects(app.execute('feishu_send_file', { path: '../other/secret.txt' }, agent), /发送未确认成功/);
  const controller = new AbortController();
  const pending = app.execute('feishu_send_file', { path: 'own.txt' }, agent, { signal: controller.signal, callId: 'pending' });
  while (!release) await new Promise(resolve => setTimeout(resolve, 1));
  controller.abort(); release(); await assert.rejects(pending);
  assert.equal(app.sent.length, 0); assert.equal(app.store().searchMessages({ query: '已发送附件' }).length, 0);
});
test('read-only users can receive and return uploads but cannot generate or edit files', async t => {
  const app = await fixture(t, { config: { permissionPreset: 'read-only' } });
  await app.send({ attachments: [{ kind: 'file', key: 'f', filename: 'original.txt' }] });
  const agent = [...app.agents.values()][0]; await app.claim(agent);
  const path = JSON.parse(app.store().searchMessages({ query: '附件接收记录' })[0].text.split('\n')[1])[0].path;
  await assert.rejects(app.execute('feishu_workspace_write', { path, text: 'tamper' }, agent), /read-only/);
  await app.execute('feishu_send_file', { path }, agent);
  assert.equal(app.uploads[0][1].filename, 'original.txt');
  assert.equal(app.uploads[0][1].data.toString(), 'uploaded content');
});

test('archiving during a download rotates before admission without downloading twice', async t => {
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  let downloads = 0;
  const app = await fixture(t, { mediaApi: { downloadMessageResource: async () => {
    downloads++; entered(); return new Promise(resolve => { release = () => resolve({ data: Buffer.from('file') }); });
  } } });
  const pending = app.send({ messageId: 'om_slow', attachments: [{ kind: 'file', key: 'slow', filename: 'slow.txt' }] });
  await waiting;
  const old = [...app.agents.values()][0]; app.archived.add(old.session.id); release(); await pending;
  const current = [...app.agents.values()].find(agent => agent.session.id !== old.session.id);
  assert.ok(current); assert.equal(old.queue.length, 0); assert.equal(current.queue.length, 1); assert.equal(downloads, 1);
  assert.equal(app.store().getMessageByFeishuId('om_slow').sessionId, current.session.id);
  assert.equal(current.queue[0].content[1].type, 'file');
});
