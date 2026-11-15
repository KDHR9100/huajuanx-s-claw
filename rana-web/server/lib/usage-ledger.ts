// 用量账本读写——rana-web/.health/usage-ledger.json（.health/ 已 gitignore，只留本地）。
// 账本是用量页的命门：会话被清理/归档后，agent 库里常规可查的每轮用量就查不到了，
// 账本保证「装好之后」的历史永远在。读=容错读+破损自愈；写=原子写（tmp+rename）。

import { mkdirSync } from "node:fs";
import path from "node:path";
import { readJson, writeJsonAtomic } from "./fs-json";
import { RANA_WEB } from "./paths";
import type { DayBuckets, SessionBuckets } from "./usage-aggregate";

/** 用量账本：每日桶 + 会话桶 + 每 agent 增量水位 */
export interface UsageLedger {
  version: 1;
  /** 是否完成过一次全量建账（false=从未建账，GET 会自动触发重建） */
  built: boolean;
  builtAt: string;
  /** 每 agent 库的增量水位（已计入账本的最大 created_at，毫秒） */
  agents: Record<string, { lastEventTs: number }>;
  days: DayBuckets;
  sessions: SessionBuckets;
}

export const USAGE_LEDGER_FILE = path.join(RANA_WEB, ".health", "usage-ledger.json");

/** 空账（built=false → 下次 GET 自动触发全量建账） */
export function emptyLedger(): UsageLedger {
  return { version: 1, built: false, builtAt: "", agents: {}, days: {}, sessions: {} };
}

/** 读账本；不存在/版本不认/形状破损 → 空账（自愈） */
export function readLedger(): UsageLedger {
  const l = readJson<UsageLedger | null>(USAGE_LEDGER_FILE, null);
  if (!l || typeof l !== "object") return emptyLedger();
  if (l.version !== 1 || !l.days || !l.sessions || typeof l.days !== "object" || typeof l.sessions !== "object") {
    return emptyLedger();
  }
  return { ...emptyLedger(), ...l, days: l.days, sessions: l.sessions };
}

/** 原子写账本（自动建 .health 目录） */
export function writeLedger(l: UsageLedger): void {
  l.builtAt = new Date().toISOString();
  mkdirSync(path.dirname(USAGE_LEDGER_FILE), { recursive: true });
  writeJsonAtomic(USAGE_LEDGER_FILE, l);
}
