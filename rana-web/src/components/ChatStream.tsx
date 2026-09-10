import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../store/useAppStore";
import Markdown from "./Markdown";
import { splitReasoning, stripOpenclawEnvelope } from "../lib/reasoning";
import { Bell, Paw, RanaAvatar } from "./RanaArt";

function fmtTime(ts: number) {
  if (!ts) return "";
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 思考过程折叠块：流式思考时展开显示"思考中"，完成后收起可手动展开 */
function ReasoningBlock({ reasoning, thinking }: { reasoning: string; thinking: boolean }) {
  const showReasoning = useAppStore((s) => s.showReasoning);
  const [open, setOpen] = useState(false);
  if (!showReasoning) return null;
  const expanded = thinking || open;
  return (
    <div className={`think-block${thinking ? " thinking" : ""}`}>
      <button className="think-toggle" onClick={() => setOpen((v) => !v)}>
        <span className="think-icon">💭</span>
        {thinking ? "……在想" : open ? "收起" : "……想了想"}
        {!thinking && <span className="think-len">{reasoning.length} 字</span>}
      </button>
      {expanded && <div className="think-body">{reasoning}</div>}
    </div>
  );
}

/** chat 事件 state=status 的生命周期阶段 → 中文提示 */
const PHASE_LABELS: Record<string, string> = {
  preparing_workspace: "准备工作区",
  naming_worktree: "命名工作树",
  creating_worktree: "创建工作树",
  running_setup: "运行初始化",
  provisioning_environment: "配置运行环境",
  preparing_context: "准备上下文",
  starting_model: "模型生成中",
};

/** 等待回复：三枚猫爪轮流冒出来 */
function PawDots() {
  return (
    <span className="typing-dots">
      <span className="paw">
        <Paw size={15} />
      </span>
      <span className="paw">
        <Paw size={15} />
      </span>
      <span className="paw">
        <Paw size={15} />
      </span>
    </span>
  );
}

function Bubble({ role, text, streaming, error, model, ts, status }: {
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
  error?: string;
  model?: string;
  ts: number;
  status?: string;
}) {
  // 先剥离 OpenClaw 运行时封套回显（压缩前冲刷回合模型偶尔把指令块吐进正文）
  const stripped = role === "assistant" ? stripOpenclawEnvelope(text) : null;
  const { reasoning, thinking, text: body } = role === "assistant"
    ? splitReasoning(stripped ? stripped.text : text)
    : { reasoning: "", thinking: false, text };
  const sysEcho = stripped?.echo ?? false;
  const statusLine = streaming && status ? PHASE_LABELS[status] ?? status : "";
  return (
    <div className={`msg ${role}`}>
      <div className="av-wrap">
        {role === "assistant" ? (
          <>
            <span className="av rana-av">
              <RanaAvatar size={40} />
            </span>
            <span className="av-bell" title="Rana 在听">
              <Bell size={15} />
            </span>
          </>
        ) : (
          <span className="av user-av">你</span>
        )}
      </div>
      <div className="stack">
        <div className="bubble">
          {sysEcho ? (
            <div className="sys-echo">⚙ 系统指令回显（已折叠，这不是她的回复）</div>
          ) : (
            <>
              {(reasoning || thinking) && <ReasoningBlock reasoning={reasoning} thinking={thinking} />}
              {body ? <Markdown text={body} /> : streaming && !thinking ? <PawDots /> : null}
              {streaming && body ? <PawDots /> : null}
            </>
          )}
          {statusLine && <div className="run-status">⚙ {statusLine}</div>}
          {error && <div style={{ color: "var(--danger)", marginTop: 6 }}>⚠ {error}</div>}
        </div>
        <div className="msg-meta">
          {model && role === "assistant" ? <span>{model.split("/").pop()}</span> : null}
          {ts ? <span>{fmtTime(ts)}</span> : null}
        </div>
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
          <span className="empty-face">
            <RanaAvatar size={88} />
          </span>
          <h1>……嗯。</h1>
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
          <span className="empty-face">
            <RanaAvatar size={88} asleep />
          </span>
          <h1>……困了。</h1>
            <p>要聊天的话，叫我。</p>
          </div>
        )}
        {messages.map((m) => (
          <Bubble key={m.id} role={m.role} text={m.text} streaming={m.streaming} error={m.error} model={m.model} ts={m.ts} status={m.status} />
        ))}
      </div>
    </div>
  );
}
