import path from "node:path";
import { execFileP } from "../lib/exec";
import { STATE_HOME, resolveOpenclawMjs } from "../lib/paths";
import { json, isLoopback } from "../lib/http";
import type { Plugin } from "vite";

/**
 * 审批端点：GET /__rana/approvals（快照）、POST /__rana/approvals（批准/拒绝）。
 * 快照直读 state 库：operator_approvals 表（未决 = resolved_at_ms 为空；历史 = 已决最近 60 条）
 * + exec_approvals_config 的 raw_json（只回 allowlist 条目，socket/token 一律剥掉不外发）。
 * POST 经官方 CLI（approvals resolve <id> allow-once|deny）——resolve 有闸门语义，不直接写库。
 * ?withGrants=1 时额外跑一次 CLI approvals grants list（子进程 1~3s，仅页面打开/手动刷新用，
 * 轮询角标别带）。仅本机可访问。
 */
export function ranaApprovalsMiddleware(): Plugin {
  const DB_FILE = path.join(STATE_HOME, "state", "openclaw.sqlite");
  const HISTORY_LIMIT = 60;




  type Row = Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" ? v : Number(v) || 0);
  const pickPresentation = (raw: unknown): { commandText?: string; warningText?: string } => {
    try {
      const p = JSON.parse(String(raw ?? "{}")) as { commandText?: string; warningText?: string };
      return { commandText: p.commandText, warningText: p.warningText };
    } catch {
      return {};
    }
  };
  const toApproval = (r: Row) => ({
    id: String(r.approval_id ?? ""),
    kind: String(r.kind ?? ""),
    commandText: pickPresentation(r.presentation_json).commandText ?? "",
    warningText: pickPresentation(r.presentation_json).warningText ?? "",
    sessionKey: String(r.source_session_key ?? ""),
    agentId: String(r.source_agent_id ?? ""),
    createdAtMs: num(r.created_at_ms),
    expiresAtMs: num(r.expires_at_ms),
    resolvedAtMs: r.resolved_at_ms === null || r.resolved_at_ms === undefined ? null : num(r.resolved_at_ms),
    decision: r.decision === null || r.decision === undefined ? null : String(r.decision),
    terminalReason: r.terminal_reason === null || r.terminal_reason === undefined ? null : String(r.terminal_reason),
    resolverId: r.resolver_id === null || r.resolver_id === undefined ? null : String(r.resolver_id),
    status: String(r.status ?? ""),
  });

  const readSnapshot = async () => {
    // 每次请求新开只读连接：库被网关 WAL 占用，只读打开安全（cron-session-cleanup 先例）
    const { DatabaseSync } = (await import("node:sqlite")) as typeof import("node:sqlite");
    const db = new DatabaseSync(DB_FILE, { readOnly: true });
    try {
      const pending = db
        .prepare("SELECT * FROM operator_approvals WHERE resolved_at_ms IS NULL ORDER BY created_at_ms DESC")
        .all()
        .map(toApproval);
      const history = db
        .prepare(`SELECT * FROM operator_approvals WHERE resolved_at_ms IS NOT NULL ORDER BY resolved_at_ms DESC LIMIT ${HISTORY_LIMIT}`)
        .all()
        .map(toApproval);
      let allowlist: Array<{ pattern: string; lastUsedAtMs?: number }> = [];
      try {
        const cfg = db.prepare("SELECT raw_json FROM exec_approvals_config WHERE config_key='current'").get() as Row | undefined;
        const parsed = JSON.parse(String(cfg?.raw_json ?? "{}")) as {
          agents?: Record<string, { allowlist?: Array<{ pattern?: string; lastUsedAt?: number }> }>;
        };
        for (const agent of Object.values(parsed.agents ?? {})) {
          for (const item of agent.allowlist ?? []) {
            if (item?.pattern) allowlist.push({ pattern: item.pattern, lastUsedAtMs: item.lastUsedAt });
          }
        }
      } catch {
        // allowlist 解析失败不影响主数据
      }
      return { pending, history, allowlist };
    } finally {
      db.close();
    }
  };

  const runCli = async (args: string[]) => {
    const { stdout, stderr } = await execFileP(process.execPath, [resolveOpenclawMjs(), ...args], {
      timeout: 25_000,
      windowsHide: true,
      env: { ...process.env, OPENCLAW_STATE_DIR: STATE_HOME },
    });
    return `${stdout}${stderr}`.trim();
  };

  const handler = async (
    req: {
      method?: string;
      url?: string;
      headers?: Record<string, unknown>;
      socket?: { remoteAddress?: string };
      on: (ev: string, cb: (c?: string) => void) => void;
    },
    res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string) => void },
  ) => {
    if (!isLoopback(req)) {
      json(res, 403, { error: "仅本机可访问" });
      return;
    }
    const u = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET") {
      try {
        const snap = await readSnapshot();
        let grants = "";
        if (u.searchParams.get("withGrants") === "1") {
          try {
            grants = await runCli(["approvals", "grants", "list"]);
          } catch (e) {
            grants = `读取失败：${(e as Error).message}`;
          }
        }
        json(res, 200, { ...snap, grants });
      } catch (e) {
        json(res, 500, { error: `读审批数据失败：${(e as Error).message}` });
      }
      return;
    }
    if (req.method === "POST") {
      const chunks: string[] = [];
      req.on("data", (c?: string) => chunks.push(c ?? ""));
      req.on("end", () => {
        void (async () => {
          let body: { id?: string; decision?: string } = {};
          try {
            body = JSON.parse(chunks.join("") || "{}") as typeof body;
          } catch {
            /* 空 Body */
          }
          const id = String(body.id ?? "");
          const decision = String(body.decision ?? "");
          if (!id || !["allow-once", "deny"].includes(decision)) {
            json(res, 400, { error: "参数不对（id + decision=allow-once|deny）" });
            return;
          }
          try {
            const out = await runCli(["approvals", "resolve", id, decision]);
            json(res, 200, { ok: true, output: out.slice(0, 2000) });
          } catch (e) {
            json(res, 502, { error: `处理失败：${(e as Error).message}` });
          }
        })();
      });
      return;
    }
    json(res, 405, { error: "method not allowed" });
  };

  return {
    name: "rana-approvals",
    configureServer(server) {
      server.middlewares.use("/__rana/approvals", handler as Parameters<typeof server.middlewares.use>[1]);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/__rana/approvals", handler as Parameters<typeof server.middlewares.use>[1]);
    },
  };
}
