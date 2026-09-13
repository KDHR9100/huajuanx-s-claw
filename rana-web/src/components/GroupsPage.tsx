// 群画像页：展示 QQ 公共号自己养出来的群画像/群友画像/周报（她每晚 4:30 自己更新），
// 外加「总结模型」选择器——走网关 WS RPC cron.update 改两个画像任务的 payload.model（空 = 跟随她的主力模型）。
// 画像文件由她写（group-analyst skill），页面经 /__rana/qq-profile 只读展示，零写入。
import { useCallback, useEffect, useState } from "react";
import { gateway } from "../lib/gateway";
import { useAppStore } from "../store/useAppStore";
import { modelSuffix } from "../lib/types";

interface MdFile {
  key: string;
  title: string;
  updated: string;
  names?: string;
  alias?: string;
  mtime: number;
  md: string;
}
interface ProfileData {
  groups: MdFile[];
  members: MdFile[];
  reports: MdFile[];
  generatedAt: number;
}
interface CronJobLite {
  id: string;
  name: string;
  agentId?: string;
  payload?: { model?: string } & Record<string, unknown>;
}

const PROFILE_JOBS = ["群画像每日增量", "群画像周报"];
const fmtTime = (ms: number) => {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export default function GroupsPage() {
  const models = useAppStore((s) => s.models);
  const [data, setData] = useState<ProfileData | null>(null);
  const [error, setError] = useState("");
  const [jobs, setJobs] = useState<CronJobLite[]>([]);
  const [savingModel, setSavingModel] = useState(false);
  const [modelMsg, setModelMsg] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/__rana/qq-profile");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData((await r.json()) as ProfileData);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const loadJobs = useCallback(async () => {
    try {
      const res = (await gateway.request("cron.list", {})) as { jobs?: CronJobLite[] };
      setJobs((res.jobs ?? []).filter((j) => j.agentId === "rana-qq-public" && PROFILE_JOBS.includes(j.name)));
    } catch {
      // 网关没连上就不显示模型状态，不挡画像展示
    }
  }, []);

  useEffect(() => {
    void load();
    void loadJobs();
  }, [load, loadJobs]);

  const cronModel = jobs[0]?.payload?.model ?? "";
  const allPinned = jobs.length > 0 && jobs.every((j) => j.payload?.model === cronModel && Boolean(cronModel));

  const setModel = async (model: string) => {
    if (savingModel) return;
    setSavingModel(true);
    setModelMsg("");
    try {
      for (const j of jobs) {
        const payload: Record<string, unknown> = { ...(j.payload ?? {}) };
        if (model) payload.model = model;
        else delete payload.model;
        await gateway.request("cron.update", { id: j.id, patch: { payload } });
      }
      setModelMsg(model ? `总结模型已钉在 ${modelSuffix(model)}` : "总结模型已改回跟随主力");
      await loadJobs();
    } catch (e) {
      setModelMsg(`切换失败：${(e as Error).message}`);
    } finally {
      setSavingModel(false);
    }
  };

  const groups = data?.groups ?? [];
  const members = data?.members ?? [];
  const reports = data?.reports ?? [];

  return (
    <div className="wallboard">
      <div className="board-inner" style={{ maxWidth: 1000 }}>
        <div className="page-intro">
          <h2>群画像</h2>
          <p>
            群里的她自己养的记忆：每晚 4:30 翻增量，周日 21:00 出周报 · {data ? `更新于 ${fmtTime(data.generatedAt)}` : ""}
            {error && <span className="sys-err">（{error}）</span>}
          </p>
        </div>

        {/* 总结模型选择器 */}
        <div className="card" style={{ marginBottom: 16 }}>
          <h3>
            🧠 画像总结模型 <small>{jobs.length ? (cronModel ? `当前钉在 ${modelSuffix(cronModel)}` : "当前跟随主力") : "网关未连接"}</small>
          </h3>
          <div className="plans">
            <button className={`plan${!allPinned ? " on" : ""}`} disabled={savingModel || !jobs.length} onClick={() => void setModel("")} title="画像任务跟随 rana-qq-public 的主力模型">
              跟随主力
            </button>
            {models.map((m) => (
              <button
                key={m.id}
                className={`plan${allPinned && modelSuffix(cronModel) === modelSuffix(m.id) ? " on" : ""}`}
                disabled={savingModel || !jobs.length}
                onClick={() => void setModel(m.id)}
              >
                {modelSuffix(m.id)}
              </button>
            ))}
          </div>
          {modelMsg && <div className="plan-hint">{modelMsg}</div>}
          <div className="plan-hint">文字模型看不懂群里的图（只会记「谁发了图」）；想让她看懂，把多模态模型（qwen-vl / glm-4.5v 类）配进云端模型后在这里选它。</div>
        </div>

        {groups.length === 0 && members.length === 0 && (
          <div className="card pending">
            <p className="pending-text">
              画像还没攒出来。等群里有几句闲聊，她今晚 4:30 就会自己写下第一批。——她现在认识谁、群里什么氛围，都会出现在这儿。
            </p>
          </div>
        )}

        {groups.length > 0 && (
          <div className="card" style={{ marginBottom: 16 }}>
            <h3>
              💬 群 <small>{groups.length} 个活跃群</small>
            </h3>
            {groups.map((g) => (
              <details key={g.key} className="profile-fold">
                <summary>
                  <b>{g.alias || g.title}</b>
                  <small className="pf-meta">
                    {g.updated && `已整理至 ${g.updated}`} · {fmtTime(g.mtime)}
                  </small>
                </summary>
                <pre className="profile-md">{g.md}</pre>
              </details>
            ))}
          </div>
        )}

        {members.length > 0 && (
          <div className="card" style={{ marginBottom: 16 }}>
            <h3>
              🧑‍🤝‍🧑 群友 <small>{members.length} 人的画像</small>
            </h3>
            {members.map((m) => (
              <details key={m.key} className="profile-fold">
                <summary>
                  <b>{m.names ?? m.title}</b>
                  <small className="pf-meta">{fmtTime(m.mtime)}</small>
                </summary>
                <pre className="profile-md">{m.md}</pre>
              </details>
            ))}
          </div>
        )}

        {reports.length > 0 && (
          <div className="card">
            <h3>
              📰 周报 <small>每周日 21:00 出刊</small>
            </h3>
            {reports.map((r) => (
              <details key={r.key} className="profile-fold" open={r === reports[0]}>
                <summary>
                  <b>{r.title}</b>
                  <small className="pf-meta">{fmtTime(r.mtime)}</small>
                </summary>
                <pre className="profile-md">{r.md}</pre>
              </details>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
