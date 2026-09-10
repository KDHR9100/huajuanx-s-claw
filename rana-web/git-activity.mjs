#!/usr/bin/env node
/**
 * git-activity.mjs — Git 活动统计（供 Rana 定时汇报"今天/本周/本月干了什么"）
 *
 * 用法：node git-activity.mjs --period=today|week|month
 *
 * 口径（与计划书一致）：
 *  - 只统计「已推送」提交：优先 origin/main（本地 remote-tracking 引用，推送后即更新，无需联网）；
 *    仓库从未推送过则退回本地 HEAD，并在报告中标注「含未推送」。
 *  - 边界（本地时区）：today=今日 00:00 起；week=上周一 00:00 ~ 本周一 00:00；month=上月 1 日 00:00 ~ 本月 1 日 00:00。
 *  - 自动提交单独归栏：push-public.cmd / backup-private.cmd 产生的 "sync:" / "backup " 前缀提交
 *    计入「自动同步」，不算实质工作；代表性提交只从实质工作里挑。
 *  - WSL 仓库：UNC 路径直读失败时退回 `wsl -e git -C <posix>`（posix 字段缺省则跳过并标注）。
 *  - 单仓库失败不影响整体：报告里标注 [跳过]。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const execFileP = promisify(execFile);

// ---------- 常量 ----------
const AUTO_PREFIXES = [/^sync:/i, /^backup[\s]/i]; // 自动提交特征（push-public / backup-private）
const MAX_TITLE_COMMITS = 5; // 每仓库最多列几条代表性提交
const REPOS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "git-activity.repos.json");

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const periodArg = argv.find((a) => a.startsWith("--period="))?.slice(9) || "today";
if (!["today", "week", "month"].includes(periodArg)) {
  console.error(`未知 --period=${periodArg}（可用 today|week|month）`);
  process.exit(2);
}

// ---------- 时间边界（本地时区） ----------
function periodRange(period, now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth(); // 0-based
  if (period === "today") {
    const start = new Date(y, m, now.getDate());
    return { start, end: new Date(y, m, now.getDate() + 1) };
  }
  if (period === "week") {
    // 本周一 00:00 为终点；往前 7 天为起点（= 上周一 00:00）
    const dow = (now.getDay() + 6) % 7; // 周一=0 ... 周日=6
    const thisMonday = new Date(y, m, now.getDate() - dow);
    return { start: new Date(thisMonday.getTime() - 7 * 864e5), end: thisMonday };
  }
  // month：上月 1 日 00:00 ~ 本月 1 日 00:00
  return { start: new Date(y, m - 1, 1), end: new Date(y, m, 1) };
}

const { start, end } = periodRange(periodArg);
const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const PERIOD_LABEL = { today: "今日", week: "上周", month: "上月" }[periodArg];

// ---------- 工具 ----------
function isAutoCommit(subject) {
  return AUTO_PREFIXES.some((re) => re.test(subject));
}

function runGit(args, opts = {}) {
  return execFileP("git", args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
    windowsHide: true,
    ...opts,
  });
}

/** 统计一个仓库。返回 {repo, ok, reason?, stats} */
async function statRepo(repo) {
  try {
    // 1) 确定统计基准：origin/main → 本地 HEAD
    let range = "origin/main";
    let pushedNote = "";
    try {
      await runGit(["-C", repo.path, "rev-parse", "--verify", "-q", "origin/main"]);
    } catch {
      // 从未有 origin/main：退回本地 HEAD
      const head = (await runGit(["-C", repo.path, "rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
      range = head || "HEAD";
      pushedNote = "（该仓库无 origin/main，退回本地分支，可能含未推送提交）";
    }

    // 2) 拉提交记录：hash 日期 标题 + shortstat
    //    用 %x01 分隔字段，--shortstat 的统计行接在每条正文后（git 默认行为）
    const logArgs = [
      "-C", repo.path,
      "-c", "i18n.logOutputEncoding=utf-8",
      "log", range,
      `--since=${start.toISOString()}`,
      `--until=${end.toISOString()}`,
      "--pretty=format:%H%x01%ad%x01%s",
      "--date=iso-strict",
      "--shortstat",
    ];
    let out;
    try {
      out = await runGit(logArgs);
    } catch (e) {
      // WSL UNC 直读失败 → wsl -e git 兜底（路径转 posix）
      if (!repo.wsl) throw e;
      const posix = repo.path.replace(/\\\\wsl(?:\.localhost|\$)\\[^\\]+\\?/, "~/").replace(/\\/g, "/");
      const wslArgs = ["-d", "Ubuntu-22.04", "-e", "git", "-C", posix, "-c", "i18n.logOutputEncoding=utf-8",
        "log", range, `--since=${start.toISOString()}`, `--until=${end.toISOString()}`,
        "--pretty=format:%H%x01%ad%x01%s", "--date=iso-strict", "--shortstat"];
      out = await execFileP("wsl", wslArgs, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 60_000, windowsHide: true });
    }
    if (!out.stdout.trim()) {
      return { repo, ok: true, empty: true, pushedNote };
    }

    // 3) 解析：正文行（含 %x01）与统计行（" 3 files changed, ..."）交替出现
    const commits = [];
    for (const chunk of out.stdout.split("\n\n")) {
      const lines = chunk.split("\n").map((l) => l.trim()).filter(Boolean);
      const mainLine = lines.find((l) => l.includes("\u0001"));
      if (!mainLine) continue;
      const [hash, date, subject] = mainLine.split("\u0001");
      let insertions = 0, deletions = 0;
      const statLine = lines.find((l) => /changed/.test(l));
      if (statLine) {
        const ins = statLine.match(/(\d+) insertion/);
        const del = statLine.match(/(\d+) deletion/);
        insertions = ins ? Number(ins[1]) : 0;
        deletions = del ? Number(del[1]) : 0;
      }
      commits.push({ hash: hash.slice(0, 7), date, subject, insertions, deletions, auto: isAutoCommit(subject) });
    }

    const real = commits.filter((c) => !c.auto);
    const auto = commits.filter((c) => c.auto);
    const sum = (list, k) => list.reduce((a, c) => a + c[k], 0);
    return {
      repo, ok: true, pushedNote,
      stats: {
        total: commits.length,
        realCount: real.length,
        autoCount: auto.length,
        realIns: sum(real, "insertions"),
        realDel: sum(real, "deletions"),
        titles: real.slice(0, MAX_TITLE_COMMITS).map((c) => `- ${c.subject}（${c.date.slice(0, 10)}，+${c.insertions}/-${c.deletions}）`),
      },
    };
  } catch (e) {
    return { repo, ok: false, reason: String(e.message || e).split("\n")[0].slice(0, 120) };
  }
}

// ---------- 主流程 ----------
let repos = [];
try {
  const cfg = JSON.parse(readFileSync(REPOS_FILE, "utf8"));
  repos = cfg.repos || [];
} catch (e) {
  console.error(`读仓库清单失败：${e.message}（${REPOS_FILE}）`);
  process.exit(1);
}

const results = [];
for (const repo of repos) {
  results.push(await statRepo(repo));
}

// ---------- 输出 Markdown ----------
const lines = [];
lines.push(`## Git 活动统计 · ${PERIOD_LABEL}（${fmt(start)} ~ ${fmt(end)}）`);
lines.push("");
lines.push(`> 统计口径：已推送提交（origin/main）；自动同步提交（sync:/backup 前缀）单独计，不算实质工作。`);
lines.push("");

let totalReal = 0, totalAuto = 0, anySkipped = false;
for (const r of results) {
  if (!r.ok) {
    anySkipped = true;
    lines.push(`### ${r.repo.name}`);
    lines.push(`[跳过] 读取失败：${r.reason}`);
    lines.push("");
    continue;
  }
  if (r.empty) {
    lines.push(`### ${r.repo.name}`);
    lines.push(`${PERIOD_LABEL}没有已推送提交。${r.pushedNote}`);
    lines.push("");
    continue;
  }
  const s = r.stats;
  totalReal += s.realCount;
  totalAuto += s.autoCount;
  lines.push(`### ${r.repo.name}`);
  lines.push(`实质工作 **${s.realCount}** 笔（+${s.realIns}/-${s.realDel} 行）${s.autoCount ? `，另有自动同步 ${s.autoCount} 笔` : ""}${r.pushedNote}`);
  if (s.titles.length) lines.push(...s.titles);
  lines.push("");
}

lines.push(`---`);
lines.push(`**合计：实质工作 ${totalReal} 笔，自动同步 ${totalAuto} 笔**（共 ${repos.length} 个仓库${anySkipped ? "，部分跳过" : ""}）`);

console.log(lines.join("\n"));
