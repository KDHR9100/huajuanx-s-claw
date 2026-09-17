// 带自动重试的 JSON 取数：给「页面挂载时单次 fetch、瞬时抖动即空面板」的地方统一用。
// 瞬时失败（网关刚重启、CLI 子进程超时、网络抖动）重试两次基本都能自愈；
// 重试仍失败则抛错，由调用方照旧显示错误文案。

export async function fetchJsonRetry<T>(
  url: string,
  opts: { retries?: number; baseDelayMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  const retries = opts.retries ?? 2;
  const baseDelay = opts.baseDelayMs ?? 800;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (opts.signal?.aborted) throw new Error("已取消");
    try {
      const r = await fetch(url, { signal: opts.signal });
      if (!r.ok) {
        let msg = `HTTP ${r.status}`;
        try {
          const j = (await r.json()) as { error?: string };
          if (j?.error) msg = j.error;
        } catch {
          /* 非 JSON 报错体就用状态码 */
        }
        throw new Error(msg);
      }
      return (await r.json()) as T;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await new Promise((res) => setTimeout(res, baseDelay * 2 ** attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
