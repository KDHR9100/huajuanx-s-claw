// 「🔁 回退重答」纯函数：锚点查找与列表截断。
// 官方 sessions.rewind 只收 user 消息的事件 UUID（且必须在当前活跃路径上），
// 所以她回复气泡的「重答」要锚定到上面最近的一条 user 消息；
// 本机乐观占位 id（local-/pending-/live-/sm-/h-N 兜底）不是服务端事件，不可锚。
import type { ChatMessage } from "./types";

/** 真·服务端事件 UUID（36 位）才能当 rewind 锚点 */
export function isRewindableId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

/** 从 fromIdx（含）往上找最近的 user 消息（rewind 锚点）。
 *  chat.history 行不带事件 id（实锤 2026-11-06），本地 id 是 h-N 兜底形态；
 *  服务端事件 UUID 由 session-edit GET 按 role+前缀+ts 定位返回，所以本地 id 形态不限。 */
export function findRewindAnchor(messages: ChatMessage[], fromIdx: number): ChatMessage | null {
  for (let i = Math.min(fromIdx, messages.length - 1); i >= 0; i--) {
    if (messages[i].role === "user") return messages[i];
  }
  return null;
}

/** 按 id 截断：返回该消息**之前**的全部消息；找不到返回 null（调用方保持原列表不动） */
export function keepBefore(messages: ChatMessage[], msgId: string): ChatMessage[] | null {
  const idx = messages.findIndex((m) => m.id === msgId);
  return idx === -1 ? null : messages.slice(0, idx);
}
