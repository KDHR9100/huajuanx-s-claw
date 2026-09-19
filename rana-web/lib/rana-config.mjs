/**
 * rana-config.mjs — 边车脚本共享小工具（Node 侧）
 * 统一两件事：状态目录定位、SecretRef apiKey 解析。
 * 背景：doctor 把 provider 明文 key 迁进密钥库后，openclaw.json 里的 apiKey
 * 变成 {source:"store",id} 对象——直读当 Bearer 用会发出 "[object Object]"。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

/** 状态目录：环境变量优先（网关启动脚本同款），缺省回退仓库内布局（本文件在 rana-web/lib/ 下，上两级即仓库根） */
export const STATE_HOME = process.env.OPENCLAW_STATE_DIR
  ? path.resolve(process.env.OPENCLAW_STATE_DIR)
  : path.resolve(fileURLToPath(new URL('../../.openclaw/.openclaw', import.meta.url)));

/** apiKey 可能是明文串，也可能是 SecretRef 对象（{source:"store",id}）——后者去 state SQLite 解析 */
export function resolveApiKey(raw) {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object' && raw.source === 'store') {
    const db = new DatabaseSync(path.join(STATE_HOME, 'state', 'openclaw.sqlite'), { readOnly: true });
    try {
      const row = db.prepare(
        "SELECT value FROM secret_store_entries WHERE name = ? AND kind = 'secret' AND deleted_at_ms IS NULL ORDER BY updated_at_ms DESC LIMIT 1"
      ).get(String(raw.id ?? ''));
      return row ? String(row.value) : undefined;
    } finally { db.close(); }
  }
  return undefined;
}
