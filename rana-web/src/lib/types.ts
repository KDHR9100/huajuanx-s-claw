export interface UsageInfo {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  contextTokens?: number;
  estimatedCostUsd?: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  ts: number;
  streaming?: boolean;
  usage?: UsageInfo;
  model?: string;
  error?: string;
}

export interface SessionRow {
  key: string;
  title?: string;
  updatedAt?: number;
  model?: string;
  totalTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  contextTokens?: number;
  estimatedCostUsd?: number;
  hasActiveRun?: boolean;
  /** 服务端持久化标识：归档（lifecycle patch）时作乐观锁 expectedSessionId */
  sessionId?: string;
  /** agent 主会话（服务端禁止删除/归档） */
  isMain?: boolean;
}

export interface ModelInfo {
  id: string;
  name?: string;
  contextWindow?: number;
  alias?: string;
  provider?: string;
}

export type ConnState = "connecting" | "connected" | "error" | "closed";

/** 外观设置（持久化在 localStorage） */
export interface ThemeSettings {
  /** 主题强调色（粉/蓝/绿…），驱动按钮、气泡、进度条等 */
  accent: string;
  /** 背景图片（dataURL 或 URL），空串表示未启用 */
  bgImage: string;
  /** 背景图不透明度 0-1 */
  bgOpacity: number;
  /** 浅色 / 夜间模式 */
  mode: "light" | "dark";
  /** 最近使用的自定义颜色（非预设），最新在前，最多 8 个 */
  accentHistory: string[];
}

/** 模型 id 归一化：去掉 provider 前缀（aliyun-maas/qwen3.8-flash → qwen3.8-flash） */
export function modelSuffix(id?: string): string {
  if (!id) return "";
  return id.split("/").pop() ?? id;
}
