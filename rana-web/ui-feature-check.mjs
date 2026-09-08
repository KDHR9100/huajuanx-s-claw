// 四项 UI 改动的无头验证：
// 1) 矮窗口+长内容时输入框可见可输入  2) 主题色切换  3) 背景+不透明度  4) 会话删除
import WebSocket from "ws";
import { spawn } from "node:child_process";
import fs from "node:fs";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9225;
const profile = process.env.TEMP + "\\chrome-headless-rana3";
const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu",
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  "--window-size=1000,560", // 刻意用矮窗口验证输入框可见性
  "about:blank",
], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let target;
for (let i = 0; i < 20; i++) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    const list = await res.json();
    target = list.find((t) => t.type === "page");
    if (target) break;
  } catch {}
  await sleep(500);
}
const cdp = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
await new Promise((r, j) => { cdp.on("open", r); cdp.on("error", j); });

let msgId = 0;
const pending = new Map();
cdp.on("message", (raw) => {
  const m = JSON.parse(raw);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === "Page.javascriptDialogOpening") {
    cdp.send(JSON.stringify({ id: 900000, method: "Page.handleJavaScriptDialog", params: { accept: true } }));
  }
});
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++msgId;
  pending.set(id, resolve);
  cdp.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) {
    console.log("[exception]", JSON.stringify(r.result.exceptionDetails).slice(0, 200));
    return undefined;
  }
  return r.result?.result?.value;
};

await send("Page.enable");
await send("Page.navigate", { url: "http://localhost:5173/" });
await sleep(4000);
// 清理上次运行残留的主题设置，从默认状态开始
await evaluate(`localStorage.clear()`);
await send("Page.navigate", { url: "http://localhost:5173/" });
await sleep(6000);

// ---- 1) 矮窗口下输入框可见性（主会话有 31k tokens 的长历史）----
const composer = await evaluate(`(function(){
  const ta = document.querySelector(".composer textarea");
  if (!ta) return JSON.stringify({ ok: false, why: "no textarea" });
  ta.focus();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
  setter.call(ta, "输入框可见性测试");
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  const rect = ta.getBoundingClientRect();
  return JSON.stringify({ ok: rect.bottom <= window.innerHeight + 1 && rect.height >= 30 && document.activeElement === ta,
    bottom: Math.round(rect.bottom), winH: window.innerHeight });
})()`);
console.log("[1 输入框可见性]", composer);

// ---- 2) 主题色切换 ----
await evaluate(`(function(){
  const btns = Array.from(document.querySelectorAll("button"));
  btns.find((b) => b.textContent.includes("外观设置"))?.click();
})()`);
await sleep(400);
const swatchRes = await evaluate(`(function(){
  const before = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  const sw = Array.from(document.querySelectorAll(".swatch")).find((x) => x.title === "#5c8fd9");
  sw?.click();
  const after = document.documentElement.style.getPropertyValue("--accent").trim();
  const btnBg = getComputedStyle(document.querySelector(".sidebar .btn:not(.ghost)")).backgroundColor;
  return JSON.stringify({ before, after, btnBg, applied: after === "#5c8fd9" });
})()`);
console.log("[2 主题色]", swatchRes);

// ---- 3) 背景 + 不透明度 ----
const bgRes = await evaluate(`(function(){
  const urlInput = document.querySelector(".set-input");
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  const png = "data:image/gif;base64,R0lGODlhAQABAIAAAObm5gAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==";
  setter.call(urlInput, png);
  urlInput.dispatchEvent(new Event("input", { bubbles: true }));
  const apply = Array.from(document.querySelectorAll(".modal .btn")).find((b) => b.textContent === "应用");
  apply?.click();
  const hasBg = document.body.classList.contains("has-bg");
  const layerOpacity = getComputedStyle(document.querySelector(".bg-layer")).opacity;
  // 拖动不透明度滑条到 80%
  const range = document.querySelector(".set-range");
  setter.call(range, "80");
  range.dispatchEvent(new Event("input", { bubbles: true }));
  const opVar = document.documentElement.style.getPropertyValue("--user-bg-opacity").trim();
  return JSON.stringify({ hasBg, layerOpacity, opVar, sliderDisabled: range.disabled });
})()`);
console.log("[3 背景+透明度]", bgRes);
await sleep(300);
await evaluate(`Array.from(document.querySelectorAll(".modal .btn")).find((b) => b.textContent === "完成")?.click()`);
await sleep(300);

// ---- 4) 会话删除：新建一个会话再删掉 ----
const titlesBefore = await evaluate(`JSON.stringify(Array.from(document.querySelectorAll(".session-item .s-title")).map((x) => x.textContent.trim()))`);
await evaluate(`Array.from(document.querySelectorAll(".sidebar .btn")).find((b) => b.textContent.includes("新会话"))?.click()`);
await sleep(2000);
const delRes = await evaluate(`(function(){
  const before = new Set(JSON.parse(${JSON.stringify(titlesBefore)}));
  const items = Array.from(document.querySelectorAll(".session-item"));
  const countBefore = items.length;
  // 新建后新出现的条目（且带删除按钮，主会话 agent:main:* 无删除按钮属预期）
  const target = items.find((it) => !before.has(it.querySelector(".s-title")?.textContent.trim() ?? "") && it.querySelector(".s-delete"));
  if (!target) return JSON.stringify({ ok: false, countBefore, titles: items.map((it) => it.querySelector(".s-title")?.textContent.trim()).slice(0, 5) });
  const del = target.querySelector(".s-delete");
  del.click();
  return JSON.stringify({ ok: true, countBefore, title: target.querySelector(".s-title")?.textContent.trim() });
})()`);
console.log("[4 删除会话] 点击删除:", delRes);
// 服务端删除较慢（SQLite 写入可达 8s+），轮询等待列表减少
let delAfter = null;
for (let i = 0; i < 20; i++) {
  await sleep(1000);
  delAfter = await evaluate(`JSON.stringify({
    countAfter: document.querySelectorAll(".session-item").length,
    stillHasNew: document.body.innerText.includes("暂无会话") ? "empty" : "some",
  })`);
  if (delRes && JSON.parse(delRes).ok && JSON.parse(delAfter).countAfter < JSON.parse(delRes).countBefore) break;
}
console.log("[4 删除会话] 删除后:", delAfter);

const shot = await send("Page.captureScreenshot", { format: "png" });
fs.writeFileSync("K:/openclaw/rana-web/ui-feature-check.png", Buffer.from(shot.result.data, "base64"));

// 控制台错误检查
const consoleCheck = await evaluate(`JSON.stringify(window.__errs ?? [])`);
console.log("[console errors]", consoleCheck);
chrome.kill();
process.exit(0);
