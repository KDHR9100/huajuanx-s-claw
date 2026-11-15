/**
 * contract-guard.mjs 的 TS 侧类型声明（2026-11-14 架构体检卡2）。
 * server/lib/contract-guard.ts 门面与单测经本声明引用；边车 .mjs 直接 import 无需声明。
 */

/** 关键字段类型（number 额外要求有限值；object 不含数组/null；array 仅真数组） */
export type GuardFieldType = "string" | "number" | "boolean" | "object" | "array";

/** 单个关键字段契约：key+类型+是否必填（每契约 3-8 个字段的最小集） */
export interface GuardField {
  key: string;
  type: GuardFieldType;
  required?: boolean;
}

/** 守卫结果：通过 = { value: 解析对象, ok: true }；坏数据/缺失 = { value: fallback, ok: false }（guardReadJson 另有 missing 标记文件缺失） */
export interface GuardResult<T> {
  value: T;
  ok: boolean;
  missing?: boolean;
}

/** 校验已解析对象，返回违规描述数组（空=通过）。只报字段名与类型名，不携带数据值 */
export declare function checkFields(data: unknown, fields: readonly GuardField[]): string[];

/** 违规留痕：console.error（[rana-web] 前缀）+ 台账追加到 RANA_WEB/.health/contract-guards.json（原子写，最近 50 条滚动） */
export declare function recordViolation(contract: string, file: string, reasons: readonly string[]): void;

/** 守卫校验一段已读出的文本（news 原文透传场景用）：坏 parse/坏字段 → 留痕+记台账+降级 fallback */
export declare function guardParsedText<T>(opts: { contract: string; file: string; fields: readonly GuardField[]; text: string; fallback: T }): GuardResult<T>;

/** 守卫读整文件：文件缺失/读不动 → 静默 fallback（missing:true，不算违规）；坏数据 → 留痕+记台账+降级 */
export declare function guardReadJson<T>(opts: { contract: string; file: string; fields: readonly GuardField[]; fallback: T }): GuardResult<T>;

/** 违规台账路径：RANA_WEB/.health/contract-guards.json（.health/ 已 gitignore） */
export declare function contractGuardsFile(): string;

/** rana-web 根（env RANA_WEB 优先，与 server/lib/paths.ts 同约定） */
export declare function ranaWebRoot(): string;

/** 卡2 全部契约名（key 拼错编译期即报） */
export type ContractName =
  | "news/report"
  | "health/patrol"
  | "qq/qq-bridge"
  | "sys/home-report"
  | "cloud-sync/home-state"
  | "cloud-sync/cloud-state"
  | "cron/cleanup-status"
  | "backup-check/status";

/** 契约规格表（单源）：8 个读侧契约的关键字段最小集（每契约 3-8 个，qq-bridge/home-report 契约本身只有 2 个键如实收录） */
export declare const CONTRACT_FIELDS: Record<ContractName, readonly GuardField[]>;
