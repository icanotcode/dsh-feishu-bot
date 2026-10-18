// 引用补全：飞书引用回复只带 parent_id。优先查本聊天历史库（含机器人自己的回复），
// 未命中再走开放平台 API 兜底（机器人上线前的消息）。补全失败不阻塞主流程。
//
// 智能截断：≤2000 字全留（多数消息完整呈现）；超长取头 1500 + 尾 500，
// 保留开头的论点与结尾的结论，中间省略并标注字数。
//
// 附件引用：被引消息若含附件，先查同聊天的「附件接收记录」拿工作区路径；
// 本地没有（如消息早于附件功能上线）时经 fetchAttachment 现场回拉飞书资源落盘，
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

export async function quoteFromStore(binding, parentId, { fetchAttachment } = {}) {
  const stored = binding.store.getAnyMessageByFeishuId?.(parentId);
  if (!stored) return '';
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

export async function quoteFromApi(client, parentId, { fetchAttachment } = {}) {
  try {
    const data = await client.getMessage(parentId);
    const item = data?.items?.[0];
    const raw = item?.body?.content;
    if (typeof raw !== 'string') return '';
    let text = '';
    try {
      const content = JSON.parse(raw);
      if (item.msg_type && item.msg_type !== 'text' && item.msg_type !== 'post') {
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
