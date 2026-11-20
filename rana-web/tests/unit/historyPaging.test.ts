// 「加载更早」翻页纯函数守门：offset 推算 / 合并去重 / 到底判定。
// 协议语义（实查 openclaw dist resolveChatHistoryNextOffset）：offset 按「记录号」计数，
// record 1 = 最旧记录；消息带 __openclaw.seq（1 基升序）。页面只显示最近 limit 条尾窗，
// 「加载更早」= 取锚点（当前最旧一条）之前 limit 条，只留比锚点旧的、按 id 去重。
import { describe, expect, it } from "vitest";
import { mergeOlderMessages, nextOlderOffset, type PagingMessage } from "../../src/lib/history-paging";

const mk = (id: string, seq: number | undefined, text = ""): PagingMessage & { text: string } => ({
  id,
  seq,
  text,
});

describe("nextOlderOffset", () => {
  it("锚点很深时跳到锚点前 limit 条", () => {
    // 最旧一条 seq=500，取它之前 200 条 = 记录 300..499 → offset 299
    expect(nextOlderOffset(500)).toBe(299);
    expect(nextOlderOffset(500, 100)).toBe(399);
  });

  it("锚点接近开头时落到 0", () => {
    expect(nextOlderOffset(150)).toBe(0);
    expect(nextOlderOffset(1)).toBe(0);
  });

  it("边界：锚点正好等于 limit+1 时 offset=0", () => {
    expect(nextOlderOffset(201)).toBe(0);
    expect(nextOlderOffset(202)).toBe(1);
  });
});

describe("mergeOlderMessages", () => {
  it("合并并按 seq 升序前插", () => {
    const existing = [mk("b", 500), mk("c", 501)];
    const page = [mk("a2", 499), mk("a1", 498)];
    const { merged, added } = mergeOlderMessages(existing, page);
    expect(added).toBe(2);
    expect(merged.map((m) => m.id)).toEqual(["a1", "a2", "b", "c"]);
  });

  it("只留比锚点旧的（页尾与已加载重叠时丢弃）", () => {
    const existing = [mk("b", 150), mk("c", 151)];
    const page = [mk("x", 1), mk("y", 100), mk("b", 150), mk("c", 151)];
    const { merged, added } = mergeOlderMessages(existing, page);
    expect(added).toBe(2);
    expect(merged.map((m) => m.id)).toEqual(["x", "y", "b", "c"]);
  });

  it("按 id 去重，无 seq 的行直接丢弃", () => {
    const existing = [mk("b", 300)];
    const page = [mk("noseq", undefined), mk("a1", 299), mk("a1", 299)];
    const { merged, added } = mergeOlderMessages(existing, page);
    expect(added).toBe(1);
    expect(merged.map((m) => m.id)).toEqual(["a1", "b"]);
  });

  it("页里没有比锚点更旧的消息时 added=0（到底信号）", () => {
    const existing = [mk("first", 1)];
    const page = [mk("other", 2, "新来的")];
    const { merged, added } = mergeOlderMessages(existing, page);
    expect(added).toBe(0);
    expect(merged.map((m) => m.id)).toEqual(["first"]);
  });
});
