// qq-sidecar 纯函数用例（2026-11-06 第二波④号）：persona.mjs「群友感」策略 + text.mjs 文本化。
// 这是主人天天用的陪伴链路，此前零测试裸奔；用例全部钉住现行为，random 因素用注入点钉死。
import { describe, it, expect } from "vitest";
import {
  DEFAULT_PERSONA, normalizePersona, hitsKeyword, isAddressed,
  decideReply, formatBatch, withEmoji, humanDelayMs,
} from "../../qq-sidecar/persona.mjs";
import { segmentsToText, formatIncoming, stripMarkdown, splitText } from "../../qq-sidecar/text.mjs";

describe("normalizePersona", () => {
  it("缺项落默认值，越界收敛", () => {
    const p = normalizePersona({});
    expect(p.mergeWindowMs).toBe(3500);
    expect(p.lurkRate).toBe(0.3);
    expect(p.emojiRate).toBe(0.35);
    expect(p.keywordTrigger).toEqual(["rana", "乐奈", "rana酱", "小rana", "拉娜"]);
    const p2 = normalizePersona({ lurkRate: 2, mergeWindowMs: -5, keywordTrigger: " rana , 乐奈 " });
    expect(p2.lurkRate).toBe(1);
    expect(p2.mergeWindowMs).toBe(0);
    expect(p2.keywordTrigger).toEqual([]);
  });
});

describe("hitsKeyword / isAddressed", () => {
  it("大小写不敏感；atMe 与关键词任一命中即点名；@全体成员不算点名", () => {
    expect(hitsKeyword("RANA 在吗")).toBe(true);
    expect(hitsKeyword("今天天气不错")).toBe(false);
    expect(isAddressed([{ atMe: true, text: "" }], {})).toBe(true);
    expect(isAddressed([{ atMe: false, text: "叫一下乐奈" }], { keywords: ["乐奈"] })).toBe(true);
    expect(isAddressed([{ atMe: false, text: "@全体成员 开会" }], { keywords: ["乐奈"] })).toBe(false);
  });
});

describe("decideReply", () => {
  it("点名必回；冷却期潜水；冷却外按 lurkRate 潜水", () => {
    expect(decideReply({ addressed: true })).toEqual({ reply: true, reason: "addressed" });
    expect(decideReply({ addressed: false, lastReplyAt: 1000, now: 5000, minReplyIntervalMs: 8000 }))
      .toEqual({ reply: false, reason: "cooldown" });
    expect(decideReply({ addressed: false, lastReplyAt: 0, now: 5000, minReplyIntervalMs: 8000, lurkRate: 0.3, random: () => 0.1 }))
      .toEqual({ reply: false, reason: "lurk" });
    expect(decideReply({ addressed: false, lastReplyAt: 0, now: 5000, minReplyIntervalMs: 8000, lurkRate: 0.3, random: () => 0.9 }))
      .toEqual({ reply: true, reason: "chat" });
  });
});

describe("formatBatch", () => {
  it("单条与多条的形状", () => {
    expect(formatBatch([{ name: "阿轮", userId: "123", text: "你好" }], 456))
      .toBe("[QQ群 456] 阿轮(123)：你好");
    expect(formatBatch([
      { name: "阿轮", userId: "123", text: "早" },
      { name: "小北", userId: "456", text: "早哇" },
    ], 456)).toBe("[QQ群 456] 群里最近 2 条消息（按时间顺序）：\n阿轮(123)：早\n小北(456)：早哇");
  });
});

describe("withEmoji / humanDelayMs", () => {
  it("概率门+表情选择+已有表情不叠；拟人延迟公式与封顶", () => {
    expect(withEmoji("早", 0.35, () => 0.99)).toBe("早");
    expect(withEmoji("早", 0.35, () => 0.1)).toBe("早 🐟");
    expect(withEmoji("早 🐟", 0.35, () => 0.1)).toBe("早 🐟");
    expect(withEmoji("", 0.35, () => 0.1)).toBe("");
    const cfg = { typingBaseMs: 500, typingPerCharMs: 18, typingMaxMs: 3000 };
    expect(humanDelayMs("1234567890", cfg, () => 0)).toBe(608);
    expect(humanDelayMs("1234567890", cfg, () => 1)).toBe(752);
    expect(humanDelayMs("x".repeat(500), cfg, () => 0)).toBe(3000);
    expect(humanDelayMs("", cfg, () => 0)).toBe(500);
  });
});

describe("segmentsToText / formatIncoming", () => {
  it("段数组文本化与入站格式", () => {
    expect(segmentsToText("直接字符串")).toBe("直接字符串");
    expect(segmentsToText([
      { type: "text", data: { text: "早" } },
      { type: "at", data: { qq: "777" } },
      { type: "image", data: {} },
    ], "777")).toBe("早@我[图片]");
    expect(segmentsToText([{ type: "at", data: { qq: "all" } }], "777")).toBe("@全体成员");
    expect(formatIncoming({
      message_type: "group", group_id: 456, user_id: 123,
      sender: { nickname: "阿轮" },
      message: [{ type: "text", data: { text: "在吗" } }],
    }, 777)).toBe("[QQ群 456] 阿轮(123)：在吗");
  });
});

describe("stripMarkdown", () => {
  it("markdown 降级 QQ 纯文本", () => {
    expect(stripMarkdown("# 标题\n正文")).toBe("标题\n正文");
    expect(stripMarkdown("**加粗**和`代码`")).toBe("加粗和代码");
    expect(stripMarkdown("[链接](https://x.com)图![](https://y.com/p.png)")).toBe("链接图");
    expect(stripMarkdown("- 甲\n- 乙")).toBe("· 甲\n· 乙");
    expect(stripMarkdown("```\ncode line\n```")).toBe("code line");
  });
});

describe("splitText", () => {
  it("短文直过；空文返回空数组", () => {
    expect(splitText("abc", 500)).toEqual(["abc"]);
    expect(splitText("", 500)).toEqual([]);
  });
  it("优先换行切点（位置过半才认）", () => {
    const t = "a".repeat(300) + "\n" + "b".repeat(299);
    expect(splitText(t, 500)).toEqual(["a".repeat(300), "b".repeat(299)]);
  });
  it("无换行退句号切点；全无则硬切", () => {
    const t = "a".repeat(400) + "。" + "b".repeat(300);
    expect(splitText(t, 500)).toEqual(["a".repeat(400) + "。", "b".repeat(300)]);
    expect(splitText("a".repeat(1200), 500)).toEqual(["a".repeat(500), "a".repeat(500), "a".repeat(200)]);
  });
});
