// lib/contract-guard.mjs / server/lib/contract-guard.ts 用例（2026-11-14 卡2）。
// 对拍纪律：每契约钉三根钉子——好数据=守卫通过且与旧内联逻辑同结果（零行为变化）、
// 坏 JSON/坏字段=同降级 + console 留痕 + 台账记录。全程临时目录+RANA_WEB 隔离，不碰仓库数据。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  checkFields,
  guardReadJson,
  guardParsedText,
  recordViolation,
  contractGuardsFile,
  CONTRACT_FIELDS,
} from "../../server/lib/contract-guard";
import type { GuardField } from "../../server/lib/contract-guard";

let root = ""; // 临时 RANA_WEB：台账与契约文件都落这里
let oldRanaWeb: string | undefined;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "guard-test-"));
  oldRanaWeb = process.env.RANA_WEB;
  process.env.RANA_WEB = root;
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errSpy.mockRestore();
  if (oldRanaWeb === undefined) delete process.env.RANA_WEB;
  else process.env.RANA_WEB = oldRanaWeb;
  rmSync(root, { recursive: true, force: true });
});

// ===== 8 契约对拍钉子（表驱动）：valid=写入方实际产物形状；badJson=坏 JSON；badType=关键字段坏型 =====
const CASES: Array<{ name: keyof typeof CONTRACT_FIELDS; valid: object; badType: object }> = [
  { name: "news/report", valid: { date: "2026-11-14", generatedAt: 1, xwlbDay: "x", xwlb: [{ title: "t" }], sections: [{ id: "s", name: "n", items: [] }], summary: "s", summaryError: "", queries: 3 }, badType: { date: 123, generatedAt: 1, xwlb: [], sections: [], summary: "s" } },
  { name: "health/patrol", valid: { version: 1, updatedAt: 1, checks: [{ id: "c", label: "l", ok: true, detail: "d" }], anomalies: [], lastAlerts: {}, history: [] }, badType: { updatedAt: "x", checks: [], anomalies: [] } },
  { name: "qq/qq-bridge", valid: { groups: { "123": "群A" }, ownerOpenId: "o" }, badType: { groups: "x" } },
  { name: "sys/home-report", valid: { receivedAt: 1, report: { sys: { cpu: 3, memTotalGB: 32, memFreeGB: 16, uptimeHours: 9, disks: [] } } }, badType: { receivedAt: "x", report: {} } },
  { name: "cloud-sync/home-state", valid: { lastPullAt: 1, file: "cloud-x.tar.gz", bytes: 8, manifest: { generatedAt: 1, parts: [] } }, badType: { lastPullAt: "x" } },
  { name: "cloud-sync/cloud-state", valid: { lastPullAt: 1, totalBytes: 8, manifest: { generatedAt: 1, parts: [{ name: "agents", files: 1, bytes: 2 }] } }, badType: { lastPullAt: 1, totalBytes: "x", manifest: {} } },
  { name: "cron/cleanup-status", valid: { running: false, dryRun: true, startedAt: 1, updatedAt: 2, step: "done", log: [], result: null, error: null }, badType: { running: "yes", updatedAt: 2, step: "init" } },
  { name: "backup-check/status", valid: { ok: true, detail: "d", checkedAt: "2026-11-14T00:00:00.000Z" }, badType: { ok: 1, checkedAt: "x" } },
];

describe("契约对拍钉子（卡2：好数据零行为变化 / 坏数据同降级+留痕）", () => {
  const F: Record<string, readonly GuardField[]> = CONTRACT_FIELDS;

  for (const c of CASES) {
    it(`${c.name} 好数据：守卫通过=旧逻辑同结果（valuetoEqual(valid)，无留痕无台账）`, () => {
      const file = path.join(root, `${c.name.replace("/", "-")}.json`);
      writeFileSync(file, JSON.stringify(c.valid), "utf8");
      const r = guardReadJson({ contract: c.name, file, fields: F[c.name], fallback: null });
      expect(r.ok).toBe(true);
      expect(r.value).toEqual(c.valid);
      expect(errSpy).not.toHaveBeenCalled();
      expect(existsSync(contractGuardsFile())).toBe(false);
    });

    it(`${c.name} 坏 JSON：降级 null（=旧 catch 默认值）+console 留痕+台账`, () => {
      const file = path.join(root, `${c.name.replace("/", "-")}.json`);
      writeFileSync(file, "{bad", "utf8");
      const r = guardReadJson({ contract: c.name, file, fields: F[c.name], fallback: null });
      expect(r.ok).toBe(false);
      expect(r.value).toBe(null);
      expect(errSpy.mock.calls.some((a) => String(a[0]).includes(`contract ${c.name}`))).toBe(true);
      const ledger = JSON.parse(readFileSync(contractGuardsFile(), "utf8")) as { total: number; recent: Array<{ contract: string }> };
      expect(ledger.total).toBe(1);
      expect(ledger.recent[0].contract).toBe(c.name);
    });

    it(`${c.name} 关键字段坏型：同降级+留痕（违规含字段名）`, () => {
      const file = path.join(root, `${c.name.replace("/", "-")}.json`);
      writeFileSync(file, JSON.stringify(c.badType), "utf8");
      const r = guardReadJson({ contract: c.name, file, fields: F[c.name], fallback: null });
      expect(r.ok).toBe(false);
      expect(r.value).toBe(null);
      const ledger = JSON.parse(readFileSync(contractGuardsFile(), "utf8")) as { recent: Array<{ reasons: string[] }> };
      expect(ledger.recent[0].reasons.length).toBeGreaterThan(0);
      expect(ledger.recent[0].reasons.join(";")).toMatch(new RegExp(Object.keys(c.badType).join("|")));
    });

    it(`${c.name} 缺必填字段：同降级+留痕；可选字段缺失不违规`, () => {
      const file = path.join(root, `${c.name.replace("/", "-")}.json`);
      const requiredKeys = F[c.name].filter((f) => f.required).map((f) => f.key);
      const missing = { ...c.valid } as Record<string, unknown>;
      delete missing[requiredKeys[0]];
      writeFileSync(file, JSON.stringify(missing), "utf8");
      expect(guardReadJson({ contract: c.name, file, fields: F[c.name], fallback: null }).ok).toBe(false);
      const okable = { ...missing, [requiredKeys[0]]: (c.valid as Record<string, unknown>)[requiredKeys[0]] };
      writeFileSync(file, JSON.stringify(okable), "utf8");
      expect(guardReadJson({ contract: c.name, file, fields: F[c.name], fallback: null }).ok).toBe(true);
    });
  }
});

describe("contract-guard 核心", () => {
  it("checkFields：顶层非对象/类型错/缺必填逐条报；未知多余字段不违规（宽松校验）", () => {
    expect(checkFields(null, [])).toHaveLength(1);
    expect(checkFields([1], [])).toHaveLength(1);
    expect(checkFields({ a: 1, extra: "x" }, [{ key: "a", type: "number", required: true }])).toEqual([]);
    expect(checkFields({ a: "s" }, [{ key: "a", type: "number", required: true }])[0]).toContain("a");
    expect(checkFields({}, [{ key: "a", type: "number", required: true }])[0]).toContain("缺必填");
    expect(checkFields({ a: 1 }, [{ key: "a", type: "number" }])).toEqual([]);
    expect(checkFields({ a: true }, [{ key: "a", type: "boolean" }])).toEqual([]);
    expect(checkFields({ a: {} }, [{ key: "a", type: "object" }])).toEqual([]);
    expect(checkFields({ a: [] }, [{ key: "a", type: "array" }])).toEqual([]);
    expect(checkFields({ a: null }, [{ key: "a", type: "object" }])[0]).toContain("null");
    expect(checkFields({ a: [] }, [{ key: "a", type: "object" }])[0]).toContain("array");
  });

  it("guardReadJson：文件缺失=静默 fallback（missing 标记，无留痕无台账——与 readJson 现状一致）", () => {
    const r = guardReadJson({ contract: "news/report", file: path.join(root, "nope.json"), fields: CONTRACT_FIELDS["news/report"], fallback: null });
    expect(r.ok).toBe(false);
    expect(r.missing).toBe(true);
    expect(r.value).toBe(null);
    expect(errSpy).not.toHaveBeenCalled();
    expect(existsSync(contractGuardsFile())).toBe(false);
  });

  it("guardParsedText：news 原文透传场景——通过时 value=解析对象（handler 用原文 res.end(text) 逐字节不变）", () => {
    const raw = '{"date":"2026-11-14","generatedAt":1,"xwlb":[],"sections":[],"summary":"s"}';
    const r = guardParsedText({ contract: "news/report", file: "f.json", fields: CONTRACT_FIELDS["news/report"], text: raw, fallback: null });
    expect(r.ok).toBe(true);
    expect(r.value).toEqual(JSON.parse(raw));
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("recordViolation：台账滚动最近 50 条+total 累计+原子写无 .tmp 残留", () => {
    for (let i = 0; i < 55; i++) recordViolation("c/x", "f.json", [`r${i}`]);
    const ledger = JSON.parse(readFileSync(contractGuardsFile(), "utf8")) as { total: number; recent: unknown[] };
    expect(ledger.total).toBe(55);
    expect(ledger.recent).toHaveLength(50);
    expect(existsSync(contractGuardsFile() + ".tmp")).toBe(false);
    expect(errSpy).toHaveBeenCalledTimes(55);
  });

  it("contractGuardsFile 随 RANA_WEB env（冒烟测试隔离同款机制）", () => {
    expect(contractGuardsFile()).toBe(path.join(root, ".health", "contract-guards.json"));
    process.env.RANA_WEB = path.join(root, "other");
    expect(contractGuardsFile()).toBe(path.join(root, "other", ".health", "contract-guards.json"));
  });

  it("规格表：8 契约齐全，每契约 2-8 字段、key 唯一", () => {
    const names = Object.keys(CONTRACT_FIELDS);
    expect(names).toHaveLength(8);
    for (const n of names) {
      const fields = CONTRACT_FIELDS[n as keyof typeof CONTRACT_FIELDS];
      expect(fields.length).toBeGreaterThanOrEqual(2);
      expect(fields.length).toBeLessThanOrEqual(8);
      expect(new Set(fields.map((f) => f.key)).size).toBe(fields.length);
    }
  });
});
