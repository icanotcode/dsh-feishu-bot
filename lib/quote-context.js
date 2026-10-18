import { lstat } from 'node:fs/promises';
import { checkedPath } from './user-tools.js';

// 引用补全：飞书引用回复只带 parent_id。优先查本聊天历史库（含机器人自己的回复），
// 未命中再走开放平台 API 兜底（机器人上线前的消息）。补全失败不阻塞主流程。
//
// 智能截断：≤2000 字全留（多数消息完整呈现）；超长取头 1500 + 尾 500，
// 保留开头的论点与结尾的结论，中间省略并标注字数。
//
// 附件引用：被引消息若含附件，按三条路径依次定位工作区文件——
// ① 同聊天「附件接收记录」（用户发来的文件）；
// ② 同聊天「已发送附件」记录（机器人发出去的文件：记录文本内含工作区路径与
//    飞书消息 id，用被引 id 反查并验证文件仍在，避免重新下载）；
// ③ 都不行时经 fetchAttachment 现场回拉飞书资源落盘，
// 实在拿不到才提示用户重发——绝不只留给 agent 一个文件名占位符。

const QUOTE_FULL = 2000;
const QUOTE_HEAD = 1500;
const QUOTE_TAIL = 500;

export function truncateQuote(text) {
  const value = String(text ?? '');
  if (value.length <= QUOTE_FULL) return value;
  const omitted = value.length - QUOTE_HEAD - QUOTE_TAIL;
  return `${value.slice(0, QUOTE_HEAD)}\n……（中间省略 ${omitted} 字）……\n${value.slice(-QUOTE_TAIL)}`;
}

// 从同聊天的附件接收记录里解析被引附件的工作区路径
function resolveQuotedAttachments(binding, quotedText) {
  const names = [...quotedText.matchAll(/(?:file|image|video|audio)\s+"([^"]+)"/g)].map(m => m[1]);
  if (!names.length) return [];
  const resolved = [];
  for (const name of names.slice(0, 4)) {
    const hits = binding.store.searchMessages({ query: name, chatId: binding.chatId, limit: 5 });
    for (const hit of hits) {
      if (hit.role !== 'note' || !String(hit.text).startsWith('附件接收记录')) continue;
      const json = String(hit.text).match(/\[\{[\s\S]*\}\]/);
      if (!json) continue;
      let records;
      try { records = JSON.parse(json[0]); } catch { continue; }
      const found = Array.isArray(records) ? records.find(item => item?.name === name && typeof item.path === 'string') : null;
      if (found) { resolved.push({ name, path: found.path, kind: found.kind || 'file' }); break; }
    }
  }
  return resolved;
}

function guidanceFor(files) {
  const lines = files.map(f => `  - ${f.name} → 工作区路径 ${f.path}（${f.kind}）`);
  return `\n[引用的附件已在本机工作区，务必读取其内容后再结合用户的问题回答，不要只凭文件名猜测]：\n${lines.join('\n')}\n读取方式：文档（pdf/xlsx/csv/txt/md）用 feishu_workspace_extract_text，图片用 feishu_read_image，其他类型先 feishu_workspace_read 尝试。`;
}

const resendHint = name => `\n[引用的附件${name ? `（${name}）` : ''}未能取回工作区；请请用户把文件直接重新发一次]`;

const ATTACH_MARKER = /\[收到附件：/;

// 机器人发出的文件：发送记录文本内含 "messageId" 与工作区 path，用被引消息 id 反查。
// 文件必须仍在工作区才返回（记录还在但文件被删时返回 null，交由回拉兜底）。
async function resolveSentAttachment(binding, parentId) {
  const hits = binding.store.searchMessages({ query: parentId, chatId: binding.chatId, limit: 5 });
  for (const hit of hits) {
    if (hit.role !== 'assistant') continue;
    const text = String(hit.text || '');
    if (!text.startsWith('已发送附件：')) continue;
    const json = text.match(/\{[\s\S]*\}/);
    if (!json) continue;
    let data;
    try { data = JSON.parse(json[0]); } catch { continue; }
    if (data?.sent !== true || typeof data.path !== 'string') continue;
    try {
      const absolute = await checkedPath(binding.workspacePath, data.path);
      if (!(await lstat(absolute)).isFile()) continue;
      return { name: data.path.split('/').pop(), path: data.path, kind: data.kind || 'file' };
    } catch { continue; }
  }
  return null;
}

export async function quoteFromStore(binding, parentId, { fetchAttachment } = {}) {
  const stored = binding.store.getAnyMessageByFeishuId?.(parentId);
  if (!stored) {
    // 消息本身不在历史库，但它可能是机器人发出去的附件（发送记录按 id 可反查）
    const sent = await resolveSentAttachment(binding, parentId);
    return sent ? `\n[用户引用的是机器人此前发送的文件]${guidanceFor([sent])}` : '';
  }
  const session = binding.store.getSession(stored.sessionId);
  if (session?.chatId !== binding.chatId) return '';  // 同用户跨聊天的引用不注入
  const text = String(stored.text || '');
  const body = truncateQuote(text);
  if (!body) return '';
  const who = stored.role === 'assistant' ? '（即机器人此前的回复）' : '';
  const head = `\n[用户引用的消息${who}]：${body}`;
  // 非附件消息：纯文本引用
  if (!ATTACH_MARKER.test(text)) return head;
  // 附件已在工作区：直接给路径
  const local = resolveQuotedAttachments(binding, text);
  if (local.length) return `${head}${guidanceFor(local)}`;
  // 附件消息但本地没有文件（如早于附件功能上线）：现场回拉
  if (fetchAttachment) {
    const fetched = await fetchAttachment(parentId).catch(() => null);
    if (fetched) return `${head}${guidanceFor([fetched])}`;
  }
  const name = (text.match(/(?:file|image|video|audio)\s+"([^"]+)"/) || [])[1];
  return `${head}${resendHint(name)}`;
}

export async function quoteFromApi(client, parentId, { fetchAttachment, binding } = {}) {
  try {
    const data = await client.getMessage(parentId);
    const item = data?.items?.[0];
    const raw = item?.body?.content;
    if (typeof raw !== 'string') return '';
    let text = '';
    try {
      const content = JSON.parse(raw);
      if (item.msg_type && item.msg_type !== 'text' && item.msg_type !== 'post') {
        // 机器人自己发出去的附件：文件本来就在工作区，直接给路径，不必回拉
        if (binding) {
          const sent = await resolveSentAttachment(binding, parentId);
          if (sent) return `\n[用户引用的是机器人此前发送的文件]${guidanceFor([sent])}`;
        }
        // 历史库没有的老附件消息：现场回拉飞书资源
        if (fetchAttachment) {
          const fetched = await fetchAttachment(parentId, item).catch(() => null);
          if (fetched) return `\n[用户引用的是一条附件消息，文件已现场取回]${guidanceFor([fetched])}`;
        }
        const name = typeof content.file_name === 'string' ? content.file_name : '';
        return resendHint(name);
      }
      text = typeof content.text === 'string' ? content.text : (typeof content.title === 'string' ? content.title : '');
    } catch { text = raw; }
    const body = truncateQuote(text);
    return body ? `\n[用户引用的消息]：${body}` : '';
  } catch { return ''; }
}
