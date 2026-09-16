export const NAME_PROMPT = '开始之前，请告诉我你的名字或希望我使用的称呼。例如回复「Alex」或「/name Alex」。确认名字后才能继续对话。';

function candidateName(text) {
  const explicit = text.match(/^(?:\/name\s+|我叫\s*|我的名字是\s*|叫我\s*)(.+)$/iu);
  const name = (explicit?.[1] ?? text).trim();
  if (!name || [...name].length > 100 || !/^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} .·'’_-]*$/u.test(name)) return null;
  if (!explicit && /^(?:你好|您好|hi|hello|确认|是的|是|yes|不|不是|no|不告诉你|不想说|不愿意|跳过|稍后|不知道|谢谢|取消)$/iu.test(name)) return null;
  return name;
}

/** Deterministic admission gate: no model or task may run before confirmation.
 * Pending names are scoped to the chat that proposed them; confirmed profiles
 * belong to the verified platform identity and survive context rotation.
 */
export function nameConfirmationReply(store, candidates, chatId, text) {
  if (store.getProfile()) return null;
  let candidate = candidates.get(chatId);
  if (candidate && text === '确认') {
    store.confirmProfile(candidate);
    candidates.clear();
    return `已确认你的名字是「${candidate}」。之后会使用这个名字命名会话，并保留你的独立历史记录。现在可以发送问题；确认前的问题请重新发送。`;
  }
  // While confirming, only an explicit new name changes the proposal. Ordinary
  // requests keep receiving the same confirmation instead of becoming tasks.
  if (!candidate || /^(?:\/name\s+|我叫|我的名字是|叫我)/iu.test(text)) {
    const proposed = candidateName(text);
    if (proposed) { candidate = proposed; candidates.set(chatId, candidate); }
  }
  return candidate ? `请确认你的名字是「${candidate}」吗？回复「确认」后才能继续；如需修改，请回复「/name 你的名字」。` : NAME_PROMPT;
}
