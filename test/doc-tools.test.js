import test from 'node:test';
import assert from 'node:assert/strict';
import { docToolDefinitions, executeDocTool } from '../lib/doc-tools.js';

const storeWith = texts => ({
  searchMessages({ query, limit }) {
    return texts
      .filter(record => record.text.includes(query))
      .slice(0, limit ?? 20);
  },
});

const bindingWith = texts => ({ chatId: 'oc_test', store: storeWith(texts) });
const userLink = token => [{ role: 'user', text: `看下这个 https://x.feishu.cn/docx/${token}` }];

const stubClient = overrides => ({
  async getDocumentContent(id) { return { content: `doc-content:${id}` }; },
  async getWikiNode(token) { return { node: { obj_token: `resolved-${token}`, obj_type: 'docx' } }; },
  async querySheets() { return { sheets: [{ sheet_id: 's1', title: '工作表1' }] }; },
  async getSheetValues() { return { valueRange: { values: [['名称', '数量'], ['苹果', 3]] } }; },
  async listBitableTables() { return { items: [{ table_id: 't1', name: '任务表' }] }; },
  async getBitableRecords() { return { items: [{ fields: { 标题: '写周报', 状态: '进行中' } }] }; },
  ...overrides,
});

test('docx 链接：用户在聊天中发过即可读取内容', async () => {
  const token = 'doxcnABCDEFGHIJ';
  const out = await executeDocTool('feishu_doc_read', { url: `https://x.feishu.cn/docx/${token}` }, bindingWith(userLink(token)), stubClient());
  assert.equal(out.text, `doc-content:${token}`);
  assert.equal(out.truncated, false);
});

test('令牌未在用户消息中出现过时拒绝读取', async () => {
  const token = 'doxcnSECRET1234';
  const binding = bindingWith([{ role: 'assistant', text: `https://x.feishu.cn/docx/${token}` }]); // 仅出现在助手消息里
  await assert.rejects(
    () => executeDocTool('feishu_doc_read', { url: `https://x.feishu.cn/docx/${token}` }, binding, stubClient()),
    /不是你在本聊天中发过的/,
  );
});

test('wiki 链接自动解析到 docx 正文', async () => {
  const token = 'wikcnABCDEFGHIJ';
  const binding = bindingWith([{ role: 'user', text: `https://x.feishu.cn/wiki/${token}` }]);
  const out = await executeDocTool('feishu_doc_read', { url: `https://x.feishu.cn/wiki/${token}` }, binding, stubClient());
  assert.equal(out.text, `doc-content:resolved-${token}`);
});

test('电子表格读取第一个工作表并带表头说明', async () => {
  const token = 'shtcnABCDEFGHIJ';
  const binding = bindingWith([{ role: 'user', text: `https://x.feishu.cn/sheets/${token}` }]);
  const out = await executeDocTool('feishu_doc_read', { url: `https://x.feishu.cn/sheets/${token}` }, binding, stubClient());
  assert.match(out.text, /工作表1/);
  assert.match(out.text, /苹果\t3/);
});

test('多维表格列出数据表与记录', async () => {
  const token = 'bascnABCDEFGHIJ';
  const binding = bindingWith([{ role: 'user', text: `https://x.feishu.cn/base/${token}` }]);
  const out = await executeDocTool('feishu_doc_read', { url: `https://x.feishu.cn/base/${token}` }, binding, stubClient());
  assert.match(out.text, /任务表/);
  assert.match(out.text, /写周报/);
});

test('权限错误映射为可操作的引导话术', async () => {
  const token = 'doxcnNOPERM000';
  const client = stubClient({ async getDocumentContent() { throw new Error('Feishu API error [99991672]: no permission'); } });
  const binding = bindingWith(userLink(token));
  await assert.rejects(
    () => executeDocTool('feishu_doc_read', { url: `https://x.feishu.cn/docx/${token}` }, binding, client),
    /分享.*机器人.*协作者/,
  );
});

test('不支持的链接与未知工具被拒绝', async () => {
  await assert.rejects(() => executeDocTool('feishu_doc_read', { url: 'https://example.com/foo' }, bindingWith([]), stubClient()), /无法识别/);
  await assert.rejects(() => executeDocTool('nope', {}, bindingWith([]), stubClient()), /Tool unavailable/);
});

test('正文超过 20000 字符时截断并标记', async () => {
  const token = 'doxcnLONGTEXT00';
  const client = stubClient({ async getDocumentContent() { return { content: 'x'.repeat(30000) }; } });
  const out = await executeDocTool('feishu_doc_read', { url: `https://x.feishu.cn/docx/${token}` }, bindingWith(userLink(token)), client);
  assert.equal(out.text.length, 20000);
  assert.equal(out.truncated, true);
});

// ===== 网页抓取 =====

const response = ({ status = 200, body = 'hello', headers = {} }) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: key => headers[key.toLowerCase()] ?? null },
  arrayBuffer: async () => Buffer.from(body),
});

const publicLookup = async () => [{ address: '93.184.216.34' }];

test('网页抓取：去标签并返回正文', async () => {
  const fetchFn = async () => response({ headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<html><style>x{}</style><body><h1>标题</h1><script>bad()</script><p>正文内容</p></body></html>' });
  const out = await executeDocTool('feishu_web_fetch', { url: 'https://example.com/a' }, bindingWith([]), stubClient(), { fetchFn, lookupFn: publicLookup });
  assert.match(out.text, /标题/);
  assert.match(out.text, /正文内容/);
  assert.doesNotMatch(out.text, /bad\(\)/);
});

test('网页抓取：内网与环回地址被拒绝', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.9', '169.254.1.1', '::1']) {
    await assert.rejects(
      () => executeDocTool('feishu_web_fetch', { url: 'http://internal/' }, bindingWith([]), stubClient(), { fetchFn: async () => { throw new Error('should not fetch'); }, lookupFn: async () => [{ address }] }),
      /内网或环回/,
    );
  }
});

test('网页抓取：非 http 协议与多次重定向被拒绝', async () => {
  await assert.rejects(() => executeDocTool('feishu_web_fetch', { url: 'file:///etc/passwd' }, bindingWith([]), stubClient(), { lookupFn: publicLookup }), /仅支持/);
  const redirecting = async () => response({ status: 302, headers: { location: 'https://example.com/next' } });
  await assert.rejects(() => executeDocTool('feishu_web_fetch', { url: 'https://example.com/' }, bindingWith([]), stubClient(), { fetchFn: redirecting, lookupFn: publicLookup }), /重定向次数过多/);
});

test('网页抓取：重定向目标同样做内网校验', async () => {
  let calls = 0;
  const fetchFn = async () => { calls++; return calls === 1 ? response({ status: 302, headers: { location: 'http://169.254.169.254/meta' } }) : response({}); };
  // 模拟真实 DNS：IP 字面量的解析结果就是其自身
  const ipAwareLookup = async host => [{ address: host }];
  await assert.rejects(
    () => executeDocTool('feishu_web_fetch', { url: 'https://example.com/' }, bindingWith([]), stubClient(), { fetchFn, lookupFn: ipAwareLookup }),
    /内网或环回/,
  );
});
