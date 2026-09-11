// 会话页右侧面板下半部：本地模型超参数调节 + 快捷命令。
// 超参数只在当前会话模型是本地 provider（baseUrl 为回环地址）时显示；
// 保存写入 openclaw.json 的 provider.models[].params（网关热重载，对该模型的所有会话生效）。
import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore } from "../store/useAppStore";
import { gateway } from "../lib/gateway";

interface ProviderRow {
  id: string;
  local: boolean;
  models: Array<{ id: string; params?: Record<string, number | undefined> }>;
}

const NUM_KEYS = [
  { key: "temperature", label: "温度 temperature", min: 0, max: 2, step: 0.05, hint: "越高越放飞，越低越稳定" },
  { key: "top_p", label: "top_p 采样", min: 0, max: 1, step: 0.01, hint: "控制候选词范围" },
  { key: "repeat_penalty", label: "重复惩罚", min: 0.8, max: 1.5, step: 0.01, hint: "越高越不容易复读" },
] as const;

export default function ModelTuningCard() {
  const sessions = useAppStore((s) => s.sessions);
  const currentKey = useAppStore((s) => s.currentKey);
  const row = sessions.find((s) => s.key === currentKey);
  const rawModel = row?.model ?? "";
  // 会话里的 model 可能带 provider 前缀也可能不带，统一取短 ID
  const shortModel = rawModel.includes("/") ? rawModel.slice(rawModel.indexOf("/") + 1) : rawModel;

  const [provs, setProvs] = useState<ProviderRow[] | null>(null);
  const [values, setValues] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState("");
  const [err, setErr] = useState("");

  // 归属：短 ID 在哪个 provider 里就归谁；本地 provider 优先
  const owner = provs?.filter((p) => p.models.some((m) => m.id === shortModel));
  const localOwner = owner?.find((p) => p.local);
  const isLocal = Boolean(localOwner);
  const providerId = localOwner?.id ?? owner?.[0]?.id ?? "";

  const loadProviders = useCallback(async () => {
    try {
      const r = await fetch("/__rana/provider-config");
      const j = (await r.json()) as { providers?: ProviderRow[] };
      setProvs(j.providers ?? []);
    } catch {
      setProvs([]);
    }
  }, []);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  // 回填现值：只在模型切换时重置，避免保存后刷新 provider 列表把成功提示清掉
  const provsRef = useRef<ProviderRow[] | null>(null);
  provsRef.current = provs;
  const modelKey = `${providerId}/${shortModel}`;
  useEffect(() => {
    const m = provsRef.current?.find((p) => p.id === providerId)?.models.find((x) => x.id === shortModel);
    const p = (m?.params ?? {}) as Record<string, number>;
    const next: Record<string, number> = {};
    for (const k of NUM_KEYS) if (typeof p[k.key] === "number") next[k.key] = p[k.key];
    setValues(next);
    setSaved("");
    setErr("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelKey]);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setSaved("");
    setErr("");
    try {
      const r = await fetch("/__rana/model-params", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerId, modelId: shortModel, params: values }),
      });
      const j = (await r.json()) as { ok?: boolean; error?: string };
      if (!r.ok || !j.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setSaved("已写入配置，网关热重载后生效（对该模型所有会话生效）");
      void loadProviders();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const runCommand = (cmd: string, confirmMsg?: string) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    if (!currentKey) return;
    void gateway.sendChat(currentKey, cmd);
    setSaved(`已发送 ${cmd}`);
  };

  if (!isLocal) return null;

  return (
    <>
      <div className="up-card tuning-card">
        <div className="k">超参数 · {shortModel}</div>
        {NUM_KEYS.map((k) => (
          <label className="tune-row" key={k.key} title={k.hint}>
            <span className="tune-label">{k.label}</span>
            <span className="tune-val">{values[k.key] ?? "—"}</span>
            <input
              type="range"
              min={k.min}
              max={k.max}
              step={k.step}
              value={values[k.key] ?? k.min}
              disabled={saving}
              onChange={(e) => setValues((v) => ({ ...v, [k.key]: Number(e.target.value) }))}
            />
          </label>
        ))}
        <button className="btn tune-save" onClick={() => void save()} disabled={saving}>
          {saving ? "写入中…" : "保存参数"}
        </button>
        {saved && <div className="tune-hint ok">{saved}</div>}
        {err && <div className="tune-hint err">⚠ {err}</div>}
      </div>

      <div className="up-card quick-card">
        <div className="k">快捷命令</div>
        <div className="quick-row">
          <button
            className="btn ghost quick-btn"
            title="清空当前会话的对话内容（不可恢复）"
            onClick={() => runCommand("/reset", "确定清空当前会话的全部对话内容吗？此操作不可恢复。")}
          >
            ♻ /reset
          </button>
          <button
            className="btn ghost quick-btn"
            title="结束当前会话并换一个新会话"
            onClick={() => runCommand("/new", "确定结束当前会话并换新会话吗？")}
          >
            ✨ /new
          </button>
        </div>
        <div className="tune-hint">发给当前会话，等同手打斜杠命令</div>
      </div>
    </>
  );
}
