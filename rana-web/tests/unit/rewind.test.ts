// src/lib/rewind.ts 纯函数测试：锚点规则与截断。
// 官方 sessions.rewind 只认 user 消息的事件 UUID（36 位），assistant 气泡的「重答」
// 要锚到上面最近一条可锚 user 消息；本机乐观占位 id 一律不可锚。
import { describe, it, expect } from "vitest";
import { isRewindableId, findRewindAnchor, keepBefore } from "../../src/lib/rewind";
import type { ChatMessage } from "../../src/lib/types";

const mk = (id: string, role: "user" | "assistant", text = "内容"): ChatMessage => ({
  id, role, text, ts: 0,
});

describe("isRewindableId", () => {
  it("36 位 UUID 可锚；占位/兜底 id 不可锚", () => {
    expect(isRewindableId("22b90a32-53aa-4eae-85e8-e21971e6fa89")).toBe(true);
    expect(isRewindableId("h-0")).toBe(false);
    expect(isRewindableId("local-xxx")).toBe(false);
    expect(isRewindableId("live-abc")).toBe(false);
    expect(isRewindableId("")).toBe(false);
  });
});

describe("findRewindAnchor", () => {
  it("assistant 气泡往上找最近 user（本地 id 形态不限，服务端按前缀+ts 定位）", () => {
    const msgs = [
      mk("h-0", "user", "占位太老"),
      mk("h-1", "user", "锚点"),
      mk("aaaaaaaa-0000-4000-8000-000000000002", "assistant", "回复A"),
      mk("h-2", "user", "第二条"),
      mk("aaaaaaaa-0000-4000-8000-000000000004", "assistant", "回复B"),
    ];
    const a = findRewindAnchor(msgs, 4);
    expect(a?.id).toBe("h-2");
    // 从 assistant(下标2) 往上找 → 最近 user 是 h-1
    const b = findRewindAnchor(msgs, 2);
    expect(b?.id).toBe("h-1");
  });

  it("上面没有 user 消息 → null（不显示 🔁）", () => {
    const b = findRewindAnchor([mk("aaaaaaaa-0000-4000-8000-000000000009", "assistant", "回复")], 0);
    expect(b).toBeNull();
  });
});

describe("keepBefore", () => {
  const msgs = [mk("a1"), mk("a2"), mk("a3")];
  it("截到目标之前", () => {
    expect(keepBefore(msgs, "a2")?.map((m) => m.id)).toEqual(["a1"]);
  });
  it("找不到返回 null（调用方保持原列表）", () => {
    expect(keepBefore(msgs, "zzz")).toBeNull();
  });
});
