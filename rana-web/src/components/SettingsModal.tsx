// 外观设置弹窗：乐奈头像 + 主题色自定义（含历史）+ 夜间模式 + 背景图（上传/URL）+ 不透明度。
import { useRef, useState } from "react";
import { useAppStore } from "../store/useAppStore";
import { PRESET_ACCENTS, pushAccentHistory } from "../lib/theme";
import { RanaAvatar } from "./RanaArt";

const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // dataURL 存 localStorage，控制在 4MB 内

export default function SettingsModal() {
  const open = useAppStore((s) => s.settingsOpen);
  const settings = useAppStore((s) => s.settings);
  const update = useAppStore((s) => s.updateSettings);
  const reset = useAppStore((s) => s.resetSettings);
  const setOpen = useAppStore((s) => s.setSettingsOpen);
  const fileRef = useRef<HTMLInputElement>(null);
  const avatarRef = useRef<HTMLInputElement>(null);
  const [urlValue, setUrlValue] = useState("");
  const [error, setError] = useState("");
  const [avatarBusy, setAvatarBusy] = useState(false);

  if (!open) return null;

  const close = () => {
    setError("");
    setOpen(false);
  };

  /** 上传自定义头像（存本地 .avatars/，不进 localStorage/git） */
  const uploadAvatar = async (file: File | undefined) => {
    if (!file || avatarBusy) return;
    setError("");
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      setError("头像只支持 PNG / JPG / WebP");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setError(`头像太大（${(file.size / 1024 / 1024).toFixed(1)}MB），限 4MB`);
      return;
    }
    setAvatarBusy(true);
    try {
      const r = await fetch("/__rana/avatar", {
        method: "POST",
        headers: { "content-type": file.type },
        body: await file.arrayBuffer(),
      });
      const j = (await r.json()) as { ok?: boolean; url?: string; error?: string };
      if (!r.ok || !j.ok || !j.url) throw new Error(j.error ?? `HTTP ${r.status}`);
      update({ avatarUrl: j.url });
    } catch (e) {
      setError(`头像上传失败：${(e as Error).message}`);
    } finally {
      setAvatarBusy(false);
    }
  };

  const clearAvatar = async () => {
    if (avatarBusy) return;
    setAvatarBusy(true);
    try {
      await fetch("/__rana/avatar", { method: "DELETE" });
      update({ avatarUrl: "" });
    } finally {
      setAvatarBusy(false);
    }
  };

  const pickFile = (file: File | undefined) => {
    if (!file) return;
    setError("");
    if (!file.type.startsWith("image/")) {
      setError("请选择图片文件（PNG/JPG/WebP 等）");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setError(`图片太大（${(file.size / 1024 / 1024).toFixed(1)}MB），请选择 4MB 以内的图片`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        update({ bgImage: String(reader.result) });
      } catch (e) {
        setError((e as Error).message);
      }
    };
    reader.readAsDataURL(file);
  };

  const applyUrl = () => {
    const url = urlValue.trim();
    if (!url) return;
    setError("");
    update({ bgImage: url });
    setUrlValue("");
  };

  /** 应用主题色：自定义色（非预设）自动记入历史 */
  const applyAccent = (color: string) => {
    update({ accent: color, accentHistory: pushAccentHistory(settings.accentHistory, color) });
  };

  return (
    <div className="modal-overlay" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>外观设置</h3>
          <button className="up-collapse" title="关闭" onClick={close}>
            ✕
          </button>
        </div>

        <section className="set-section">
          <h4>
            <em>乐奈的头像</em>（你自己上传）
          </h4>
          <div className="avatar-up">
            <div className="avatar-ring">
              <div className="inner">
                <RanaAvatar size={74} />
              </div>
            </div>
            <div className="avatar-actions">
              <button className="btn" onClick={() => avatarRef.current?.click()} disabled={avatarBusy}>
                {avatarBusy ? "上传中…" : "📁 上传图片"}
              </button>
              <button className="btn ghost" onClick={() => void clearAvatar()} disabled={avatarBusy || !settings.avatarUrl}>
                恢复默认脸
              </button>
            </div>
            <input
              ref={avatarRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              style={{ display: "none" }}
              onChange={(e) => {
                void uploadAvatar(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </div>
          <div className="set-hint">图片只存在你自己电脑上（rana-web/.avatars/，不入公开仓库），聊天气泡和空状态自动套用</div>
        </section>

        <section className="set-section">
          <h4>主题颜色</h4>
          <div className="swatches">
            {PRESET_ACCENTS.map((c) => (
              <button
                key={c}
                className={`swatch${settings.accent.toLowerCase() === c.toLowerCase() ? " active" : ""}`}
                style={{ background: c }}
                title={c}
                onClick={() => update({ accent: c })}
              />
            ))}
            <label className={`swatch custom${PRESET_ACCENTS.includes(settings.accent.toLowerCase()) ? "" : " active"}`} title="自定义颜色">
              <input type="color" value={settings.accent} onChange={(e) => applyAccent(e.target.value)} />
              <span>＋</span>
            </label>
          </div>
          {settings.accentHistory.length > 0 && (
            <div className="set-subsection">
              <div className="set-hint">最近使用的自定义颜色</div>
              <div className="swatches history">
                {settings.accentHistory.map((c) => (
                  <button
                    key={c}
                    className={`swatch${settings.accent.toLowerCase() === c.toLowerCase() ? " active" : ""}`}
                    style={{ background: c }}
                    title={c}
                    onClick={() => update({ accent: c })}
                  />
                ))}
              </div>
            </div>
          )}
        </section>

        <section className="set-section">
          <h4>界面模式</h4>
          <div className="mode-toggle">
            <button
              className={`mode-btn${settings.mode !== "dark" ? " active" : ""}`}
              onClick={() => update({ mode: "light" })}
            >
              ☀️ 浅色
            </button>
            <button
              className={`mode-btn${settings.mode === "dark" ? " active" : ""}`}
              onClick={() => update({ mode: "dark" })}
            >
              🌙 夜间
            </button>
          </div>
          <div className="set-hint">夜间模式下面板转为黑色与黑色半透明，可与背景图叠加</div>
        </section>

        <section className="set-section">
          <h4>背景图片</h4>
          <div className="set-row">
            <button className="btn ghost" onClick={() => fileRef.current?.click()}>
              上传图片…
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              onChange={(e) => {
                pickFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <input
              className="set-input"
              type="text"
              placeholder="或粘贴图片 URL…"
              value={urlValue}
              onChange={(e) => setUrlValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && applyUrl()}
            />
            <button className="btn ghost" onClick={applyUrl} disabled={!urlValue.trim()}>
              应用
            </button>
          </div>
          {settings.bgImage ? (
            <div className="set-row">
              <span className="set-hint">已启用自定义背景（见预览效果）</span>
              <button className="btn ghost" onClick={() => update({ bgImage: "" })}>
                清除背景
              </button>
            </div>
          ) : (
            <div className="set-hint">未设置背景，使用默认纯色</div>
          )}
        </section>

        <section className="set-section">
          <h4>
            背景不透明度 <em>{Math.round(settings.bgOpacity * 100)}%</em>
          </h4>
          <input
            className="set-range"
            type="range"
            min={0}
            max={100}
            value={Math.round(settings.bgOpacity * 100)}
            disabled={!settings.bgImage}
            onChange={(e) => update({ bgOpacity: Number(e.target.value) / 100 })}
          />
          <div className="set-hint">数值越低背景越透出、文字区域越素净；建议 30%~60%</div>
        </section>

        {error && <div className="set-error">⚠ {error}</div>}

        <div className="modal-foot">
          <button className="btn ghost" onClick={() => reset()}>
            恢复默认
          </button>
          <button className="btn" onClick={close}>
            完成
          </button>
        </div>
      </div>
    </div>
  );
}
