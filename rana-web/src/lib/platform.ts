// 宿主平台（由 vite.config.ts 的 define 注入，见其注释）：
// win32=家里的电脑（保留本地模型面板与本机操作卡）；其余=云服务器（隐藏 LM Studio 入口）。
declare const __RANA_HOST_PLATFORM__: string;
export const HOST_IS_WINDOWS = __RANA_HOST_PLATFORM__ === "win32";
