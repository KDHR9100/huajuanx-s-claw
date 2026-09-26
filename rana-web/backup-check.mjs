#!/usr/bin/env node
/**
 * backup-check.mjs — 私有备份健康自检（backup-private.cmd 的守卫）
 *
 * 判定链（fail-closed，无法确认=失败）：
 *   1. K:\openclaw-backup-run.log 最后一条运行标记（backup start/done/ERROR）：
 *      - 没有/超过 26 小时 → 失败「备份任务没跑」
 *      - 最后是 start 且在 2 小时内 → 备份进行中，本轮跳过（视为正常）
 *      - 最后是 start 且超 2 小时 → 失败「备份中断」
 *   2. 最后是 done / ERROR 时查 git 远端同步：
 *      - origin/main..main 有未推送提交 → 失败「远端落后 N 提交（push 失败）」
 *      - ahead=0 → 正常（中途有 ERROR 但远端已同步也算好）
 *      - git 查询失败 → 失败「无法确认远端状态」
 *
 * 结果写 rana-web/.backup-check/status.json，由 backup-check-alert cron 读取播报。
 * 手动运行：node backup-check.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const LOG = 'K:/openclaw-backup-run.log';
const REPO = 'K:/openclaw-backup';
const GIT = 'G:/Git/cmd/git.exe';
const OUT_DIR = 'K:/OpenClaw/rana-web/.backup-check';
const OUT = path.join(OUT_DIR, 'status.json');
const MAX_AGE_H = 26;
const RUNNING_GRACE_H = 2;

const checkedAt = new Date().toISOString();
let ok = false, reason = '', detail = '';

/* 1) 解析运行日志（混合编码：只依赖 ASCII 关键词与时间戳） */
let lastRun = null;
try {
  const lines = fs.readFileSync(LOG, 'utf8').split(/\r?\n/).filter(Boolean);
  const mark = /^(?:backup start|backup done|ERROR)/;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^\[(\d{4}\/\d{2}\/\d{2})[^\]]*?(\d{1,2}:\d{2}:\d{2}(?:\.\d+)?)\]\s*(.+)$/);
    if (!m || !mark.test(m[3])) continue;
    lastRun = { ts: new Date(`${m[1]} ${m[2]}`), kind: m[3].split(/[: ]/)[0] === 'ERROR' ? 'error' : m[3].slice(0, 12), line: m[3] };
    break;
  }
} catch { /* 日志读不到按没跑过处理 */ }

if (!lastRun || Number.isNaN(lastRun.ts.getTime())) {
  reason = '备份任务没跑过：日志里找不到任何运行记录';
} else {
  const ageH = (Date.now() - lastRun.ts.getTime()) / 3600e3;
  if (ageH > MAX_AGE_H) {
    reason = `备份任务没跑：最后一次运行是 ${Math.round(ageH)} 小时前`;
    detail = `最后记录：${lastRun.line}`;
  } else if (lastRun.kind === 'start') {
    if (ageH <= RUNNING_GRACE_H) {
      ok = true;
      detail = '备份正在运行中，本轮跳过判定';
    } else {
      reason = '备份中断：最后一次记录是 backup start 但迟迟没有结论';
      detail = `最后记录：${lastRun.line}`;
    }
  } else {
    /* 2) done / ERROR 都要查远端同步状态 */
    let ahead = null;
    try {
      ahead = parseInt(
        execFileSync(GIT, ['-C', REPO, 'rev-list', '--count', 'origin/main..main'], { encoding: 'utf8', timeout: 30000 }).trim(),
        10,
      );
    } catch {
      try {
        ahead = parseInt(
          execFileSync('git', ['-C', REPO, 'rev-list', '--count', 'origin/main..main'], { encoding: 'utf8', timeout: 30000 }).trim(),
          10,
        );
      } catch { ahead = null; }
    }
    if (ahead === null) {
      reason = '无法确认远端同步状态（git rev-list 失败），需人工检查';
      detail = `最后记录：${lastRun.line}`;
    } else if (ahead > 0) {
      reason = `本地已备份但远端落后 ${ahead} 个提交（push 失败）`;
      detail = '修复：挂好代理后 git -C K:/openclaw-backup push origin main';
    } else if (lastRun.kind === 'error') {
      ok = true;
      detail = `最后运行有 ERROR 但远端已同步，无需处理（${lastRun.line}）`;
    } else {
      ok = true;
      detail = `最后成功备份：${lastRun.ts.toLocaleString('zh-CN')}；远端已同步`;
    }
  }
}

const status = { ok, reason: reason || undefined, detail: detail || undefined, checkedAt };
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(status, null, 1));
console.log(JSON.stringify(status, null, 1));
process.exit(ok ? 0 : 1);
