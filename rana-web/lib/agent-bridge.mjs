/**
 * agent-bridge.mjs — 专用会话桥接脚本（study / fate / life）的共享实现（Node 侧）。
 *
 * [2026-11-14 收拢批1] 实体（runAgentBridge / DEFAULT_WAIT_MS）已逐字迁入
 * lib/cli-bridge.mjs（边车 .mjs 世界与插件 .ts 世界共用的单一真相源），
 * 本文件退化为路径兼容薄封装：study-agent / fate-agent / life-agent 三边车调用点零改动。
 *
 * 输出契约（stdout 一行 JSON）：
 *   {ok:true, reply:"她的最终回复", data:{解析出的json} | null} 或 {ok:false, error:"原因"}
 */
export { runAgentBridge, DEFAULT_WAIT_MS } from "./cli-bridge.mjs";
