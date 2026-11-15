// repo-hygiene.test.mjs — 仓库卫生守卫：两道确定性检查，源起 2026-11-14 两起真病（KNOWN-ISSUES.md 同日条目）。
// 检查矩阵的洞：node --check 查不出「import 藏注释块」（语法合法、运行时才炸）；tsc 管不到 .mjs 边车；
// vitest 不 import 边车脚本——本文件用字符级状态机直接扫源码补洞。
// A2 时区案（11-08 备份仓 / 11-14 owner-status 同根）：本地构造的日期与写死 Z 时刻串不许同文件混框。
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../..", import.meta.url)); // tests/unit/ → 仓库根

// A2 豁免名单（git 相对路径）：混框确属合法时才加（如在测 UTC 解析本身），必须写明理由，
// 且能回答「任何时区跑结果是否一致」。当前为空——owner-status.test.mjs 的残留混框已同款加固，零豁免。
const ALLOWLIST = []; // 例: ["rana-web/tests/unit/xxx.test.ts"]（理由写同行或上方注释）
// git pathspec 的 ** 不匹配零层级（实测）：rana-web/**/*.mjs 罩不住根级边车——今天病样本体
// git-activity-cron.mjs 就在根级，必须补 rana-web/*.mjs；两 glob 有交集，用 Set 去重。CI(ubuntu) 的 git 同可用。
const listFiles = (specs) =>
  [...new Set(
    execFileSync("git", ["ls-files", "--", ...specs], { cwd: REPO, encoding: "utf8" })
      .split("\n").map((s) => s.trim()).filter(Boolean),
  )];
// ---------- A1：import 藏注释块（字符级状态机：正常 / 行注释 / 块注释 / 字符串含转义） ----------
// 从左到右扫，顺序钉死：先判字符串引号、再判 //（行注释吃到行尾，里面的 /* 不许开块）、再判 /*。
// 块注释内的行，去掉行首空白与行首 * 后以「import 」或「import{」开头 → 违规，报行号。
function scanImportInBlockComment(src) {
  const hits = [];
  let state = "normal";
  let quote = "";
  let line = 1;
  let frag = ""; // 当前行处于块注释状态的字符片段（行尾统一判定）
  const flush = () => {
    const t = frag.replace(/\r/g, "").replace(/^\s+/, "").replace(/^\*+/, "").trim();
    if (t.startsWith("import ") || t.startsWith("import{")) hits.push(line);
    frag = "";
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1] ?? "";
    if (c === "\n") {
      if (frag) flush();
      line++;
      continue;
    }
    if (state === "normal") {
      if (c === "'" || c === '"' || c === "`") { state = "string"; quote = c; }
      else if (c === "/" && n === "/") { state = "line"; i++; }
      else if (c === "/" && n === "*") { state = "block"; i++; }
    } else if (state === "string") {
      if (c === "\\") i++; // 转义：跳过下一字符（\" \' \` \\ 等）
      else if (c === quote) state = "normal";
    } else if (state === "line") {
      // 行注释只吃到行尾（\n 顶部统一处理）；里面的 /* 不许开块——今天真实误报的形状就死在这
    } else {
      // block：只认 */ 收尾；引号在注释内只是普通字符
      frag += c;
      if (c === "*" && n === "/") { state = "normal"; i++; }
    }
  }
  if (frag) flush(); // 文件以未闭合块注释结尾的病态也抓
  return hits;
}
// ---------- fixtures：钉死两种真实形状 ----------
// 病样（必须被抓）：import 被误插进文件头 JSDoc 注释块——git-activity-cron.mjs 2026-11-14 真实病形（3ae0403 已修）。
// 它整体在反引号模板串里，被 A1 自扫时处于字符串状态，不会误伤本文件。
const SICK_FIXTURE = `#!/usr/bin/env node
/**
 * foo-cron.mjs — cron 包装：跑统计、落盘、推送
 * import { spawn } from "node:child_process";
 * 用法：node foo-cron.mjs
 */
import path from "node:path";
`;
// 免疫样（必须不抓，今天真实误报形状）：行注释含 /*（/__rana/fate/* 路径通配符）+ 字符串含 /*（路径常量）。
const IMMUNE_FIXTURE = `#!/usr/bin/env node
// 由 vite.config.ts 的 /__rana/fate/* 中间件兜底，路径通配符写在注释里属正常。
const PREFIX = "/__rana/fate/*";
import path from "node:path";
`;
// 边界钉死：单行块注释包 import / *import{ 紧贴星号（JSDoc 手滑最常见形）/ 字符串转义不破态。
const EDGE_FIXTURE = `/* import x from "y"; */
/**
 *import{ a } from "b";
 */
import z from "z";
`;
// 内容里的 \" 转义让字符串中的 /* 不开块；真块注释里的 import 行照抓（模板串里写 \\" 才是内容里的 \"）。
const ESCAPE_FIXTURE = `const a = "x\\"y /* 这不是块注释开符";
/* real block
 * import q from "q";
 */
`;
describe("A1 import 藏注释块（字符级状态机）", () => {
  it("病样：JSDoc 内插 import 被抓到且行号正确（钉死 2026-11-14 真实病形）", () => {
    expect(scanImportInBlockComment(SICK_FIXTURE)).toEqual([4]);
  });
  it("免疫样：行注释含 /* 与字符串含 /*（今天真实误报形状）必须不抓", () => {
    expect(scanImportInBlockComment(IMMUNE_FIXTURE)).toEqual([]);
  });
  it("边界：单行块注释包 import、*import{ 紧贴、字符串转义不破态", () => {
    expect(scanImportInBlockComment(EDGE_FIXTURE)).toEqual([1, 3]);
    expect(scanImportInBlockComment(ESCAPE_FIXTURE)).toEqual([3]);
  });
  it("全仓扫描：rana-web 全部 .mjs（含根级边车兜底）与 tools/*.mjs 零违规", () => {
    const files = listFiles(["rana-web/**/*.mjs", "rana-web/*.mjs", "tools/*.mjs"]);
    const bad = [];
    for (const rel of files) {
      const hits = scanImportInBlockComment(readFileSync(path.join(REPO, rel), "utf8"));
      if (hits.length) bad.push(`${rel}:${hits.join(",")}`);
    }
    // 修法：import 行挪回 import 区，别插注释块。node --check 查不出这种病（语法合法、运行时才炸），
    // 见 KNOWN-ISSUES.md 2026-11-14「git-activity-cron.mjs import 误插注释块」条目。
    expect(
      bad,
      `以下文件的块注释内藏 import 行（import 被注释吞，脚本触发即 ReferenceError）:\n${bad.join("\n")}\n修法：import 挪回 import 区；见台账 2026-11-14 import 案`,
    ).toEqual([]);
  });
});
// ---------- A2：测试时区混框（本地构造的日期 与 写死 Z 时刻串 不许同文件混框） ----------
// UTC+8 开发机一直绿、UTC CI 必挂（11-08 备份仓 / 11-14 owner-status 两案同根）。
// 反引号用 BTICK 拼接：正则字面量里直接写 ` 会引号失衡，让本文件被 A1 自扫时状态机走歪。
const BTICK = String.fromCharCode(96);
const RE_LOCAL = /\bnew Date\(\s*\d{4}\s*,/; // 多参本地日历构造（new Date(y, m, ...)）
const RE_ZULU = new RegExp(
  "['\"" + BTICK + "]\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2})?(?:\\.\\d+)?Z['\"" + BTICK + "]",
); // 写死的 Z 结尾时刻串字面量（双引/单引/反引三种都算）
describe("A2 测试时区混框", () => {
  it("正则形状自测：真形状命中、正确修法不误伤", () => {
    expect(RE_LOCAL.test("new Date(2026, 10, 8, 1, 0)")).toBe(true);
    expect(RE_LOCAL.test("new Date(ts)")).toBe(false);
    expect(RE_LOCAL.test("new Date(123)")).toBe(false); // 单参毫秒值不是日历构造
    expect(RE_ZULU.test('at: "2026-11-07T15:00:00Z"')).toBe(true);
    expect(RE_ZULU.test('"2026-11-07T15:00:00.000Z"')).toBe(true);
    expect(RE_ZULU.test('"2026-11-07T15:00:00+08:00"')).toBe(false); // 带 offset 的串不在 Z 串形状内
    expect(RE_ZULU.test("new Date(2026, 10, 7, 23, 0).toISOString()")).toBe(false); // 同框本地构造=正确修法
  });
  it("全仓扫描：tests/ 下 .test.(mjs|ts) 不许同文件混框", () => {
    // 跳过本文件：上面的自测 it 必然出现两种形状的字符串样本（自指必中，逐行正则不做状态机解析），
    // 形状正确性由自测 it 钉死；A1 无需跳过（其 fixtures 藏在模板串里，状态机自扫已实证安全）。
    const selfRel = path.relative(REPO, fileURLToPath(import.meta.url)).split(path.sep).join("/");
    const files = listFiles(["rana-web/tests/"]).filter(
      (f) => /\.test\.(mjs|ts)$/.test(f) && f !== selfRel && !ALLOWLIST.includes(f),
    );
    const bad = [];
    for (const rel of files) {
      const localLines = [];
      const zuluLines = [];
      readFileSync(path.join(REPO, rel), "utf8").split("\n").forEach((l, i) => {
        if (RE_LOCAL.test(l)) localLines.push(i + 1);
        if (RE_ZULU.test(l)) zuluLines.push(i + 1);
      });
      if (localLines.length && zuluLines.length) {
        bad.push(`${rel} 本地构造@${localLines.join(",")} / Z串@${zuluLines.join(",")}`);
      }
    }
    // 修法：时间戳与 now 同框本地构造（new Date(...).toISOString()），见台账 2026-11-14 时区案。
    expect(
      bad,
      `以下测试文件「本地构造日期」与「写死 Z 时刻串」同文件混框（UTC+8 绿、UTC CI 必挂）:\n${bad.join("\n")}\n修法：时间戳与 now 同框本地构造（new Date(...).toISOString()），见台账 2026-11-14 时区案`,
    ).toEqual([]);
  });
});
