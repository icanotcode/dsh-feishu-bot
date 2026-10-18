// 引用补全：飞书引用回复只带 parent_id。优先查本聊天历史库（含机器人自己的回复），
// 未命中再走开放平台 API 兜底（机器人上线前的消息）。补全失败不阻塞主流程。
//
// 智能截断：≤2000 字全留（多数消息完整呈现）；超长取头 1500 + 尾 500，
// 保留开头的论点与结尾的结论，中间省略并标注字数。
//
// 附件引用：被引消息若含附件，从同聊天的「附件接收记录」note 中解析工作区路径，
// 指引用提取/读图工具读取内容后结合问题回答，而不只是看到一个占位符。

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

function attachmentGuidance(binding, quotedText) {
  const files = resolveQuotedAttachments(binding, quotedText);
  if (!files.length) return '';
  const lines = files.map(f => `  - ${f.name} → 工作区路径 ${f.path}（${f.kind}）`);
  return `\n[引用的附件已在本机工作区，务必读取其内容后再结合用户的问题回答，不要只凭文件名猜测]：\n${lines.join('\n')}\n读取方式：文档（pdf/xlsx/csv/txt/md）用 feishu_workspace_extract_text，图片用 feishu_read_image，其他类型先 feishu_workspace_read 尝试。`;
}

export function quoteFromStore(binding, parentId) {
  const stored = binding.store.getAnyMessageByFeishuId?.(parentId);
  if (!stored) return '';
  const session = binding.store.getSession(stored.sessionId);
  if (session?.chatId !== binding.chatId) return '';  // 同用户跨聊天的引用不注入
  const who = stored.role === 'assistant' ? '（即机器人此前的回复）' : '';
  const body = truncateQuote(stored.text);
  if (!body) return '';
  return `\n[用户引用的消息${who}]：${body}${attachmentGuidance(binding, String(stored.text || ''))}`;
}

export async function quoteFromApi(client, parentId) {
  try {
    const data = await client.getMessage(parentId);
    const item = data?.items?.[0];
    const raw = item?.body?.content;
    if (typeof raw !== 'string') return '';
    let text = '';
    try {
      const content = JSON.parse(raw);
      if (item.msg_type && item.msg_type !== 'text' && item.msg_type !== 'post') {
        const name = typeof content.file_name === 'string' ? content.file_name : '';
        return `\n[用户引用的是一条${item.msg_type}附件消息${name ? `（${name}）` : ''}，该文件未存于工作区；请请用户把文件直接重新发一次]`;
      }
      text = typeof content.text === 'string' ? content.text : (typeof content.title === 'string' ? content.title : '');
    } catch { text = raw; }
    const body = truncateQuote(text);
    return body ? `\n[用户引用的消息]：${body}` : '';
  } catch { return ''; }
}
