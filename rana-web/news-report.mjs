#!/usr/bin/env node
/**
 * news-report.mjs — 每日早报生成器（独立于会话，产出文件供早报页渲染）
 *
 * 数据源：
 *  1. CCTV 新闻联播文字版列表页（昨天那期）：https://tv.cctv.com/lm/xwlb/day/YYYYMMDD.shtml（国内直连）
 *  2. 博查 web-search API（key 从 openclaw.json 的 mcp.bocha.env 读取，不硬编码）：
 *     四个类目各搜一次 —— AI 与前沿、科技动态、国内时事、国际视野（freshness=oneDay，含摘要与来源链接）
 *
 * 输出：rana-web/.news/report.json（目录已 gitignore，仅本地）
 * 触发：openclaw cron（每天 08:00，command payload）或手动 node 运行。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, ".news");
const OUT_FILE = path.join(OUT_DIR, "report.json");
const CFG = JSON.parse(fs.readFileSync("K:/OpenClaw/.openclaw/.openclaw/openclaw.json", "utf8"));
const BOCHA_KEY = CFG?.mcp?.servers?.bocha?.env?.BOCHA_API_KEY;
const BOCHA_API = "https://api.bochaai.com/v1/web-search";

// ---------- 工具 ----------
const log = (m) => console.log(`${new Date().toISOString()} ${m}`);

async function fetchText(url, headers, timeoutMs = 20000) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`${url} HTTP ${r.status}`);
  return await r.text();
}

// ---------- 1. 新闻联播（昨天那期条目列表） ----------
async function fetchXwlb() {
  const d = new Date(Date.now() - 24 * 3600 * 1000);
  const day = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  try {
    const html = await fetchText(`https://tv.cctv.com/lm/xwlb/day/${day}.shtml`);
    const items = [];
    const re = /<a href="(https:\/\/tv\.cctv\.com\/\d{4}\/\d{2}\/\d{2}\/VIDE[^"]+\.shtml)"[^>]*title="([^"]+)"/g;
    for (const m of html.matchAll(re)) {
      const title = m[2].replace(/^\[视频\]/, "").trim();
      // 第一条是整期节目本身，跳过
      if (/^《新闻联播》/.test(title)) continue;
      if (!items.some((x) => x.title === title)) items.push({ title, url: m[1] });
    }
    return { day, items };
  } catch (e) {
    log(`新闻联播抓取失败（跳过该板块）：${e.message}`);
    return { day, items: [] };
  }
}

// ---------- 2. 博查搜索（分类目） ----------
const SECTIONS = [
  { id: "ai", name: "AI 与前沿", query: "人工智能 大模型 最新进展", count: 5 },
  { id: "tech", name: "科技动态", query: "科技行业 新品 芯片 互联网", count: 5 },
  { id: "china", name: "国内时事", query: "国内 重要新闻 政策", count: 5 },
  { id: "world", name: "国际视野", query: "国际 重大新闻", count: 5 },
];

async function bochaSearch(section) {
  const body = { query: section.query, freshness: "oneDay", summary: true, count: section.count };
  const res = await fetch(BOCHA_API, {
    method: "POST",
    headers: { Authorization: `Bearer ${BOCHA_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Bocha HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  if (!res.ok || (json.code && json.code !== 200)) throw new Error(json?.message ?? `Bocha code ${json.code}`);
  const pages = json?.data?.webPages ?? {};
  const items = (pages.value ?? []).map((p) => ({
    title: (p.name ?? "").trim(),
    summary: (p.summary ?? p.snippet ?? "").trim().slice(0, 200),
    source: p.siteName ?? (p.url ? new URL(p.url).hostname : ""),
    url: p.url ?? "",
  }));
  return items;
}

async function fetchSections() {
  const out = [];
  for (const s of SECTIONS) {
    try {
      const items = await bochaSearch(s);
      out.push({ id: s.id, name: s.name, items });
      log(`[${s.name}] ${items.length} 条`);
    } catch (e) {
      out.push({ id: s.id, name: s.name, items: [], error: e.message });
      log(`[${s.name}] 搜索失败：${e.message}`);
    }
  }
  return out;
}

// ---------- 主流程 ----------
const xwlb = await fetchXwlb();
log(`新闻联播 ${xwlb.day}：${xwlb.items.length} 条`);
const sections = await fetchSections();

const report = {
  date: new Date().toISOString().slice(0, 10),
  generatedAt: Date.now(),
  xwlbDay: xwlb.day,
  xwlb: xwlb.items,
  sections,
};
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, JSON.stringify(report, null, 1), "utf8");
log(`已写入 ${OUT_FILE}（联播 ${xwlb.items.length} 条 / ${sections.map((s) => `${s.name}:${s.items.length}`).join(" ")}）`);
