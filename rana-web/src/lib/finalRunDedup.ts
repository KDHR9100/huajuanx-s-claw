// finalRunDedup.ts —— gateway.ts「去重原语」的纯函数提取（测试安全网，锁现行行为）。
//
// 提取来源：rana-web/src/lib/gateway.ts
//   行 125   —— finalRunIds 字段声明（Set<string>）
//   行 546-553 —— rememberFinalRun()：50 条缓存 + 淘汰
//   行 512   —— final 已见判定（onSessionMessage 内）
//   行 520   —— 最近 8 条内容比对（onSessionMessage 内）
// 提取日期：2026-11-14。
// 现行行为语义（三条，与 gateway 内联实现逐字等价）：
//   1) remember(runId)：runId falsy（空串）不入账；add 后若 size>50，
//      删除 Set 插入序最旧一条。注意 JS Set 对已存在值 add 是 no-op、
//      不刷新位置——这是「首次插入序 FIFO」，不是刷新式 LRU。
//   2) hasFinal(runId)：仅当 runId !== undefined 且缓存命中才算已见；
//      空串因 (1) 永不入账、永远不命中。
//   3) isDuplicateOfRecentMessage：取列表最近 8 条，存在
//      role + text + 附件数 三元组全等即判重复；list 不足 8 条时窗口=全表；
//      双方都无附件按 0===0 命中（现行语义，不特判）。
// 采用方式：并行 WIP 落地后由 adoption patch 把 gateway.ts 内联实现替换为
//   调用本模块（本文件零 import，node 测试环境零牵连）。

/** final runId 的 50 条缓存（对应 gateway.ts:125 字段 + 546-553 方法） */
export class FinalRunCache {
  private ids = new Set<string>();

  /** 逐字对应 gateway.ts:546-553 rememberFinalRun（this.finalRunIds → this.ids） */
  remember(runId: string): void {
    if (!runId) return;
    this.ids.add(runId);
    if (this.ids.size > 50) {
      const oldest = this.ids.values().next().value;
      if (oldest !== undefined) this.ids.delete(oldest);
    }
  }

  /** 逐字对应 gateway.ts:512 的 `(p.runId !== undefined && this.finalRunIds.has(p.runId))` */
  hasFinal(runId: string | undefined): boolean {
    return runId !== undefined && this.ids.has(runId);
  }

  /** 测试/断言用：当前缓存条数 */
  get size(): number {
    return this.ids.size;
  }

  /** 测试/断言用：插入序快照（最旧在前） */
  snapshot(): string[] {
    return [...this.ids];
  }
}

/** 判定输入的最小形状：gateway.ts:520 比对只用到 role/text/附件长度 */
interface RecentMsgLike {
  role: string;
  text: string;
  attachments?: unknown[];
}

/** 会话消息是否与最近 8 条内容重复（逐字对应 gateway.ts:520 的 slice(-8).some 判定） */
export function isDuplicateOfRecentMessage(
  list: readonly RecentMsgLike[],
  role: string,
  text: string,
  atts?: readonly unknown[] | null,
): boolean {
  return list.slice(-8).some(
    (m) => m.role === role && m.text === text && (m.attachments?.length ?? 0) === (atts?.length ?? 0),
  );
}
