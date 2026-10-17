// 重连退避计划（纯函数叶模块，零浏览器依赖，供 gateway.ts 与单测共用）。
// 口径（批次 D）：首试 ~1s、每次 ×2、封顶 30s、无限重试不放弃——
// 网关重启是本项目日常运维动作，旧"6 次（约 45s）后彻底放弃"逼用户手动刷新页面。

const RECONNECT_MAX_DELAY_MS = 30_000;

/** 重连退避延时：attempt = 已连败次数；1s→2s→4s→8s→16s→30s（封顶） */
export function reconnectBackoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** Math.max(0, attempt), RECONNECT_MAX_DELAY_MS);
}
