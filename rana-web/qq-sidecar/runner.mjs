// OpenClaw 调用层：用 CLI 跑一轮 agent（P0 已验证可用，token 直连 WS 无 scope）。
//
// 选 CLI 而不是网关 WS 的原因：纯 token 握手拿不到 operator.read/write；
// 设备配对需要人工授权。CLI 复用网关既有鉴权，零配置。
// 代价：每条消息启动一次进程、无流式、无中途打断；P2 需要时再升级。
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

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

/** 把 stdout 里夹杂的日志剥掉，取 JSON 主体（CLI 正常时是纯 JSON）。 */
function parseJsonOutput(raw) {
  const text = raw.replace(/^\uFEFF/, '').trim();
  try {
    return JSON.parse(text);
  } catch {
    // 兜底：抓第一个 { 到最后一个 }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

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
    const mjs = this.mjsPath;
    const args = [
      mjs, 'agent',
      '--agent', this.agent,
      '--session-key', sessionKey,
      '--message', message,
      '--json',
      '--timeout', String(timeoutSeconds ?? this.timeoutSeconds),
    ];
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, {
        env: { ...process.env, OPENCLAW_STATE_DIR: this.stateDir },
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      let killedByTimeout = false;
      const hardTimeout = setTimeout(() => {
        killedByTimeout = true;
        child.kill();
      }, ((timeoutSeconds ?? this.timeoutSeconds) + 30) * 1000);

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
        if (stdout.length > MAX_OUTPUT_BYTES) child.kill();
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.on('error', (error) => {
        clearTimeout(hardTimeout);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(hardTimeout);
        if (killedByTimeout) {
          reject(new Error(`agent 运行超时（${timeoutSeconds ?? this.timeoutSeconds}s）`));
          return;
        }
        const payload = parseJsonOutput(stdout);
        if (code !== 0 || !payload || payload.status !== 'ok') {
          const detail = stderr.trim().split('\n').slice(-3).join(' | ') || `exit=${code}`;
          reject(new Error(`agent 运行失败: ${detail}`));
          return;
        }
        resolve({ text: extractReply(payload), runId: payload.runId });
      });
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
