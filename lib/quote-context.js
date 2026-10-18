// 引用补全：飞书引用回复只带 parent_id。优先查本聊天历史库（含机器人自己的回复），
// 未命中再走开放平台 API 兜底（机器人上线前的消息）。补全失败不阻塞主流程。
const QUOTE_CAP = 500;

export function quoteFromStore(binding, parentId) {
  const stored = binding.store.getAnyMessageByFeishuId?.(parentId);
  if (!stored) return '';
  const session = binding.store.getSession(stored.sessionId);
  if (session?.chatId !== binding.chatId) return '';  // 同用户跨聊天的引用不注入
  const text = String(stored.text || '');
  const who = stored.role === 'assistant' ? '（即机器人此前的回复）' : '';
  return `\n[用户引用的消息${who}]：${text.slice(0, QUOTE_CAP)}${text.length > QUOTE_CAP ? '…' : ''}`;
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
    if (!text) return '';
    return `\n[用户引用的消息]：${text.slice(0, QUOTE_CAP)}${text.length > QUOTE_CAP ? '…' : ''}`;
  } catch { return ''; }
}
