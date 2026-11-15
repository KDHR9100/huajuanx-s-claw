// server/lib/memory-search.ts 用例（2026-11-15 全文搜索卡）。
// fixture 用 new DatabaseSync(':memory:') 按真库实查形状建表灌假行（transcript_events + session_nodes，
// 列形状 = 2026-11-15 main 库实查），零顶层 I/O，时间用固定常量断言。
// 覆盖：q 校验 / LIKE 转义 / 正文抽取 / snippet 切片 / timestamp 两种形态 /
//       zstd 行跳过 / 坏 JSON 行跳过 / role 过滤 / sessionKey JOIN / 扫描上限 partial / 多库合并降序截断 / 库跳过。
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  normalizeQuery,
  normalizeLimit,
  buildLikePattern,
  extractTextFromContent,
  parseEventTsMs,
  snippetAround,
  mergeAndCap,
  searchAgentDb,
  searchAgentDbs,
  parseAgentsFilter,
  SCAN_ROW_CAP,
  type AgentDbRef,
  type MemorySearchHit,
  type SearchableDb,
} from "../../server/lib/memory-search";

// ===== fixture 工具 =====

/** 按真库形状建 in-memory 库（transcript_events 主键 (session_id, seq) + session_nodes 反查表） */
function makeDb(withNodes = true): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE transcript_events (session_id TEXT NOT NULL, seq INTEGER NOT NULL, event_json TEXT, created_at INTEGER NOT NULL, event_zstd BLOB, PRIMARY KEY (session_id, seq))",
  );
  if (withNodes) {
    db.exec("CREATE TABLE session_nodes (session_key TEXT NOT NULL, current_session_id TEXT)");
  }
  return db;
}

/** message 事件 JSON（timestamp 形态可选：ISO 串 / 毫秒数字 / 缺省不写——排序回落 created_at） */
function messageJson(role: string, content: unknown, timestamp?: string | number): string {
  const message: Record<string, unknown> = { role, content };
  const event: Record<string, unknown> = { type: "message", id: "ev-1", message };
  if (timestamp !== undefined) {
    message.timestamp = timestamp;
    event.timestamp = timestamp;
  }
  return JSON.stringify(event);
}

interface FixtureRow {
  sessionId?: string;
  seq?: number;
  createdAt?: number;
  eventJson?: string | null;
  zstd?: Buffer;
}

/** 灌一行 transcript_events（sessionId/seq 缺省自动编号） */
function insertRow(db: DatabaseSync, row: FixtureRow, autoSeq = { n: 0 }): void {
  const sessionId = row.sessionId ?? "sess-a";
  const seq = row.seq ?? ++autoSeq.n;
  db.prepare(
    "INSERT INTO transcript_events (session_id, seq, event_json, created_at, event_zstd) VALUES (?, ?, ?, ?, ?)",
  ).run(sessionId, seq, row.eventJson ?? null, row.createdAt ?? 1000, row.zstd ?? null);
}

function insertNode(db: DatabaseSync, sessionKey: string, currentSessionId: string): void {
  db.prepare("INSERT INTO session_nodes (session_key, current_session_id) VALUES (?, ?)").run(sessionKey, currentSessionId);
}

const hitOf = (hits: MemorySearchHit[], i = 0): MemorySearchHit => hits[i];

// ===== 参数校验 =====

describe("normalizeQuery · q 校验", () => {
  it("空 q / 纯空白 / 非 string 拒绝", () => {
    expect(normalizeQuery("").ok).toBe(false);
    expect(normalizeQuery("   ").ok).toBe(false);
    expect(normalizeQuery(undefined).ok).toBe(false);
    expect(normalizeQuery(42).ok).toBe(false);
  });
  it("单字符拒绝（≥2 才放行），两端 trim", () => {
    expect(normalizeQuery("a").ok).toBe(false);
    const ok = normalizeQuery("  draining  ");
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.q).toBe("draining");
  });
  it("超长截到 64", () => {
    const ok = normalizeQuery("x".repeat(80));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.q).toHaveLength(64);
  });
  it("normalizeLimit：缺省 30、cap 50、非法回落 30", () => {
    expect(normalizeLimit(undefined)).toBe(30);
    expect(normalizeLimit("999")).toBe(50);
    expect(normalizeLimit(10)).toBe(10);
    expect(normalizeLimit("abc")).toBe(30);
    expect(normalizeLimit(-5)).toBe(30);
  });
});

// ===== 纯函数 =====

describe("buildLikePattern · LIKE 转义", () => {
  it("转义 % _ \\ 三个特殊字符", () => {
    expect(buildLikePattern("100%")).toBe("%100\\%%");
    expect(buildLikePattern("a_b")).toBe("%a\\_b%");
    expect(buildLikePattern("a\\b")).toBe("%a\\\\b%");
    expect(buildLikePattern("plain")).toBe("%plain%");
  });
});

describe("extractTextFromContent · 正文抽取", () => {
  it("user 纯字符串 content 整体返回（实查形态）", () => {
    expect(extractTextFromContent("回复'配置成功'两个字")).toBe("回复'配置成功'两个字");
  });
  it("块数组只拼 text 块，思考块不进搜索正文", () => {
    const blocks = [
      { type: "thinking", thinking: "让我想想" },
      { type: "text", text: "第一段" },
      { type: "text", text: "第二段" },
      { type: "tool_use", id: "t1" },
      { type: "text" }, // 空 text 跳过
    ];
    expect(extractTextFromContent(blocks)).toBe("第一段\n第二段");
  });
  it("非字符串非数组（null/数字/对象）返回空串", () => {
    expect(extractTextFromContent(null)).toBe("");
    expect(extractTextFromContent(123)).toBe("");
    expect(extractTextFromContent({ type: "text" })).toBe("");
    expect(extractTextFromContent(undefined)).toBe("");
  });
});

describe("snippetAround · 命中点切片", () => {
  it("命中点前后各 ~60 字，越界补省略号", () => {
    const long = "前".repeat(80) + "关键词" + "后".repeat(80);
    const snip = snippetAround(long, "关键词", 60)!;
    expect(snip.startsWith("…")).toBe(true);
    expect(snip.endsWith("…")).toBe(true);
    expect(snip).toContain("关键词");
    expect(snip.length).toBeLessThan(long.length);
  });
  it("开头命中不补前省略号，结尾命中不补后省略号", () => {
    expect(snippetAround("关键词在开头", "关键词")).toBe("关键词在开头");
    expect(snippetAround("在结尾的关键词", "关键词")).toBe("在结尾的关键词");
  });
  it("大小写不敏感命中", () => {
    expect(snippetAround("Gateway 网关重试", "gateway")).toContain("Gateway");
  });
  it("找不到命中返回 null（LIKE 粗筛与 JSON 过滤口径对齐）", () => {
    expect(snippetAround("完全没有", "关键词")).toBeNull();
  });
});

describe("parseEventTsMs · timestamp 两种形态", () => {
  it("ISO 字符串形态（实查 main 库形态）", () => {
    expect(parseEventTsMs({ timestamp: "2026-09-07T17:23:49.716Z" }, 0)).toBe(Date.parse("2026-09-07T17:23:49.716Z"));
  });
  it("毫秒数字形态", () => {
    expect(parseEventTsMs({ timestamp: 1757265829716 }, 0)).toBe(1757265829716);
  });
  it("缺失/非法回落 created_at 兜底值", () => {
    expect(parseEventTsMs({}, 12345)).toBe(12345);
    expect(parseEventTsMs({ timestamp: "not-a-date" }, 12345)).toBe(12345);
    expect(parseEventTsMs({ timestamp: -1 }, 12345)).toBe(12345);
  });
});

describe("mergeAndCap · 跨库合并与截断", () => {
  const h = (ts: number, id: string): MemorySearchHit => ({ agentId: "a", ts, role: "user", snippet: id });
  it("ts 降序合并（乱序输入排好）", () => {
    const { hits } = mergeAndCap([h(100, "a"), h(300, "b"), h(200, "c")], 10);
    expect(hits.map((x) => x.snippet)).toEqual(["b", "c", "a"]);
  });
  it("limit 截断且 total 保留截断前总数", () => {
    const many = Array.from({ length: 10 }, (_, i) => h(i + 1, `m${i}`));
    const { hits, total } = mergeAndCap(many, 3);
    expect(hits).toHaveLength(3);
    expect(hits[0].snippet).toBe("m9");
    expect(total).toBe(10);
  });
  it("limit 非正返回空数组", () => {
    const { hits } = mergeAndCap([h(1, "a")], 0);
    expect(hits).toEqual([]);
  });
});

// ===== 单库搜索（in-memory sqlite） =====

describe("searchAgentDb · 单库搜索", () => {
  it("基础命中：块数组 assistant + 字符串 user 两种 content 都搜得到，sessionKey 经 session_nodes 带出", () => {
    const db = makeDb();
    try {
      insertNode(db, "agent:main:main", "sess-a");
      insertRow(db, {
        sessionId: "sess-a",
        seq: 1,
        createdAt: 1000,
        eventJson: messageJson("user", "帮我查 draining 日志", "2026-01-01T00:00:01.000Z"),
      });
      insertRow(db, {
        sessionId: "sess-a",
        seq: 2,
        createdAt: 2000,
        eventJson: messageJson("assistant", [{ type: "text", text: "网关日志里 draining 状态出现了 17 次" }], 1757265829716),
      });
      const out = searchAgentDb(db as unknown as SearchableDb, "main", "Rana (Work)", "draining", { limit: 10 });
      expect(out.total).toBe(2);
      expect(out.partial).toBe(false);
      expect(out.failed).toBe(false);
      const first = hitOf(out.hits, 0);
      expect(first.sessionKey).toBe("agent:main:main");
      expect(first.agentId).toBe("main");
      expect(first.agentName).toBe("Rana (Work)");
      expect(first.ts).toBe(1757265829716); // assistant 行走事件毫秒形态
      expect(first.snippet).toContain("draining");
      const second = hitOf(out.hits, 1);
      expect(second.role).toBe("user");
      expect(second.ts).toBe(Date.parse("2026-01-01T00:00:01.000Z")); // user 行走 ISO 形态
    } finally {
      db.close();
    }
  });
  it("zstd 行（event_zstd 有值 event_json 空）不搜——深档案不含", () => {
    const db = makeDb();
    try {
      insertRow(db, { seq: 1, zstd: Buffer.from("not-really-zstd"), eventJson: null, createdAt: 1000 });
      const out = searchAgentDb(db as unknown as SearchableDb, "main", undefined, "zstd", { limit: 10 });
      expect(out.total).toBe(0);
      expect(out.hits).toHaveLength(0);
    } finally {
      db.close();
    }
  });
  it("坏 JSON 行跳过不炸，其余行照常命中", () => {
    const db = makeDb();
    try {
      insertRow(db, { seq: 1, createdAt: 1000, eventJson: "{not-json!!!" });
      insertRow(db, { seq: 2, createdAt: 2000, eventJson: messageJson("user", "正常行 draining") });
      const out = searchAgentDb(db as unknown as SearchableDb, "main", undefined, "draining", { limit: 10 });
      expect(out.total).toBe(1);
      expect(out.hits[0].snippet).toContain("正常行");
    } finally {
      db.close();
    }
  });
  it("LIKE 通配符转义：搜 '100%' 只命中字面 100% 的行，不把含任意字符的行拖进来", () => {
    const db = makeDb();
    try {
      insertRow(db, { seq: 1, createdAt: 1000, eventJson: messageJson("user", "今天 100% 完成了 draining") });
      insertRow(db, { seq: 2, createdAt: 2000, eventJson: messageJson("user", "中间隔了任意字符也像1xx0x1的样子 draining") });
      const out = searchAgentDb(db as unknown as SearchableDb, "main", undefined, "100%", { limit: 10 });
      expect(out.total).toBe(1);
      expect(out.hits[0].snippet).toContain("100% 完成了");
    } finally {
      db.close();
    }
  });
  it("role 过滤：toolResult / custom / thinking 事件不进结果", () => {
    const db = makeDb();
    try {
      insertRow(db, { seq: 1, createdAt: 1000, eventJson: messageJson("toolResult", "工具输出 draining") });
      insertRow(db, { seq: 2, createdAt: 1100, eventJson: messageJson("custom", "系统便签 draining") });
      insertRow(db, { seq: 3, createdAt: 1200, eventJson: JSON.stringify({ type: "custom", data: "draining" }) });
      insertRow(db, { seq: 4, createdAt: 1300, eventJson: messageJson("assistant", [{ type: "thinking", thinking: "思考里提到 draining" }, { type: "text", text: "正文不提" }]) });
      const out = searchAgentDb(db as unknown as SearchableDb, "main", undefined, "draining", { limit: 10 });
      expect(out.total).toBe(0);
    } finally {
      db.close();
    }
  });
  it("session_nodes 映射不到 → sessionKey 缺席（诚实降级）", () => {
    const db = makeDb();
    try {
      insertRow(db, { sessionId: "sess-orphan", seq: 1, createdAt: 1000, eventJson: messageJson("user", "孤儿会话 draining") });
      const out = searchAgentDb(db as unknown as SearchableDb, "main", undefined, "draining", { limit: 10 });
      expect(out.total).toBe(1);
      expect(out.hits[0].sessionKey).toBeUndefined();
      expect(out.hits[0].sessionId).toBe("sess-orphan");
    } finally {
      db.close();
    }
  });
  it("scanRowCap 超限提前停扫并标 partial", () => {
    const db = makeDb();
    try {
      for (let i = 1; i <= 5; i++) {
        insertRow(db, { seq: i, createdAt: 1000 + i, eventJson: messageJson("user", `第${i}次 draining`) });
      }
      const out = searchAgentDb(db as unknown as SearchableDb, "main", undefined, "draining", { limit: 10, scanRowCap: 3 });
      expect(out.partial).toBe(true);
      expect(out.total).toBeLessThan(5); // 扫到上限就停，后面的行没数
    } finally {
      db.close();
    }
  });
  it("transcript_events 表缺失 → failed=true（编排层把它算进 skippedAgents）", () => {
    const db = new DatabaseSync(":memory:"); // 空库，啥表都没有
    try {
      const out = searchAgentDb(db as unknown as SearchableDb, "ghost", undefined, "draining", { limit: 10 });
      expect(out.failed).toBe(true);
      expect(out.total).toBe(0);
    } finally {
      db.close();
    }
  });
  it("SCAN_ROW_CAP 是 20 万（任务书兜底值）", () => {
    expect(SCAN_ROW_CAP).toBe(200_000);
  });
});

// ===== 多库编排 =====

describe("searchAgentDbs · 多库编排", () => {
  const refA: AgentDbRef = { id: "main", name: "Rana (Work)", dbPath: "db://a" };
  const refB: AgentDbRef = { id: "rana-rp", name: "Rana-RP", dbPath: "db://b" };

  it("多库合并 ts 降序、limit 截断、total 为各库全量命中之和、dbCount 正确", () => {
    const dbA = makeDb();
    insertRow(dbA, { sessionId: "sa", seq: 1, createdAt: 5000, eventJson: messageJson("user", "A 库新行 draining") });
    insertRow(dbA, { sessionId: "sa", seq: 2, createdAt: 1000, eventJson: messageJson("user", "A 库旧行 draining") });
    const dbB = makeDb();
    insertRow(dbB, { sessionId: "sb", seq: 1, createdAt: 3000, eventJson: messageJson("assistant", "B 库中段 draining") });
    const dbs = new Map<string, DatabaseSync>([["db://a", dbA], ["db://b", dbB]]);
    const summary = searchAgentDbs("draining", [refA, refB], {
      limit: 2,
      deps: {
        openDb: (p) => (dbs.get(p) as unknown as SearchableDb) ?? null,
        now: (() => {
          let t = 0;
          return () => ++t; // elapsedMs 至少 1
        })(),
      },
    });
      expect(summary.hits.map((h) => h.agentId)).toEqual(["main", "rana-rp"]); // 5000 > 3000（1000 的被 limit 2 截掉）
      expect(summary.hits[0].ts).toBe(5000);
      expect(summary.total).toBe(3); // 截断前全量：A 库 2 + B 库 1
      expect(summary.dbCount).toBe(2);
      expect(summary.elapsedMs).toBeGreaterThan(0);
      expect(summary.agents.map((a) => a.id)).toEqual(["main", "rana-rp"]);
      expect(summary.skippedAgents).toEqual([]);
  });
  it("库打不开（openDb 返回 null）→ 该 agent 计入 skippedAgents，不拖垮其余库", () => {
    const dbB = makeDb();
    insertRow(dbB, { sessionId: "sb", seq: 1, createdAt: 3000, eventJson: messageJson("user", "只有 B 库 draining") });
    const dbs = new Map<string, DatabaseSync>([["db://b", dbB]]);
    const summary = searchAgentDbs("draining", [refA, refB], {
      deps: { openDb: (p) => (dbs.get(p) as unknown as SearchableDb) ?? null },
    });
    expect(summary.skippedAgents).toEqual(["main"]);
    expect(summary.dbCount).toBe(1);
    expect(summary.total).toBe(1);
    expect(summary.hits[0].agentId).toBe("rana-rp");
  });
  it("表缺失的库计入 skippedAgents（failed 通道）", () => {
    const dbA = new DatabaseSync(":memory:");
    const dbB = makeDb();
    const dbs = new Map<string, DatabaseSync>([["db://a", dbA], ["db://b", dbB]]);
    const summary = searchAgentDbs("draining", [refA, refB], {
      deps: { openDb: (p) => (dbs.get(p) as unknown as SearchableDb) ?? null },
    });
    expect(summary.skippedAgents).toEqual(["main"]);
    expect(summary.dbCount).toBe(1);
  });
  it("parseAgentsFilter：缺省=全部、白名单过滤、不认识的 id 剔除", () => {
    expect(parseAgentsFilter(undefined, [refA, refB])).toHaveLength(2);
    expect(parseAgentsFilter("", [refA, refB])).toHaveLength(2);
    expect(parseAgentsFilter("main", [refA, refB]).map((r) => r.id)).toEqual(["main"]);
    expect(parseAgentsFilter("main , rana-rp", [refA, refB])).toHaveLength(2);
    expect(parseAgentsFilter("nope", [refA, refB])).toEqual([]);
  });
});
