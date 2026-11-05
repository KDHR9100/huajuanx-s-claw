// server/lib/fs-json.ts 用例：收拢 11 处手抄写 JSON 三件套后的行为锚（2026-11-06）。
// 钉住：容错读、.bak 备份语义、tmp+rename 原子写。全程用临时目录，不碰仓库数据。
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readJson, writeJsonBak, writeJsonAtomic, backupThenWrite } from "../../server/lib/fs-json";

const dir = mkdtempSync(path.join(tmpdir(), "fs-json-test-"));
const f = path.join(dir, "a", "b", "x.json");

describe("fs-json", () => {
  it("readJson 容错：不存在或坏 JSON 返回 fallback", () => {
    expect(readJson(f, null)).toBe(null);
    writeFileSync(path.join(dir, "bad.json"), "{bad", "utf8");
    expect(readJson(path.join(dir, "bad.json"), { ok: 1 })).toEqual({ ok: 1 });
  });

  it("writeJsonBak：首写无 .bak，覆写产生 .bak", () => {
    rmSync(f, { force: true });
    writeJsonBak(f, { v: 1 });
    expect(existsSync(f + ".bak")).toBe(false);
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ v: 1 });
    writeJsonBak(f, { v: 2 });
    expect(existsSync(f + ".bak")).toBe(true);
    expect(JSON.parse(readFileSync(f + ".bak", "utf8"))).toEqual({ v: 1 });
  });

  it("backupThenWrite 自定义后缀", () => {
    const g = path.join(dir, "y.md");
    writeFileSync(g, "v1", "utf8");
    backupThenWrite(g, "v2", ".bak-x");
    expect(readFileSync(g + ".bak-x", "utf8")).toBe("v1");
    expect(readFileSync(g, "utf8")).toBe("v2");
  });

  it("writeJsonAtomic：内容正确且无 .tmp 残留", () => {
    const a = mkdtempSync(path.join(tmpdir(), "fs-json-tmp-")) + "/atomic.json";
    writeJsonAtomic(a, { ok: 1 });
    expect(JSON.parse(readFileSync(a, "utf8"))).toEqual({ ok: 1 });
    expect(existsSync(a + ".tmp")).toBe(false);
    writeJsonAtomic(a, { ok: 2 });
    expect(JSON.parse(readFileSync(a, "utf8"))).toEqual({ ok: 2 });
  });
});
