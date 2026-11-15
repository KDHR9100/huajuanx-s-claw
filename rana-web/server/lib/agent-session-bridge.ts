// 专用会话桥三胞胎收拢（2026-11-06 第二波①号）：fate/life/study 三插件各自手抄
// 「spawn 边车 + agentBusy 互斥 + 尾行 JSON 解析」，连错误话术都逐字一样。
//
// [2026-11-14 收拢批1] 实体（createAgentBridge / AgentBridgeReply）已逐字迁入
// lib/cli-bridge.mjs（边车 .mjs 世界与插件 .ts 世界共用的单一真相源），
// 本文件退化为路径兼容薄封装：fate / life / study 三插件调用点零改动。
export { createAgentBridge } from "../../lib/cli-bridge.mjs";
export type { AgentBridgeReply } from "../../lib/cli-bridge.mjs";
