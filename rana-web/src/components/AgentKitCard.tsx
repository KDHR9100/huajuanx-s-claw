// 右侧面板底部：当前会话所属智能体的技能与 MCP 扩展清单（只读）。
// 数据走 /__rana/agent-info（vite 中间件跑 openclaw CLI 拿真清单，120s 缓存）；
// main / rana-rp 两个智能体的装备不一样，切会话时自动跟着换。
import { useCallback, useEffect, useState } from "react";
import { useAppStore } from "../store/useAppStore";

interface SkillRow {
  name: string;
  description?: string;
  emoji?: string;
  source?: string;
}
interface AgentInfo {
  agent: string;
  skills: SkillRow[];
  mcp: Array<{ id: string }>;
}

export default function AgentKitCard() {
  const sessions = useAppStore((s) => s.sessions);
  const currentKey = useAppStore((s) => s.currentKey);
  const agentId = sessions.find((s) => s.key === currentKey)?.agentId ?? "main";

  const [data, setData] = useState<AgentInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(async (agent: string, refresh = false) => {
    setLoading(true);
    setErr("");
    try {
      const r = await fetch(`/__rana/agent-info?agent=${encodeURIComponent(agent)}${refresh ? "&refresh=1" : ""}`);
      const j = (await r.json()) as AgentInfo & { error?: string };
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setData(j);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(agentId);
  }, [agentId, load]);

  return (
    <>
      <div className="up-card kit-card">
        <div className="kit-head">
          <div className="k">
            🛠 技能
            <small>
              {agentId} · {data && data.agent === agentId ? `${data.skills.length} 个` : loading ? "……" : "—"}
            </small>
          </div>
          <button className="up-collapse" title="重新拉取" onClick={() => void load(agentId, true)}>
            ↻
          </button>
        </div>
        {err && <div className="tune-hint err">⚠ {err}</div>}
        {data && data.agent === agentId && data.skills.length === 0 && !err && (
          <div className="tune-hint">这个智能体没有可见技能</div>
        )}
        {data && data.agent === agentId && data.skills.length > 0 && (
          <div className="kit-list">
            {data.skills.map((s) => (
              <div key={s.name} className="skill-row" title={s.description || s.name}>
                <span className="sk-name">
                  {s.emoji && <i className="sk-emoji">{s.emoji}</i>}
                  {s.name}
                  {s.source === "openclaw-workspace" && <span className="sk-mine">自装</span>}
                </span>
                {s.description && <span className="sk-desc">{s.description}</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="up-card kit-card">
        <div className="kit-head">
          <div className="k">
            🔌 MCP 扩展<small>{data && data.agent === agentId ? `${data.mcp.length} 个` : loading ? "……" : "—"}</small>
          </div>
        </div>
        {data && data.agent === agentId && data.mcp.length > 0 ? (
          <div className="mcp-chips">
            {data.mcp.map((m) => (
              <span key={m.id} className="chip">
                {m.id}
              </span>
            ))}
          </div>
        ) : (
          <div className="tune-hint">没配 MCP 服务器</div>
        )}
        <div className="tune-hint">记忆 / 联网搜索 / 文档查询这类外挂工具</div>
      </div>
    </>
  );
}
