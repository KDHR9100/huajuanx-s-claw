#!/usr/bin/env node
/**
 * git-activity-cron.mjs — git 统计直跑任务的 cron 包装：跑统计 → 落盘 → 推送 QQ 私聊
 *
 * 用法：node git-activity-cron.mjs --period=today|week|month --out=<报告文件> [--notify=qqbot:c2c:<openid>]
 *
 * 设计要点：
 *  - --notify 目标串由 cron 任务的 argv 传入（任务存 state 库，不进公开 git）；
 *  - 推送走 `openclaw message send` CLI（node 直调 openclaw.mjs，不经 shell、不经任何模型）；
 *  - ⚠ CLI 长消息 bug：实测 850 字整包发送必炸（outLog.debug is not a function，上游问题），
 *    故按行切成 ~350 字的分段顺序发送（段间 400ms 保序），首段带（x/y）标记；
 *  - 统计失败 → 退出码非零（任务标失败）；推送失败 → 仅告警不判失败（报告仍已落盘）。
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const OPENCLAW_MJS = "C:/Users/Administrator/AppData/Roaming/npm/node_modules/openclaw/openclaw.mjs";
const CHUNK_LIMIT = 350;
const here = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const period = argv.find((a) => a.startsWith("--period="))?.slice(9) || "today";
const out = argv.find((a) => a.startsWith("--out="))?.slice(6);
const notify = argv.find((a) => a.startsWith("--notify="))?.slice(9);

/** 按行切成 ≤CHUNK_LIMIT 的段；超长单行硬切 */
function chunkReport(text) {
  const lines = text.split("\n");
  const chunks = [];
  let cur = [];
  let curLen = 0;
  for (const line of lines) {
    let rest = line;
    // 超长单行先硬切完
    while (rest.length > CHUNK_LIMIT) {
      if (curLen > 0) { chunks.push(cur.join("\n")); cur = []; curLen = 0; }
      chunks.push(rest.slice(0, CHUNK_LIMIT));
      rest = rest.slice(CHUNK_LIMIT);
    }
    const add = rest.length + (curLen > 0 ? 1 : 0);
    if (curLen + add > CHUNK_LIMIT && curLen > 0) {
      chunks.push(cur.join("\n"));
      cur = [];
      curLen = 0;
    }
    cur.push(rest);
    curLen += rest.length + 1;
  }
  if (cur.length) chunks.push(cur.join("\n"));
  // 只有一段就不加序号；多段给每段头部加（x/y）
  if (chunks.length <= 1) return chunks;
  return chunks.map((c, i) => `（${i + 1}/${chunks.length}）\n${c}`);
}

function sendChunk(channel, target, message) {
  return new Promise((resolve) => {
    const send = spawn(
      process.execPath,
      [OPENCLAW_MJS, "message", "send", "--channel", channel, "--target", target, "--message", message],
      { stdio: ["ignore", "inherit", "inherit"] }
    );
    send.on("close", (c) => resolve(c));
    send.on("error", (e) => { console.error(`推送子进程启动失败: ${e.message}`); resolve(1); });
  });
}

const child = spawn(
  process.execPath,
  [path.join(here, "git-activity.mjs"), `--period=${period}`, ...(out ? [`--out=${out}`] : [])],
  { stdio: ["ignore", "pipe", "inherit"] }
);

let report = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (d) => (report += d));

child.on("close", async (code) => {
  report = report.trim();
  if (code !== 0) {
    console.error(`统计脚本退出码 ${code}`);
    process.exit(code || 1);
  }
  console.log(report);

  if (!notify) return;
  const channel = notify.split(":")[0];
  const chunks = chunkReport(report);
  let failed = 0;
  for (const [i, c] of chunks.entries()) {
    const rc = await sendChunk(channel, notify, c);
    if (rc !== 0) { failed++; console.error(`⚠ 第 ${i + 1}/${chunks.length} 段推送失败（退出码 ${rc}）`); }
    await new Promise((r) => setTimeout(r, 400));
  }
  if (failed) console.error(`⚠ 共 ${failed}/${chunks.length} 段推送失败；报告已落盘 ${out || "（未指定 --out）"}`);
});
