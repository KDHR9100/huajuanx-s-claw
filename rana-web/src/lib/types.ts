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
  /** 运行阶段（chat 事件 state=status 的 phase），仅流式期间有意义 */
  status?: string;
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
  /** 会话所属智能体（main / rana-rp…），右侧面板的技能清单跟着它切换 */
  agentId?: string;
}

export interface ModelInfo {
  id: string;
  name?: string;
  contextWindow?: number;
  alias?: string;
  provider?: string;
}

export type ConnState = "connecting" | "connected" | "error" | "closed";

/** 顶部导航的页面视图 */
export type AppView = "chat" | "sys" | "cron" | "news" | "study" | "apps";

/** 外观设置（持久化在 localStorage） */
export interface ThemeSettings {
  /** 主题强调色（绿/粉/蓝…），驱动按钮、气泡、进度条等 */
  accent: string;
  /** 背景图片（dataURL 或 URL），空串表示未启用 */
  bgImage: string;
  /** 背景图不透明度 0-1 */
  bgOpacity: number;
  /** 浅色 / 夜间模式 */
  mode: "light" | "dark";
  /** 最近使用的自定义颜色（非预设），最新在前，最多 8 个 */
  accentHistory: string[];
  /** 乐奈头像 URL（/__rana/avatar?…，空串=手绘默认脸）；带时间戳参数防缓存 */
  avatarUrl?: string;
}

/** 模型 id 归一化：去掉 provider 前缀（aliyun-maas/qwen3.8-flash → qwen3.8-flash） */
export function modelSuffix(id?: string): string {
  if (!id) return "";
  return id.split("/").pop() ?? id;
}
