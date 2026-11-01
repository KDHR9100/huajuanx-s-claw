// 人物·事件图谱解析器：把 personal/graph.md 的两张 markdown 表格解析成结构化数据。
// 数据契约（ADR-0001）：表格即数据源，列序无关，按表头名取列。
//   「最后核对：YYYY-MM-DD」行 -> lastChecked
//   ## 人物节点 表格列：节点|圈层|一句话|与轩瑜|来源；## 事节点 表格列：事件|状态|关联人|来源
// 容错优先：这文件是给人手改/弱模型手改的——坏行跳过、缺列降级、解析永不 throw。

export interface PersonNode {
  name: string;
  group: string; // 圈层：家人/朋友与在意的人/职场/我/…；缺列 -> 未分组
  blurb: string; // 一句话
  relation: string; // 与轩瑜
  source: string; // 来源
}

export interface EventNode {
  name: string;
  status: string;
  people: string; // 关联人（自由文本，只展示不建边）
  source: string;
}

const UNFILED = "未分组";

/** 读「最后核对：YYYY-MM-DD」行（全角冒号兼容）；没有则 null。 */
export function parseLastChecked(md: string): string | null {
  const m = md.match(/最后核对[:：]\s*(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

/** 取「## 标题」小节文本（到下一个 ## 或文末）。 */
function sectionOf(md: string, title: string): string {
  const m = md.match(new RegExp(`^##\\s*${title}`, "m"));
  if (!m || m.index === undefined) return "";
  const rest = md.slice(m.index + m[0].length);
  const nxt = rest.match(/^##\s/m);
  return nxt && nxt.index !== undefined ? rest.slice(0, nxt.index) : rest;
}

/** 拆表格行：取以 | 开头的行，去首尾管道，trim 每格；不校验列数（坏行靠列名取列兜底）。 */
function tableRows(sec: string): string[][] {
  const rows: string[][] = [];
  for (const line of sec.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("|")) continue;
    rows.push(
      t
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((c) => c.trim()),
    );
    if (rows.length > 500) break; // 防手滑巨型文件
  }
  return rows;
}

/** 表头列名 -> 列号（精确名匹配，列序无关）。 */
function headerIndex(header: string[], names: string[]): Map<string, number> {
  const map = new Map<string, number>();
  header.forEach((h, i) => {
    const n = names.find((x) => h === x);
    if (n !== undefined && !map.has(n)) map.set(n, i);
  });
  return map;
}

/** 解析人物节点表。 */
export function parsePeopleTable(sec: string): PersonNode[] {
  const rows = tableRows(sec);
  if (rows.length === 0) return [];
  const idx = headerIndex(rows[0], ["节点", "圈层", "一句话", "与轩瑜", "来源"]);
  if (!idx.has("节点")) return [];
  const get = (cells: string[], key: string): string => {
    const i = idx.get(key);
    return i === undefined ? "" : (cells[i] ?? "");
  };
  const out: PersonNode[] = [];
  for (const cells of rows.slice(1)) {
    if (cells.every((c) => c === "")) continue;
    if (/^:?-{3,}:?$/.test(cells[0])) continue; // 表头分隔行
    const name = get(cells, "节点");
    if (!name) continue;
    out.push({
      name,
      group: get(cells, "圈层") || UNFILED,
      blurb: get(cells, "一句话"),
      relation: get(cells, "与轩瑜"),
      source: get(cells, "来源"),
    });
  }
  return out;
}

/** 解析事节点表。 */
export function parseEventsTable(sec: string): EventNode[] {
  const rows = tableRows(sec);
  if (rows.length === 0) return [];
  const idx = headerIndex(rows[0], ["事件", "状态", "关联人", "来源"]);
  if (!idx.has("事件")) return [];
  const get = (cells: string[], key: string): string => {
    const i = idx.get(key);
    return i === undefined ? "" : (cells[i] ?? "");
  };
  const out: EventNode[] = [];
  for (const cells of rows.slice(1)) {
    if (cells.every((c) => c === "")) continue;
    if (/^:?-{3,}:?$/.test(cells[0])) continue;
    const name = get(cells, "事件");
    if (!name) continue;
    out.push({ name, status: get(cells, "状态"), people: get(cells, "关联人"), source: get(cells, "来源") });
  }
  return out;
}

/** 整页解析入口：lastChecked + 人物表 + 事节点表，永不 throw。 */
export function parsePersonGraph(md: string): PersonGraphData {
  try {
    return {
      lastChecked: parseLastChecked(md),
      people: parsePeopleTable(sectionOf(md, "人物节点")),
      events: parseEventsTable(sectionOf(md, "事节点")),
      links: parseLinksTable(sectionOf(md, "连线")),
    };
  } catch (e) {
    return { lastChecked: null, people: [], events: [], links: [], error: (e as Error).message };
  }
}

export interface PersonGraphData {
  lastChecked: string | null;
  people: PersonNode[];
  events: EventNode[];
  links: LinkEdge[]; // 人物/事节点之间的连线（星型中心连线另由前端生成）
  error?: string; // 文件不可读等整页级问题；表格级坏行不算
}

export interface LinkEdge {
  a: string; // 人物A（须与人物/事节点名一致，对不上的边前端静默跳过）
  b: string; // 人物B
  note: string; // 一句话说明（画在连线标签上）
}

/** 解析连线表（## 连线：人物A|人物B|一句话）。 */
export function parseLinksTable(sec: string): LinkEdge[] {
  const rows = tableRows(sec);
  if (rows.length === 0) return [];
  const idx = headerIndex(rows[0], ["人物A", "人物B", "一句话"]);
  if (!idx.has("人物A") || !idx.has("人物B")) return [];
  const get = (cells: string[], key: string): string => {
    const i = idx.get(key);
    return i === undefined ? "" : (cells[i] ?? "");
  };
  const out: LinkEdge[] = [];
  for (const cells of rows.slice(1)) {
    if (cells.every((c) => c === "")) continue;
    if (/^:?-{3,}:?$/.test(cells[0])) continue;
    const a = get(cells, "人物A");
    const b = get(cells, "人物B");
    if (!a || !b) continue;
    out.push({ a, b, note: get(cells, "一句话") });
  }
  return out;
}
