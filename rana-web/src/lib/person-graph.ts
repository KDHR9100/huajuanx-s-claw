// 人物图谱前端小工具：把解析出的结构化数据拼成 mermaid 图定义（纯函数，tests/unit 有对照测试）。
import type { PersonGraphData } from "../../server/lib/person-graph-parse";

/** mermaid 标签转义：引号/方括号/尖括号是 mermaid 语法字符，统一换全角防断裂。 */
export function escLabel(s: string): string {
  return s
    .replace(/"/g, "#quot;")
    .replace(/\[/g, "（")
    .replace(/\]/g, "）")
    .replace(/</g, "＜")
    .replace(/>/g, "＞");
}

/** 数据 -> mermaid flowchart 定义（星型拓扑：所有节点连中心，按圈层 subgraph 分组）。 */
export function buildMermaidDef(data: PersonGraphData, centerLabel = "轩瑜"): string {
  const lines: string[] = ["graph LR", `  XY(("${escLabel(centerLabel)}"))`];
  const groups = new Map<string, number[]>();
  data.people.forEach((p, k) => {
    const arr = groups.get(p.group) ?? [];
    arr.push(k);
    groups.set(p.group, arr);
  });
  let gi = 0;
  for (const [g, ks] of groups) {
    lines.push(`  subgraph SG${gi}["${escLabel(g)}"]`);
    for (const k of ks) lines.push(`    n${k}["${escLabel(data.people[k].name)}"]`);
    lines.push("  end");
    gi++;
  }
  if (data.events.length) {
    lines.push(`  subgraph SGEV["事件"]`);
    data.events.forEach((e, k) => lines.push(`    ev${k}["${escLabel(e.name)}"]`));
    lines.push("  end");
  }
  for (let k = 0; k < data.people.length; k++) lines.push(`  XY --- n${k}`);
  data.events.forEach((_, k) => lines.push(`  XY --- ev${k}`));
  lines.push(`  classDef center fill:#77DD77,stroke:#4a9e57,color:#000;`);
  lines.push("  class XY center");
  return lines.join("\n");
}
