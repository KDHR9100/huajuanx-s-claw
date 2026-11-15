/**
 * single-instance.mjs —— 单实例端口锁公共库（零依赖，只用 node:net）。
 *
 * 来源：2026-11-15 从 qq-sidecar/index.mjs 的 acquireLock() 逐字抽取（架构体检小项1）。
 * 机制：在 127.0.0.1:<port> 上 listen 一个 TCP server；端口被占（EADDRINUSE）
 * 就说明同端口实例已在跑——同一台机器上谁占着锁谁就是唯一实例。
 *
 * 等价承诺：机制与原 acquireLock 逐字等价——
 *   - 成功：返回句柄 { port, name, server }。server 就是原来那个 net server，
 *     持有方退出时自行 server.close()（qq-sidecar 现状即如此）；
 *   - 失败：抛 listen 的原始错误（带 .code，如 'EADDRINUSE'）。
 *     原版是 resolve({ ok, error }) 结果对象，改抛错后调用方的退出话术/退出码不变。
 *
 * 现役用户：qq-sidecar/index.mjs（锁端口 47612，环境变量 QQ_SIDECAR_LOCK_PORT 可覆盖）。
 * 未来可用者（尚未迁移，宁缺勿歪，迁前先读各自现状）：
 *   根目录 tools/embedding-watchdog.mjs、tools/sse-fix-proxy.mjs（各自手抄了同款
 *   「端口被占即退」逻辑）、rana-web/health-patrol.mjs 等。
 */
import net from 'node:net';

/**
 * 抢占端口锁。
 * @param {number} port 要占住的端口（绑 127.0.0.1，不对外）
 * @param {string} name 持锁方标识（只放进句柄便于日志辨识，不影响行为）
 * @returns {Promise<{port: number, name: string, server: import('node:net').Server}>}
 *   抢到返回句柄；端口被占等失败则抛原始错误，调用方按 error.code 分流话术。
 */
export function acquirePortLock(port, name = 'single-instance') {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (error) => reject(error));
    server.listen(port, '127.0.0.1', () => resolve({ port: server.address()?.port ?? port, name, server }));
  });
}
