// 云端模型配置：读写 openclaw.json 的 aliyun-maas provider（经 vite 中间件），
// 保存后 gateway 热重载，立即以这里的 URL/key 为准（覆盖环境变量里的 DASHSCOPE_API_KEY）。
import { useEffect, useState } from "react";
import { useAppStore } from "../store/useAppStore";

export default function CloudConfigModal() {
  const open = useAppStore((s) => s.cloudOpen);
  const setOpen = useAppStore((s) => s.setCloudOpen);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [current, setCurrent] = useState<{ baseUrl: string; apiKeyMasked: string; hasKey: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!open) return;
    setMsg("");
    setErr("");
    setApiKey("");
    fetch("/__rana/provider-config")
      .then((r) => r.json())
      .then((d: { baseUrl?: string; apiKeyMasked?: string; hasKey?: boolean }) => {
        setCurrent({ baseUrl: d.baseUrl ?? "", apiKeyMasked: d.apiKeyMasked ?? "", hasKey: Boolean(d.hasKey) });
        setBaseUrl(d.baseUrl ?? "");
      })
      .catch((e: Error) => setErr("读取失败：" + e.message));
  }, [open]);

  if (!open) return null;

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setMsg("");
    setErr("");
    try {
      const res = await fetch("/__rana/provider-config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl, apiKey: apiKey.trim() || undefined }),
      });
      const d = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !d.ok) throw new Error(d.error ?? "保存失败");
      setMsg("已保存，gateway 已热重载——之后的云端调用以这里为准");
      setCurrent((c) => (c ? { ...c, baseUrl } : c));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={() => setOpen(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>云端模型</h3>
          <button className="up-collapse" title="关闭" onClick={() => setOpen(false)}>
            ✕
          </button>
        </div>

        <section className="set-section">
          <h4>接口地址（Base URL）</h4>
          <input
            className="set-input"
            type="text"
            placeholder="https://…/compatible-mode/v1"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
          <div className="set-hint">
            token-plan 端点形如 https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
          </div>
        </section>

        <section className="set-section">
          <h4>API Key {current?.hasKey ? <em className="set-hint">（当前 {current.apiKeyMasked}，留空则保持不变）</em> : null}</h4>
          <input
            className="set-input"
            type="password"
            placeholder={current?.hasKey ? "输入新 key 覆盖" : "sk-…"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <div className="set-hint">保存后写入配置并热重载，优先于系统环境变量 DASHSCOPE_API_KEY</div>
        </section>

        {err && <div className="set-error">⚠ {err}</div>}
        {msg && <div className="set-ok">✓ {msg}</div>}

        <div className="modal-foot">
          <button className="btn" onClick={() => void save()} disabled={busy || !baseUrl.trim()}>
            {busy ? "保存中…" : "保存并生效"}
          </button>
        </div>
      </div>
    </div>
  );
}
