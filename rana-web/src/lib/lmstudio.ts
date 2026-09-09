// LM Studio 本地模型管理（REST v1，经 Vite 代理 /lmstudio → 127.0.0.1:1234）。
// 已在本机验证的端点：
//   GET  /api/v1/models        列出全部已下载模型 + 加载实例
//   POST /api/v1/models/load   { model, context_length?, flash_attention?, offload_kv_cache_to_gpu? }
//   POST /api/v1/models/unload { instance_id }

const BASE = "/lmstudio";
const TIMEOUT_MS = 15_000;

export interface LmInstance {
  id: string;
  contextLength?: number;
}

export interface LmModel {
  key: string;
  type: "llm" | "embedding" | string;
  publisher: string;
  displayName: string;
  quantization: string;
  sizeBytes: number;
  params: string;
  maxContextLength?: number;
  instances: LmInstance[];
}

export interface LoadOptions {
  contextLength?: number;
  flashAttention: boolean;
  offloadKvToGpu: boolean;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      signal: ctrl.signal,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
    if (!res.ok) {
      throw new Error(body?.error?.message ?? `LM Studio 返回 ${res.status}`);
    }
    return body;
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw new Error("LM Studio 响应超时");
    if (e instanceof TypeError) throw new Error("无法连接 LM Studio（127.0.0.1:1234）");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function listModels(): Promise<LmModel[]> {
  const res = await call<{ models?: Array<Record<string, unknown>> }>("/api/v1/models");
  const rows = res.models ?? [];
  return rows.map((r) => ({
    key: String(r.key ?? ""),
    type: String(r.type ?? "llm"),
    publisher: String(r.publisher ?? ""),
    displayName: String(r.display_name ?? r.key ?? ""),
    quantization: String((r.quantization as { name?: string })?.name ?? ""),
    sizeBytes: Number(r.size_bytes ?? 0),
    params: String(r.params_string ?? ""),
    maxContextLength: (r.max_context_length as number | undefined) ?? undefined,
    instances: Array.isArray(r.loaded_instances)
      ? (r.loaded_instances as Array<Record<string, unknown>>).map((i) => ({
          id: String(i.id ?? ""),
          contextLength: (i.context_length as number | undefined) ?? undefined,
        }))
      : [],
  }));
}

export async function loadModel(model: string, opts: LoadOptions): Promise<void> {
  await call("/api/v1/models/load", {
    method: "POST",
    body: JSON.stringify({
      model,
      ...(opts.contextLength ? { context_length: opts.contextLength } : {}),
      flash_attention: opts.flashAttention,
      offload_kv_cache_to_gpu: opts.offloadKvToGpu,
      echo_load_config: true,
    }),
  });
}

export async function unloadModel(instanceId: string): Promise<void> {
  await call("/api/v1/models/unload", {
    method: "POST",
    body: JSON.stringify({ instance_id: instanceId }),
  });
}

export function fmtBytes(n: number): string {
  if (!n) return "";
  const gb = n / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(n / 1024 ** 2).toFixed(0)} MB`;
}
