// 我的生辰档案（支持多人）：名字框右侧下拉切换/新建人，全部存本地 rana-web/.fate/profiles.json
// （gitignore，不入公开仓库）。问卦时中间件会取「当前选中」那份连同命盘发给云端 Rana——隐私代价已说明。
import { useEffect, useState } from "react";

export interface FateProfile {
  id?: string;
  nick: string;
  gender: "男" | "女" | "";
  birthday: string; // YYYY-MM-DD
  birthTime: string; // HH:MM 可空
  birthplace: string;
  savedAt?: number;
}
type ProfileEntry = FateProfile & { id: string };

const EMPTY: FateProfile = { nick: "", gender: "", birthday: "", birthTime: "", birthplace: "" };
const NEW_OPT = "__new__";

const label = (p: ProfileEntry) => p.nick || `${p.gender}·${p.birthday}`;

export default function FateProfileCard({ onSaved }: { onSaved: (p: FateProfile | null) => void }) {
  const [list, setList] = useState<ProfileEntry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null); // null = 正在新建
  const [form, setForm] = useState<FateProfile>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const applyStore = (l: ProfileEntry[], active: string | null) => {
    setList(l);
    setActiveId(active);
    const cur = active ? l.find((p) => p.id === active) ?? null : null;
    setForm(cur ? { ...cur } : { ...EMPTY });
    onSaved(cur);
  };

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch("/__rana/fate/profile");
        const j = (await r.json()) as { list?: ProfileEntry[]; active?: string | null } | { empty: true };
        if (!("empty" in j) && j.list?.length) applyStore(j.list, j.active ?? j.list[0].id);
      } catch {
        /* 首次没档案 */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const post = async (body: Record<string, unknown>) => {
    const r = await fetch("/__rana/fate/profile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = (await r.json()) as { ok?: boolean; list?: ProfileEntry[]; active?: string | null; error?: string };
    if (!r.ok || !j.ok || !j.list) throw new Error(j.error ?? `HTTP ${r.status}`);
    return { list: j.list, active: j.active ?? null };
  };

  const switchTo = async (id: string) => {
    if (busy) return;
    if (id === NEW_OPT) {
      setList((l) => l);
      setActiveId(null);
      setForm({ ...EMPTY });
      onSaved(null);
      return;
    }
    try {
      const s = await post({ action: "select", id });
      applyStore(s.list, s.active);
      setMsg("");
    } catch (e) {
      setMsg(`切换失败：${(e as Error).message}`);
    }
  };

  const save = async () => {
    if (busy) return;
    if (!form.gender) return setMsg("性别要选一下（紫微排盘必需）");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.birthday)) return setMsg("生日要选阳历日期");
    setBusy(true);
    setMsg("");
    try {
      const s = await post({
        action: "save",
        profile: {
          ...(activeId ? { id: activeId } : {}),
          nick: form.nick.trim() || undefined,
          gender: form.gender,
          birthday: form.birthday,
          birthTime: /^\d{2}:\d{2}$/.test(form.birthTime) ? form.birthTime : undefined,
          birthplace: form.birthplace.trim() || undefined,
        },
      });
      applyStore(s.list, s.active);
      setMsg("存好了，就在这台电脑上。");
    } catch (e) {
      setMsg(`存失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy || !activeId) return;
    const cur = list.find((p) => p.id === activeId);
    if (!window.confirm(`删掉「${label(cur!)}」的档案？删了就没了。`)) return;
    setBusy(true);
    try {
      const s = await post({ action: "delete", id: activeId });
      applyStore(s.list, s.active);
      setMsg("");
    } catch (e) {
      setMsg(`删除失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const active = list.find((p) => p.id === activeId) ?? null;

  return (
    <div className="fate-form">
      <div className="sf-row4">
        <input className="set-input" placeholder="怎么称呼（可选）" value={form.nick} onChange={(e) => setForm({ ...form, nick: e.target.value })} />
        <select
          className="set-input sf-pick"
          value={activeId ?? NEW_OPT}
          onChange={(e) => void switchTo(e.target.value)}
          title="切换人（未保存的改动会丢）"
        >
          {list.map((p) => (
            <option key={p.id} value={p.id}>
              {label(p)}
            </option>
          ))}
          <option value={NEW_OPT}>＋ 新建一个人</option>
        </select>
        {activeId && (
          <button className="btn ghost sm" onClick={() => void remove()} disabled={busy} title="删掉当前这个人的档案">
            删
          </button>
        )}
      </div>
      <div className="sf-row">
        <label className="sf-field">
          <span>阳历生日</span>
          <input className="set-input" type="date" value={form.birthday} onChange={(e) => setForm({ ...form, birthday: e.target.value })} />
        </label>
        <label className="sf-field">
          <span>出生时间（选填）</span>
          <input className="set-input" type="time" value={form.birthTime} onChange={(e) => setForm({ ...form, birthTime: e.target.value })} />
        </label>
        <label className="sf-field">
          <span>出生地（选填）</span>
          <input className="set-input" placeholder="如 上海" value={form.birthplace} onChange={(e) => setForm({ ...form, birthplace: e.target.value })} />
        </label>
        <div className="sf-field">
          <span>性别（紫微必需）</span>
          <div className="gender-pick">
            {(["男", "女"] as const).map((g) => (
              <button key={g} type="button" className={`mode-btn${form.gender === g ? " active" : ""}`} onClick={() => setForm({ ...form, gender: g })}>
                {g}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="cc-acts">
        <button className="btn sm" onClick={() => void save()} disabled={busy}>
          {busy ? "存…" : activeId ? "更新档案" : "存为新档案"}
        </button>
        {active && <span className="tune-hint ok">当前：{label(active)} · 存于 {new Date(active.savedAt ?? 0).toLocaleString()}</span>}
        {!activeId && <span className="tune-hint">正在新建：存完自动切换到这个人</span>}
      </div>
      {msg && <p className={`tune-hint ${msg.startsWith("存好了") ? "ok" : "err"}`}>{msg}</p>}
      <p className="tune-hint">
        档案只存在本机（.fate/profiles.json，不入公开仓库），可以记多人、下拉切换。按「问她解卦」时，用的是当前选中的这个人——命盘摘要会发给云端模型，您已知情。
      </p>
    </div>
  );
}
