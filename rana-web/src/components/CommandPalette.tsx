// ⌘K 命令面板：Ctrl+K 全局呼出（输入框聚焦时也拦截，业界惯例）、Esc 关闭、↑↓ 循环选择、↵ 执行，
// 鼠标 hover 选中、点击执行。条目构建与过滤全在 lib/command-palette.ts（纯函数守门）。
// 执行语义：页签/会话 → store 跳转（UsagePage jumpToSession 同款先例）；动作 → 真端点/真入口，
// 结果用右下角状态条提示（不 alert 轰炸）。样式 .cp-* 见 styles.css 尾部。
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyEvent } from "react";
import { useAppStore } from "../store/useAppStore";
import {
  buildPaletteItems,
  filterPalette,
  GROUP_LABELS,
  type PaletteActionId,
  type PaletteItem,
} from "../lib/command-palette";

interface Toast {
  kind: "info" | "ok" | "err";
  text: string;
}

/** 记忆同步步骤文案：与 Topbar 的 BridgeSyncButton 同源（同款端点、同款轮询节奏） */
const SYNC_STEP_ZH: Record<string, string> = {
  start: "启动",
  lmstudio: "检查 LM Studio",
  model: "检查模型",
  "shared-bridge": "共享桥同步中",
  "private-bridge": "私密桥同步中",
  unload: "释放显存",
  done: "完成",
  failed: "失败",
};

type ShowToast = (t: Toast, ttlMs?: number) => void;

/** 执行动作：每个动作都走真实存在的端点/入口（清单见 buildActionItems 注释） */
async function runAction(actionId: PaletteActionId, showToast: ShowToast): Promise<void> {
  if (actionId === "sessions-cleanup") {
    // 与侧栏/审批页按钮同一个全局入口：打开 SystemCleanupModal（里面自带预览与确认，危险动作不在这直接开跑）
    useAppStore.getState().setCleanupOpen(true);
    return;
  }
  if (actionId === "usage-rebuild") {
    try {
      const res = await fetch("/__rana/usage/rebuild", { method: "POST" });
      if (res.status === 202) {
        showToast({ kind: "ok", text: "✓ 账本重建已发起——打开「用量」页可看进度" }, 8000);
      } else {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        showToast({ kind: "err", text: `✗ 重建发起失败：${j.error ?? "HTTP " + res.status}` }, 12000);
      }
    } catch (e) {
      showToast({ kind: "err", text: `✗ 重建请求发不出去：${(e as Error).message}` }, 12000);
    }
    return;
  }
  // bridge-sync：POST 发起 → GET 轮询到完成，与 Topbar 的 BridgeSyncButton 同款语义
  showToast({ kind: "info", text: "🔗 记忆同步：启动…" });
  try {
    const r = await fetch("/__rana/bridge-sync", { method: "POST" });
    const j = (await r.json()) as { started?: boolean; error?: string };
    if (!j.started) {
      showToast({ kind: "err", text: `✗ 记忆同步无法启动：${j.error ?? "未知原因"}` }, 12000);
      return;
    }
  } catch (e) {
    showToast({ kind: "err", text: `✗ 记忆同步请求发不出去：${(e as Error).message}` }, 12000);
    return;
  }
  const poll = async () => {
    try {
      const s = (await (await fetch("/__rana/bridge-sync")).json()) as {
        running?: boolean;
        step?: string;
        error?: string | null;
        result?: Record<string, string> | null;
      };
      if (s.running) {
        showToast({ kind: "info", text: `🔗 ${SYNC_STEP_ZH[s.step ?? ""] ?? s.step ?? "同步中…"}` });
        setTimeout(() => void poll(), 2000);
      } else if (s.error) {
        showToast({ kind: "err", text: `✗ 记忆同步失败：${s.error}` }, 12000);
      } else {
        const results = Object.values(s.result ?? {});
        const allOk = results.length > 0 && results.every((v) => v.includes("✓"));
        showToast(
          { kind: allOk ? "ok" : "err", text: allOk ? "✓ 记忆同步完成" : "⚠ 部分完成，详见网关日志" },
          8000,
        );
      }
    } catch {
      showToast({ kind: "err", text: "✗ 同步状态查询失败" }, 12000);
    }
  };
  void poll();
}

export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const [toast, setToast] = useState<Toast | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const inputRef = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  const sessions = useAppStore((s) => s.sessions);

  // 条目：随会话列表变化重建；每次打开刷新一次"现在"（相对时间别停在旧值）
  useEffect(() => {
    if (open) setNow(Date.now());
  }, [open]);
  const items = useMemo(() => buildPaletteItems(sessions, now), [sessions, now]);
  const hits = useMemo(() => filterPalette(items, query), [items, query]);
  const selIdx = Math.min(sel, Math.max(0, hits.length - 1));

  const showToast = useCallback<ShowToast>((t, ttlMs) => {
    setToast(t);
    window.clearTimeout(toastTimer.current);
    if (ttlMs !== undefined) toastTimer.current = window.setTimeout(() => setToast(null), ttlMs);
  }, []);

  const openPalette = useCallback(() => {
    setQuery("");
    setSel(0);
    setNow(Date.now());
    setOpen(true);
  }, []);

  // 全局 Ctrl+K：无论焦点在哪（包括输入控件内）都拦截呼出；再按一次收起
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K" || e.code === "KeyK")) {
        e.preventDefault();
        if (open) setOpen(false);
        else openPalette();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, openPalette]);

  // 打开时自动聚焦输入框
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const execute = (item: PaletteItem | undefined) => {
    if (!item) return;
    const st = useAppStore.getState();
    if (item.group === "pages" && item.view) {
      setOpen(false);
      st.setView(item.view);
      return;
    }
    if (item.group === "sessions" && item.sessionKey) {
      // UsagePage jumpToSession 同款：会话还活着才跳（已清理/归档的只提示不跳）
      if (!st.sessions.some((x) => x.key === item.sessionKey)) {
        setOpen(false);
        showToast({ kind: "err", text: "该会话已不在会话列表（可能已清理或归档），跳转失败" }, 8000);
        return;
      }
      setOpen(false);
      st.setCurrentKey(item.sessionKey);
      st.setView("chat");
      return;
    }
    if (item.actionId) {
      setOpen(false);
      void runAction(item.actionId, showToast);
    }
  };

  const onInputKeyDown = (e: ReactKeyEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel(hits.length ? (selIdx + 1) % hits.length : 0);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel(hits.length ? (selIdx - 1 + hits.length) % hits.length : 0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      execute(hits[selIdx]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  if (!open && !toast) return null;

  return (
    <>
      {open && (
        <div className="cp-overlay" onMouseDown={() => setOpen(false)}>
          <div
            className="cp-panel"
            role="dialog"
            aria-label="命令面板"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="cp-head">
              <span className="cp-kbd">Ctrl K</span>
              <input
                ref={inputRef}
                className="cp-input"
                value={query}
                placeholder="跳到…或输入命令"
                onChange={(e) => {
                  setQuery(e.target.value);
                  setSel(0);
                }}
                onKeyDown={onInputKeyDown}
              />
            </div>
            <div className="cp-list">
              {hits.map((it, idx) => (
                <Fragment key={it.id}>
                  {(idx === 0 || hits[idx - 1].group !== it.group) && (
                    <div className="cp-group-head">{GROUP_LABELS[it.group]}</div>
                  )}
                  <button
                    className={`cp-row${idx === selIdx ? " sel" : ""}`}
                    onMouseEnter={() => setSel(idx)}
                    onClick={() => execute(it)}
                  >
                    <span className={`cp-icon${it.group === "sessions" ? " dot" : ""}`}>{it.icon}</span>
                    <span className="cp-label">{it.label}</span>
                    {it.hint && <span className="cp-hint">{it.hint}</span>}
                  </button>
                </Fragment>
              ))}
              {!hits.length && <div className="cp-empty">没有匹配的条目</div>}
            </div>
            <div className="cp-foot">
              <span>↑↓ 选择 · ↵ 执行 · esc 关闭</span>
              <span>Ctrl K 呼出</span>
            </div>
          </div>
        </div>
      )}
      {toast && <div className={`cp-toast ${toast.kind}`}>{toast.text}</div>}
    </>
  );
}
