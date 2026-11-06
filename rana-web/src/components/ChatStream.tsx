import { memo, useEffect, useRef, useState } from "react";
import { useAppStore } from "../store/useAppStore";
import { gateway } from "../lib/gateway";
import Markdown from "./Markdown";
import { fmtHmOr as fmtTime } from "../lib/fmt";
import { splitReasoning, stripOpenclawEnvelope } from "../lib/reasoning";
import { findRewindAnchor, keepBefore } from "../lib/rewind";
import { Bell, Paw, RanaAvatar } from "./RanaArt";
import type { ChatAttachment } from "../lib/types";

/** 气泡里的附件：图片有预览显示预览，其余显示文件条 */
function AttachmentList({ items }: { items: ChatAttachment[] }) {
  return (
    <div className="bubble-attachments">
      {items.map((a, i) =>
        a.kind === "image" && a.dataUrl ? (
          <img key={i} className="bubble-img" src={a.dataUrl} alt={a.name} title={a.name} />
        ) : (
          <span key={i} className="bubble-file" title={a.name}>
            <span className="attach-ic">{a.kind === "image" ? "🖼" : "📄"}</span>
            {a.name}
          </span>
        ),
      )}
    </div>
  );
}

/** 思考过程折叠块：流式思考时展开显示"思考中"，完成后默认摊开，可手动收起 */
function ReasoningBlock({ reasoning, thinking }: { reasoning: string; thinking: boolean }) {
  const showReasoning = useAppStore((s) => s.showReasoning);
  const [open, setOpen] = useState(true);
  if (!showReasoning) return null;
  const expanded = thinking || open;
  return (
    <div className={`think-block${thinking ? " thinking" : ""}`}>
      <button className="think-toggle" onClick={() => setOpen((v) => !v)}>
        <span className="think-icon">💭</span>
        {thinking ? "……在想" : open ? "思考（点收起）" : "……想了想（点展开）"}
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

const Bubble = memo(function Bubble({ role, text, reasoning, streaming, error, model, ts, status, attachments, msgId, anchorId, anchorText, anchorTs }: {
  role: "user" | "assistant";
  text: string;
  /** 历史消息携带的原生思考块（chat.history / 落库事件提取；内联 <think> 另由 splitReasoning 现场拆） */
  reasoning?: string;
  streaming?: boolean;
  error?: string;
  model?: string;
  ts: number;
  status?: string;
  attachments?: ChatAttachment[];
  /** 消息 id：真身事件 UUID 可精确锚定编辑；local-/pending-/live- 前缀是乐观占位，禁编辑 */
  msgId?: string;
  /** 回退锚点（user 消息事件 UUID）：她的回复锚到上面最近一条 user 消息；user 消息锚自己 */
  anchorId?: string;
  /** 锚点消息原文（确认弹窗展示 + 重发默认文字） */
  anchorText?: string;
  /** 锚点消息时间戳（服务端三锚定位用） */
  anchorTs?: number;
}) {
  const currentKey = useAppStore((s) => s.currentKey);
  // 先剥离 OpenClaw 运行时封套回显（压缩前冲刷回合模型偶尔把指令块吐进正文）
  const stripped = role === "assistant" ? stripOpenclawEnvelope(text) : null;
  const { reasoning: inlineReasoning, thinking, text: body } = role === "assistant"
    ? splitReasoning(stripped ? stripped.text : text)
    : { reasoning: "", thinking: false, text };
  // 原生思考块（历史携带）与内联 <think> 合并渲染：原生在前
  const combinedReasoning = [reasoning, inlineReasoning].filter(Boolean).join("\n\n");
  const sysEcho = (stripped?.echo ?? false) && !streaming;
  const statusLine = streaming && status ? PHASE_LABELS[status] ?? status : "";
  const [editing, setEditing] = useState(false);
  // 🔁 回退重答状态（user 消息带内联编辑器；她的回复走确认弹窗直发）
  const [rewindDraft, setRewindDraft] = useState<string | null>(null);
  const [rewindBusy, setRewindBusy] = useState(false);
  const [rewindErr, setRewindErr] = useState("");

  /** 回退重答执行体：session-edit GET 按 role+前缀+ts 定位出服务端事件 UUID → rewind → 本地截断 → 重发 */
  const doRewind = async (localId: string, anchorText: string, anchorTs: number, resendText: string) => {
    if (!currentKey || rewindBusy) return;
    setRewindBusy(true);
    setRewindErr("");
    try {
      // chat.history 行不带事件 id（实锤 2026-11-06），先换服务端事件 UUID
      const p = new URLSearchParams({ sessionKey: currentKey, role: "user", prefix: anchorText.slice(0, 60) });
      if (anchorTs) p.set("tsMs", String(anchorTs));
      const locRes = await fetch(`/__rana/session-edit?${p.toString()}`);
      const loc = await locRes.json() as { ok?: boolean; eventId?: string; error?: string };
      if (!loc.ok || !loc.eventId) throw new Error(loc.error ?? "定位锚点失败");
      const res = await gateway.rewindSession(currentKey, loc.eventId);
      const list = useAppStore.getState().messages[currentKey] ?? [];
      const kept = keepBefore(list, localId);
      if (kept) useAppStore.getState().setMessages(currentKey, kept);
      const atts = res.editorAttachments?.map((a, i) => ({
        fileName: `附件${i + 1}.${(a.mimeType.split("/")[1] ?? "bin").split(";")[0]}`,
        mimeType: a.mimeType,
        content: a.data,
        type: (a.mimeType.startsWith("image/") ? "image" : "file") as "image" | "file",
      }));
      setRewindDraft(null);
      setRewindBusy(false);
      await gateway.sendChat(currentKey, resendText, atts?.length ? atts : undefined);
    } catch (e) {
      setRewindErr((e as Error).message);
      setRewindBusy(false);
    }
  };

  /** 确认弹窗文案：收起范围 + 主会话（QQ 共享）连带提醒 */
  const rewindConfirmText = () => {
    const shared = currentKey === useAppStore.getState().mainSessionKey
      ? "\n\n⚠ 注意：这是与 QQ 私聊共享的主会话，收起对那边同样生效。"
      : "";
    return `🔁 回退重答\n\n从这条起，后面的对话会从当前会话收起——页面上和她的记忆里都会消失（库里留底但不再看），收起后立即重发。\n锚点：${(anchorText ?? "").slice(0, 24)}${(anchorText ?? "").length > 24 ? "…" : ""}${shared}\n\n确定？`;
  };

  /** user 气泡内联编辑器的「收起后续并重答」：先确认再执行 */
  const confirmRewind = () => {
    if (!currentKey || !anchorId) return;
    if (!window.confirm(rewindConfirmText())) return;
    void doRewind(anchorId, anchorText ?? "", anchorTs ?? 0, rewindDraft ?? "");
  };

  /** 她的回复：🔁 确认后锚到上面最近的 user 消息，原句原样重发 */
  const confirmRewindForAssistant = () => {
    if (!currentKey || !anchorId) return;
    if (!window.confirm(rewindConfirmText())) return;
    void doRewind(anchorId, anchorText ?? "", anchorTs ?? 0, anchorText ?? "");
  };
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
        {editing && currentKey && msgId ? (
          <div className="bubble editing">
            <MessageEditor
              sessionKey={currentKey}
              msgId={msgId}
              role={role}
              text={text}
              ts={ts}
              onDone={() => {
                setEditing(false);
                if (currentKey) void gateway.loadHistory(currentKey);
              }}
              onCancel={() => setEditing(false)}
            />
          </div>
        ) : rewindDraft !== null && currentKey && anchorId ? (
          <div className="bubble editing">
            <div className="msg-edit">
              <div className="msg-edit-label">🔁 收起这条及之后的对话，用下面这段重新发问</div>
              <textarea
                className="msg-edit-area"
                autoFocus
                value={rewindDraft}
                rows={Math.min(14, Math.max(3, Math.ceil(rewindDraft.length / 60)))}
                onChange={(e) => setRewindDraft(e.target.value)}
              />
              {rewindErr && <div className="msg-edit-err">⚠ {rewindErr}</div>}
              <div className="msg-edit-actions">
                <button className="btn ghost" onClick={() => setRewindDraft(null)}>取消</button>
                <button className="btn" disabled={rewindBusy} onClick={() => void confirmRewind()}>
                  {rewindBusy ? "处理中…" : "收起后续并重答"}
                </button>
              </div>
            </div>
          </div>
        ) : (
        <div className="bubble">
          {sysEcho ? (
            <div className="sys-echo">⚙ 系统指令回显（已折叠，这不是她的回复）</div>
          ) : (
            <>
              {(combinedReasoning || thinking) && <ReasoningBlock reasoning={combinedReasoning} thinking={thinking} />}
              {attachments && attachments.length > 0 && <AttachmentList items={attachments} />}
              {body ? <Markdown text={body} /> : streaming && !thinking && !attachments?.length ? <PawDots /> : null}
              {streaming && body ? <PawDots /> : null}
            </>
          )}
          {statusLine && <div className="run-status">⚙ {statusLine}</div>}
          {error && <div style={{ color: "var(--danger)", marginTop: 6 }}>⚠ {error}</div>}
        </div>
        )}
        <div className="msg-meta">
          {model && role === "assistant" ? <span>{model.split("/").pop()}</span> : null}
          {ts ? <span>{fmtTime(ts)}</span> : null}
          {!streaming && !sysEcho && currentKey && msgId && !/^(local|pending|live)-/.test(msgId) && (
            <button className="msg-edit-btn" title="编辑这条消息（写回会话库）" onClick={() => setEditing(true)}>✏️</button>
          )}
          {!streaming && !sysEcho && currentKey && anchorId && !rewindBusy && (
            <button
              className="msg-edit-btn"
              title={role === "user" ? "改并重答（收起这条及之后，改完重发）" : "重答（收起你上一条之后全部，重新回答）"}
              onClick={() => (role === "user" ? setRewindDraft(text) : confirmRewindForAssistant())}
            >🔁</button>
          )}
        </div>
      </div>
    </div>
  );
});

/** 编辑器打开时按锚点取真身块 */

function fetchBlocks(sessionKey: string, msgId: string, role: string, text: string, ts: number, onOk: (blocks: Array<{ kind: "thinking" | "text"; content: string }>, hash: string) => void, onErr: (msg: string) => void) {
  const p = new URLSearchParams({ sessionKey, role, prefix: text.slice(0, 60) });
  if (ts) p.set("tsMs", String(ts));
  // 真身事件 UUID（36 位）可精确锚定；h-N 兜底 id 形态不符会被服务端忽略并退回前缀锚
  if (/^[0-9a-f-]{36}$/i.test(msgId)) p.set("eventId", msgId);
  fetch(`/__rana/session-edit?${p.toString()}`)
    .then((r) => r.json())
    .then((d: { ok?: boolean; error?: string; hash?: string; blocks?: Array<{ kind: "thinking" | "text"; content: string }> }) => {
      if (!d.ok || !d.blocks) throw new Error(d.error ?? "读取失败");
      onOk(d.blocks, d.hash ?? "");
    })
    .catch(() => onErr("读取失败：无法连接编辑端点（仅本机可用）"));
}

/** 历史消息编辑（改真身）：取库里的真身块 → 按块编辑 → 确认后写回（后端自动备份） */
function MessageEditor({ sessionKey, msgId, role, text, ts, onDone, onCancel }: {
  sessionKey: string;
  msgId: string;
  role: "user" | "assistant";
  text: string;
  ts: number;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [state, setState] = useState<"loading" | "edit" | "saving">("loading");
  const [blocks, setBlocks] = useState<Array<{ kind: "thinking" | "text"; content: string }>>([]);
  const [hash, setHash] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;
    fetchBlocks(sessionKey, msgId, role, text, ts, (bs, h) => {
      if (!alive) return;
      setBlocks(bs);
      setHash(h);
      setState("edit");
    }, (m) => {
      if (!alive) return;
      setErr(m);
      setState("edit");
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    if (state === "saving") return;
    if (!window.confirm("保存后会写进会话库（Rana 之后看到的就是改后的版本），原内容当日自动备份。\n确认保存？")) return;
    setState("saving");
    try {
      const payload = {
        sessionKey,
        role,
        prefix: text.slice(0, 60),
        ...(ts ? { tsMs: ts } : {}),
        ...(/^[0-9a-f-]{36}$/i.test(msgId) ? { eventId: msgId } : {}),
        expect: hash,
        blocks,
      };
      const r = await fetch("/__rana/session-edit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = (await r.json()) as { ok?: boolean; error?: string };
      if (!r.ok || !d.ok) throw new Error(d.error ?? `保存失败（HTTP ${r.status}）`);
      onDone();
    } catch (e) {
      setErr((e as Error).message);
      setState("edit");
    }
  };

  return (
    <div className="msg-edit">
      {state === "loading" && <div className="msg-edit-hint">正在读取消息真身……</div>}
      {err && <div className="msg-edit-err">⚠ {err}</div>}
      {blocks.map((b, i) => (
        <div key={i} className="msg-edit-block">
          <div className="msg-edit-label">{b.kind === "thinking" ? "💭 思考（会进 Rana 的上下文）" : "正文"}</div>
          <textarea
            className="msg-edit-area"
            value={b.content}
            rows={Math.min(14, Math.max(3, Math.ceil(b.content.length / 60)))}
            onChange={(e) => {
              const next = blocks.slice();
              next[i] = { ...b, content: e.target.value };
              setBlocks(next);
            }}
          />
        </div>
      ))}
      {state !== "loading" && (
        <div className="msg-edit-actions">
          <button className="btn ghost" onClick={onCancel}>取消</button>
          <button className="btn" disabled={state === "saving"} onClick={() => void save()}>
            {state === "saving" ? "保存中…" : "保存（改真身）"}
          </button>
        </div>
      )}
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
                {messages.map((m, i) => {
          // 回退锚点：user 消息锚自己；她的回复锚到上面最近一条 user 消息（本地 id 形态不限，服务端按前缀+ts 定位）
          const anchor = m.role === "user" ? m : findRewindAnchor(messages, i - 1);
          return (
            <Bubble key={m.id} msgId={m.id} role={m.role} text={m.text} reasoning={m.reasoning} streaming={m.streaming} error={m.error} model={m.model} ts={m.ts} status={m.status} attachments={m.attachments} anchorId={anchor?.id} anchorText={anchor?.text} anchorTs={anchor?.ts ?? 0} />
          );
        })}
      </div>
    </div>
  );
}
