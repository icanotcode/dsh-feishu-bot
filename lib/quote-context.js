// 引用补全：飞书引用回复只带 parent_id。优先查本聊天历史库（含机器人自己的回复），
// 未命中再走开放平台 API 兜底（机器人上线前的消息）。补全失败不阻塞主流程。
//
// 智能截断：≤2000 字全留（多数消息完整呈现）；超长取头 1500 + 尾 500，
// 保留开头的论点与结尾的结论，中间省略并标注字数。

const QUOTE_FULL = 2000;
const QUOTE_HEAD = 1500;
const QUOTE_TAIL = 500;

export function truncateQuote(text) {
  const value = String(text ?? '');
  if (value.length <= QUOTE_FULL) return value;
  const omitted = value.length - QUOTE_HEAD - QUOTE_TAIL;
  return `${value.slice(0, QUOTE_HEAD)}\n……（中间省略 ${omitted} 字）……\n${value.slice(-QUOTE_TAIL)}`;
}

export function quoteFromStore(binding, parentId) {
  const stored = binding.store.getAnyMessageByFeishuId?.(parentId);
  if (!stored) return '';
  const session = binding.store.getSession(stored.sessionId);
  if (session?.chatId !== binding.chatId) return '';  // 同用户跨聊天的引用不注入
  const who = stored.role === 'assistant' ? '（即机器人此前的回复）' : '';
  const body = truncateQuote(stored.text);
  return body ? `\n[用户引用的消息${who}]：${body}` : '';
}

export async function quoteFromApi(client, parentId) {
  try {
    const data = await client.getMessage(parentId);
    const raw = data?.items?.[0]?.body?.content;
    if (typeof raw !== 'string') return '';
    let text = '';
    try {
      const content = JSON.parse(raw);
      text = typeof content.text === 'string' ? content.text : (typeof content.title === 'string' ? content.title : '');
    } catch { text = raw; }
    const body = truncateQuote(text);
    return body ? `\n[用户引用的消息]：${body}` : '';
  } catch { return ''; }
}
