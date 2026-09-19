import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";
import { useAppStore } from "../store/useAppStore";
import { gateway } from "../lib/gateway";
import type { OutgoingAttachment } from "../lib/types";

const HEIGHT_KEY = "rana-web.composer-height";
const MIN_H = 46; // 约一行
const MAX_H_RATIO = 0.6; // 最多占视口 60%
const clampHeight = (h: number) => Math.min(Math.max(h, MIN_H), Math.floor(window.innerHeight * MAX_H_RATIO));

// 网关 chat.send 附件限额（hello policy 广播的 decoded-size 上限）：单图 6MB、单文件 20MB；
// 附件 base64 后整帧还有 25MiB 限制，客户端按 24MB 总量留余量
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_FILE_BYTES = 18 * 1024 * 1024;
const MAX_TOTAL_B64 = 24 * 1024 * 1024;

/** 待发送的附件：base64 为主体，图片额外留 dataUrl 做预览 */
interface PendingAttachment {
  id: string;
  name: string;
  mimeType: string;
  kind: "image" | "file";
  size: number;
  base64: string;
  dataUrl?: string;
}

/** 恢复上次拖拽保存的输入框高度（无效/越界则回到自适应） */
function loadHeight(): number | null {
  const raw = Number(localStorage.getItem(HEIGHT_KEY));
  return Number.isFinite(raw) && raw >= MIN_H ? clampHeight(raw) : null;
}

function readAsDataURL(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error("文件读取失败"));
    r.readAsDataURL(f);
  });
}

export default function Composer() {
  const [text, setText] = useState("");
  const [height, setHeight] = useState<number | null>(loadHeight);
  const [files, setFiles] = useState<PendingAttachment[]>([]);
  const [attachError, setAttachError] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const conn = useAppStore((s) => s.conn);
  const currentKey = useAppStore((s) => s.currentKey);
  const run = useAppStore((s) => (s.currentKey ? s.runs[s.currentKey] : undefined));
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const canSend = conn === "connected" && !!currentKey && !run && (!!text.trim() || files.length > 0);

  const addFiles = async (list: FileList | File[]) => {
    const errs: string[] = [];
    const next: PendingAttachment[] = [];
    let totalB64 = files.reduce((n, f) => n + f.base64.length, 0);
    for (const f of Array.from(list)) {
      const isImage = f.type.startsWith("image/");
      const limit = isImage ? MAX_IMAGE_BYTES : MAX_FILE_BYTES;
      if (f.size > limit) {
        errs.push(`「${f.name}」超过 ${Math.round(limit / 1024 / 1024)}MB 上限`);
        continue;
      }
      let dataUrl: string;
      try {
        dataUrl = await readAsDataURL(f);
      } catch (e) {
        errs.push(`「${f.name}」读取失败：${(e as Error).message}`);
        continue;
      }
      const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
      if (totalB64 + base64.length > MAX_TOTAL_B64) {
        errs.push(`「${f.name}」放不下了：这批附件总量到上限`);
        continue;
      }
      totalB64 += base64.length;
      next.push({
        id: crypto.randomUUID(),
        name: f.name,
        mimeType: f.type || "application/octet-stream",
        kind: isImage ? "image" : "file",
        size: f.size,
        base64,
        dataUrl: isImage ? dataUrl : undefined,
      });
    }
    if (next.length) setFiles((prev) => [...prev, ...next]);
    setAttachError(errs.join("；"));
  };

  const send = () => {
    if (!canSend || !currentKey) return;
    const body = text;
    const payload: OutgoingAttachment[] = files.map((f) => ({
      fileName: f.name,
      mimeType: f.mimeType,
      content: f.base64,
      type: f.kind,
    }));
    setText("");
    setFiles([]);
    setAttachError("");
    void gateway.sendChat(currentKey, body, payload.length ? payload : undefined);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  // 截图直接 Ctrl+V：剪贴板里有文件就收下（纯文本粘贴不受影响）
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const fs = e.clipboardData?.files;
    if (fs && fs.length > 0) {
      e.preventDefault();
      void addFiles(fs);
    }
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault(); // 不拦的话浏览器会直接打开文件
    setDragOver(true);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer?.files?.length) void addFiles(e.dataTransfer.files);
  };

  // 拖拽调高：把手在输入区上缘，向上拖变大（微信/QQ 桌面端手感），松手持久化
  const onHandleDown = (e: MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const textarea = e.currentTarget.parentElement?.querySelector("textarea");
    const startH = height ?? textarea?.offsetHeight ?? MIN_H;
    dragRef.current = { startY: e.clientY, startH };
    const onMove = (ev: globalThis.MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setHeight(clampHeight(d.startH + (d.startY - ev.clientY)));
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("dragging");
      setHeight((h) => {
        if (h !== null) localStorage.setItem(HEIGHT_KEY, String(h));
        return h;
      });
    };
    document.body.classList.add("dragging");
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // 双击把手：恢复自适应高度
  const onHandleDoubleClick = () => {
    localStorage.removeItem(HEIGHT_KEY);
    setHeight(null);
  };

  // 视口大幅缩放时把保存的高度夹回合法范围
  useEffect(() => {
    if (height === null) return;
    const onResize = () => setHeight((h) => (h === null ? h : clampHeight(h)));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [height === null]);

  return (
    <div
      className={`composer${dragOver ? " drag-over" : ""}`}
      onDragOver={onDragOver}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <div
        className={`composer-resize${height === null ? "" : " fixed"}`}
        title="拖动调整输入框高度（双击恢复默认）"
        onMouseDown={onHandleDown}
        onDoubleClick={onHandleDoubleClick}
      >
        <span className="grip" />
      </div>
      {(files.length > 0 || attachError) && (
        <div className="attach-tray">
          {files.map((f) => (
            <span key={f.id} className="attach-chip" title={`${f.name}（${Math.max(1, Math.round(f.size / 1024))}KB）`}>
              {f.kind === "image" && f.dataUrl ? (
                <img className="attach-thumb" src={f.dataUrl} alt={f.name} />
              ) : (
                <span className="attach-ic">{f.kind === "image" ? "🖼" : "📄"}</span>
              )}
              <span className="attach-name">{f.name}</span>
              <button
                className="attach-x"
                title="移除"
                onClick={() => setFiles((prev) => prev.filter((x) => x.id !== f.id))}
              >
                ✕
              </button>
            </span>
          ))}
          {attachError && <div className="attach-err">⚠ {attachError}</div>}
        </div>
      )}
      <div className="composer-inner">
        <button
          className="composer-attach"
          title="发图片 / 文件给她（也可拖进来或 Ctrl+V 粘贴截图）"
          onClick={() => fileInputRef.current?.click()}
          disabled={conn !== "connected" || !currentKey}
        >
          📎
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files?.length) void addFiles(e.target.files);
            e.target.value = ""; // 同名文件可重复选择
          }}
        />
        <textarea
          rows={1}
          style={height !== null ? { height, maxHeight: "none" } : undefined}
          placeholder={
            conn === "connected"
              ? "给 Rana 发消息…（Enter 发送，Shift+Enter 换行；图片文件可拖入/粘贴）"
              : `gateway ${conn}…`
          }
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          disabled={conn !== "connected" || !currentKey}
        />
        {run ? (
          <button className="btn ghost" onClick={() => currentKey && void gateway.abort(currentKey)}>
            ■ 停止
          </button>
        ) : (
          <button className="btn" onClick={send} disabled={!canSend}>
            发送
          </button>
        )}
      </div>
    </div>
  );
}
