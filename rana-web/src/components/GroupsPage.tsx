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
/** /__rana/provider-config 返回的 provider 条目（含 baseUrl 与 key 状态，模型是配置文件全量） */
interface ProviderLite {
  id: string;
  baseUrl: string;
  apiKeyMasked: string;
  hasKey: boolean;
  local: boolean;
  models: Array<{ id: string; name?: string; contextWindow?: number }>;
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
  const [providers, setProviders] = useState<ProviderLite[]>([]);
  const [savingModel, setSavingModel] = useState(false);
  const [modelMsg, setModelMsg] = useState("");
  const [running, setRunning] = useState(false);
  const [runMsg, setRunMsg] = useState("");

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

  // provider 全量（含 baseUrl + key 状态）用于把同名模型按"哪家 URL 哪把 KEY"分组
  const loadProviders = useCallback(async () => {
    try {
      const r = await fetch("/__rana/provider-config");
      if (!r.ok) return;
      const d = (await r.json()) as { providers?: ProviderLite[] };
      setProviders(d.providers ?? []);
    } catch {
      // 拉不到就退回平铺展示（不挡画像）
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
    void loadProviders();
  }, [load, loadJobs, loadProviders]);

  const cronModel = jobs[0]?.payload?.model ?? "";
  const allPinned = jobs.length > 0 && jobs.every((j) => j.payload?.model === cronModel && Boolean(cronModel));

  /** 手动补跑每日增量：cron.run 入队，然后轮询画像目录，generatedAt 变了即她写完档（约 12×30s 封顶） */
  const runNow = async () => {
    const daily = jobs.find((j) => j.name === PROFILE_JOBS[0]);
    if (!daily || running) return;
    setRunning(true);
    setRunMsg("已排队，她开始翻增量了……");
    try {
      const res = await gateway.request<{ runId?: string }>("cron.run", { jobId: daily.id });
      setRunMsg(`已排队${res.runId ? `（run ${res.runId.slice(0, 8)}…）` : ""}，她翻完增量写完档，这里会自动刷新。`);
      const before = data?.generatedAt ?? 0;
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 30000));
        try {
          const r = await fetch("/__rana/qq-profile");
          if (!r.ok) continue;
          const d = (await r.json()) as ProfileData;
          setData(d);
          if (d.generatedAt !== before) {
            setRunMsg("画像已更新 ✓");
            break;
          }
        } catch {
          // 单次拉取失败就等下一轮
        }
      }
    } catch (e) {
      setRunMsg(`运行失败：${(e as Error).message}`);
    } finally {
      setRunning(false);
    }
  };

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
  // provider 分组：有 provider-config 数据就按「哪家 URL 哪把 KEY」分组展示，退回平铺
  const hostOf = (url: string) => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  };

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

        {/* 手动补跑（4:30 电脑没开就错过了） */}
        <div className="card" style={{ marginBottom: 16 }}>
          <h3>
            🔄 画像更新 <small>每天 4:30 自动跑；电脑没开着就点这里补</small>
          </h3>
          <div className="dsh-actions">
            <button className="btn" disabled={running || !jobs.length} onClick={() => void runNow()} title={jobs.length ? "立刻跑一次每日增量" : "网关未连接"}>
              {running ? "更新中……" : "立即更新一次"}
            </button>
            {runMsg && <span className="dsh-ok">{runMsg}</span>}
          </div>
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
          </div>
          {providers.length > 0 ? (
            providers.map((p) => (
              <div key={p.id} className="prov-group">
                <div className="prov-head" title={`${p.id} · ${p.baseUrl || "（未配 URL）"} · ${p.hasKey ? p.apiKeyMasked : "无 KEY"}`}>
                  <b>{p.id}</b>
                  {p.baseUrl && <span className="prov-url">{hostOf(p.baseUrl)}</span>}
                  <span className="prov-key">{p.local ? "本机" : p.hasKey ? `🔒 ${p.apiKeyMasked}` : "⚠ 无 KEY"}</span>
                </div>
                <div className="plans">
                  {p.models.length === 0 && <span className="plan-hint">（该 provider 未配模型）</span>}
                  {p.models.map((m) => {
                    const full = `${p.id}/${m.id}`;
                    return (
                      <button
                        key={full}
                        className={`plan${cronModel && (cronModel === full || cronModel.endsWith(`/${m.id}`)) ? " on" : ""}`}
                        disabled={savingModel || !jobs.length}
                        onClick={() => void setModel(full)}
                        title={`${full}${m.contextWindow ? ` · 上下文 ${m.contextWindow}` : ""}`}
                      >
                        {m.id}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))
          ) : (
            <div className="plans">
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
          )}
          {modelMsg && <div className="plan-hint">{modelMsg}</div>}
          <div className="plan-hint">qwen3.8-flash 自带看图（多模态）——钉在它上面，她就能把群里的图看懂、记进画像；换成纯文字模型就只会记「谁发了图」。</div>
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
