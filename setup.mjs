#!/usr/bin/env node
// setup.mjs —— Rana/OpenClaw 开箱初始化（由 setup.cmd 调起，也可直接 node setup.mjs）
// 做四件事：
//   ① 检查 Node 版本（中间件/边车用 node:sqlite，需要 22+）
//   ② 初始化状态目录（openclaw.json + Rana 人格三件套；已存在则跳过，可重复执行）
//   ③ 确认全局 openclaw CLI（缺失则安装）
//   ④ 安装 rana-web 前端依赖
// 状态目录位置：环境变量 OPENCLAW_STATE_DIR 优先，缺省落在仓库内 .openclaw/.openclaw（已 gitignore，不会发布）。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const TPL = path.join(repoRoot, "setup-templates");
const step = (msg) => console.log(`\n[setup] ${msg}`);
const die = (msg) => {
  console.error(`\n[setup][失败] ${msg}`);
  process.exit(1);
};

// ① Node 版本
const major = Number(process.versions.node.split(".")[0]);
if (!(major >= 22)) {
  die(`Node 版本过低（当前 ${process.versions.node}，需要 22 或更高）。请到 https://nodejs.org 下载后重跑本脚本。`);
}

// ② 状态目录与人格初始化
const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(repoRoot, ".openclaw", ".openclaw");
const cfgFile = path.join(stateDir, "openclaw.json");
step(`状态目录：${stateDir}`);
if (fs.existsSync(cfgFile)) {
  console.log("openclaw.json 已存在，跳过初始化（想彻底重来：删掉整个状态目录后再跑本脚本）。");
} else {
  fs.mkdirSync(path.join(stateDir, "workspace-main"), { recursive: true });
  const tpl = JSON.parse(fs.readFileSync(path.join(TPL, "openclaw.template.json"), "utf8"));
  // 网关访问令牌：随机生成，只存在本机配置里，不入 git
  tpl.gateway.auth.token = randomBytes(48).toString("hex");
  // workspace 必须显式指定（openclaw 不自动认领 workspace-main，缺了它 SOUL 人格不会被注入）；
  // 写 setup 时的实际绝对路径（正斜杠——OpenClaw 配置里 Windows 路径一律正斜杠）
  tpl.agents.entries.main.workspace = path.join(stateDir, "workspace-main").replace(/\\/g, "/");
  fs.writeFileSync(cfgFile, JSON.stringify(tpl, null, 2), "utf8");
  // 人格三件套：SOUL（她是谁）/ USER（你是谁）/ MEMORY（她的长期记忆索引）
  const files = [
    ["SOUL.template.md", "SOUL.md"],
    ["USER.template.md", "USER.md"],
    ["MEMORY.template.md", "MEMORY.md"],
  ];
  for (const [src, dest] of files) {
    const target = path.join(stateDir, "workspace-main", dest);
    if (!fs.existsSync(target)) fs.copyFileSync(path.join(TPL, src), target);
  }
  console.log("已生成 openclaw.json（含随机网关令牌）+ Rana 人格文件（workspace-main/SOUL.md 等）。");
}

// ③ openclaw CLI（网关本体）
step("检查 openclaw CLI …");
// 传给 spawn 的都是本文件里的固定字面量，无用户输入，拼整串走 shell 是安全的
const run = (cmd, opts = {}) =>
  spawnSync(cmd, { shell: true, encoding: "utf8", windowsHide: true, ...opts });
if (run("openclaw --version").status !== 0) {
  console.log("未检测到 openclaw，开始全局安装（约 1-2 分钟）……");
  const inst = run("npm i -g openclaw", { stdio: "inherit" });
  if (inst.status !== 0) {
    die("openclaw 安装失败。国内网络多为代理问题：先执行 set HTTPS_PROXY=http://127.0.0.1:7897（换成你的代理地址）再重跑。");
  }
}
const ver = run("openclaw --version");
console.log(`openclaw 就绪（${String(ver.stdout).trim() || "已安装"}）。`);

// ④ rana-web 依赖
step("安装 rana-web 依赖（npm install）……");
const ni = run("npm install", { cwd: path.join(repoRoot, "rana-web"), stdio: "inherit" });
if (ni.status !== 0) die("rana-web 依赖安装失败，看上方报错（多为网络/代理问题）。");

console.log(`
========================================================
初始化完成！接下来三步：
  1. 双击 rana-web\\start-rana.cmd（网关 + 页面一起拉起）
  2. 浏览器自动打开 http://localhost:5173
  3. 页面右上角设置 → 云端模型：填 baseUrl / 模型名 / API key
     （任何 OpenAI 兼容接口都行：智谱、阿里百炼、DeepSeek、OpenAI……）
  填完回到聊天页，跟 Rana 说句话试试。
========================================================`);
