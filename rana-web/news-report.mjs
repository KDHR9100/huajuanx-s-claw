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

/** 低质结果过滤：疑似推广位/纯链接/无正文的结果不要（用户实测遇到过"整条只有一个链接"的广告位） */
function isJunkItem(p) {
  const t = (p.name ?? "").trim();
  const url = p.url ?? "";
  const sum = (p.summary ?? p.snippet ?? "").trim();
  if (!t || t.length < 6) return true; // 标题太短/空
  if (/^https?:\/\/|\.(com|cn|net|org|top|vip|xyz)(\/|$)/i.test(t)) return true; // 标题本身是网址
  if (!sum && t.length < 14) return true; // 没摘要且标题凑不成新闻
  if (/^(广告|推广|sponsor|ad)\b|【广告】/i.test(t)) return true; // 明示广告
  if (/\.pdf$|\.doc/i.test(url)) return true; // 文档链接不是新闻
  return false;
}

/** 标题清洗：去掉 "_央视网(cctv.com)" 之类的网站栏目尾巴 */
function cleanTitle(t) {
  return t
    .replace(/[\s_]*[(（][a-z0-9.-]+\.(com|cn|net|org|cc)[）)]\s*$/i, "")
    .replace(/[_\s]+$/,"")
    .trim();
}

async function bochaSearch(section) {
  const body = { query: section.query, freshness: "oneDay", summary: true, count: section.count + 2 };
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
  const items = (pages.value ?? [])
    .filter((p) => !isJunkItem(p))
    .slice(0, section.count)
    .map((p) => ({
      title: cleanTitle((p.name ?? "").trim()),
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

// ---------- 3. 乐奈的总结（qwen3.8-flash，只看标题就能总结今天发生了什么） ----------
async function ranaSummary(xwlb, sections) {
  try {
    const p = CFG?.models?.providers?.["aliyun-maas"];
    if (!p?.baseUrl || !p?.apiKey) throw new Error("aliyun-maas provider 未配置");
    const titles = [
      ...xwlb.items.slice(0, 15).map((x) => `- ${x.title}`),
      ...sections.flatMap((s) => s.items.slice(0, 4).map((i) => `- ${i.title}`)),
    ].join("\n");
    const sys = "你是 Rana，猫系少女，话少、句子短、不用感叹号堆砌。根据新闻标题列表，用你自己的口吻总结今天世界上主要发生了什么：先一句话总起，再挑最重要的 3-5 件事各一句说明白（谁/哪里/发生了什么/意味着什么的程度），结尾一句短评。全文 180 字以内，口语自然，不列标题不复述清单。";
    const res = await fetch(p.baseUrl.replace(/\/+$/, "") + "/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.apiKey}` },
      body: JSON.stringify({
        model: "qwen3.8-flash",
        messages: [
          { role: "system", content: sys },
          { role: "user", content: `以下是今天的新闻标题列表：\n${titles}\n\n总结一下。` },
        ],
        max_tokens: 500,
        temperature: 0.5,
      }),
      signal: AbortSignal.timeout(45000),
    });
    const j = await res.json();
    const text = j?.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error(`flash 返回空（HTTP ${res.status}）`);
    return text;
  } catch (e) {
    log(`乐奈总结失败（跳过）：${e.message}`);
    return "";
  }
}

// ---------- 主流程 ----------
const xwlb = await fetchXwlb();
log(`新闻联播 ${xwlb.day}：${xwlb.items.length} 条`);
const sections = await fetchSections();
const summary = await ranaSummary(xwlb, sections);
// 本地时区日期（toISOString 是 UTC，凌晨跑会差一天）
const now = new Date();
const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

const report = {
  date: today,
  generatedAt: Date.now(),
  xwlbDay: xwlb.day,
  xwlb: xwlb.items,
  sections,
  summary,
  queries: SECTIONS.length, // 本次博查搜索调用次数（额度意识）
};
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, JSON.stringify(report, null, 1), "utf8");
log(`已写入 ${OUT_FILE}（联播 ${xwlb.items.length} 条 / ${sections.map((s) => `${s.name}:${s.items.length}`).join(" ")}）`);
