import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { useAppStore } from "../store/useAppStore";
import { gateway } from "../lib/gateway";

const HEIGHT_KEY = "rana-web.composer-height";
const MIN_H = 46; // 约一行
const MAX_H_RATIO = 0.6; // 最多占视口 60%
const clampHeight = (h: number) => Math.min(Math.max(h, MIN_H), Math.floor(window.innerHeight * MAX_H_RATIO));

/** 恢复上次拖拽保存的输入框高度（无效/越界则回到自适应） */
function loadHeight(): number | null {
  const raw = Number(localStorage.getItem(HEIGHT_KEY));
  return Number.isFinite(raw) && raw >= MIN_H ? clampHeight(raw) : null;
}

export default function Composer() {
  const [text, setText] = useState("");
  const [height, setHeight] = useState<number | null>(loadHeight);
  const conn = useAppStore((s) => s.conn);
  const currentKey = useAppStore((s) => s.currentKey);
  const run = useAppStore((s) => (s.currentKey ? s.runs[s.currentKey] : undefined));
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  const canSend = conn === "connected" && !!currentKey && !!text.trim() && !run;

  const send = () => {
    if (!canSend || !currentKey) return;
    const body = text;
    setText("");
    void gateway.sendChat(currentKey, body);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
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
    <div className="composer">
      <div
        className={`composer-resize${height === null ? "" : " fixed"}`}
        title="拖动调整输入框高度（双击恢复默认）"
        onMouseDown={onHandleDown}
        onDoubleClick={onHandleDoubleClick}
      >
        <span className="grip" />
      </div>
      <div className="composer-inner">
        <textarea
          rows={1}
          style={height !== null ? { height, maxHeight: "none" } : undefined}
          placeholder={conn === "connected" ? "给 Rana 发消息…（Enter 发送，Shift+Enter 换行）" : `gateway ${conn}…`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
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
