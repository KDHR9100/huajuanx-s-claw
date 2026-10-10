// 学习计划桥接脚本（薄封装）：把页面发起的请求（排课 / 出题 / 判分）送进 Rana 的专用会话，
// 等她干完活，把最终回复连同其中最后一个 ```json 结果块打印到 stdout（一行 JSON）。
// 由 vite.config.ts 的 /__rana/study/* 中间件以子进程方式调用：
//   node study-agent.mjs --message "完整指令文本" [--model "模型id"]
//     [--session-key "会话key" --ephemeral] [--tail N]
// --model：可选，指定这轮用哪个模型（sessions.patch 到专用会话，粘性生效）。
// --session-key：可选，用指定会话而不是常驻排课会话（配合 --ephemeral 做一次性干净会话）。
// --ephemeral：干完活把这次用的会话删掉，不留在侧栏（一次性模式专用）。
// --tail N：可选，发消息前从常驻会话的历史里摘最近 N 轮对话拼进指令开头（"只带最近几条"用）。
// 实体逻辑见 lib/agent-bridge.mjs（与 fate/life 共用）。
import { runAgentBridge } from "./lib/agent-bridge.mjs";

const SESSION_KEY = "agent:main:study-planner";
const SESSION_LABEL = "📚 学习计划";
const WAIT_FINAL_MS = 165000; // 等 final 的上限（中间件 execFile 超时 180s，留出余量）

const argv = process.argv.slice(2);
let message = "";
let wantModel = "";
let sessionKeyArg = "";
let ephemeral = false;
let tailCount = 0;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--message") message = argv[i + 1] ?? "";
  if (argv[i] === "--model") wantModel = argv[i + 1] ?? "";
  if (argv[i] === "--session-key") sessionKeyArg = argv[i + 1] ?? "";
  if (argv[i] === "--ephemeral") ephemeral = true;
  if (argv[i] === "--tail") tailCount = Number(argv[i + 1]) || 0;
}

await runAgentBridge({
  sessionKey: SESSION_KEY,
  label: SESSION_LABEL,
  message,
  model: wantModel,
  overrideKey: sessionKeyArg,
  overrideLabel: sessionKeyArg
    ? `📖 上课（一次性 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}）`
    : "",
  ephemeral,
  tail: tailCount,
  tailSourceKey: SESSION_KEY,
  waitMs: WAIT_FINAL_MS,
  scopes: ["operator.read", "operator.write", "operator.admin"],
});
