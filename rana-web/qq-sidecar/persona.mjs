// 「群友感」策略：合并窗口 + 节流 + @/关键词触发 + 潜水概率 + 表情 + 拟人延迟。
//
// 纯函数为主，index.mjs 只负责定时器和 IO，便于单测与调参。
// 原则：她像一个群友，不是客服——连着几条话会攒起来一起想，刚说过话就先歇一会，
// 没被点名时有一定概率只潜水，偶尔带个表情，回复前还有一点点「打字」时间。

export const DEFAULT_PERSONA = {
  /** 同一群里连续消息合并成一轮思考的窗口（毫秒） */
  mergeWindowMs: 3500,
  /** 两次回复之间至少隔多久（毫秒）；被 @/点名时也会等够这个间隔再发 */
  minReplyIntervalMs: 8000,
  /** 被 @我 或命中关键词时必回 */
  atTrigger: true,
  /** 命中任一关键词视为在叫她（不区分大小写） */
  keywordTrigger: ['rana', '乐奈', 'rana酱', '小rana', '拉娜'],
  /** 没被点名时的潜水概率 0~1（0=每条都回） */
  lurkRate: 0.3,
  /** 回复末尾带表情的概率 0~1 */
  emojiRate: 0.35,
  /** 发送前拟人等待：基础 + 每字，封顶（毫秒） */
  typingBaseMs: 500,
  typingPerCharMs: 18,
  typingMaxMs: 3000,
};

const EMOJIS = ['✨', '🐟', '😺', '🫧', '💤', '🌙', '🍰', '🎀', '😹', '👀', '🥺', '🦋'];

/** 合并配置：缺项落默认值，数值做范围收敛。 */
export function normalizePersona(raw = {}) {
  const p = { ...DEFAULT_PERSONA, ...(raw ?? {}) };
  const clamp = (v, min, max) => Math.min(max, Math.max(min, Number(v) || 0));
  p.mergeWindowMs = clamp(p.mergeWindowMs, 0, 60_000);
  p.minReplyIntervalMs = clamp(p.minReplyIntervalMs, 0, 10 * 60_000);
  p.lurkRate = clamp(p.lurkRate, 0, 1);
  p.emojiRate = clamp(p.emojiRate, 0, 1);
  p.typingBaseMs = clamp(p.typingBaseMs, 0, 10_000);
  p.typingPerCharMs = clamp(p.typingPerCharMs, 0, 200);
  p.typingMaxMs = clamp(p.typingMaxMs, 0, 30_000);
  p.keywordTrigger = Array.isArray(p.keywordTrigger)
    ? p.keywordTrigger.map((k) => String(k).trim()).filter(Boolean)
    : [];
  return p;
}

/** 文本里是否在叫她的名字。 */
export function hitsKeyword(text, keywords = DEFAULT_PERSONA.keywordTrigger) {
  const t = String(text ?? '').toLowerCase();
  return keywords.some((k) => k && t.includes(String(k).toLowerCase()));
}

/**
 * 一批消息是否「在跟她说话」：有 @我，或任一文本命中关键词。
 * @全体成员 不算点名（避免群里一喊全体她就冲出来）。
 */
export function isAddressed(items, { atTrigger = true, keywords = [] } = {}) {
  return items.some((it) => (atTrigger && it.atMe) || hitsKeyword(it.text, keywords));
}

/**
 * 是否回应。addressed 一定回（节流由调用方在真正发送前等待）；
 * 否则在冷却期内潜水，冷却期外按 lurkRate 潜水。
 */
export function decideReply({ addressed, lastReplyAt, now, minReplyIntervalMs, lurkRate, random = Math.random }) {
  if (addressed) return { reply: true, reason: 'addressed' };
  if (lastReplyAt && now - lastReplyAt < minReplyIntervalMs) return { reply: false, reason: 'cooldown' };
  if (random() < lurkRate) return { reply: false, reason: 'lurk' };
  return { reply: true, reason: 'chat' };
}

/** 一批消息 → 投给 agent 的一段上下文（多行，保留谁说的）。 */
export function formatBatch(items, groupId) {
  const lines = items.map((it) => `${it.name}(${it.userId})：${it.text}`);
  if (lines.length === 1) return `[QQ群 ${groupId}] ${lines[0]}`;
  return `[QQ群 ${groupId}] 群里最近 ${lines.length} 条消息（按时间顺序）：\n${lines.join('\n')}`;
}

const EMOJI_TAIL = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]$/u;

/** 按概率补一个表情；已有表情结尾就不再叠。 */
export function withEmoji(text, emojiRate = DEFAULT_PERSONA.emojiRate, random = Math.random) {
  const t = String(text ?? '').trim();
  if (!t || random() >= emojiRate || EMOJI_TAIL.test(t)) return t;
  const emoji = EMOJIS[Math.floor(random() * EMOJIS.length)] ?? EMOJIS[0];
  return `${t} ${emoji}`;
}

/** 发送前的拟人等待：像在看着键盘打出来，而不是秒回。 */
export function humanDelayMs(text, cfg = DEFAULT_PERSONA, random = Math.random) {
  const base = Number(cfg.typingBaseMs ?? DEFAULT_PERSONA.typingBaseMs);
  const per = Number(cfg.typingPerCharMs ?? DEFAULT_PERSONA.typingPerCharMs);
  const max = Number(cfg.typingMaxMs ?? DEFAULT_PERSONA.typingMaxMs);
  const len = Math.min(String(text ?? '').length, 400);
  const ms = base + len * per * (0.6 + random() * 0.8);
  return Math.min(max, Math.max(0, Math.round(ms)));
}
