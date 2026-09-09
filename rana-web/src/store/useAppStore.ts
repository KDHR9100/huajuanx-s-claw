import { create } from "zustand";
import type { ChatMessage, ConnState, ModelInfo, SessionRow, ThemeSettings } from "../lib/types";
import { applySettings, loadSettings, saveSettings, DEFAULT_SETTINGS } from "../lib/theme";

interface StreamingRun {
  runId: string;
  msgId: string;
  text: string;
  lastSeq: number;
}

interface AppState {
  conn: ConnState;
  connError?: string;

  sessions: SessionRow[];
  currentKey?: string;
  mainSessionKey?: string;
  /** 置顶的会话 key（按置顶先后排序，持久化在 localStorage） */
  pinned: string[];

  messages: Record<string, ChatMessage[]>;

  models: ModelInfo[];
  /** 每个会话正在进行的 run（v1：每会话同时最多一个） */
  runs: Record<string, StreamingRun | undefined>;

  panelOpen: boolean;
  /** 显示模型思考过程（<think> 折叠块）；关闭时完全不渲染 */
  showReasoning: boolean;

  settings: ThemeSettings;
  settingsOpen: boolean;
  /** LM Studio 本地模型管理面板 */
  lmOpen: boolean;
  /** 云端模型配置面板 */
  cloudOpen: boolean;

  setConn: (conn: ConnState, connError?: string) => void;
  setSessions: (sessions: SessionRow[]) => void;
  mergeSession: (row: Partial<SessionRow> & { key: string }) => void;
  removeSession: (key: string) => void;
  togglePin: (key: string) => void;
  setCurrentKey: (key: string) => void;
  setMainSessionKey: (key: string) => void;
  setModels: (models: ModelInfo[]) => void;
  setMessages: (key: string, messages: ChatMessage[]) => void;
  appendMessage: (key: string, message: ChatMessage) => void;
  patchMessage: (key: string, msgId: string, patch: Partial<ChatMessage>) => void;
  setRun: (key: string, run: StreamingRun | undefined) => void;
  togglePanel: () => void;
  setShowReasoning: (v: boolean) => void;
  updateSettings: (patch: Partial<ThemeSettings>) => void;
  resetSettings: () => void;
  setSettingsOpen: (open: boolean) => void;
  setLmOpen: (open: boolean) => void;
  setCloudOpen: (open: boolean) => void;
}

export const PINNED_STORAGE_KEY = "rana-web.pinned";
const REASONING_KEY = "rana-web.show-reasoning";

function loadShowReasoning(): boolean {
  return localStorage.getItem(REASONING_KEY) !== "0";
}

function loadPinned(): string[] {
  try {
    const raw = localStorage.getItem(PINNED_STORAGE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export const useAppStore = create<AppState>((set) => ({
  conn: "connecting",
  sessions: [],
  pinned: loadPinned(),
  messages: {},
  models: [],
  runs: {},
  panelOpen: true,
  showReasoning: loadShowReasoning(),

  settings: loadSettings(),
  settingsOpen: false,
  lmOpen: false,
  cloudOpen: false,

  setConn: (conn, connError) => set((s) => ({ conn, connError: connError ?? (conn === "connected" ? undefined : s.connError) })),
  setSessions: (sessions) => set({ sessions }),
  mergeSession: (row) =>
    set((s) => {
      const idx = s.sessions.findIndex((x) => x.key === row.key);
      if (idx === -1) return { sessions: [{ title: "新会话", ...row } as SessionRow, ...s.sessions] };
      const next = s.sessions.slice();
      next[idx] = { ...next[idx], ...row };
      return { sessions: next };
    }),
  setCurrentKey: (currentKey) => set({ currentKey }),
  setMainSessionKey: (mainSessionKey) => set({ mainSessionKey }),
  setModels: (models) => set({ models }),
  setMessages: (key, messages) => set((s) => ({ messages: { ...s.messages, [key]: messages } })),
  appendMessage: (key, message) =>
    set((s) => ({ messages: { ...s.messages, [key]: [...(s.messages[key] ?? []), message] } })),
  patchMessage: (key, msgId, patch) =>
    set((s) => {
      const list = s.messages[key];
      if (!list) return {};
      const idx = list.findIndex((m) => m.id === msgId);
      if (idx === -1) return {};
      const next = list.slice();
      next[idx] = { ...next[idx], ...patch };
      return { messages: { ...s.messages, [key]: next } };
    }),
  setRun: (key, run) => set((s) => ({ runs: { ...s.runs, [key]: run } })),
  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
  setShowReasoning: (showReasoning) => {
    localStorage.setItem(REASONING_KEY, showReasoning ? "1" : "0");
    set({ showReasoning });
  },
  removeSession: (key) =>
    set((s) => {
      const sessions = s.sessions.filter((x) => x.key !== key);
      const messages = { ...s.messages };
      delete messages[key];
      const runs = { ...s.runs };
      delete runs[key];
      const pinned = s.pinned.filter((k) => k !== key);
      if (pinned.length !== s.pinned.length) localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify(pinned));
      // 删除的是当前会话时：优先回到主会话，否则回列表第一个
      const fallback =
        s.mainSessionKey && s.mainSessionKey !== key && sessions.some((x) => x.key === s.mainSessionKey)
          ? s.mainSessionKey
          : sessions[0]?.key;
      return { sessions, messages, runs, pinned, currentKey: s.currentKey === key ? fallback : s.currentKey };
    }),
  togglePin: (key) =>
    set((s) => {
      const pinned = s.pinned.includes(key) ? s.pinned.filter((k) => k !== key) : [key, ...s.pinned];
      localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify(pinned));
      return { pinned };
    }),
  updateSettings: (patch) =>
    set((s) => {
      const next = { ...s.settings, ...patch };
      saveSettings(next);
      applySettings(next);
      return { settings: next };
    }),
  resetSettings: () =>
    set(() => {
      const next = { ...DEFAULT_SETTINGS };
      saveSettings(next);
      applySettings(next);
      return { settings: next };
    }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setLmOpen: (lmOpen) => set({ lmOpen }),
  setCloudOpen: (cloudOpen) => set({ cloudOpen }),
}));
