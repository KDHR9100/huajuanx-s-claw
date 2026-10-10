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

export const isLoopback = (req: { socket?: { remoteAddress?: string }; headers?: Record<string, unknown> }) => {
  const ra = req.socket?.remoteAddress ?? "";
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ra)) return false;
  const origin = String(req.headers?.origin ?? "");
  if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return false;
  return true;
};
