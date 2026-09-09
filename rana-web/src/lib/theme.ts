// 外观设置：持久化 + 应用到 CSS 自定义属性。
// accent 驱动 --accent（其余粉色元素在 CSS 内用 color-mix 派生）；
// 背景图写到 --user-bg-image，配合 body.has-bg 让面板半透明透出背景；
// mode 写到 <html data-mode>，夜间配色由 CSS 变量覆盖实现。
import type { ThemeSettings } from "./types";

const KEY = "rana-web.theme";

export const DEFAULT_SETTINGS: ThemeSettings = {
  accent: "#e8748f",
  bgImage: "",
  bgOpacity: 0.35,
  mode: "light",
  accentHistory: [],
};

/** 预设主题色（含默认粉在内的常见色系） */
export const PRESET_ACCENTS = [
  "#e8748f", // 樱花粉（默认）
  "#e86a5c", // 珊瑚橙
  "#e09b3c", // 暖杏黄
  "#5cad8a", // 青黛绿
  "#5c8fd9", // 雾霾蓝
  "#8a6fd9", // 藤萝紫
  "#d95c9e", // 玫红
  "#6b7280", // 石墨灰
];

const MAX_HISTORY = 8;
const isHexColor = (s: unknown): s is string => typeof s === "string" && /^#[0-9a-fA-F]{6}$/.test(s);

/** 把自定义颜色（非预设）记入历史：去重、最新在前、截断长度 */
export function pushAccentHistory(history: string[], color: string): string[] {
  const c = color.toLowerCase();
  if (PRESET_ACCENTS.some((p) => p.toLowerCase() === c)) return history;
  return [color, ...history.filter((x) => x.toLowerCase() !== c)].slice(0, MAX_HISTORY);
}

export function loadSettings(): ThemeSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<ThemeSettings>;
    return {
      accent: isHexColor(parsed.accent) ? parsed.accent : DEFAULT_SETTINGS.accent,
      bgImage: typeof parsed.bgImage === "string" ? parsed.bgImage : "",
      bgOpacity: typeof parsed.bgOpacity === "number" ? Math.min(1, Math.max(0, parsed.bgOpacity)) : DEFAULT_SETTINGS.bgOpacity,
      mode: parsed.mode === "dark" ? "dark" : "light",
      accentHistory: Array.isArray(parsed.accentHistory) ? parsed.accentHistory.filter(isHexColor).slice(0, MAX_HISTORY) : [],
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: ThemeSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch (e) {
    // dataURL 过大超出 localStorage 配额时给出明确提示
    console.warn("[theme] 设置保存失败:", e);
    throw new Error("背景图过大，无法保存（请换小一点的图片或使用 URL 方式）");
  }
}

/** 把设置应用到文档根元素（幂等，可在任意时机重复调用） */
export function applySettings(settings: ThemeSettings) {
  const root = document.documentElement;
  root.style.setProperty("--accent", settings.accent);
  root.style.setProperty("--user-bg-opacity", String(settings.bgOpacity));
  root.dataset.mode = settings.mode;
  if (settings.bgImage) {
    root.style.setProperty("--user-bg-image", `url("${settings.bgImage}")`);
  } else {
    root.style.removeProperty("--user-bg-image");
  }
  document.body.classList.toggle("has-bg", Boolean(settings.bgImage));
}
