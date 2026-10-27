// lib/types.ts 模型引用工具的回归测试。
// 背景：网关 models.list 返回的 id 是裸名（provider 单独字段），会话把 provider 与裸名分开存
// （modelProvider / model）。同名模型跨 provider（glm-5.3 等）时，必须用完整引用才能选对接口。
import { describe, it, expect } from "vitest";
import { isSameModel, modelRef, modelSuffix } from "../../src/lib/types";

describe("modelRef", () => {
  it("provider 已知 → provider/id", () => {
    expect(modelRef({ id: "qwen3.8-flash", provider: "aliyun-maas" })).toBe("aliyun-maas/qwen3.8-flash");
  });

  it("provider 缺失 → 退回裸名（向后兼容旧存档）", () => {
    expect(modelRef({ id: "qwen3.8-flash" })).toBe("qwen3.8-flash");
  });

  it("裸名不会重复拼前缀", () => {
    expect(modelRef({ id: "glm-5.3" })).toBe("glm-5.3");
    expect(modelSuffix("glm/glm-5.3")).toBe("glm-5.3");
  });
});

describe("isSameModel", () => {
  const row = { id: "glm-5.3", provider: "bailian" };

  it("同名同 provider → 命中", () => {
    expect(isSameModel("glm-5.3", "bailian", row)).toBe(true);
  });

  it("同名不同 provider → 不命中（不再一次亮多行）", () => {
    expect(isSameModel("glm-5.3", "aliyun-maas", row)).toBe(false);
  });

  it("provider 未知时退回裸名比较（旧会话缓存兼容）", () => {
    expect(isSameModel("glm-5.3", undefined, row)).toBe(true);
    expect(isSameModel("qwen3.8-flash", undefined, row)).toBe(false);
  });

  it("会话模型带前缀也能比（兼容 model 字段偶尔存全引用）", () => {
    expect(isSameModel("bailian/glm-5.3", "bailian", row)).toBe(true);
    expect(isSameModel("bailian/glm-5.3", "glm", row)).toBe(false);
  });

  it("会话无模型 → 不命中", () => {
    expect(isSameModel(undefined, "bailian", row)).toBe(false);
  });
});
