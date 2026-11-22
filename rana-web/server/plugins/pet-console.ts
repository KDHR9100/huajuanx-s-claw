import { json } from "../lib/http";
import { defineRanaPlugin } from "../lib/rana-plugin";

/**
 * 桌宠设置页同源代理：宠物 HTTP 服务(127.0.0.1:47690) 的只读转发层，宠物没跑时优雅降级。
 * 「🐾 桌宠」页签用 iframe 嵌 /__rana/pet-console/，浏览器视角全程同源（免跨域），
 * 这里把请求原样转发给本机 RanaPet：
 * - GET  任意路径：设置页本体 / 静态资源 / 只读接口；
 * - POST 任意路径：设置页的保存动作（body 先收完再转发，限 200KB，超限 413）。
 * 宠物没跑（连接拒绝 / 超时）时不往浏览器甩硬错误：
 * - GET 设置页本体 → 返回内联的「没在跑」提示页（200），iframe 里直接可见；
 * - 其余 → JSON {ok:false, running:false, reason}，交由调用方自行降级。
 * 安全：目标硬编码 127.0.0.1:47690（不接受用户指定 host）；剩余路径防 SSRF/开放代理——
 * 只许以 / 开头且不含 //、@、反斜杠，非法直接 400（挡 /__rana/pet-console//evil.com 之类的把戏）。
 * 回环守卫由 defineRanaPlugin 工厂统一做（非本机来源到不了这里），不重复。
 */
export function ranaPetConsoleMiddleware() {
  const BASE = "http://127.0.0.1:47690";
  const MAX_BODY = 200 * 1024; // POST body 上限：设置保存用不了这么大，挡手滑/恶意大包

  // 宠物没跑时给 iframe 的极小提示页（200 状态，页面体面降级而不是白屏/报错）
  const FALLBACK_HTML =
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>RanaPet 设置</title></head>' +
    '<body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;background:#15151b;color:#c9d1c9;font:14px/1.7 system-ui,sans-serif">' +
    '<div style="text-align:center"><div style="font-size:42px">🐾</div>' +
    '<p style="margin:14px 0 0">宠物程序没在跑——双击 <code>K:\\RanaPet\\start-pet.cmd</code> 启动后刷新</p>' +
    "</div></body></html>";

  const handler = (
    req: {
      method?: string;
      url?: string;
      headers?: Record<string, unknown>;
      on: (ev: string, cb: (c?: string) => void) => void;
    },
    res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string | Buffer) => void },
  ) => {
    // connect 前缀挂载会把 /__rana/pet-console 剥掉，req.url 即剩余路径（含查询串）
    let rest = req.url || "/";
    if (!rest.startsWith("/")) rest = "/" + rest; // 归一化：保证以 / 开头
    if (rest.includes("//") || rest.includes("@") || rest.includes("\\")) {
      // 防 SSRF/开放代理：路径里不许有协议相对、userinfo、反斜杠绕法
      json(res, 400, { ok: false, error: "非法路径" });
      return;
    }

    const method = (req.method ?? "GET").toUpperCase();
    const ct = String(req.headers?.["content-type"] ?? "");

    // POST 先把 body 收完再转发（chunk 收集写法照抄 avatar.ts；超限即失败，resolve/reject 只认先到的）
    const collectBody = () =>
      new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let done = false;
        req.on("data", (c?: string) => {
          if (done) return;
          size += c?.length ?? 0;
          if (size > MAX_BODY) {
            done = true;
            reject(new Error("body too large"));
            return;
          }
          chunks.push(Buffer.from(c ?? "", "binary"));
        });
        req.on("end", () => {
          if (!done) {
            done = true;
            resolve(Buffer.concat(chunks));
          }
        });
      });

    void (async () => {
      let body: Buffer | undefined;
      if (method === "POST") {
        try {
          body = await collectBody();
        } catch {
          json(res, 413, { ok: false, error: "请求体太大（限 200KB）" });
          return;
        }
      }
      try {
        // 只透传 Content-Type（设置页的表单/JSON 都靠它，其余头部不外带）；10 秒超时防挂死
        const r = await fetch(BASE + rest, {
          method,
          headers: ct ? { "content-type": ct } : undefined,
          body,
          signal: AbortSignal.timeout(10000),
        });
        // 上游响应原样透传：状态码 + content-type + body 逐字节回给浏览器
        const buf = Buffer.from(await r.arrayBuffer());
        res.setHeader("content-type", r.headers.get("content-type") ?? "application/octet-stream");
        res.statusCode = r.status;
        res.end(buf);
      } catch {
        // 宠物没跑（ECONNREFUSED / 超时）：优雅降级
        if (method === "GET" && rest.split("?")[0] === "/") {
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.statusCode = 200;
          res.end(FALLBACK_HTML);
          return;
        }
        json(res, 502, { ok: false, running: false, reason: "宠物程序没在跑（RanaPet 未启动或刚重启）" });
      }
    })();
  };

  return defineRanaPlugin({
    name: "rana-pet-console",
    routes: { "/__rana/pet-console": handler },
  });
}
