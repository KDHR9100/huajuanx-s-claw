// 云端模型多 provider 配置：管理 openclaw.json 的 models.providers（经 vite 中间件），
// 每个档案 = id + baseUrl + apiKey + 模型列表；保存后 gateway 热重载。
// 切换模型在顶栏 ModelPicker 里按 provider 分组直接点选。
import { useEffect, useState } from "react";
import { useAppStore } from "../store/useAppStore";
import { gateway } from "../lib/gateway";

interface ProviderModelRow {
  id: string;
  name?: string;
  contextWindow?: number;
}
interface ProviderRow {
  id: string;
  baseUrl: string;
  apiKeyMasked: string;
  hasKey: boolean;
  local: boolean;
  models: ProviderModelRow[];
}

const NEW_ID = "__new__";

export default function CloudConfigModal() {
  const open = useAppStore((s) => s.cloudOpen);
  const setOpen = useAppStore((s) => s.setCloudOpen);
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [selId, setSelId] = useState<string>("");
  // 新增模式的档案 id（selId 保持 NEW_ID 直到保存成功）
  const [newId, setNewId] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<ProviderModelRow[]>([]);
  const [fetched, setFetched] = useState<string[]>([]);
  const [fetchPick, setFetchPick] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  // 手动添加模型的小表单
  const [mId, setMId] = useState("");
  const [mCtx, setMCtx] = useState("");

  const sel = providers.find((p) => p.id === selId);
  const isNew = selId === NEW_ID;

  const load = () => {
    fetch("/__rana/provider-config")
      .then((r) => r.json())
      .then((d: { providers?: ProviderRow[] }) => {
        const rows = d.providers ?? [];
        setProviders(rows);
        setSelId((cur) => (cur && (cur === NEW_ID || rows.some((p) => p.id === cur)) ? cur : rows[0]?.id ?? ""));
      })
      .catch((e: Error) => setErr("读取失败：" + e.message));
  };

  useEffect(() => {
    if (!open) return;
    setMsg("");
    setErr("");
    setApiKey("");
    setFetched([]);
    setFetchPick({});
    setMId("");
    setMCtx("");
    setNewId("");
    load();
  }, [open]);

  // 选中变化时同步表单字段
  useEffect(() => {
    setBaseUrl(sel?.baseUrl ?? "");
    setModels(sel?.models ?? [] ?? []);
    setApiKey("");
    setFetched([]);
    setFetchPick({});
    setMsg("");
    setErr("");
    setMId("");
    setMCtx("");
  }, [selId]);

  if (!open) return null;

  const patchModel = (id: string, patch: Partial<ProviderModelRow>) =>
    setModels((ms) => ms.map((m) => (m.id === id ? { ...m, ...patch } : m)));

  const addModels = (ids: string[], ctx?: number) =>
    setModels((ms) => {
      const next = ms.slice();
      for (const id of ids) if (!next.some((m) => m.id === id)) next.push({ id, ...(ctx ? { contextWindow: ctx } : {}) });
      return next;
    });

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setMsg("");
    setErr("");
    try {
      const res = await fetch("/__rana/provider-config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: isNew ? newId : selId, baseUrl, apiKey: apiKey.trim() || undefined, models }),
      });
      const d = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !d.ok) throw new Error(d.error ?? "保存失败");
      setMsg("已保存，gateway 已热重载——顶栏选择器即生效");
      setApiKey("");
      load();
      void gateway.refreshModels();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy || !sel || sel.local) return;
    if (!confirm(`删除 provider「${sel.id}」？（会话不受影响，引用它的默认模型会被拒绝删除）`)) return;
    setBusy(true);
    setMsg("");
    setErr("");
    try {
      const res = await fetch(`/__rana/provider-config?id=${encodeURIComponent(sel.id)}`, { method: "DELETE" });
      const d = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !d.ok) throw new Error(d.error ?? "删除失败");
      setMsg(`已删除 ${sel.id}`);
      setSelId("");
      load();
      void gateway.refreshModels();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const doFetch = async () => {
    if (busy) return;
    setBusy(true);
    setMsg("");
    setErr("");
    try {
      const res = await fetch("/__rana/provider-models", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: baseUrl.trim() || undefined, apiKey: apiKey.trim() || undefined, providerId: isNew ? undefined : selId }),
      });
      const d = (await res.json()) as { ok?: boolean; models?: string[]; error?: string };
      if (!res.ok || !d.ok) throw new Error(d.error ?? "拉取失败");
      setFetched(d.models ?? []);
      setFetchPick({});
      setMsg(`拉取到 ${(d.models ?? []).length} 个模型，勾选后点“添加勾选”`);
    } catch (e) {
      setErr("拉取模型列表失败：" + (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const picked = Object.entries(fetchPick).filter(([, v]) => v).map(([k]) => k);

  return (
    <div className="modal-overlay" onClick={() => setOpen(false)}>
      <div className="modal cloud-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>云端模型（多接口档案）</h3>
          <button className="up-collapse" title="关闭" onClick={() => setOpen(false)}>
            ✕
          </button>
        </div>

        <div className="cloud-layout">
          <div className="cloud-list">
            {providers.map((p) => (
              <button
                key={p.id}
                className={`cloud-prov${p.id === selId ? " active" : ""}`}
                onClick={() => setSelId(p.id)}
                title={p.baseUrl}
              >
                <span className="cloud-prov-id">{p.local ? "🖥" : "☁"} {p.id}</span>
                <span className="cloud-prov-meta">{p.models.length} 模型</span>
              </button>
            ))}
            <button className={`cloud-prov${isNew ? " active" : ""}`} onClick={() => setSelId(NEW_ID)}>
              <span className="cloud-prov-id">➕ 新增接口档案</span>
            </button>
          </div>

          <div className="cloud-editor">
            {!isNew && !sel ? (
              <div className="set-hint" style={{ padding: 12 }}>选择左侧档案，或新增一个</div>
            ) : (
              <>
                <section className="set-section">
                  <h4>档案 ID（provider 前缀）</h4>
                  {isNew ? (
                    <>
                      <input
                        className="set-input"
                        type="text"
                        placeholder="例如 aliyun-maas / siliconflow / openrouter"
                        value={newId}
                        onChange={(e) => setNewId(e.target.value.trim().toLowerCase())}
                      />
                      <div className="set-hint">小写字母/数字/连字符；模型会以 「id/模型名」 形式出现在顶栏选择器</div>
                    </>
                  ) : (
                    <div className="set-hint" style={{ fontWeight: 600 }}>{sel?.id}{sel?.local ? "（本地 LM Studio，改配置请编辑 openclaw.json）" : ""}</div>
                  )}
                </section>

                <section className="set-section">
                  <h4>接口地址（Base URL）</h4>
                  <input
                    className="set-input"
                    type="text"
                    placeholder="https://…/v1（OpenAI 兼容）"
                    value={baseUrl}
                    disabled={sel?.local}
                    onChange={(e) => setBaseUrl(e.target.value)}
                  />
                  <div className="set-hint">OpenAI 兼容端点，如 https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1</div>
                </section>

                <section className="set-section">
                  <h4>
                    API Key{" "}
                    {sel?.hasKey ? <em className="set-hint">（当前 {sel.apiKeyMasked}，留空则保持不变）</em> : null}
                  </h4>
                  <input
                    className="set-input"
                    type="password"
                    placeholder={sel?.hasKey ? "输入新 key 覆盖" : "sk-…"}
                    value={apiKey}
                    disabled={sel?.local}
                    onChange={(e) => setApiKey(e.target.value)}
                  />
                </section>

                {!sel?.local && (
                  <section className="set-section">
                    <h4>
                      模型列表（{models.length}）
                      <button className="btn ghost sm" style={{ marginLeft: 8 }} disabled={busy || (!baseUrl.trim() && !sel)} onClick={() => void doFetch()}>
                        ⟳ 从接口拉取
                      </button>
                    </h4>
                    <div className="cloud-models">
                      {models.map((m) => (
                        <div key={m.id} className="cloud-model-row">
                          <input
                            className="set-input grow"
                            type="text"
                            value={m.id}
                            onChange={(e) => {
                              const v = e.target.value;
                              setModels((ms) => ms.map((x) => (x === m ? { ...x, id: v } : x)));
                            }}
                          />
                          <input
                            className="set-input ctx"
                            type="number"
                            min={0}
                            placeholder="ctx"
                            value={m.contextWindow ?? ""}
                            onChange={(e) => patchModel(m.id, { contextWindow: Number(e.target.value) || undefined })}
                          />
                          <button className="s-delete" title="移除模型" onClick={() => setModels((ms) => ms.filter((x) => x.id !== m.id))}>
                            ✕
                          </button>
                        </div>
                      ))}
                      <div className="cloud-model-row">
                        <input className="set-input grow" type="text" placeholder="手动添加：模型 id" value={mId} onChange={(e) => setMId(e.target.value)} />
                        <input className="set-input ctx" type="number" min={0} placeholder="ctx" value={mCtx} onChange={(e) => setMCtx(e.target.value)} />
                        <button
                          className="btn ghost sm"
                          onClick={() => {
                            if (!mId.trim()) return;
                            addModels([mId.trim()], Number(mCtx) || undefined);
                            setMId("");
                            setMCtx("");
                          }}
                        >
                          添加
                        </button>
                      </div>
                    </div>
                    {fetched.length > 0 && (
                      <div className="cloud-fetched">
                        <div className="set-hint">
                          接口返回的模型（勾选后添加）：
                          <button className="btn ghost sm" disabled={!picked.length} onClick={() => { addModels(picked); setFetchPick({}); setFetched(fetched.filter((f) => !picked.includes(f))); }}>
                            添加勾选（{picked.length}）
                          </button>
                        </div>
                        <div className="cloud-fetch-list">
                          {fetched.map((id) => (
                            <label key={id}>
                              <input
                                type="checkbox"
                                checked={Boolean(fetchPick[id])}
                                onChange={(e) => setFetchPick((p) => ({ ...p, [id]: e.target.checked }))}
                              />
                              {id}
                            </label>
                          ))}
                        </div>
                      </div>
                    )}
                  </section>
                )}
              </>
            )}
          </div>
        </div>

        {err && <div className="set-error">⚠ {err}</div>}
        {msg && <div className="set-ok">✓ {msg}</div>}

        <div className="modal-foot">
          {!isNew && sel && !sel.local && (
            <button className="btn danger" onClick={() => void remove()} disabled={busy}>
              删除档案
            </button>
          )}
          <button
            className="btn"
            onClick={() => void save()}
            disabled={
              busy ||
              (!isNew && !sel) ||
              (isNew && !/^[a-z0-9][a-z0-9-]{0,40}$/.test(newId)) ||
              (!sel?.local && !baseUrl.trim()) ||
              (!sel?.local && !apiKey.trim() && !sel?.hasKey)
            }
          >
            {busy ? "处理中…" : "保存并生效"}
          </button>
        </div>
      </div>
    </div>
  );
}
