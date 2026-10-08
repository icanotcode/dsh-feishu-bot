// 隔离会话的云文档与网页读取工具。
//
// 安全模型：
// - 飞书云文档（docx/wiki/sheets/bitable）走应用凭据（tenant token）服务端读取，
//   但要求**链接令牌必须出现在该用户自己在本聊天中发过的消息里**——
//   用户把链接发进自己的私聊，才授权本会话代读该文档；猜来的令牌读不到。
// - 网页读取只允许公网 http/https，DNS 解析后拦截内网/环回地址，跟随重定向时逐跳复核。
// - 全部输出截断封顶，附件与网页内容始终视为不可信资料。

import { lookup as defaultLookup } from 'node:dns/promises';

const string = { type: 'string' };
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

export const docToolDefinitions = [
  {
    name: 'feishu_doc_read',
    description: '读取用户发过来的飞书云文档内容。支持 docx 文档、wiki 知识库节点（自动解析到实际文档）、sheets 电子表格、bitable/base 多维表格。链接必须由用户本人在本聊天中发送过；文档还需把机器人加为协作者或开启链接可读。返回文本封顶 20000 字符，截断时 truncated=true。',
    parameters: schema({ url: { ...string, description: '用户消息中出现的飞书文档完整链接' } }, ['url']),
  },
  {
    name: 'feishu_web_fetch',
    description: '抓取一个公网网页的正文文本（http/https，自动去标签，封顶 20000 字符）。内网与环回地址被拒绝。仅用于读取用户给出的网页链接。',
    parameters: schema({ url: { ...string, description: '公网 http/https 链接' } }, ['url']),
  },
];

const TEXT_CAP = 20000;
const WEB_MAX_BYTES = 512 * 1024;
const BITABLE_TABLE_CAP = 5;
const BITABLE_RECORD_CAP = 50;

const DOC_PATTERNS = [
  ['docx', /\/docx\/([A-Za-z0-9]{10,})/],
  ['wiki', /\/wiki\/([A-Za-z0-9]{10,})/],
  ['sheets', /\/sheets\/([A-Za-z0-9]{10,})/],
  ['bitable', /\/(?:base|bitable)\/([A-Za-z0-9]{10,})/],
];

function parseDocUrl(url) {
  if (typeof url !== 'string' || !url.includes('feishu')) throw new Error('无法识别的链接：请给出完整的飞书云文档链接');
  for (const [kind, pattern] of DOC_PATTERNS) {
    const match = url.match(pattern);
    if (match) return { kind, token: match[1] };
  }
  throw new Error('无法识别的链接：目前支持 docx 文档、wiki、电子表格、多维表格');
}

/** 令牌归属校验：令牌必须出现在本聊天内某条用户消息里。 */
function assertTokenClaimed(binding, token) {
  const hits = binding.store.searchMessages({ query: token, chatId: binding.chatId, limit: 20 });
  if (!hits.some(record => record.role === 'user' && typeof record.text === 'string' && record.text.includes(token))) {
    throw new Error('该文档链接不是你在本聊天中发过的，无法代读。请把链接直接发给我。');
  }
}

const cap = (text) => {
  const value = String(text ?? '');
  return value.length > TEXT_CAP ? { text: value.slice(0, TEXT_CAP), truncated: true } : { text: value, truncated: false };
};

function permissionHint(error) {
  const message = String(error?.message);
  // 应用未开通 API 权限范围（scope）：与文档协作权限无关，必须部署管理员在开放平台开通并发布
  if (/scopes is required|尚未开通所需的应用身份权限/.test(message)) {
    const required = (message.match(/\[([^\]]*readonly[^\]]*|[^\]]*:app[^\]]*)\]/) || [])[1] || '对应云文档权限';
    return new Error(`机器人应用未开通云文档 API 权限（缺少 scope：${required}）。这与文档协作权限无关——需要部署管理员在飞书开放平台 → 应用 → 权限管理中开通对应权限（多维表格 bitable:app:readonly、云文档 docx:document:readonly、电子表格 sheets:spreadsheet:readonly、知识库 wiki:wiki:readonly），并创建新版本发布后重试。`);
  }
  if (/permission|forbidden|access denied|99991672|1254\d\d/i.test(message)) {
    return new Error('机器人没有该文档的访问权限。两条路：① 若文档与机器人在同一飞书企业，请在文档「分享」中把机器人加为协作者（或设为「组织内获得链接可阅读」）后重试；② 若文档在其他飞书企业（跨组织），平台不允许给外部机器人授权——请把表格导出为 Excel/CSV 后直接把文件发给我（我能解析 xlsx/csv），或直接复制内容粘贴到对话里。不要再发链接重试。');
  }
  return error;
}

function formatSheetValues(data) {
  const rows = data?.valueRange?.values ?? [];
  if (!rows.length) return { text: '（表格为空）', truncated: false };
  const lines = rows.map(row => (Array.isArray(row) ? row : [row]).map(cell => cell == null ? '' : String(cell)).join('\t'));
  return cap(lines.join('\n'));
}

async function readSheet(client, token) {
  const meta = await client.querySheets(token);
  const sheets = meta?.sheets ?? [];
  if (!sheets.length) return { text: '（未找到工作表）', truncated: false };
  const first = sheets[0];
  const data = await client.getSheetValues(token, `${first.sheet_id}!A1:Z200`);
  const out = formatSheetValues(data);
  return {
    ...out,
    text: `电子表格（共 ${sheets.length} 个工作表，以下为第一个「${first.title || first.sheet_id}」前 200 行）：\n${out.text}`,
  };
}

async function readBitable(client, token) {
  const meta = await client.listBitableTables(token);
  const tables = (meta?.items ?? []).slice(0, BITABLE_TABLE_CAP);
  if (!tables.length) return { text: '（多维表格中没有数据表）', truncated: false };
  const parts = [];
  let truncated = false;
  for (const table of tables) {
    const records = await client.getBitableRecords(token, table.table_id);
    const items = (records?.items ?? []).slice(0, BITABLE_RECORD_CAP);
    if ((records?.items ?? []).length > BITABLE_RECORD_CAP) truncated = true;
    parts.push(`数据表「${table.name || table.table_id}」（${items.length} 条）：\n` +
      items.map(item => JSON.stringify(item.fields)).join('\n'));
  }
  const out = cap(parts.join('\n\n'));
  return { ...out, truncated: truncated || out.truncated };
}

async function readDocx(client, documentId) {
  const data = await client.getDocumentContent(documentId);
  return cap(data?.content ?? '');
}

export async function executeDocTool(name, args, binding, client, deps = {}) {
  if (name === 'feishu_web_fetch') return await webFetch(args.url, deps);
  if (name !== 'feishu_doc_read') throw new Error('Tool unavailable');

  const { kind, token } = parseDocUrl(args.url);
  assertTokenClaimed(binding, token);
  try {
    if (kind === 'docx') return await readDocx(client, token);
    if (kind === 'sheets') return await readSheet(client, token);
    if (kind === 'bitable') return await readBitable(client, token);
    // wiki：先解析节点到真实对象再分发
    const node = (await client.getWikiNode(token))?.node;
    if (!node?.obj_token) throw new Error('wiki 节点解析失败');
    if (node.obj_type === 'docx' || node.obj_type === 'doc') return await readDocx(client, node.obj_token);
    if (node.obj_type === 'sheet') return await readSheet(client, node.obj_token);
    if (node.obj_type === 'bitable') return await readBitable(client, node.obj_token);
    throw new Error(`wiki 节点类型「${node.obj_type}」暂不支持读取`);
  } catch (error) {
    throw permissionHint(error);
  }
}

// ===== 网页抓取（SSRF 防护）=====

function isPrivateIp(ip) {
  if (ip.includes(':')) {  // IPv6
    const v = ip.toLowerCase();
    return v === '::1' || v === '::' || v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('::ffff:127.') || v.startsWith('::ffff:10.') || v.startsWith('::ffff:192.168');
  }
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || a >= 224;
}

async function assertPublicHost(url, lookupFn) {
  const host = url.hostname;
  const addresses = await lookupFn(host, { all: true });
  if (!addresses.length) throw new Error('域名解析失败');
  for (const { address } of addresses) {
    if (isPrivateIp(address)) throw new Error('内网或环回地址不允许访问');
  }
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

async function webFetch(rawUrl, deps) {
  const fetchFn = deps.fetchFn ?? globalThis.fetch;
  const lookupFn = deps.lookupFn ?? defaultLookup;
  let url;
  try { url = new URL(rawUrl); } catch { throw new Error('无效链接'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('仅支持 http/https 链接');

  for (let hop = 0; hop < 4; hop++) {
    await assertPublicHost(url, lookupFn);
    const response = await fetchFn(url, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      const next = new URL(response.headers.get('location'), url);
      if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new Error('重定向到不支持的协议');
      url = next;
      continue;
    }
    if (!response.ok) throw new Error(`网页返回状态 ${response.status}`);
    const length = Number(response.headers.get('content-length') || 0);
    if (length > WEB_MAX_BYTES) throw new Error('网页过大（超过 512KB），无法读取');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > WEB_MAX_BYTES) throw new Error('网页过大（超过 512KB），无法读取');
    const type = response.headers.get('content-type') || '';
    const raw = buffer.toString('utf8');
    const text = /html|xml/i.test(type) ? htmlToText(raw) : raw;
    if (!text) throw new Error('网页没有可提取的文本内容');
    return cap(text);
  }
  throw new Error('重定向次数过多');
}
