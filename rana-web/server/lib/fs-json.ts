// 共享 JSON 文件读写器（2026-11-06 收拢：此前 9 个插件 11 处手抄「.bak+writeFileSync」三件套）。
// 语义与原手抄版逐字等价；被运行时热重载监视的 openclaw.json 改用 writeJsonAtomic
// （tmp+rename，qq-sidecar 同款口径）降低网关读到半截文件的概率。
import fs from "node:fs";
import path from "node:path";

/** 容错读 JSON：文件不存在或解析失败返回 fallback */
export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** 先把旧文件备份到 file+suffix（无旧文件则跳过），再写入 content（原 11 处手抄三件套的收拢版） */
export function backupThenWrite(file: string, content: string, suffix = ".bak") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.copyFileSync(file, file + suffix);
  } catch {
    // 首次写入没有旧文件
  }
  fs.writeFileSync(file, content, "utf8");
}

/** JSON 备份写：JSON.stringify(data, null, 2) 后走 backupThenWrite */
export function writeJsonBak(file: string, data: unknown, bakSuffix = ".bak") {
  backupThenWrite(file, JSON.stringify(data, null, 2), bakSuffix);
}

/** 原子写：先写 file+".tmp" 再 rename 覆盖（Windows 下 renameSync 可覆盖已存在文件） */
export function writeJsonAtomic(file: string, data: unknown) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmp, file);
}
