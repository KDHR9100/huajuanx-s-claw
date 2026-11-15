// OpenClaw 调用层：用 CLI 跑一轮 agent（P0 已验证可用，token 直连 WS 无 scope）。
//
// 选 CLI 而不是网关 WS 的原因：纯 token 握手拿不到 operator.read/write；
// 设备配对需要人工授权。CLI 复用网关既有鉴权，零配置。
// 代价：每条消息启动一次进程、无流式、无中途打断；P2 需要时再升级。
//
// [2026-11-14 收拢批1] AgentRunner 的 spawn/硬超时/4MB 看门/首{到末}兜底解析迁到
// lib/cli-bridge.mjs 的 runCli（全部作策略参数注入，run() 调用方签名不变）。
// resolveOpenclawMjs 语义与桥版不等价（explicit 参数优先/APPDATA 猜测/失败抛错 vs 裸名兜底），
// 按「宁缺勿歪」保留本地实现，未收编。
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { runCli, PARSE, MAX_OUTPUT_BYTES } from '../lib/cli-bridge.mjs';

/**
 * 定位全局 openclaw 入口。
 * Windows 上直接 spawn npm.cmd 会报 EINVAL，所以先走 APPDATA 推导，
 * 推导不到才退回 shell 执行 `npm root -g`。
 */
export function resolveOpenclawMjs(explicit) {
  if (explicit) return explicit;
  if (process.platform === 'win32' && process.env.APPDATA) {
    const guess = path.join(process.env.APPDATA, 'npm', 'node_modules', 'openclaw', 'openclaw.mjs');
    if (fs.existsSync(guess)) return guess;
  }
  const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
  return path.join(root, 'openclaw', 'openclaw.mjs');
}

// [2026-11-14 收拢批1] 原 parseJsonOutput（首{到末}兜底解析）逐字迁入 lib/cli-bridge.mjs 的
// PARSE.firstToLastJson，本文件经由 runCli 的 parse 策略参数注入使用。

function extractReply(payload) {
  const result = payload?.result ?? {};
  const texts = Array.isArray(result.payloads)
    ? result.payloads.map((p) => (typeof p?.text === 'string' ? p.text : '')).filter(Boolean)
    : [];
  if (texts.length) return texts.join('\n').trim();
  const terminal = result.meta?.terminalReply?.text;
  return typeof terminal === 'string' ? terminal.trim() : '';
}

export class AgentRunner {
  constructor({ agent, mjsPath, stateDir, timeoutSeconds = 300, log = console.log }) {
    this.agent = agent;
    this.mjsPath = resolveOpenclawMjs(mjsPath);
    this.stateDir = stateDir;
    this.timeoutSeconds = timeoutSeconds;
    this.log = log;
  }

  /**
   * 跑一轮，返回 { text, runId }。失败抛错（由调用方决定是否告知群）。
   * @param {{sessionKey:string, message:string, timeoutSeconds?:number}} opts
   */
  run({ sessionKey, message, timeoutSeconds }) {
    const t = timeoutSeconds ?? this.timeoutSeconds;
    const args = [
      this.mjsPath, 'agent',
      '--agent', this.agent,
      '--session-key', sessionKey,
      '--message', message,
      '--json',
      '--timeout', String(t),
    ];
    // spawn + (t+30)s 硬超时 + 4MB 看门 + 首{到末}兜底解析：全部是桥的策略参数；错误话术与状态校验留本类
    return runCli({
      command: process.execPath,
      args,
      env: { ...process.env, OPENCLAW_STATE_DIR: this.stateDir },
      windowsHide: true,
      hardTimeoutMs: (t + 30) * 1000,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      parse: PARSE.firstToLastJson,
    }).then((r) => {
      if (r.timedOut) throw new Error(`agent 运行超时（${t}s）`);
      const payload = r.parsed;
      if (r.code !== 0 || !payload || payload.status !== 'ok') {
        const detail = r.stderr.trim().split('\n').slice(-3).join(' | ') || `exit=${r.code}`;
        throw new Error(`agent 运行失败: ${detail}`);
      }
      return { text: extractReply(payload), runId: payload.runId };
    });
  }
}

/** 同一会话必须串行：并发跑同一 session 会互相抢上下文。 */
export class SerialQueue {
  constructor() {
    this.chains = new Map();
  }

  push(key, task) {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(task, task);
    this.chains.set(key, next.catch(() => {}));
    return next;
  }
}
