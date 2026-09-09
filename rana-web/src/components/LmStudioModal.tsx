// 本地模型管理面板：列出 LM Studio 已下载模型，按参数加载/卸载。
// 加载参数作用于 LM Studio 的模型加载（上下文长度、Flash Attention、KV cache 位置）；
// 采样参数（温度等）不在此处——那是每次请求下发的，归模型选择器/OpenClaw 配置管。
import { useCallback, useEffect, useState } from "react";
import { useAppStore } from "../store/useAppStore";
import { fmtBytes, listModels, loadModel, unloadModel, type LmModel } from "../lib/lmstudio";

export default function LmStudioModal() {
  const open = useAppStore((s) => s.lmOpen);
  const setOpen = useAppStore((s) => s.setLmOpen);
  const [models, setModels] = useState<LmModel[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null); // 正在加载/卸载的模型 key
  const [ctxLength, setCtxLength] = useState(32768);
  const [flashAttn, setFlashAttn] = useState(true);
  const [kvOnGpu, setKvOnGpu] = useState(true);

  const refresh = useCallback(async () => {
    setError("");
    try {
      setModels(await listModels());
    } catch (e) {
      setModels(null);
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  if (!open) return null;

  const loaded = (models ?? []).filter((m) => m.instances.length > 0);
  const unloaded = (models ?? []).filter((m) => m.instances.length === 0);

  const doLoad = async (m: LmModel) => {
    if (busy) return;
    setBusy(m.key);
    setError("");
    try {
      // 上下文长度不超过模型上限
      const cap = m.maxContextLength ?? ctxLength;
      await loadModel(m.key, {
        contextLength: Math.min(ctxLength, cap),
        flashAttention: flashAttn,
        offloadKvToGpu: kvOnGpu,
      });
      await refresh();
    } catch (e) {
      setError(`加载 ${m.displayName} 失败：${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  const doUnload = async (m: LmModel, instanceId: string) => {
    if (busy) return;
    setBusy(m.key);
    setError("");
    try {
      await unloadModel(instanceId);
      await refresh();
    } catch (e) {
      setError(`卸载 ${m.displayName} 失败：${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="modal-overlay" onClick={() => setOpen(false)}>
      <div className="modal lm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>本地模型（LM Studio）</h3>
          <div className="lm-head-actions">
            <button className="btn ghost" onClick={() => void refresh()} disabled={busy !== null}>
              ↻ 刷新
            </button>
            <button className="up-collapse" title="关闭" onClick={() => setOpen(false)}>
              ✕
            </button>
          </div>
        </div>

        {models === null && !error && <div className="set-hint">正在连接 LM Studio…</div>}
        {error && (
          <div className="set-error">
            ⚠ {error}
            <div className="set-hint" style={{ marginTop: 4 }}>
              请确认 LM Studio 已启动，且 Developer → Server 正在运行（127.0.0.1:1234）
            </div>
          </div>
        )}

        {models !== null && (
          <>
            <section className="set-section">
              <h4>已加载（{loaded.length}）</h4>
              {loaded.length === 0 && <div className="set-hint">暂无已加载模型</div>}
              {loaded.map((m) =>
                m.instances.map((inst) => (
                  <div className="lm-row loaded" key={inst.id}>
                    <div className="lm-info">
                      <span className="lm-name">
                        {m.type === "embedding" ? "🔤" : "💬"} {m.displayName}
                      </span>
                      <span className="lm-sub">
                        {m.quantization} · {fmtBytes(m.sizeBytes)}
                        {inst.contextLength ? ` · ${(inst.contextLength / 1024).toFixed(0)}K ctx` : ""}
                      </span>
                    </div>
                    <button
                      className="btn ghost"
                      disabled={busy !== null}
                      onClick={() => void doUnload(m, inst.id)}
                      title={`卸载实例 ${inst.id}`}
                    >
                      {busy === m.key ? "…" : "卸载"}
                    </button>
                  </div>
                )),
              )}
            </section>

            <section className="set-section">
              <h4>加载选项</h4>
              <div className="set-row">
                <label className="set-hint">上下文长度</label>
                <select
                  className="set-input"
                  value={ctxLength}
                  onChange={(e) => setCtxLength(Number(e.target.value))}
                >
                  {[4096, 8192, 16384, 32768, 65536, 131072].map((v) => (
                    <option key={v} value={v}>
                      {(v / 1024).toFixed(0)}K
                    </option>
                  ))}
                </select>
              </div>
              <label className="lm-check">
                <input type="checkbox" checked={flashAttn} onChange={(e) => setFlashAttn(e.target.checked)} />
                Flash Attention（省显存、提速）
              </label>
              <label className="lm-check">
                <input type="checkbox" checked={kvOnGpu} onChange={(e) => setKvOnGpu(e.target.checked)} />
                KV cache 放显存（取消则放内存，速度换容量）
              </label>
              <div className="set-hint">实际加载时若超过模型上限会自动截断</div>
            </section>

            <section className="set-section">
              <h4>可加载（{unloaded.length}）</h4>
              {unloaded.length === 0 && <div className="set-hint">所有已下载模型均已加载</div>}
              {unloaded.map((m) => (
                <div className="lm-row" key={m.key}>
                  <div className="lm-info">
                    <span className="lm-name">
                      {m.type === "embedding" ? "🔤" : "💬"} {m.displayName}
                    </span>
                    <span className="lm-sub">
                      {m.publisher} · {m.quantization} · {fmtBytes(m.sizeBytes)}
                      {m.params ? ` · ${m.params}` : ""}
                      {m.maxContextLength ? ` · 最大 ${(m.maxContextLength / 1024).toFixed(0)}K ctx` : ""}
                    </span>
                  </div>
                  <button className="btn" disabled={busy !== null} onClick={() => void doLoad(m)}>
                    {busy === m.key ? "加载中…" : "加载"}
                  </button>
                </div>
              ))}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
