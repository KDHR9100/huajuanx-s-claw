/**
 * cli-bridge.mjs 的 TS 侧类型声明（2026-11-14 收拢批1/批2，对齐现有 interface 一字不改）。
 * 插件 .ts 世界经 server/lib/agent-session-bridge.ts 薄封装或本声明直接引用；
 * 边车 .mjs 世界直接 import（无需本声明）。
 */

/** execFile 的 Promise 版（= server/lib/exec.ts 现行实现，重载经 promisify 原样推导：encoding utf8 → string / 缺省 → Buffer） */
export declare const execFileP: import("node:util").PromisifyCustom<typeof import("node:child_process").execFile>;

/** agent-session-bridge.ts 原版回复类型（一字不改） */
export type AgentBridgeReply = { ok: boolean; reply?: string; data?: Record<string, unknown>; error?: string };

/** 状态目录定位（env OPENCLAW_STATE_DIR 优先，缺省回退仓库内布局） */
export declare function resolveStateHome(): string;
/** 模块装载时定好的状态目录（= resolveStateHome() 首次取值，同 rana-config.mjs 的 STATE_HOME） */
export declare const STATE_HOME: string;
/** openclaw.mjs 定位（env OPENCLAW_MJS → npm root -g 探测 → 裸文件名；每进程只探一次） */
export declare function resolveOpenclawMjs(): string;

/** runAgentBridge 等 final 的默认上限（ms） */
export declare const DEFAULT_WAIT_MS: number;
/** qq-sidecar AgentRunner 的 stdout 超限看门（bytes） */
export declare const MAX_OUTPUT_BYTES: number;

/** runCli 解析策略的上下文（close 时的原始结果） */
export interface ParseCtx {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** 解析策略注册表（五套现存口径逐字收录；可任选注入 runCli 的 parse） */
export declare const PARSE: {
  /** 尾行 JSON：取 stdout 最后一行 JSON.parse（agent-session-bridge 三桥口径；坏 JSON 时抛错） */
  lastLineJson: (raw: string) => unknown;
  /** 首{到末}：剥 BOM 裸 parse，失败抓第一个 { 到最后一个 }，再失败回 null（qq-sidecar runner 口径） */
  firstToLastJson: (raw: string) => unknown;
  /** indexOf 截取：从第一个 { 截到末尾再 JSON.parse（health-patrol 口径） */
  indexOfSliceJson: (raw: string) => unknown;
  /** 裸 parse：stdout 原样 JSON.parse（agent-info / provider-config 口径） */
  bareJson: (raw: string) => unknown;
  /** 原文返回：stdout+stderr 拼接去首尾空白（approvals 口径） */
  rawText: (raw: string, ctx: ParseCtx) => string;
};

export interface SpawnCliOpts {
  /** 可执行文件（缺省 process.execPath） */
  command?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  windowsHide?: boolean;
  detached?: boolean;
  stdio?: "pipe" | "ignore" | "inherit";
  /** 拉起后立即 child.unref()（detached fire-and-forget 用） */
  unref?: boolean;
}
export declare function spawnCli(opts: SpawnCliOpts): import("node:child_process").ChildProcess;

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** 硬超时到点 kill 后为 true（错误话术由调用方决定） */
  timedOut: boolean;
  /** parse 策略的产物；未传 parse 或超时时为 null */
  parsed: unknown;
}

export interface RunCliOpts extends SpawnCliOpts {
  /** 硬超时（ms）：到点 child.kill()；0 = 不限时（detached 场景） */
  hardTimeoutMs?: number;
  /** stdout 超限看门（bytes）：超过即 kill；0 = 不看门 */
  maxOutputBytes?: number;
  /** 解析策略（PARSE 五选一或自定义）；null 不解析 */
  parse?: ((raw: string, ctx: ParseCtx) => unknown) | null;
}
export declare function runCli(opts: RunCliOpts): Promise<CliResult>;

/** createAgentBridge 的返回（agent-session-bridge.ts 现有 interface 原样保留：互斥 + 默认 180s + 尾行解析） */
export interface AgentBridge {
  /** 免互斥直跑（原 spawnAgent 等价） */
  spawn: (args: string[], timeoutMs?: number) => Promise<AgentBridgeReply>;
  /** 互斥执行：忙时抛「她正忙着上一个请求，等一下再试」（原 runAgent 等价） */
  run: (args: string[], timeoutMs?: number) => Promise<AgentBridgeReply>;
}
export declare function createAgentBridge(script: string, defaultTimeoutMs?: number): AgentBridge;

export interface RunAgentBridgeOpts {
  /** 常驻会话 key（也是默认目标会话） */
  sessionKey: string;
  /** 常驻会话显示名 */
  label: string;
  /** 要发给她的完整指令文本 */
  message: string;
  /** 这轮指定模型（create / patch 时带上） */
  model?: string;
  /** 用指定会话替代常驻会话（一次性模式） */
  overrideKey?: string;
  /** overrideKey 生效时的会话显示名 */
  overrideLabel?: string;
  /** 干完活删掉本次会话（一次性模式） */
  ephemeral?: boolean;
  /** 发消息前从 tailSourceKey 摘最近 N 轮拼进指令开头 */
  tail?: number;
  /** 摘历史的来源会话（默认同 sessionKey） */
  tailSourceKey?: string;
  /** 等 final 的上限（ms） */
  waitMs?: number;
  /** 握手 scopes */
  scopes?: string[];
}
export declare function runAgentBridge(opts: RunAgentBridgeOpts): Promise<void>;
