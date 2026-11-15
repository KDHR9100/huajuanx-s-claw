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

/**
 * openclaw.json 单写口（2026-11-15 收拢）：此前 model-params / provider-config 共 3 处手抄
 * 「copyFileSync 备份特定后缀 + writeJsonAtomic 原子写」，收拢为本函数，openclaw.json 只许从这写。
 * 行为 = 现役做法的并集取最严：备份（旧文件缺失则跳过，同 writeJsonBak 口径）+ 原子写（tmp+rename）。
 * bakSuffix 沿用各写点原有后缀（.bak-params / .bak-cloud），新写者不传默认 .bak。
 * file 由调用方传 OPENCLAW_CONFIG（server/lib/paths.ts），与读侧 readFullConfig 同一个常量，读写同源不漂移；
 * 特意不做成内置默认路径——本模块必须保持顶层零 I/O，单测才能裸机导入（11-15 CI 四连红教训），
 * 一旦引 paths.ts 就会连带它顶层的 CLI 探测 I/O。
 */
export function writeOpenclawConfig(file: string, data: unknown, bakSuffix = ".bak") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.copyFileSync(file, file + bakSuffix);
  } catch {
    // 首次写入还没有旧文件
  }
  writeJsonAtomic(file, data);
}
