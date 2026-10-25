// 宿主平台形态：云端部署以 RANA_HOST_PLATFORM=linux 启动(rana-web.service 注入)，
// 家里不设该变量=Windows 默认(保留本地模型面板与本机操作卡)。
// 注:最初用 vite define 注入 __RANA_HOST_PLATFORM__,dev 模式实测不替换(裸标识符进浏览器=白屏),改走 envPrefix 通道。
export const HOST_IS_WINDOWS = import.meta.env.RANA_HOST_PLATFORM !== "linux";
