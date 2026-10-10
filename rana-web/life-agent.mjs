// 人生规划桥接脚本（薄封装）：把规划页发起的请求（目标拆解 / 内容库搜集 / 投喂提炼）送进 Rana 的专用会话，
// 等她干完活，把最终回复连同其中最后一个 ```json 结果块打印到 stdout（一行 JSON）。
// 由 vite.config.ts 的 /__rana/life/* 中间件以子进程方式调用：
//   node life-agent.mjs --message "完整指令文本" [--model "模型id"] [--wait-ms 165000]
// --wait-ms：等 final 的上限，默认 165s；联网搜集场景由中间件传更长的值。
// 实体逻辑见 lib/agent-bridge.mjs（与 study/fate 共用）。
import { runAgentBridge } from "./lib/agent-bridge.mjs";

const SESSION_KEY = "agent:main:life-planner";
const SESSION_LABEL = "🗺 人生规划";
const DEFAULT_WAIT_MS = 165000;

const argv = process.argv.slice(2);
let message = "";
let wantModel = "";
let waitMs = DEFAULT_WAIT_MS;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--message") message = argv[i + 1] ?? "";
  if (argv[i] === "--model") wantModel = argv[i + 1] ?? "";
  if (argv[i] === "--wait-ms") {
    const n = Number(argv[i + 1]);
    if (Number.isFinite(n) && n > 0) waitMs = n;
  }
}

await runAgentBridge({
  sessionKey: SESSION_KEY,
  label: SESSION_LABEL,
  message,
  model: wantModel,
  waitMs,
});
