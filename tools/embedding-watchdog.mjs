#!/usr/bin/env node
// ============================================================================
// embedding 看门狗 —— 死规则：LM Studio 里 qwen3-embedding 恒定恰好一份、纯 CPU 常驻
//
// 背景（详见仓库 KNOWN-ISSUES.md「embedding 模型双实例」条目）：
//   OpenClaw 记忆子系统调 /v1/embeddings 时不带加载参数；模型没加载时 LM Studio
//   会按默认配置（GPU + ctx 8192）自动补一份；与常驻份参数不一致就裂出 ":2" 第二份，
//   各占约 0.6GB 显存。2026-09-11 起反复复发，故设此看门狗锁死。
//
// 规则（任何时刻必须成立，否则自动纠正）：
//   text-embedding-qwen3-embedding-0.6b 恰好 1 份实例，ctx = 32768，GPU offload 关闭。
//   纠正动作 = unload 全部实例 + 用 lms.exe 以纯 CPU 参数重载一份。
//   （实例的 GPU/CPU 属性 API 查不到，靠"重载永远用 --gpu off"保证稳态；
//    JIT 裂出的份 ctx 是 8192，会被 ctx 校验捕获。）
//
// 运行方式：由 rana-web/start-gateway.cmd 随网关一起启动；端口锁防多开。
// 想手动清掉模型：先停看门狗（关网关窗口或 taskkill 本进程），再自己 unload。
//
// 日志：%TEMP%\openclaw\embedding-watchdog.log（只记启动/纠正/不可达/退出，正常轮次不记）
// ============================================================================

import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---- 可调参数（环境变量可覆盖，便于临时调试） --------------------------------
const BASE = process.env.EMBED_WATCHDOG_BASE ?? 'http://127.0.0.1:1234';
const MODEL = process.env.EMBED_WATCHDOG_MODEL ?? 'text-embedding-qwen3-embedding-0.6b';
const STANDARD_CTX = Number(process.env.EMBED_WATCHDOG_CTX ?? 32768);
const INTERVAL_MS = Number(process.env.EMBED_WATCHDOG_INTERVAL_MS ?? 60_000);
const LOCK_PORT = Number(process.env.EMBED_WATCHDOG_LOCK_PORT ?? 47611);
const LMS_BIN = process.env.EMBED_WATCHDOG_LMS ?? 'C:\\Users\\Administrator\\.lmstudio\\bin\\lms.exe';

// ---- 日志 -------------------------------------------------------------------
const LOG_DIR = path.join(os.tmpdir(), 'openclaw');
const LOG_FILE = path.join(LOG_DIR, 'embedding-watchdog.log');
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch { /* 日志失败不致命 */ }
}

// ---- 端口锁：已有看门狗在跑就直接退出 ---------------------------------------
const lock = net.createServer();
lock.once('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    log(`端口 ${LOCK_PORT} 已被占用，已有看门狗实例在跑，本进程退出`);
    process.exit(0);
  }
  log(`端口锁异常 ${e.code}，放弃启动`);
  process.exit(1);
});
lock.listen(LOCK_PORT, '127.0.0.1', main);

// ---- 主循环 -----------------------------------------------------------------
let busy = false;          // 纠正动作进行中，防重入
let lastUnreachable = 0;   // LM Studio 不可达日志限频（10 分钟一条）

async function main() {
  log(`看门狗启动：${MODEL} 目标态=1份 ctx${STANDARD_CTX} 纯CPU，每 ${INTERVAL_MS / 1000}s 巡检一次`);
  await check();
  setInterval(check, INTERVAL_MS);
}

async function check() {
  if (busy) return;
  busy = true;
  try {
    const models = await getLoadedInstances();
    const insts = models ?? [];
    const ok = insts.length === 1
      && insts[0].config?.context_length === STANDARD_CTX;
    if (!ok) {
      log(`偏离目标态（实例数=${insts.length}，各ctx=${insts.map(i => i.config?.context_length ?? '?').join(',')}），开始纠正`);
      await enforce();
      // 纠正后立刻复查，把结果记下来
      const after = await getLoadedInstances();
      log(`纠正完成，复查：实例数=${after?.length ?? 0}，ctx=${(after ?? []).map(i => i.config?.context_length ?? '?').join(',')}`);
    }
  } catch (e) {
    if (e.code === 'ECONNREFUSED' || e.name === 'FetchError' || e.cause?.code === 'ECONNREFUSED') {
      if (Date.now() - lastUnreachable > 10 * 60_000) {
        lastUnreachable = Date.now();
        log('LM Studio 不可达（没开？），静默等待下一轮');
      }
    } else {
      log(`巡检异常：${e.message}`);
    }
  } finally {
    busy = false;
  }
}

// 返回该模型当前的 loaded_instances；LM Studio 没开则 throw
async function getLoadedInstances() {
  const res = await fetch(`${BASE}/api/v1/models`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`/api/v1/models HTTP ${res.status}`);
  const data = await res.json();
  const m = (data.models ?? []).find(x => x.type === 'embedding' && x.key === MODEL);
  return m ? m.loaded_instances ?? [] : [];
}

// 纠正：unload 全部 + 纯 CPU 重载一份
async function enforce() {
  const insts = await getLoadedInstances().catch(() => []);
  for (const inst of insts) {
    try {
      const res = await fetch(`${BASE}/api/v1/models/unload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instance_id: inst.id }),
        signal: AbortSignal.timeout(15_000),
      });
      log(`unload ${inst.id} -> HTTP ${res.status}`);
    } catch (e) {
      log(`unload ${inst.id} 失败：${e.message}`);
    }
  }
  await lmsLoad();
}

function lmsLoad() {
  return new Promise((resolve) => {
    const p = spawn(LMS_BIN, ['load', MODEL, '-c', String(STANDARD_CTX), '--gpu', 'off', '-y'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = '';
    const strip = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '');
    p.stdout.on('data', (d) => { tail = (tail + strip(d.toString())).slice(-300); });
    p.stderr.on('data', (d) => { tail = (tail + strip(d.toString())).slice(-300); });
    const timer = setTimeout(() => { log('lms load 超时(90s)，放弃本轮'); p.kill(); resolve(); }, 90_000);
    p.on('exit', (code) => {
      clearTimeout(timer);
      log(`lms load 退出码=${code} 输出尾部: ${tail.replace(/\n+/g, ' | ').trim()}`);
      resolve();
    });
  });
}

// ---- 退出 -------------------------------------------------------------------
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log('看门狗退出');
    process.exit(0);
  });
}
