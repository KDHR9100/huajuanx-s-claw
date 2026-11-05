// server/lib/session-edit-core.ts 的纯函数测试：解码/编码、块视图、定位锚点、哈希。
// 背景：编辑历史消息（改真身）的定位与改写是纯逻辑，这里钉住三件事——
// ①定位要求唯一命中（0 条/多条都报错，绝不猜）；②改写只动内容不动块结构；③写回保持存储格式。
import { describe, it, expect } from "vitest";
import { zstdCompressSync } from "node:zlib";
import {
  SessionEditError,
  decodeEventRow,
  encodeEventJson,
  listEditableBlocks,
  applyBlocksToEvent,
  locateMessage,
  hashBlocks,
  MIN_PREFIX_LEN,
  type LoadedMessage,
} from "../../server/lib/session-edit-core";

/** 构造标准 message 事件 */
function ev(o: { role?: string; blocks?: unknown[]; id?: string; ts?: string; type?: string }) {
  return {
    type: o.type ?? "message",
    id: o.id ?? "11111111-2222-3333-4444-555555555555",
    parentId: "00000000-0000-0000-0000-000000000000",
    timestamp: o.ts ?? "2026-11-05T10:00:00.000Z",
    message: { role: o.role ?? "user", content: o.blocks ?? [{ type: "text", text: "默认正文，长度充足" }] },
  };
}

describe("decodeEventRow / encodeEventJson", () => {
  it("plain 行解码 + 编码回原 JSON", () => {
    const e = ev({});
    const { event, storage } = decodeEventRow({ event_json: JSON.stringify(e) });
    expect(storage).toBe("plain");
    const enc = encodeEventJson(event, "plain");
    expect(enc.event_json).toBe(JSON.stringify(e));
  });

  it("zstd 行解码 + 写回保持压缩格式", () => {
    const e = ev({});
    const buf = zstdCompressSync(Buffer.from(JSON.stringify(e), "utf8"));
    const { event, storage } = decodeEventRow({ event_zstd: buf });
    expect(storage).toBe("zstd");
    const enc = encodeEventJson(event, "zstd");
    expect(enc.event_zstd).not.toBeNull();
    expect(enc.event_json).toBeNull();
  });

  it("两栏都空 → 报错", () => {
    expect(() => decodeEventRow({})).toThrow(SessionEditError);
  });
});

describe("listEditableBlocks / applyBlocksToEvent", () => {
  it("text + thinking 混合块：取视图、改写后只动内容与剥签名", () => {
    const e = ev({
      role: "assistant",
      blocks: [
        { type: "thinking", thinking: "旧思考", thinkingSignature: "sig-abc" },
        { type: "text", text: "旧正文" },
        { type: "toolCall", id: "t1", name: "read" },
      ],
    });
    const blocks = listEditableBlocks(e);
    expect(blocks).toEqual([
      { kind: "thinking", content: "旧思考" },
      { kind: "text", content: "旧正文" },
    ]);
  });

  it("改写：只动内容不动结构，思考块剥签名", () => {
    const e = ev({
      role: "assistant",
      blocks: [
        { type: "thinking", thinking: "旧思考", thinkingSignature: "sig-abc" },
        { type: "text", text: "旧正文" },
        { type: "toolCall", id: "t1", name: "read" },
      ],
    });
    applyBlocksToEvent(e, [
      { kind: "thinking", content: "新思考" },
      { kind: "text", content: "新正文" },
    ]);
    const content = e.message.content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: "thinking", thinking: "新思考" });
    expect(content[1].text).toBe("新正文");
    expect(content[2]).toEqual({ type: "toolCall", id: "t1", name: "read" });
  });

  it("块数对不上 → 409", () => {
    const e = ev({ blocks: [{ type: "text", text: "只有一块" }] });
    expect(() => applyBlocksToEvent(e, [{ kind: "text", content: "x" }, { kind: "text", content: "y" }])).toThrow(SessionEditError);
  });

  it("kind 顺序对不上 → 409", () => {
    const e = ev({
      role: "assistant",
      blocks: [
        { type: "thinking", thinking: "思考" },
        { type: "text", text: "正文" },
      ],
    });
    expect(() => applyBlocksToEvent(e, [{ kind: "text", content: "x" }, { kind: "thinking", content: "y" }])).toThrow(SessionEditError);
  });
});

// user 消息 content 是纯字符串形态（实查 2026-11-05）：整段视作一个 text 块
describe("字符串形态 content", () => {
  it("listEditableBlocks：整段视作一个 text 块", () => {
    const e = ev({ blocks: undefined }) as never;
    e.message.content = "整段字符串正文";
    expect(listEditableBlocks(e)).toEqual([{ kind: "text", content: "整段字符串正文" }]);
  });

  it("applyBlocksToEvent：整段替换", () => {
    const e = ev({ blocks: undefined }) as never;
    e.message.content = "整段字符串正文";
    applyBlocksToEvent(e, [{ kind: "text", content: "替换后" }]);
    expect(e.message.content).toBe("替换后");
  });

  it("applyBlocksToEvent：提交多块/含思考 → 409", () => {
    const e = ev({ blocks: undefined }) as never;
    e.message.content = "整段字符串正文";
    expect(() => applyBlocksToEvent(e, [{ kind: "text", content: "x" }, { kind: "text", content: "y" }])).toThrow(SessionEditError);
    expect(() => applyBlocksToEvent(e, [{ kind: "thinking", content: "y" }])).toThrow(SessionEditError);
  });
});

describe("locateMessage", () => {
  const mk = (id: string, role: "user" | "assistant", text: string, tsMs: number): LoadedMessage => ({
    sessionId: "s1",
    seq: 0,
    eventId: id,
    tsMs,
    role,
    joinedText: text,
    blocks: [{ kind: "text", content: text }],
    storage: "plain",
    event: { type: "message", id },
  });

  it("eventId 精确命中", () => {
    const msgs = [
      mk("aaaaaaaa-0000-4000-8000-000000000001", "user", "你好呀", 1000),
      mk("aaaaaaaa-0000-4000-8000-000000000002", "assistant", "你好！在的", 2000),
    ];
    const hit = locateMessage(msgs, { eventId: "aaaaaaaa-0000-4000-8000-000000000001" });
    expect(hit.eventId).toBe("aaaaaaaa-0000-4000-8000-000000000001");
  });

  it("UUID 形态但库里没有 → 404 不回退", () => {
    const msgs = [mk("aaaaaaaa-0000-4000-8000-000000000001", "user", "你好呀", 1000)];
    expect(() => locateMessage(msgs, { eventId: "aaaaaaaa-0000-4000-8000-000000000009" })).toThrow(SessionEditError);
  });

  it("role+前缀+ts 唯一命中", () => {
    const msgs = [
      mk("a1", "user", "这是第一条很长的消息内容", 1000),
      mk("a2", "assistant", "这是第一条很长的消息内容的回复", 2000),
    ];
    const hit = locateMessage(msgs, { role: "user", prefix: "这是第一条很长的消息内容", tsMs: 1000 });
    expect(hit.eventId).toBe("a1");
  });

  it("ts 邻近不中 → 退回纯前缀匹配", () => {
    const msgs = [mk("a1", "user", "这是第一条很长的消息内容", 1000)];
    const hit = locateMessage(msgs, { role: "user", prefix: "这是第一条很长的消息内容", tsMs: 999999 });
    expect(hit.eventId).toBe("a1");
  });

  it("前缀太短 → 400", () => {
    const msgs = [mk("a1", "user", "这是第一条很长的消息内容", 1000)];
    expect(() => locateMessage(msgs, { role: "user", prefix: "这是" })).toThrow(/至少/);
  });

  it("前缀命中多条 → 409 拒绝猜测", () => {
    const msgs = [
      mk("a1", "user", "重复内容测试重复内容测试", 1000),
      mk("a2", "user", "重复内容测试重复内容测试", 2000),
      mk("a3", "user", "重复内容测试重复内容测试", 4000),
    ];
    expect(() => locateMessage(msgs, { role: "user", prefix: "重复内容测试重复内容测试" })).toThrow(/多条/);
  });

  it("前缀命中多条但 ts 邻近只剩一条 → 命中", () => {
    const msgs = [
      mk("a1", "user", "重复内容测试重复内容测试", 1000),
      mk("a2", "user", "重复内容测试唯一差异", 2000),
      mk("a3", "user", "重复内容测试重复内容测试", 99999),
    ];
    const hit = locateMessage(msgs, { role: "user", prefix: "重复内容测试重复内容测试", tsMs: 1000 });
    expect(hit.eventId).toBe("a1");
  });

  it("MIN_PREFIX_LEN 钉死为 8", () => {
    expect(MIN_PREFIX_LEN).toBe(8);
  });
});

describe("hashBlocks", () => {
  it("同块同哈希、异块异哈希", () => {
    const a = [{ kind: "text", content: "x" }];
    const b = [{ kind: "text", content: "y" }];
    expect(hashBlocks(a)).toBe(hashBlocks(a));
    expect(hashBlocks(a)).not.toBe(hashBlocks(b));
  });
});