import { useState, type KeyboardEvent } from "react";
import { useAppStore } from "../store/useAppStore";
import { gateway } from "../lib/gateway";

export default function Composer() {
  const [text, setText] = useState("");
  const conn = useAppStore((s) => s.conn);
  const currentKey = useAppStore((s) => s.currentKey);
  const run = useAppStore((s) => (s.currentKey ? s.runs[s.currentKey] : undefined));

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

  return (
    <div className="composer">
      <div className="composer-inner">
        <textarea
          rows={1}
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
