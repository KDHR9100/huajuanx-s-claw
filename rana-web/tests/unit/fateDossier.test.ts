// server/plugins/fate.ts 的全量资料注入纯函数测试（2026-11-08 主人拍板的「问时全量注入」）。
//
// 黄金值纪律同 fateCore.test.ts：钉住的是「安全与契约」，不是「与现状一致」——
// 1. resolveDossierPaths：穿越型 nick（../、绝对路径、盘符跳转）一律拒绝（querent="")，
//    防 profiles.json 里的 nick 把读取范围推出 querents 目录；
// 2. dossierSections：注入文案的段落数与关键引导语（延续/冲突/代问/画像用途）钉死，
//    这是发给云端模型的提示词契约，改动需自觉对照；
// 3. readMaybe：读不到不抛错不阻塞解卦（null=照旧）。
import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveDossierPaths,
  dossierSections,
  readMaybe,
  type DossierBundle,
} from "../../server/plugins/fate";

// ---------- resolveDossierPaths：路径安全 ----------

describe("resolveDossierPaths 路径安全", () => {
  it("正常 nick → querent 落在 querents 目录内、指向 <nick>.md；user 恒为 USER.md", () => {
    const r = resolveDossierPaths("张轩瑜");
    expect(r.querent.endsWith(path.join("personal", "querents", "张轩瑜.md"))).toBe(true);
    expect(r.user.endsWith(path.join("workspace-main", "USER.md"))).toBe(true);
  });

  it("穿越型 nick（../、反斜杠、绝对路径）→ querent 拒绝为空串，user 不受影响", () => {
    for (const bad of ["../evil", "..\\..\\evil", "a/b", "C:\\windows\\evil", "/etc/passwd"]) {
      const r = resolveDossierPaths(bad);
      expect(r.querent, `nick=${bad}`).toBe("");
      expect(r.user.endsWith("USER.md")).toBe(true);
    }
  });

  it("空/缺 nick → querent 为空串（不注入档案），user 仍返回", () => {
    expect(resolveDossierPaths().querent).toBe("");
    expect(resolveDossierPaths("").querent).toBe("");
    expect(resolveDossierPaths("").user.endsWith("USER.md")).toBe(true);
  });
});

// ---------- dossierSections：注入文案契约 ----------

describe("dossierSections 注入文案", () => {
  const full: DossierBundle = {
    querent: "# 张轩瑜（主人）\n\n- 2026-09-16 摇卦问学习运……",
    user: "# USER.md - User Model\n\n- Always 中文交流。",
  };

  it("全空 → 零段（照旧解盘，不注入）", () => {
    expect(dossierSections({ querent: null, user: null })).toEqual([]);
  });

  it("只有问卦档案 → 一段，含档案全文与延续/冲突/代问三条引导语", () => {
    const s = dossierSections({ ...full, user: null });
    expect(s).toHaveLength(1);
    expect(s[0]).toContain("历次问卦档案");
    expect(s[0]).toContain("张轩瑜（主人）");
    expect(s[0]).toContain("延续口径");
    expect(s[0]).toContain("冲突就点明");
    expect(s[0]).toContain("(代问)");
  });

  it("只有 USER.md → 一段，含画像全文与「联系实际处境」引导语", () => {
    const s = dossierSections({ ...full, querent: null });
    expect(s).toHaveLength(1);
    expect(s[0]).toContain("生活画像");
    expect(s[0]).toContain("Always 中文交流");
    expect(s[0]).toContain("实际处境");
  });

  it("两者都有 → 两段，档案段在前、画像段在后", () => {
    const s = dossierSections(full);
    expect(s).toHaveLength(2);
    expect(s[0]).toContain("历次问卦档案");
    expect(s[1]).toContain("生活画像");
  });
});

// ---------- readMaybe：容错读 ----------

describe("readMaybe 容错读", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fate-dossier-"));
  const realFile = path.join(tmpDir, "real.md");
  fs.writeFileSync(realFile, "档案内容", "utf8");
  const emptyFile = path.join(tmpDir, "empty.md");
  fs.writeFileSync(emptyFile, "  \n", "utf8");

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  it("存在的文件 → 全文", () => {
    expect(readMaybe(realFile)).toBe("档案内容");
  });
  it("空/纯空白文件 → null（按没有处理）", () => {
    expect(readMaybe(emptyFile)).toBe(null);
  });
  it("不存在的文件 → null（不抛错）", () => {
    expect(readMaybe(path.join(tmpDir, "missing.md"))).toBe(null);
  });
  it("空串路径 → null", () => {
    expect(readMaybe("")).toBe(null);
  });
});
