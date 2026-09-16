// Only resource keys carried by the authenticated source message may be downloaded.
// Message text, filenames, links and attachment contents remain untrusted user data.
export function parseFeishuMessage(event) {
  const { message, sender } = event || {};
  if (!message || !sender) return null;
  const msgType = message.message_type;
  let content;
  try { content = JSON.parse(message.content); }
  catch { content = msgType === 'text' ? { text: message.content || '' } : {}; }
  if (!content || typeof content !== 'object' || Array.isArray(content)) content = {};
  const attachments = [];
  const texts = [];
  let attachmentError;
  function resource(kind, key, filename, extra = {}) {
    if (typeof key !== 'string' || !key || key.length > 2048 || /[\x00-\x1f\x7f]/.test(key)) {
      attachmentError = '附件消息缺少有效的资源标识，请重新发送原始文件。'; return;
    }
    if (attachments.length >= 10) { attachmentError = '一条消息最多接收 10 个附件，请分开发送。'; return; }
    if (attachments.some(item => item.key === key)) return;
    attachments.push({ kind, key, filename: typeof filename === 'string' ? filename.slice(0, 240) : '', ...extra });
  }
  function video(node) {
    resource('video', node.file_key, node.file_name || 'video.mp4');
    if (node.image_key) resource('image', node.image_key, 'video-cover.jpg', { cover: true });
  }
  if (msgType === 'text') {
    if (typeof content.text !== 'string') return null;
    texts.push(content.text);
  } else if (msgType === 'image') resource('image', content.image_key, 'image');
  else if (msgType === 'file') resource('file', content.file_key, content.file_name || 'attachment');
  else if (msgType === 'audio') resource('audio', content.file_key, content.file_name || 'audio.opus');
  else if (msgType === 'media') video(content);
  else if (msgType === 'post') {
    const post = Array.isArray(content.content) ? content : content.zh_cn || content.en_us || Object.values(content).find(value => Array.isArray(value?.content));
    if (typeof post?.title === 'string') texts.push(post.title);
    for (const row of Array.isArray(post?.content) ? post.content : []) {
      if (!Array.isArray(row)) continue;
      const line = [];
      for (const node of row) {
        if (!node || typeof node !== 'object') continue;
        if (['text', 'a'].includes(node.tag) && typeof node.text === 'string') line.push(node.text);
        if (node.tag === 'a' && typeof node.href === 'string') line.push(` (${node.href})`);
        if (node.tag === 'img') resource('image', node.image_key, 'image');
        if (node.tag === 'media') video(node);
      }
      texts.push(line.join(''));
    }
    if (!texts.some(Boolean) && !attachments.length && !attachmentError) attachmentError = '这条富文本消息没有可读取的正文或附件。';
  } else {
    attachmentError = '暂不支持这种消息。请直接发送文字、图片、文件、音频或视频，不要使用合并转发或表情包。';
  }
  let userText = texts.filter(Boolean).join('\n');
  if (message.chat_type === 'group' && Array.isArray(message.mentions)) {
    for (const mention of message.mentions) if (typeof mention?.key === 'string' && mention.key) userText = userText.split(mention.key).join('').trim();
  }
  if (attachments.length) userText += `${userText ? '\n' : ''}[收到附件：${attachments.map(item => `${item.kind} ${JSON.stringify(item.filename)}`).join('；')}]`;
  if (attachmentError) userText += `${userText ? '\n' : ''}[附件未接收：${attachmentError}]`;
  return {
    chatType: message.chat_type || '', messageId: message.message_id || '', chatId: message.chat_id || '', senderId: sender.sender_id?.open_id || '',
    timestamp: /^\d+$/.test(String(message.create_time || '')) && Number.isFinite(new Date(Number(message.create_time)).getTime())
      ? new Date(Number(message.create_time)).toISOString() : new Date().toISOString(),
    userText, msgType: msgType || '', content, sender,
    ...(attachments.length ? { attachments } : {}), ...(attachmentError ? { attachmentError } : {}),
  };
}
