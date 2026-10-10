import fs from "node:fs";
import { OPENCLAW_CONFIG } from "./paths";

export interface ModelEntry {
  id: string;
  name?: string;
  contextWindow?: number;
  params?: Record<string, unknown>;
  [k: string]: unknown;
}
export interface ProviderEntry {
  baseUrl?: string;
  /** 明文 key；OpenClaw doctor 会把密钥迁进密钥库，这里会变成 {source,provider,id} 的 SecretRef 引用 */
  apiKey?: string | Record<string, unknown>;
  api?: string;
  models?: ModelEntry[];
  [k: string]: unknown;
}
export type ProvidersMap = Record<string, ProviderEntry>;

export interface FullConfig {
  models?: { providers?: ProvidersMap };
  agents?: {
    defaults?: { model?: { primary?: string }; compaction?: { memoryFlush?: { model?: string } }; models?: Record<string, unknown> };
    entries?: Record<string, { model?: string; utilityModel?: string }>;
  };
  [k: string]: unknown;
}

export function readFullConfig(): FullConfig {
  return JSON.parse(fs.readFileSync(OPENCLAW_CONFIG, "utf8")) as FullConfig;
}

export function maskKey(key?: string | Record<string, unknown>): string {
  if (!key) return "";
  if (typeof key === "string") return key.slice(0, 5) + "…" + key.slice(-4);
  // SecretRef：密钥本体在 OpenClaw 密钥库里，网页侧只能显示引用 id
  const id = String(key.id ?? "");
  return `🔒密钥库(${id.slice(0, 8)}${id.length > 8 ? "…" : ""})`;
}

export function isLocalProvider(p: ProviderEntry): boolean {
  return /\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(p.baseUrl ?? "");
}

/** 引用某 provider 的配置项（默认模型/agent 模型等），删除前检查 */
export function providerReferences(cfg: FullConfig, providerId: string): string[] {
  const refs: string[] = [];
  const prefix = providerId + "/";
  const primary = cfg.agents?.defaults?.model?.primary;
  if (primary?.startsWith(prefix)) refs.push(`默认模型 ${primary}`);
  const flush = cfg.agents?.defaults?.compaction?.memoryFlush?.model;
  if (flush?.startsWith(prefix)) refs.push(`记忆落地模型 ${flush}`);
  for (const [agentId, entry] of Object.entries(cfg.agents?.entries ?? {})) {
    if (entry.model?.startsWith(prefix)) refs.push(`agent ${agentId} 的模型 ${entry.model}`);
    if (entry.utilityModel?.startsWith(prefix)) refs.push(`agent ${agentId} 的 utilityModel`);
  }
  for (const key of Object.keys(cfg.agents?.defaults?.models ?? {})) {
    if (key.startsWith(prefix)) refs.push(`模型别名配置 ${key}`);
  }
  return refs;
}
