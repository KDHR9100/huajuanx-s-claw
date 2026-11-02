// 自检：不依赖 SnowLuma，直接验证「文本格式化 → CLI 跑一轮 → 回复解析」。
// 用法：node rana-web/qq-sidecar/selftest.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AgentRunner, resolveOpenclawMjs } from './runner.mjs';
import { splitText, stripMarkdown } from './text.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(
  fs.readFileSync(path.join(HERE, 'config.json'), 'utf8').replace(/^\uFEFF/, ''),
);

const runner = new AgentRunner({
  agent: cfg.openclaw.agent,
  mjsPath: cfg.openclaw.mjsPath,
  stateDir: cfg.openclaw.stateDir,
  timeoutSeconds: 60,
});

const sessionKey = 'qq:selftest';

const started = Date.now();
const { text, runId } = await runner.run({
  sessionKey,
  message: '自检：请只回复四个字「自检通过」，不要调用任何工具。',
  timeoutSeconds: 60,
});
console.log(`runId=${runId} 用时=${Date.now() - started}ms`);
console.log(`原始回复: ${JSON.stringify(text)}`);
const reply = stripMarkdown(text);
console.log(`清洗后: ${JSON.stringify(reply)}，分条=${JSON.stringify(splitText(reply, 500))}`);

// 清理自检会话
try {
  const mjs = resolveOpenclawMjs(cfg.openclaw.mjsPath);
  execFileSync(process.execPath, [
    mjs, 'sessions', 'delete',
    '--agent', cfg.openclaw.agent,
    '--yes', `agent:${cfg.openclaw.agent}:${sessionKey}`,
  ], { env: { ...process.env, OPENCLAW_STATE_DIR: cfg.openclaw.stateDir }, stdio: 'ignore' });
  console.log('自检会话已清理');
} catch (error) {
  console.log(`自检会话清理失败（可忽略）：${error?.message ?? error}`);
}
