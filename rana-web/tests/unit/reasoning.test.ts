// src/lib/reasoning.ts 的分支全覆盖测试。
// 背景：本地微调 RP 模型与云端思考模型的输出经常带脏结构（伪思维链、封套回显、档案模仿），
// 这条清洗管线是聊天页显示前的最后一道闸。用例形态取自 README「技术亮点4」记载的真实脏输出。
import { describe, it, expect } from "vitest";
import { splitReasoning, stripOpenclawEnvelope } from "../../src/lib/reasoning";

describe("splitReasoning", () => {
  it("空输入 → 全空", () => {
    expect(splitReasoning("")).toEqual({ reasoning: "", thinking: false, text: "" });
  });

  it("无任何标记 → 原样返回", () => {
    expect(splitReasoning("今天天气不错")).toEqual({
      reasoning: "",
      thinking: false,
      text: "今天天气不错",
    });
  });

  it("单个闭合 <think>：思考与正文分离", () => {
    const r = splitReasoning("你好<think>想想怎么说</think>再见");
    expect(r.reasoning).toBe("想想怎么说");
    expect(r.text).toBe("你好\n\n再见");
    expect(r.thinking).toBe(false);
  });

  it("多个 <think> 块：按出现顺序合并", () => {
    const r = splitReasoning("<think>第一段</think>中间<think>第二段</think>结尾");
    expect(r.reasoning).toBe("第一段\n\n第二段");
    expect(r.text).toBe("中间\n\n结尾");
    expect(r.thinking).toBe(false);
  });

  it("流式未闭合 <think>：thinking=true，剩余全部算思考", () => {
    const r = splitReasoning("开场白<think>正在推理，还没说完…");
    expect(r.thinking).toBe(true);
    expect(r.reasoning).toBe("正在推理，还没说完…");
    expect(r.text).toBe("开场白");
  });

  it("标签名大小写不敏感（<Think>）", () => {
    const r = splitReasoning("<Think>想</THINK>正文");
    expect(r.reasoning).toBe("想");
    expect(r.text).toBe("正文");
  });

  it("闭合 <details> 且 summary 含思考提示词 → 当作思考折叠", () => {
    const r = splitReasoning("<details><summary>心理分析</summary>内容A</details>结尾");
    expect(r.reasoning).toBe("内容A");
    expect(r.text).toBe("结尾");
    expect(r.thinking).toBe(false);
  });

  it("<details> 带属性 + 英文提示词（open）同样命中", () => {
    const r = splitReasoning('<details open><summary>Plan</summary>step1</details>done');
    expect(r.reasoning).toBe("step1");
    expect(r.text).toBe("done");
  });

  it("summary 无思考提示词的 <details> → 原样留在正文（普通折叠内容）", () => {
    const raw = "<details><summary>剧透</summary>凶手是管家</details>";
    const r = splitReasoning(raw);
    expect(r.reasoning).toBe("");
    expect(r.text).toBe(raw);
    expect(r.thinking).toBe(false);
  });

  it("流式未闭合 <details>（含提示词）→ thinking=true", () => {
    const r = splitReasoning("<details><summary>思考过程</summary>分析中…");
    expect(r.thinking).toBe(true);
    expect(r.reasoning).toBe("分析中…");
    expect(r.text).toBe("");
  });

  it("<think> 与 <details> 混排：谁在前先处理谁", () => {
    const r = splitReasoning(
      "<details><summary>思绪</summary>细节块</details>过渡<think>尾块</think>收"
    );
    expect(r.reasoning).toBe("细节块\n\n尾块");
    expect(r.text).toBe("过渡\n\n收");
  });

  it("空白段落被过滤，正文按 \\n\\n 连接", () => {
    const r = splitReasoning("   <think>x</think>   ");
    expect(r.reasoning).toBe("x");
    expect(r.text).toBe("");
  });

  it("guard 上限 24：超出部分原样落入正文尾巴（防死循环兜底）", () => {
    const raw = Array.from({ length: 25 }, (_, i) => `<think>t${i + 1}</think>`).join("");
    const r = splitReasoning(raw);
    expect(r.reasoning.endsWith("t24")).toBe(true);
    expect(r.reasoning).not.toContain("t25");
    expect(r.text).toBe("<think>t25</think>");
  });
});

describe("stripOpenclawEnvelope", () => {
  it("空输入 → 非回声、空文本", () => {
    expect(stripOpenclawEnvelope("")).toEqual({ echo: false, text: "" });
  });

  it("完整 attempt 封套 + 真实内容 → 只剥封套", () => {
    const raw =
      "<!-- openclaw:attempt:abc123 -->\n内部指令内容\n<!-- /openclaw:attempt:abc123 -->\n真正的回复";
    expect(stripOpenclawEnvelope(raw)).toEqual({ echo: false, text: "真正的回复" });
  });

  it("整条只剩封套 → echo=true（前端折叠成占位行）", () => {
    const raw = "<!-- openclaw:attempt:x -->\n冲刷内容\n<!-- /openclaw:attempt:x -->";
    expect(stripOpenclawEnvelope(raw)).toEqual({ echo: true, text: "" });
  });

  it("未闭合封套（流式中）→ 从开标签起整段剥掉", () => {
    expect(stripOpenclawEnvelope("好的<!-- openclaw:attempt:x -->\n还在生成…")).toEqual({
      echo: false,
      text: "好的",
    });
    expect(stripOpenclawEnvelope("<!-- openclaw:attempt:x -->\n还在生成…")).toEqual({
      echo: true,
      text: "",
    });
  });

  it("多个封套逐个剥净", () => {
    const raw =
      "<!-- openclaw:attempt:1 -->a<!-- /openclaw:attempt:1 -->中间<!-- openclaw:attempt:2 -->b<!-- /openclaw:attempt:2 -->结尾";
    expect(stripOpenclawEnvelope(raw)).toEqual({ echo: false, text: "中间结尾" });
  });

  it("残留的孤立闭合标签也被清掉", () => {
    expect(stripOpenclawEnvelope("<!-- /openclaw:attempt:old -->回复")).toEqual({
      echo: false,
      text: "回复",
    });
  });

  it("内部上下文块（<<<BEGIN/END_OPENCLAW_INTERNAL_CONTEXT>>>）被剥除", () => {
    const raw =
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n机密上下文\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>\n回复";
    expect(stripOpenclawEnvelope(raw)).toEqual({ echo: false, text: "回复" });
  });

  it("inbound_meta 信封复读（带 [时间] 头的完整围栏）被剥除", () => {
    const raw =
      '[2026-10-02 15:07]\n```json\n{"schema": "openclaw.inbound_meta.v2", "channel": "webchat"}\n```\n你好！';
    expect(stripOpenclawEnvelope(raw)).toEqual({ echo: false, text: "你好！" });
  });

  it("outbound_meta 信封同样剥除", () => {
    const raw = '```json\n{"schema": "openclaw.outbound_meta.v1", "surface": "qq"}\n```\n晚上好';
    expect(stripOpenclawEnvelope(raw)).toEqual({ echo: false, text: "晚上好" });
  });

  it("流式中信封围栏已开未闭 → 从围栏起点整段按回显处理", () => {
    expect(stripOpenclawEnvelope('```json\n{"openclaw.in')).toEqual({ echo: true, text: "" });
    expect(stripOpenclawEnvelope('[23:04]\n```json\n{"openclaw.out')).toEqual({
      echo: true,
      text: "",
    });
  });

  it("模仿 ## Chat history 档案结构的代码块被剥除", () => {
    // 块本体被整段剥掉；块前后的换行保留（函数只做首尾 trim），中间留下空行属预期
    const raw = "前置说明\n```\n## Chat history\nuser: 在吗\nassistant: 在的\n```\n后置";
    expect(stripOpenclawEnvelope(raw)).toEqual({ echo: false, text: "前置说明\n\n后置" });
  });

  it("## Memory / ## Runtime 档案模仿同样剥除", () => {
    const raw = "```\n## Memory\n- 某条记忆\n```\n正文";
    expect(stripOpenclawEnvelope(raw)).toEqual({ echo: false, text: "正文" });
    const raw2 = "```md\n## Runtime\nk=v\n```\n正文2";
    expect(stripOpenclawEnvelope(raw2)).toEqual({ echo: false, text: "正文2" });
  });

  it("开头的日期标题头（## Fri 2026-09-10 …）被剥除", () => {
    expect(stripOpenclawEnvelope("## Fri 2026-09-10 22:15\n晚上好")).toEqual({
      echo: false,
      text: "晚上好",
    });
  });

  it("开头的时间标题头（## [23:04 RP]）被剥除", () => {
    expect(stripOpenclawEnvelope("## [23:04 RP]\n（正文）")).toEqual({
      echo: false,
      text: "（正文）",
    });
  });

  it("组合脏输出：封套 + 标题头 + 正文", () => {
    const raw =
      "<!-- openclaw:attempt:9 -->x<!-- /openclaw:attempt:9 -->\n## [21:00 RP]\n今晚月色真美";
    expect(stripOpenclawEnvelope(raw)).toEqual({ echo: false, text: "今晚月色真美" });
  });

  it("剥完只剩空白 → echo=true", () => {
    expect(stripOpenclawEnvelope("   \n  ")).toEqual({ echo: true, text: "" });
  });
});
