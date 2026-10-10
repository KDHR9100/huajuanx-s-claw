import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** 子进程 execFile 的 Promise 版本（原 vite.config.ts 顶部定义） */
export const execFileP = promisify(execFile);
