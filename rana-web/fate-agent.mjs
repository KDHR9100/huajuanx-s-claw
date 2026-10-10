// 问卦桥接脚本（薄封装）：把页面发起的解卦请求送进 Rana 的专用会话，
// 等她干完活，把最终回复连同其中最后一个 ```json 结果块打印到 stdout（一行 JSON）。
// 由 vite.config.ts 的 /__rana/fate/* 中间件以子进程方式调用：
//   node fate-agent.mjs --message "完整指令文本" [--model "模型id"]
// 实体逻辑见 lib/agent-bridge.mjs（与 study/life 共用）。
import { runAgentBridge } from "./lib/agent-bridge.mjs";

const SESSION_KEY = "agent:main:fate-teller";
const SESSION_LABEL = "🔮 问卜";
const WAIT_FINAL_MS = 165000; // 等 final 的上限（中间件 execFile 超时 180s，留出余量）

const argv = process.argv.slice(2);
let message = "";
let wantModel = "";
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--message") message = argv[i + 1] ?? "";
  if (argv[i] === "--model") wantModel = argv[i + 1] ?? "";
}

await runAgentBridge({
  sessionKey: SESSION_KEY,
  label: SESSION_LABEL,
  message,
  model: wantModel,
  waitMs: WAIT_FINAL_MS,
});
