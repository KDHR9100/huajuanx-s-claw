import { useEffect, useRef } from "react";
import { useAppStore } from "../store/useAppStore";
import Markdown from "./Markdown";

function fmtTime(ts: number) {
  if (!ts) return "";
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function Bubble({ role, text, streaming, error, model, ts }: {
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
  error?: string;
  model?: string;
  ts: number;
}) {
  return (
    <div className={`msg ${role}`}>
      <div className="bubble">
        {text ? <Markdown text={text} /> : streaming ? (
          <span className="typing-dots">
            <span />
            <span />
            <span />
          </span>
        ) : null}
        {streaming && text ? <span className="typing-dots"><span /><span /><span /></span> : null}
        {error && <div style={{ color: "var(--danger)", marginTop: 6 }}>⚠ {error}</div>}
      </div>
      <div className="msg-meta">
        {model && role === "assistant" ? <span>{model.split("/").pop()}</span> : null}
        {ts ? <span>{fmtTime(ts)}</span> : null}
      </div>
    </div>
  );
}

export default function ChatStream() {
  const currentKey = useAppStore((s) => s.currentKey);
  const messagesMap = useAppStore((s) => s.messages);
  const messages = currentKey ? messagesMap[currentKey] ?? [] : [];
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const text = messages.map((m) => m.text.length).join(",");
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [text, messages.length, currentKey]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  if (!currentKey) {
    return (
      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="empty-state">
          <h1>嗨～我是 Rana</h1>
          <p>正在连接 gateway…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
      <div className="chat-inner">
        {messages.length === 0 && (
          <div className="empty-state">
            <h1>嗨～我是 Rana</h1>
            <p>今天想做点什么？</p>
          </div>
        )}
        {messages.map((m) => (
          <Bubble key={m.id} role={m.role} text={m.text} streaming={m.streaming} error={m.error} model={m.model} ts={m.ts} />
        ))}
      </div>
    </div>
  );
}
