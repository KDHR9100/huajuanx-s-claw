import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

/** rana-web 根目录（原 vite.config.ts 里每插件自算的 import.meta.url 目录）。
 *  Vite 打包配置时可能把 import.meta.url 指到临时文件，故先验证该目录确含 vite.config.ts，
 *  否则回退 process.cwd()（`npm run dev` 的 cwd 即 rana-web）。 */
export const RANA_WEB = (() => {
  if (process.env.RANA_WEB) return path.resolve(process.env.RANA_WEB);
  const fromMeta = path.dirname(fileURLToPath(import.meta.url));
  if (fs.existsSync(path.join(fromMeta, "vite.config.ts"))) return fromMeta;
  return process.cwd();
})();

// ===== 路径可移植化：环境变量优先，缺省相对仓库根推导（换机器/换目录不用改代码） =====
// 状态目录：OPENCLAW_STATE_DIR 环境变量优先（与启动脚本/边车同一约定），
// 缺省 = rana-web 同级的 .openclaw/.openclaw（已 gitignore，setup.cmd 初始化的就是这里）。
export const STATE_HOME = process.env.OPENCLAW_STATE_DIR
  ? path.resolve(process.env.OPENCLAW_STATE_DIR)
  : path.resolve(RANA_WEB, "..", ".openclaw", ".openclaw");

export const OPENCLAW_CONFIG = path.join(STATE_HOME, "openclaw.json");

/** openclaw CLI 入口（拉运行时模型目录用；与 start-gateway.cmd 同源）：
 *  OPENCLAW_MJS 环境变量 > 常见 npm 全局位置探测 > npm root -g 兜底。 */
export function resolveOpenclawMjs(): string {
  if (process.env.OPENCLAW_MJS) return process.env.OPENCLAW_MJS;
  const candidates = [
    path.join(process.env.APPDATA ?? "", "npm", "node_modules", "openclaw", "openclaw.mjs"),
    path.join(process.env.USERPROFILE ?? "", ".npm-global", "lib", "node_modules", "openclaw", "openclaw.mjs"),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      // 尝试下一个候选
    }
  }
  try {
    const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8", timeout: 15000, windowsHide: true, shell: true }).trim();
    const guess = path.join(root, "openclaw", "openclaw.mjs");
    if (fs.existsSync(guess)) return guess;
  } catch {
    // 探测失败：返回首选候选，调用时会给出明确报错
  }
  return candidates[0];
}
export const OPENCLAW_MJS = resolveOpenclawMjs();

// 仅开发服务器：为本机前端提供 gateway token。
// 优先读本项目的 gateway 状态目录（STATE_HOME/openclaw.json），
// 再回退到 %USERPROFILE%\.openclaw\openclaw.json。
// 只在 loopback dev server 暴露；生产部署请通过设置面板手动填 token。
export function readGatewayToken(): string {
  const candidates = [
    OPENCLAW_CONFIG,
    path.join(process.env.USERPROFILE ?? "", ".openclaw", "openclaw.json"),
  ];
  for (const file of candidates) {
    try {
      const cfg = JSON.parse(fs.readFileSync(file, "utf8")) as { gateway?: { auth?: { token?: string } } };
      const token = cfg?.gateway?.auth?.token;
      if (token) return token;
    } catch {
      // 尝试下一个候选
    }
  }
  return "";
}
