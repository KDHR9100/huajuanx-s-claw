// memory-bridge-core.mjs 测试：零网络、零隐私。
// chat/cloudChat 依赖 fetch 联网（任务 c 条明确：单元测试不测网络，故不覆盖）；
// 说话人一律用中性词（用户/助手/某人），不读 identity/privacy-patterns 等私有文件。
// readNewEvents 用 fs.mkdtempSync 临时目录自建 agent 库实查，用例对照函数实际行为逐分支钉桩。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseCloudText, readNewEvents } from "../../lib/memory-bridge-core.mjs";

describe("parseCloudText", () => {
  it("SSE 流式：delta.content 逐段累加 + [DONE] 跳过 + 垃圾行忽略 + think 剥离", () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"<think>内心推理"}}]}',
      ": keep-alive 注释行（非 data 行忽略）",
      "data: 垃圾半行不是JSON",
      'data: {"choices":[{"delta":{"content":"中"}}]}',
      'data: {"choices":[{"delta":{"content":"</think>正文一"}}]}',
      "data: [DONE]",
      'data: {"choices":[{"message":{"content":"正文二"}}]}',
    ].join("\n");
    expect(parseCloudText(sse)).toBe("正文一正文二");
  });

  it("同一帧 delta 与 message 都累加（中转站怪口径钉桩）", () => {
    const frame = 'data: {"choices":[{"delta":{"content":"甲"},"message":{"content":"乙"}}]}';
    expect(parseCloudText(frame)).toBe("甲乙");
  });

  it("JSON 兜底路径：非 SSE 文本走 JSON.parse，content 剥 think + trim 原样返回", () => {
    expect(parseCloudText('{"choices":[{"message":{"content":"  <think>推理</think>纯JSON回答  "}}]}')).toBe("纯JSON回答");
    expect(parseCloudText('{"choices":[{"message":{"content":""}}]}')).toBe("");
  });

  it("非 SSE 非 JSON → 让 JSON.parse 的错抛出去（调用方 catch）", () => {
    expect(() => parseCloudText("这不是JSON")).toThrow();
  });

  it("全是 [DONE] 的 SSE → 空串", () => {
    expect(parseCloudText("data: [DONE]\ndata: [DONE]")).toBe("");
  });
});

// 本地时区分量构造，toTimeString 在任何机器上都得固定 HH:MM（对齐 memory-bridge-parse 测试手法）
const T = (h, m) => new Date(2026, 9, 17, h, m, 0).getTime();
// 腿清洗链 fixture：与 memory-bridge.mjs 原版内置链同款（测试作为调用方注入，库本身不内置）
const cleanText = (t) => t
  .replace(/<think>[\s\S]*?<\/think>/g, "")
  .replace(/```[\s\S]*?```/g, "")
  .replace(/!\[[^\]]*\]\([^)]*\)/g, "[图]")
  .replace(/\[Chat history (begins|ends)\]/g, "")
  .trim();
const mkEvt = (role, content, extra = {}) => JSON.stringify({ type: "message", message: { role, content }, ...extra });

describe("readNewEvents（临时 agent 库实查）", () => {
  let home;
  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "mb-core-test-"));
    fs.mkdirSync(path.join(home, "agents/test-agent/agent"), { recursive: true });
    const db = new DatabaseSync(path.join(home, "agents/test-agent/agent/openclaw-agent.sqlite"));
    db.exec("CREATE TABLE session_nodes (session_key TEXT, current_session_id TEXT)");
    db.exec("CREATE TABLE transcript_events (session_id TEXT, event_json TEXT, created_at INTEGER)");
    const node = db.prepare("INSERT INTO session_nodes (session_key, current_session_id) VALUES (?, ?)");
    node.run("main:会话甲", "sess-a");
    node.run("main:cron:定时任务", "sess-cron");
    node.run("gate-内部评估", "sess-gate");
    const evt = db.prepare("INSERT INTO transcript_events (session_id, event_json, created_at) VALUES (?, ?, ?)");
    evt.run("sess-a", mkEvt("user", "网关修好了，任务完成"), T(14, 5));
    evt.run("sess-a", mkEvt("assistant", "好的<think>内部推理过程</think>马上看\n![截图](https://example.com/a.png)"), T(14, 6));
    evt.run("sess-cron", mkEvt("user", "定时任务跑完了"), T(14, 7));
    evt.run("sess-gate", mkEvt("user", "闸门会话的内容"), T(14, 8));
    evt.run("sess-a", "{{{ 这行不是合法JSON", T(14, 9));
    evt.run("sess-a", JSON.stringify({ type: "other", message: { role: "user", content: "类型不对" } }), T(14, 10));
    evt.run("sess-a", mkEvt("tool", "工具调用结果"), T(14, 11));
    evt.run("sess-a", mkEvt("user", "/help 查看命令"), T(14, 12));
    evt.run("sess-a", mkEvt("user", [
      { type: "text", text: "前半" },
      { type: "image_url", image_url: { url: "https://example.com/b.png" } },
      { type: "text", text: "后半" },
    ]), T(14, 13));
    evt.run("sess-a", mkEvt("user", "这行被present拦"), T(14, 14));
    db.close();
  });
  afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

  // 公共调用形态：会话过滤/清洗链/说话人全部按「腿注入」方式传入（与生产包装一致）
  const run = (over = {}) => readNewEvents({
    home,
    agentId: "test-agent",
    sinceMs: 0,
    capChars: 100000,
    sessionFilter: (key) => !key.includes(":cron:") && !key.includes("gate-"),
    cleanText,
    present: (text, role) => (text.includes("present拦") ? null : { text, speaker: role === "user" ? "用户" : "助手", tag: "" }),
    ...over,
  });

  it("行格式钉桩：[HH:MM]说话人: 正文；通过过滤的正好 3 条且按时间升序", () => {
    const out = run();
    expect(out.length).toBe(3);
    expect(out[0]).toEqual({ ts: T(14, 5), line: "[14:05] 用户: 网关修好了，任务完成" });
    expect(out[1].line).toBe("[14:06] 助手: 好的马上看 [图]");
    expect(out[2].line).toBe("[14:13] 用户: 前半 后半");
  });

  it("坏 JSON 行 / 非 message 型 / role 非 user+assistant 一律跳过（10-03 事故防护）", () => {
    const joined = run().map((e) => e.line).join("\n");
    expect(joined).not.toContain("合法JSON");
    expect(joined).not.toContain("类型不对");
    expect(joined).not.toContain("工具调用");
  });

  it(":cron: 与 gate- 会话被 sessionFilter 排除（JSON.parse 之前）", () => {
    const joined = run().map((e) => e.line).join("\n");
    expect(joined).not.toContain("定时任务");
    expect(joined).not.toContain("闸门会话");
  });

  it("斜杠命令行跳过；present 返回 null 跳过该行", () => {
    const joined = run().map((e) => e.line).join("\n");
    expect(joined).not.toContain("/help");
    expect(joined).not.toContain("present拦");
  });

  it("assistant 的 think 被 cleanText 剥离、图片 markdown 转 [图] 占位；数组 content 只拼 text 分段", () => {
    const out = run();
    expect(out[1].line).toBe("[14:06] 助手: 好的马上看 [图]");
    expect(out[1].line).not.toContain("内部推理");
    expect(out[1].line).not.toContain("![");
    expect(out[2].line).toBe("[14:13] 用户: 前半 后半");
  });

  it("tag 前缀拼接自 present 返回值（带前导空格，钉住群聊 gTag 口径）", () => {
    const out = run({ present: (text) => ({ text, speaker: "某人", tag: " [群甲]" }) });
    expect(out[0].line).toBe("[14:05] [群甲] 某人: 网关修好了，任务完成");
  });

  it("capChars 预算截断：本次装不下就停，停在上一条（ts 供 state 接力）", () => {
    const full = run();
    const cut = run({ capChars: full[0].line.length });
    expect(cut.length).toBe(1);
    expect(cut[0].line).toBe(full[0].line);
    expect(cut[0].ts).toBe(full[0].ts);
  });

  it("present 缺省时用中性 role 当说话人（库不内置任何人名）", () => {
    const out = run({ present: undefined });
    expect(out[0].line).toBe("[14:05] user: 网关修好了，任务完成");
  });
});
