import { execFileP } from "../lib/exec";
import { STATE_HOME, OPENCLAW_MJS } from "../lib/paths";
import { readFullConfig } from "../lib/config";
import type { Plugin } from "vite";

/**
 * 智能体装备端点（只读，给右侧面板的技能/MCP 卡用）：
 * GET /__rana/agent-info?agent=main[&refresh=1] → {agent, skills[], mcp[]}
 * - 技能：子进程跑 openclaw CLI `skills list --json`（node 直跑 openclaw.mjs，不走 .cmd shim——
 *   Windows 下 execFile 跑不了 .cmd；env 必须带 OPENCLAW_STATE_DIR），只留 modelVisible 且未停用的，
 *   自装（workspace 来源）排前面。结果按 agent 缓存 120s，refresh=1 强制刷新。
 * - MCP：读 openclaw.json 的 mcp.servers，只回 server id，command/args/env 一律不外传。
 */
export function ranaAgentInfoMiddleware(): Plugin {
  const CACHE_MS = 120000;
  const AGENT_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
  const cache = new Map<string, { at: number; data: unknown }>();

  const listSkills = async (agentId: string) => {
    const { stdout } = await execFileP(
      process.execPath,
      [OPENCLAW_MJS, "skills", "list", "--json", "--agent", agentId],
      {
        encoding: "utf8",
        timeout: 20000,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, OPENCLAW_STATE_DIR: STATE_HOME },
      },
    );
    const j = JSON.parse(stdout) as {
      skills?: Array<{ name?: string; description?: string; emoji?: string; source?: string; modelVisible?: boolean; disabled?: boolean }>;
    };
    const rows = (j.skills ?? [])
      .filter((s) => s.modelVisible && !s.disabled && s.name)
      .map((s) => ({
        name: String(s.name),
        description: String(s.description ?? "").trim().slice(0, 140),
        emoji: s.emoji ? String(s.emoji) : "",
        source: s.source ? String(s.source) : "",
      }));
    // 自装的（workspace 来源）排前面，其余按名字排
    rows.sort(
      (a, b) =>
        (a.source === "openclaw-workspace" ? 0 : 1) - (b.source === "openclaw-workspace" ? 0 : 1) ||
        a.name.localeCompare(b.name),
    );
    return rows;
  };

  const listMcp = () => {
    const cfg = readFullConfig() as { mcp?: { servers?: Record<string, unknown> } };
    return Object.keys(cfg.mcp?.servers ?? {}).map((id) => ({ id }));
  };

  const handler = (
    req: { method?: string; url?: string },
    res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string) => void },
  ) => {
    res.setHeader("content-type", "application/json");
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }
    const u = new URL(req.url ?? "/", "http://x");
    const agentId = (u.searchParams.get("agent") ?? "main").toLowerCase();
    const refresh = u.searchParams.get("refresh") === "1";
    if (!AGENT_RE.test(agentId)) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "agent id 格式不对" }));
      return;
    }
    const hit = cache.get(agentId);
    if (!refresh && hit && Date.now() - hit.at < CACHE_MS) {
      res.end(JSON.stringify(hit.data));
      return;
    }
    listSkills(agentId)
      .then((skills) => {
        const data = { agent: agentId, skills, mcp: listMcp() };
        cache.set(agentId, { at: Date.now(), data });
        res.end(JSON.stringify(data));
      })
      .catch((e: Error) => {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: `技能清单拿不到：${e.message}` }));
      });
  };

  return {
    name: "rana-agent-info",
    configureServer(server) {
      server.middlewares.use("/__rana/agent-info", handler as Parameters<typeof server.middlewares.use>[1]);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/__rana/agent-info", handler as Parameters<typeof server.middlewares.use>[1]);
    },
  };
}
