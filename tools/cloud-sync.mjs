#!/usr/bin/env node
/**
 * cloud-sync.mjs — 家里电脑拉取云端快照（迁移批1 同步桥的家侧；跑一次退一次，无常驻）
 *
 * 干什么：向云端 rana-web 要一份「数据快照」（tar.gz：会话库/人格/记忆/凭据，不含插件缓存），
 *         落到 K:\OpenClaw\.migration-sync\cloud-<时间戳>.tar.gz，本地只留最近 14 份。
 *         这就是「云端是上班的她、家里是她的家」里每日回家的那趟车——不续费/换服务器时，
 *         拿最新一份就能让家里顶班或初始化新云（恢复：tar -xzf 到状态目录，或 tools/sync-now.cmd 里有说明）。
 *
 * 配置：同目录 cloud-sync.config.json（{"url":"http://<云端Tailscale地址>:5173","token":"..."}，
 *       gitignore；模板 cloud-sync.config.example.json）。token 与云端 rana-web/.env 的 HOME_REPORT_TOKEN 一致。
 * 触发：手动 node 运行 / 本地 rana-web 记忆页「☁️ 拉回云端记忆」按钮 / 开机自动一趟（批5 注册，云端上线前不装）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SYNC_DIR = path.join(REPO, "rana-web", ".migration-sync");
const STATE_FILE = path.join(REPO, "rana-web", ".health", "home-sync-state.json");
const KEEP = 14;

const cfgPath = path.join(HERE, "cloud-sync.config.json");
let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
} catch {
  console.error(`缺配置 ${cfgPath}（复制 cloud-sync.config.example.json 改名填云端地址和 token）`);
  process.exit(1);
}
if (!cfg.url || !cfg.token) {
  console.error("配置里 url/token 没填全");
  process.exit(1);
}

const stamp = new Date();
const name = `cloud-${stamp.toISOString().slice(0, 10).replace(/-/g, "")}-${String(stamp.getHours()).padStart(2, "0")}${String(stamp.getMinutes()).padStart(2, "0")}.tar.gz`;
const outPath = path.join(SYNC_DIR, name);

fs.mkdirSync(SYNC_DIR, { recursive: true });
console.log(`向 ${cfg.url} 拉取云端快照 …`);

// 流式落盘（fetch body → 文件），带 token；manifest 在响应头 x-rana-manifest（base64 JSON）
const res = await fetch(cfg.url.replace(/\/+$/, "") + "/__rana/cloud-snapshot", {
  headers: { "x-home-token": cfg.token },
});
if (!res.ok || !res.body) {
  console.error(`云端拒绝了：HTTP ${res.status} ${await res.text().catch(() => "")}`.slice(0, 300));
  process.exit(1);
}
const totalHeader = res.headers.get("content-length");
const manifestB64 = res.headers.get("x-rana-manifest");
let manifest = null;
try {
  manifest = manifestB64 ? JSON.parse(Buffer.from(manifestB64, "base64").toString("utf8")) : null;
} catch { /* 头部坏了不影响快照本体 */ }

const tmpPath = outPath + ".part";
let bytes = 0;
using handle = fs.openSync(tmpPath, "w");
const reader = res.body.getReader();
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  fs.writeSync(handle, value);
  bytes += value.byteLength;
  if (totalHeader && bytes % (50 * 1024 * 1024) < value.byteLength) {
    console.log(`  已收 ${(bytes / 1024 / 1024).toFixed(0)} MB …`);
  }
}
fs.closeSync(handle);
fs.renameSync(tmpPath, outPath);

// 只留最近 KEEP 份
const files = fs.readdirSync(SYNC_DIR).filter((f) => /^cloud-.*\.tar\.gz$/.test(f)).sort();
for (const old of files.slice(0, Math.max(0, files.length - KEEP))) {
  try { fs.unlinkSync(path.join(SYNC_DIR, old)); } catch { /* 删不掉就留着 */ }
}

fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
fs.writeFileSync(STATE_FILE, JSON.stringify({
  lastPullAt: Date.now(),
  file: name,
  bytes,
  manifest,
}, null, 2));

console.log(`完成：${name}（${(bytes / 1024 / 1024).toFixed(1)} MB${totalHeader ? ` / 预期 ${(Number(totalHeader) / 1024 / 1024).toFixed(1)} MB` : ""}），本地共保留最近 ${Math.min(files.length + 1, KEEP)} 份`);
if (manifest?.parts) {
  const line = manifest.parts.map((p) => `${p.name}:${(p.bytes / 1024 / 1024).toFixed(0)}MB`).join(" ");
  console.log(`快照内容：${line}`);
}
