// ⌘K 命令面板纯逻辑守门：页签来自真实 NAV_TABS、动作只含真端点/真入口（无网关重启假项）、
// 过滤大小写不敏感、组序 pages→sessions→actions、会话取最近 5 个、相对时间分桶。
import { describe, expect, it } from "vitest";
import { NAV_TABS, type SessionRow } from "../../src/lib/types";
import {
  buildActionItems,
  buildPageItems,
  buildPaletteItems,
  buildSessionItems,
  filterPalette,
  relativeTime,
  GROUP_ORDER,
} from "../../src/lib/command-palette";

// 固定"现在"：本地时区 2026-11-15 12:00，避免测试随时钟漂移
const NOW = new Date(2026, 10, 15, 12, 0, 0).getTime();

function sess(key: string, title: string, updatedAt?: number): SessionRow {
  return { key, title, updatedAt };
}

describe("buildPageItems：页签数据来自真实 NAV_TABS", () => {
  it("条目与 NAV_TABS 一一对应（数量/id/文案对齐）", () => {
    const pages = buildPageItems();
    expect(pages).toHaveLength(NAV_TABS.length);
    pages.forEach((p, i) => {
      expect(p.group).toBe("pages");
      expect(p.id).toBe(`page:${NAV_TABS[i].id}`);
      expect(p.view).toBe(NAV_TABS[i].id);
      expect(p.label).toBe(NAV_TABS[i].label.replace(/^\p{Extended_Pictographic}\uFE0F?\s*/u, ""));
    });
  });
});

describe("buildActionItems：动作只放真实存在的端点/入口", () => {
  it("恰好是 bridge-sync / sessions-cleanup / usage-rebuild 三个，且都带 actionId", () => {
    const actions = buildActionItems();
    expect(actions.map((a) => a.actionId)).toEqual(["bridge-sync", "sessions-cleanup", "usage-rebuild"]);
    expect(actions.every((a) => a.group === "actions" && a.id.startsWith("action:"))).toBe(true);
  });
  it("不造假危险入口：过滤「重启」不会有任何命中", () => {
    const all = buildPaletteItems([]);
    const hits = filterPalette(all, "重启");
    expect(hits).toHaveLength(0);
  });
});

describe("filterPalette：过滤与组序", () => {
  const sessions = [sess("s1", "深夜碎碎念", NOW - 60_000)];
  const all = buildPaletteItems(sessions, NOW);

  it("空输入=默认列表（全部页签 + 最近会话 + 全部动作）", () => {
    const hits = filterPalette(all, "");
    expect(hits).toHaveLength(all.length);
    expect(hits.filter((x) => x.group === "pages")).toHaveLength(NAV_TABS.length);
    expect(hits.filter((x) => x.group === "sessions")).toHaveLength(1);
    expect(hits.filter((x) => x.group === "actions")).toHaveLength(3);
  });

  it("子串命中 label，且不区分大小写（qq / REBUILD）", () => {
    const qq = filterPalette(all, "qq");
    expect(qq.some((x) => x.view === "qq")).toBe(true);
    expect(qq.every((x) => x.group !== "sessions")).toBe(true); // 输入串别误伤会话组

    const rebuild = filterPalette(all, "REBUILD");
    expect(rebuild.map((x) => x.actionId)).toEqual(["usage-rebuild"]);
  });

  it("命中组按 pages→sessions→actions 排列，组内保持原有顺序", () => {
    // "会话" 同时命中页签（💬 会话）与会话清理动作；s1 标题也带"会话"则三组全中
    const withSess = buildPaletteItems([sess("s1", "群消息日报整理会话", NOW - 120_000)], NOW);
    const hits = filterPalette(withSess, "会话");
    const groups = [...new Set(hits.map((x) => x.group))];
    expect(groups).toEqual(GROUP_ORDER.filter((g) => hits.some((x) => x.group === g)));
    expect(groups[0]).toBe("pages");

    // 组内保序：全量输出的 pages 段与 NAV_TABS 同序
    const pagesOrder = filterPalette(all, "").filter((x) => x.group === "pages");
    expect(pagesOrder.map((x) => x.view)).toEqual(NAV_TABS.map((t) => t.id));
  });

  it("keywords 也参与匹配（输 usage 可命中用量页签）", () => {
    const hits = filterPalette(all, "usage");
    expect(hits.some((x) => x.view === "usage")).toBe(true);
    expect(hits.some((x) => x.actionId === "usage-rebuild")).toBe(true);
  });
});

describe("buildSessionItems：最近会话", () => {
  it("7 个会话只取 updatedAt 最近 5 个，从新到旧；updatedAt 缺失视为最旧", () => {
    const list = [
      sess("a", "A 刚刚", NOW - 10_000),
      sess("b", "B 一小时前", NOW - 3_600_000),
      sess("c", "C 两小时前", NOW - 2 * 3_600_000),
      sess("d", "D 昨天", NOW - 30 * 3_600_000),
      sess("e", "E 三天前", NOW - 3 * 86_400_000),
      sess("f", "F 无时间", undefined),
      sess("g", "G 更早", NOW - 30 * 86_400_000),
    ];
    const items = buildSessionItems(list, NOW);
    expect(items).toHaveLength(5);
    expect(items.map((x) => x.sessionKey)).toEqual(["a", "b", "c", "d", "e"]);
    expect(items[0].hint).toBe("刚刚");
    expect(items[3].hint).toBe("昨天 06:00");
  });

  it("标题缺失回退会话 key", () => {
    const items = buildSessionItems([sess("bare-key", "")], NOW);
    expect(items[0].label).toBe("bare-key");
  });
});

describe("relativeTime：设计图同款分桶", () => {
  it("刚刚 / 分钟 / 同日小时 / 昨天 / 更早", () => {
    expect(relativeTime(NOW - 30_000, NOW)).toBe("刚刚");
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe("5 分钟前");
    expect(relativeTime(NOW - 2 * 3_600_000, NOW)).toBe("2 小时前");
    expect(relativeTime(new Date(2026, 10, 14, 23, 40).getTime(), NOW)).toBe("昨天 23:40");
    expect(relativeTime(new Date(2026, 10, 10, 8, 5).getTime(), NOW)).toBe("11月10日 08:05");
  });
});
