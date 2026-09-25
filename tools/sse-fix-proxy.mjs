// sse-fix-proxy —— 给 sillytraven 中转站补流式"结束暗号"的小代理
//
// 背景（详见 KNOWN-ISSUES.md 2026-09-25 条目）：api.sillytraven.dev 的 SSE 流
// 从不发 finish_reason 块和 [DONE] 结束标记（内容本身完整）。openclaw 严格按
// 协议收流，等不到结束标记就把整次回复判为失败丢弃，导致微信侧 RP 无回复。
//
// 本代理夹在 openclaw 与中转站之间：
//   - 请求原样转发（含 Authorization，钥匙仍由 openclaw 持有，本代理不存密钥）；
//   - 响应为 SSE 且缺结束标记时，在流末尾补一个 finish_reason:"stop" 块和 [DONE]；
//   - 非 SSE 响应（如 JSON 报错）原样透传，不动刀。
//
// 端口锁：已在本端口运行时直接退出，防多开（与 embedding-watchdog 同规矩）。
// 环境变量可覆盖：SSEFIX_PORT（默认 18801）、SSEFIX_UPSTREAM（默认中转站 v1 根）。
// 日志：%TEMP%\openclaw\sse-fix-proxy.log

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.SSEFIX_PORT || 18801);
const UPSTREAM = process.env.SSEFIX_UPSTREAM || 'https://api.sillytraven.dev/api/ai/v1';
const UP = new URL(UPSTREAM);

const logDir = path.join(process.env.TEMP || '.', 'openclaw');
fs.mkdirSync(logDir, { recursive: true });
const LOG = path.join(logDir, 'sse-fix-proxy.log');
function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  try { fs.appendFileSync(LOG, line + '\n'); } catch {}
  console.log(line);
}

// 在字节流里找结束标记（跨块边界：保留 64 字符尾巴接续扫描）。
// "finish_reason":" 只匹配字符串值，null 不会误判。
function makeScanner() {
  let carry = '', sawFinish = false, sawDone = false, sawContent = false;
  return {
    scan(text) {
      const buf = carry + text;
      if (/"finish_reason"\s*:\s*"/.test(buf)) sawFinish = true;
      if (/(^|\n)data:\s*\[DONE\]/.test(buf)) sawDone = true;
      if (/"content"\s*:/.test(buf)) sawContent = true;
      carry = buf.length > 64 ? buf.slice(-64) : buf;
    },
    get needFix() { return !sawFinish; },
    get sawDone() { return sawDone; },
    get sawContent() { return sawContent; },
  };
}

const server = http.createServer((req, res) => {
  const started = Date.now();
  if (!req.url.startsWith('/v1/')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'sse-fix-proxy: only /v1/* paths are proxied' }));
    return;
  }
  const upstreamPath = UP.pathname + req.url.slice('/v1'.length);

  const headers = { ...req.headers };
  delete headers.host;
  delete headers.connection;
  // 强制上游返回未压缩响应，否则字节级扫描会扫到 gzip 乱码
  delete headers['accept-encoding'];

  const upReq = https.request(
    { hostname: UP.hostname, port: 443, path: upstreamPath, method: req.method, headers },
    (upRes) => {
      const isSSE = String(upRes.headers['content-type'] || '').includes('text/event-stream');
      if (!isSSE) {
        res.writeHead(upRes.statusCode, upRes.headers);
        upRes.pipe(res);
        return;
      }
      const scanner = makeScanner();
      const outHeaders = { ...upRes.headers };
      // 我们可能在末尾追加字节，不能保留上游的分块/长度声明
      delete outHeaders['content-length'];
      delete outHeaders['transfer-encoding'];
      res.writeHead(upRes.statusCode, outHeaders);
      upRes.setEncoding('utf8');
      upRes.on('data', (chunk) => {
        scanner.scan(chunk);
        res.write(chunk);
      });
      upRes.on('end', () => {
        const events = 0; // 仅日志占位，计数在下方 chunks 统计
        if (scanner.needFix && scanner.sawContent) {
          const tail =
            'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
            (scanner.sawDone ? '' : 'data: [DONE]\n\n');
          res.write(tail);
          log(`req ${req.method} ${req.url} -> ${upRes.statusCode} FIXED (append finish_reason/[DONE]) ${Date.now() - started}ms`);
        } else if (scanner.needFix && !scanner.sawContent) {
          log(`req ${req.method} ${req.url} -> ${upRes.statusCode} empty-sse, not fixing ${Date.now() - started}ms`);
        } else {
          log(`req ${req.method} ${req.url} -> ${upRes.statusCode} passthrough (upstream sent finish_reason) ${Date.now() - started}ms`);
        }
        res.end();
      });
      upRes.on('error', (e) => {
        log(`req ${req.method} ${req.url} upstream error: ${e.message}`);
        res.end();
      });
    }
  );
  upReq.on('error', (e) => {
    log(`req ${req.method} ${req.url} connect error: ${e.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'sse-fix-proxy upstream connect failed', detail: e.message }));
    } else {
      res.end();
    }
  });
  req.pipe(upReq);
});

// 长 RP 生成可能好几分钟，禁掉 Node 默认的请求超时
server.requestTimeout = 0;
server.headersTimeout = 60000;

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    log(`port ${PORT} already in use, another sse-fix-proxy is running; exit 0`);
    process.exit(0);
  }
  throw e;
});

server.listen(PORT, '127.0.0.1', () => {
  log(`sse-fix-proxy listening on 127.0.0.1:${PORT} -> ${UPSTREAM}`);
});
