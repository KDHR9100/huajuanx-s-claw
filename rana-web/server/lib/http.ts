/** 中间件共用的 HTTP 小工具（原 vite.config.ts 里每插件重复定义，2026-10 抽公共） */
export const json = (
  res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string) => void },
  code: number,
  out: unknown,
) => {
  res.setHeader("content-type", "application/json");
  res.statusCode = code;
  res.end(JSON.stringify(out));
};

export const readBody = (req: { on: (ev: string, cb: (c?: string) => void) => void }) =>
  new Promise<string>((resolve) => {
    let body = "";
    req.on("data", (c?: string) => {
      body += c ?? "";
    });
    req.on("end", () => resolve(body));
  });

/**
 * 写端点来源校验（回环 + 可信内网 IP）。
 * - 本地部署（家里的电脑）：不设 RANA_TRUSTED_IPS，行为与旧版完全一致（仅 127.0.0.1/::1）。
 * - 云端部署：启动环境注入 RANA_TRUSTED_IPS=主人在 Tailscale 内网的设备 IP（逗号分隔，
 *   精确到具体 IP，不放整个 100.64/10 CGNAT 段——迁移方案 2026-10 终审拍板）。
 *   第一道门禁是 Tailscale 组网本身，这里做第二道：页面上所有写操作仍要求来源可信。
 */
const TRUSTED_IPS = (process.env.RANA_TRUSTED_IPS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .flatMap((ip) => [ip, `::ffff:${ip}`]);
const ipLiteral = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const isLoopback = (req: { socket?: { remoteAddress?: string }; headers?: Record<string, unknown> }) => {
  const ra = req.socket?.remoteAddress ?? "";
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ra) && !TRUSTED_IPS.includes(ra)) return false;
  const origin = String(req.headers?.origin ?? "");
  if (origin) {
    const originOk =
      /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin) ||
      TRUSTED_IPS.some((ip) => new RegExp(`^https?:\/\/${ipLiteral(ip.replace(/^::ffff:/, ""))}(:\\d+)?$`, "i").test(origin));
    if (!originOk) return false;
  }
  return true;
};
