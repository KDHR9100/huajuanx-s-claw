/**
 * contract-guard.mjs — 跨进程文件契约读侧守卫（2026-11-14 架构体检卡2 基建）
 *
 * 背景：边车写→前端读的 JSON「表格」全库零校验；坏 JSON 被 readJson 静默吞，
 * 故障无痕（KNOWN-ISSUES 10-17 案：同款修复漏姊妹脚本，班班必炸两天）。
 *
 * 语义（本卡唯一被批准的行为变化）：
 *   - 文件缺失：不算违规，静默走 fallback（与现状一致——首次生成前文件本就不存在）；
 *   - 坏数据（parse 失败 / 关键字段缺·类型错）：不静默——console 留痕（server-lib json()
 *     同款 [rana-web] 前缀）+ 降级 fallback + 违规记入 rana-web/.health/contract-guards.json
 *     （数据就位即可，状态页亮灯接线列后续）；
 *   - 正常数据零行为变化：守卫通过 = 与原实现结果一致（news 场景原文逐字节透传）。
 *
 * 单源纪律：核心实现在本文件（.mjs），服务端插件（TS）经 server/lib/contract-guard.ts
 * 门面引用，边车脚本（backup-check.mjs 等）直接 import 本文件——两边一个真相，
 * 不重演「同款修复漏姊妹脚本」。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** rana-web 根（env RANA_WEB 优先，与 server/lib/paths.ts 同约定；违规台账挂这里的 .health/） */
export function ranaWebRoot() {
  if (process.env.RANA_WEB) return path.resolve(process.env.RANA_WEB);
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

/** 违规台账路径：RANA_WEB/.health/contract-guards.json（.health/ 已 gitignore） */
export function contractGuardsFile() {
  return path.join(ranaWebRoot(), ".health", "contract-guards.json");
}

/** 字段类型判定（number 额外要求有限值——JSON 里不该出现 Infinity/NaN） */
function typeOk(v, type) {
  switch (type) {
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "boolean":
      return typeof v === "boolean";
    case "object":
      return typeof v === "object" && v !== null && !Array.isArray(v);
    case "array":
      return Array.isArray(v);
    default:
      return false;
  }
}

/** 只报类型名不报值——违规记录/日志不携带数据内容（私密文件不进日志） */
function describe(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/**
 * 校验已解析的 JSON 对象：返回违规描述数组（空数组=通过）。
 * 顶层必须是普通对象（数组/标量按违规处理——全部现存契约都是对象形）。
 * fields：[{ key, type: "string"|"number"|"boolean"|"object"|"array", required? }]
 */
export function checkFields(data, fields) {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return [`顶层应为 JSON 对象，实为 ${describe(data)}`];
  }
  const bad = [];
  for (const f of fields) {
    const v = data[f.key];
    if (v === undefined) {
      if (f.required) bad.push(`缺必填字段 ${f.key}`);
      continue;
    }
    if (!typeOk(v, f.type)) bad.push(`字段 ${f.key} 应为 ${f.type}，实为 ${describe(v)}`);
  }
  return bad;
}

/** 违规留痕：console.error（json() 同款 [rana-web] 前缀）+ 台账追加（tmp+rename 原子写，最近 50 条滚动，尽力而为不抛） */
export function recordViolation(contract, file, reasons) {
  const at = new Date().toISOString();
  console.error(`[rana-web] ${at} contract ${contract} 违规：${reasons.join("; ")}`);
  try {
    const f = contractGuardsFile();
    let ledger = { updatedAt: "", total: 0, recent: [] };
    try {
      ledger = JSON.parse(fs.readFileSync(f, "utf8"));
    } catch {
      /* 首次或旧台账损坏：重新起册（旧册已不可信） */
    }
    ledger.updatedAt = at;
    ledger.total = (Number(ledger.total) || 0) + 1;
    ledger.recent = [
      ...(Array.isArray(ledger.recent) ? ledger.recent : []),
      { at, contract, file: String(file), reasons: reasons.slice(0, 5) },
    ].slice(-50);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(ledger, null, 1), "utf8");
    fs.renameSync(tmp, f);
  } catch (e) {
    console.error(`[rana-web] contract-guards 台账写失败：${e?.message ?? e}`);
  }
}

/**
 * 守卫校验一段已读出的文本（调用方已持有原文时用——如 news 的原文透传场景）。
 * 返回 { value, ok }：通过 = { value: 解析对象, ok: true }；
 * 坏数据 = 守卫留痕+记台账后 { value: fallback, ok: false }。
 */
export function guardParsedText({ contract, file, fields, text, fallback }) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    recordViolation(contract, file, ["不是合法 JSON"]);
    return { value: fallback, ok: false };
  }
  const bad = checkFields(data, fields);
  if (bad.length > 0) {
    recordViolation(contract, file, bad);
    return { value: fallback, ok: false };
  }
  return { value: data, ok: true };
}

/**
 * 守卫读整文件（read→parse→校验）。文件缺失/读不动：静默走 fallback（不算违规，
 * 与 readJson 现状一致）；坏数据：留痕+记台账+降级。返回 { value, ok }。
 */
export function guardReadJson({ contract, file, fields, fallback }) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { value: fallback, ok: false, missing: true };
  }
  return guardParsedText({ contract, file, fields, text, fallback });
}

// ===== 契约规格表（卡2 全部 8 个读侧契约的关键字段最小集；单源——插件 TS 世界与
// 边车 .mjs 世界都从这里取，杜绝「同款修复漏姊妹脚本」式规格漂移）=====
// 字段清单照各写入方实际产物钉死：news-report.mjs / health-patrol.mjs /
// memory-bridge.mjs / sys-status.ts POST / tools/cloud-sync.mjs /
// cron-session-cleanup.mjs / 本文件所在库的 backup-check.mjs。
export const CONTRACT_FIELDS = {
  /** 早报 .news/report.json（news-report.mjs 写，news.ts 读） */
  "news/report": [
    { key: "date", type: "string", required: true },
    { key: "generatedAt", type: "number", required: true },
    { key: "xwlb", type: "array", required: true },
    { key: "sections", type: "array", required: true },
    { key: "summary", type: "string", required: true },
    { key: "summaryError", type: "string" },
    { key: "queries", type: "number" },
  ],
  /** 巡检快照 .health/patrol.json（health-patrol.mjs 写，sys-status.ts 读） */
  "health/patrol": [
    { key: "updatedAt", type: "number", required: true },
    { key: "checks", type: "array", required: true },
    { key: "anomalies", type: "array", required: true },
    { key: "version", type: "number" },
    { key: "sendError", type: "string" },
  ],
  /** 群别名表 shared-memory/qq-bridge.json（memory-bridge.mjs 写，恒保证 groups 对象；qq-profile.ts 读） */
  "qq/qq-bridge": [
    { key: "groups", type: "object", required: true },
    { key: "ownerOpenId", type: "string" },
  ],
  /** 家里探针上报 .health/home-report.json（home-probe.ps1 报文经 sys-status POST 收写，GET 读回） */
  "sys/home-report": [
    { key: "receivedAt", type: "number", required: true },
    { key: "report", type: "object", required: true },
  ],
  /** 家侧拉取记录 .health/home-sync-state.json（tools/cloud-sync.mjs 写，cloud-sync.ts 读；manifest 可为 null 故不验） */
  "cloud-sync/home-state": [
    { key: "lastPullAt", type: "number", required: true },
    { key: "file", type: "string" },
    { key: "bytes", type: "number" },
  ],
  /** 云侧被拉取记录 .health/cloud-sync-state.json（cloud-sync.ts snapshotHandler 写，同文件 GET 读回） */
  "cloud-sync/cloud-state": [
    { key: "lastPullAt", type: "number", required: true },
    { key: "totalBytes", type: "number", required: true },
    { key: "manifest", type: "object", required: true },
  ],
  /** 会话清理进度 %TEMP%/openclaw/cron-session-cleanup.json（cron-session-cleanup.mjs 写，sessions-cleanup.ts 读） */
  "cron/cleanup-status": [
    { key: "running", type: "boolean", required: true },
    { key: "updatedAt", type: "number", required: true },
    { key: "step", type: "string", required: true },
    { key: "dryRun", type: "boolean" },
    { key: "log", type: "array" },
  ],
  /** 备份自检 .backup-check/status.json（backup-check.mjs 写+写后自检；外部 backup-check-alert cron 读） */
  "backup-check/status": [
    { key: "ok", type: "boolean", required: true },
    { key: "checkedAt", type: "string", required: true },
    { key: "reason", type: "string" },
    { key: "detail", type: "string" },
  ],
};
