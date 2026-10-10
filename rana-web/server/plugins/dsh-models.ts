import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

/**
 * DSH 模型清单端点（纯只读）：GET /__rana/dsh-models
 * 读 WSL 里 DSH 的 settings.yaml（deepseek/百炼路线 + 自定义 pi-ai 路线），供派活页下拉。
 * 路径与派活页个人预设都放在 gitignored 的 local-config.json（模板 local-config.example.json）；
 * 文件缺失/未配置时返回空清单与空预设，前端退回内置默认与自由填写。改配置需重启 vite。
 */
export function ranaDshModelsMiddleware(): Plugin {
  // 本机个人路径（含 WSL 用户名）不入公开仓库：启动时从 local-config.json 读一次
  let dshSettingsPath = "";
  let dshPresets: Array<{ name: string; cwd: string }> = [];
  try {
    const local = JSON.parse(
      fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "local-config.json"), "utf8"),
    ) as { dshSettingsPath?: string; dshPresets?: Array<{ name: string; cwd: string }> };
    if (typeof local.dshSettingsPath === "string") dshSettingsPath = local.dshSettingsPath;
    if (Array.isArray(local.dshPresets)) dshPresets = local.dshPresets;
  } catch {
    // 没配 local-config.json：模型清单走空、预设由前端内置默认兜底
  }

  const parseModels = (): Array<{ provider: string; full: string; name?: string }> => {
    let raw = "";
    if (!dshSettingsPath) return [];
    try {
      raw = fs.readFileSync(dshSettingsPath, "utf8");
    } catch {
      return [];
    }
    const out: Array<{ provider: string; full: string; name?: string }> = [];
    const lines = raw.split("\n");
    let current = "";
    const bodyBySection = new Map<string, string[]>();
    for (const ln of lines) {
      const top = ln.match(/^(\S+):\s*$/);
      if (top) {
        current = top[1];
        if (!bodyBySection.has(current)) bodyBySection.set(current, []);
        continue;
      }
      if (current && (ln.startsWith("  ") || ln.trim() === "")) bodyBySection.get(current)!.push(ln);
    }
    for (const [name, body] of bodyBySection) {      if (name === "llm-deepseek") {
        for (const ln of body) {
          const id = ln.match(/^\s{4}- id:\s*(\S+)/);
          if (id) out.push({ provider: "deepseek-official", full: `deepseek-official/${id[1]}`, name: undefined });
          const nm = ln.match(/^\s+name:\s*(.+)/);
          if (nm && out.length) out[out.length - 1].name = nm[1].trim();
        }
      } else if (name === "llm-pi-ai") {
        // providers: <key>: 下缩进的 models 列表
        let prov = "";
        for (const ln of body) {
          const pk = ln.match(/^\s{4}(\S+):\s*$/);
          if (pk) {
            prov = pk[1];
            continue;
          }
          const id = ln.match(/^\s{8}- id:\s*(\S+)/);
          if (id && prov) out.push({ provider: prov, full: `${prov}/${id[1]}`, name: undefined });
          const nm = ln.match(/^\s{10}name:\s*(.+)/);
          if (nm && out.length) out[out.length - 1].name = nm[1].trim();
        }
      }
    }
    return out;
  };

  const handler = (
    req: { method?: string; url?: string },
    res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string) => void },
  ) => {
    if (req.method === "GET") {
      const models = parseModels();
      res.setHeader("content-type", "application/json");
      res.statusCode = 200;
      res.end(JSON.stringify({ models, presets: dshPresets, updatedAt: Date.now() }));
      return;
    }
    res.setHeader("content-type", "application/json");
    res.statusCode = 405;
    res.end(JSON.stringify({ error: "method not allowed" }));
  };

  return {
    name: "rana-dsh-models",
    configureServer(server) {
      server.middlewares.use("/__rana/dsh-models", handler as Parameters<typeof server.middlewares.use>[1]);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/__rana/dsh-models", handler as Parameters<typeof server.middlewares.use>[1]);
    },
  };
}
