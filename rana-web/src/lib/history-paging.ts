// 聊天页「加载更早」翻页纯函数（2026-11-20 方案A）。
// 背景：chat.history 服务端默认 limit??200 条尾窗，旧消息在库但页面翻不到；
// offset 语义=从最旧记录（seq 1）起跳过的记录数，消息带 __openclaw.seq（1 基升序）。
// 本文件零副作用：gateway.loadHistoryOlder 取数，ChatStream 只管按钮与滚动。
// 协议实查：resolveChatHistoryNextOffset 用 totalMessages - oldestSeq + 1 换算，
// 即 offset 按「记录号」计数，与消息 seq 同一坐标系。

/** 计算下一次「加载更早」的 offset：取锚点（当前最旧一条）之前 limit 条的那一页 */
export function nextOlderOffset(oldestSeq: number, limit = 200): number {
  return Math.max(0, oldestSeq - 1 - limit);
}

export interface PagingMessage {
  id: string;
  seq?: number;
}

/**
 * 合并一页更早消息到现有列表头部：
 * 只保留比锚点（existing[0].seq）更旧的、按 id 去重、按 seq 升序排列。
 * added === 0 即「已经到底」。
 */
export function mergeOlderMessages<T extends PagingMessage>(existing: T[], page: T[]): { merged: T[]; added: number } {
  const anchorSeq = existing[0]?.seq;
  const seen = new Set(existing.map((m) => m.id));
  const older: T[] = [];
  for (const m of page) {
    if (typeof m.seq !== "number" || typeof anchorSeq !== "number" || m.seq >= anchorSeq) continue;
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    older.push(m);
  }
  older.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  return { merged: [...older, ...existing], added: older.length };
}
