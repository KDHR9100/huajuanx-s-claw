// 专用会话桥三胞胎收拢（2026-11-06 第二波①号）：fate/life/study 三插件各自手抄
// 「spawn 边车 + agentBusy 互斥 + 尾行 JSON 解析」，连错误话术都逐字一样。
// 工厂收拢互斥与执行；差异只在 args 组装与超时，由各插件注入。三个边车契约（agent-bridge.mjs）不动。
import { execFileP } from "./exec";

export type AgentBridgeReply = { ok: boolean; reply?: string; data?: Record<string, unknown>; error?: string };

/**
 * 造一个「她一次只干一件事」的 agent 会话桥。
 * spawn/run 都吃 args 数组与可选超时覆盖；默认 180s（与原手抄一致）。
 */
export function createAgentBridge(script: string, defaultTimeoutMs = 180000) {
  let busy = false;

  const spawnOnce = async (args: string[], timeoutMs?: number): Promise<AgentBridgeReply> => {
    const { stdout } = await execFileP(process.execPath, [script, ...args], {
      encoding: "utf8",
      timeout: timeoutMs ?? defaultTimeoutMs,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    return JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
  };

  return {
    /** 免互斥直跑（原 spawnAgent 等价） */
    spawn: spawnOnce,
    /** 互斥执行：忙时抛「她正忙着上一个请求，等一下再试」（原 runAgent 等价） */
    async run(args: string[], timeoutMs?: number): Promise<AgentBridgeReply> {
      if (busy) throw new Error("她正忙着上一个请求，等一下再试");
      busy = true;
      try {
        return await spawnOnce(args, timeoutMs);
      } finally {
        busy = false;
      }
    }
  };
}
