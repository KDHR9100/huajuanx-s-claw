// QQ 消息文本化 + 出站格式化（P1 只做纯文本，图片/语音留占位符）。

const PLACEHOLDERS = {
  image: '[图片]',
  record: '[语音]',
  video: '[视频]',
  face: '[表情]',
  mface: '[表情]',
  forward: '[聊天记录]',
  file: '[文件]',
};

/** OneBot v11 的 message 段数组 → 纯文本。 */
export function segmentsToText(message, selfId = null) {
  if (typeof message === 'string') return message;
  if (!Array.isArray(message)) return '';
  const parts = [];
  for (const seg of message) {
    if (!seg || typeof seg !== 'object') continue;
    const data = seg.data ?? {};
    switch (seg.type) {
      case 'text':
        parts.push(String(data.text ?? ''));
        break;
      case 'at':
        // 自己被 @ 时不必重复 QQ 号，交给触发策略判断（P2）；P1 保留语义
        if (String(data.qq ?? '') === String(selfId ?? '')) parts.push('@我');
        else if (data.qq === 'all') parts.push('@全体成员');
        else parts.push(`@${data.name ?? data.qq ?? '某人'}`);
        break;
      case 'reply':
        break;
      case 'image':
      case 'record':
      case 'video':
      case 'face':
      case 'mface':
      case 'forward':
      case 'file':
        parts.push(PLACEHOLDERS[seg.type] ?? '');
        break;
      default:
        break;
    }
  }
  return parts.join('').trim();
}

/** 群/私聊消息 → 投给 agent 的一行上下文。 */
export function formatIncoming(event, selfId) {
  const body = segmentsToText(event.message, selfId ?? event.self_id);
  const sender = event.sender ?? {};
  const name = sender.card || sender.nickname || String(event.user_id ?? '');
  const qq = String(event.user_id ?? '');
  if (event.message_type === 'group') {
    return `[QQ群 ${event.group_id}] ${name}(${qq})：${body}`;
  }
  return `[QQ私聊] ${name}(${qq})：${body}`;
}

/** 把 markdown 降级成 QQ 里不难看的纯文本。 */
export function stripMarkdown(input) {
  let text = String(input ?? '');
  text = text.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code) => code.trim());
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  text = text.replace(/^#{1,6}\s+/gm, '');
  text = text.replace(/^\s*[-*+]\s+/gm, '· ');
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
  text = text.replace(/__([^_]+)__/g, '$1');
  text = text.replace(/`([^`]+)`/g, '$1');
  return text.trim();
}

/** 长回复按段落/句号切成多条，避免刷屏或触发长度限制。 */
export function splitText(input, maxChars = 500) {
  const text = String(input ?? '').trim();
  if (!text) return [];
  if (text.length <= maxChars) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf('\n', maxChars);
    if (cut < maxChars * 0.5) cut = rest.lastIndexOf('。', maxChars);
    if (cut < maxChars * 0.5) cut = maxChars;
    else cut += 1;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks.filter(Boolean);
}
