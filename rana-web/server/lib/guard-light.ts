/**
 * guard-light.ts — 契约守卫灯（2026-11-15 状态页亮灯接线）
 *
 * 把违规台账 .health/contract-guards.json（lib/contract-guard.mjs 的 recordViolation
 * 写：{ updatedAt, total, recent: [{ at, contract, file, reasons }] }，recent 滚动最近
 * 50 条）翻译成状态页看得见的灯。
 *
 * 纯函数纪律：输入台账原文（parse 后的 unknown）+ now（注入时间，可测确定性），
 * 不读盘、不打日志、零依赖零顶层副作用（11-15 CI 案教训：测试 import 生产模块
 * 不许触发顶层 I/O）。坏形状一律降级绿灯不炸——没证据就是健康，不冤枉。
 *
 * 灯语义（本卡拍板）：
 *   - 台账读不到 / 空 / 坏形状 = 绿（文件首次生成前本就不存在，缺失≠违规）；
 *   - recent 里能认出的违规 ≥ 1 条 = 红，violations 取时间最新的 10 条倒序。
 */
export interface GuardLightViolation {
  /** 契约名（recordViolation 的 contract，如 "health/patrol"） */
  contract: string;
  /** 违规时间（ISO 串原样透传，展示格式前端自定） */
  at: string;
  /** 违规原因串成一行（reasons 用 "; " 连接；不携带数据内容——守卫只记类型名不记值） */
  problem: string;
}
export interface GuardLight {
  lamp: "green" | "red";
  /** 最近 10 条违规（时间倒序）；绿灯恒空 */
  violations: GuardLightViolation[];
  /** 台账累计违规次数（total 烂数字时回退用 recent 条数兜底，不出 NaN） */
  total: number;
}

/** 台账单条 → 灯条目（缺啥补啥，不炸；垃圾条目出空串字段） */
function toViolation(e: Record<string, unknown>): GuardLightViolation {
  const reasons = e.reasons;
  const problem = Array.isArray(reasons)
    ? reasons.filter((r) => typeof r === "string").join("; ")
    : typeof reasons === "string"
      ? reasons
      : "";
  return {
    contract: typeof e.contract === "string" && e.contract ? e.contract : "未知契约",
    at: typeof e.at === "string" ? e.at : "",
    problem,
  };
}

/** 违规时间解析：烂时间戳沉底（0）；未来时间戳按 now 封顶——烂钟记录不按假时间乱窜 */
function violationTime(at: string, now: number): number {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return 0;
  return Math.min(t, Math.max(now, 0));
}

/**
 * 台账原文 → 灯形状。ledger：contract-guards.json parse 后的任意值（含 null/垃圾）；
 * now：当前毫秒（注入以便测试确定性；仅用于时间排序封顶）。
 */
export function guardLight(ledger: unknown, now: number = Date.now()): GuardLight {
  const recent =
    ledger !== null && typeof ledger === "object" && !Array.isArray(ledger)
      ? (ledger as { recent?: unknown }).recent
      : undefined;
  if (!Array.isArray(recent)) return { lamp: "green", violations: [], total: 0 };
  const rows = recent
    .filter((e): e is Record<string, unknown> => e !== null && typeof e === "object" && !Array.isArray(e))
    // 认不出任何违规字段的条目（如 {}）=坏形状，跳过——降级绿灯不冤枉
    .filter(
      (e) =>
        typeof e.contract === "string" ||
        typeof e.at === "string" ||
        Array.isArray(e.reasons) ||
        typeof e.reasons === "string",
    )
    .map(toViolation);
  if (rows.length === 0) return { lamp: "green", violations: [], total: 0 };
  const sorted = [...rows.entries()]
    .sort((a, b) => violationTime(b[1].at, now) - violationTime(a[1].at, now) || a[0] - b[0])
    .map(([, v]) => v);
  const rawTotal = (ledger as { total?: unknown }).total;
  return {
    lamp: "red",
    violations: sorted.slice(0, 10),
    total: typeof rawTotal === "number" && Number.isFinite(rawTotal) ? rawTotal : rows.length,
  };
}
