// pendingCreateKeys.ts —— gateway.ts「临时 key 原语」的纯函数提取（测试安全网）。
//
// 提取来源：rana-web/src/lib/gateway.ts
//   行 117     —— pendingCreates 字段声明（tempKey → 服务端真实 key 的 Promise）
//   行 771     —— makePendingCreateKey：tempKey = `pending-create:${uuid}`
//   行 534/675/818/832 —— key.startsWith("pending-create:") 四处分支判定
//   行 675-683 —— sendChat 等真实 key：无 promise 静默放弃；await 失败静默放弃
//   行 832-838 —— deleteSession 等真实 key：await 失败或空串 → 放弃
//   行 591-594 —— refreshSessions 保留未落地的占位会话行
//   行 802-809 —— migratePendingSession 迁移时的标题/model/sessionId 字段映射
// 提取日期：2026-11-14。
// 现行行为语义：
//   1) 生命周期：createSession 先发占位 key 并把创建 promise 存入 pendingCreates
//      （789），promise settle 后无论成败立即从 map 移除（790 的 finally），
//      失败时 catch 吞掉防 unhandled rejection。
//   2) send 与 delete 的取 key 语义**已统一**（2026-11-17 主人拍板「向 delete 看齐」）：
//      promise resolve("") 两边都按失败放弃（返回 null）。统一前 send 侧曾透传空串
//      继续发送（可能发出 sessionKey="" 的请求）；实际运行中 sessions.create 响应缺 key
//      会 throw（gateway.ts:780），原属死分支，故统一是观察等价的防御性收拢。
//   3) refreshSessions：占位会话只要服务端列表还没出现就保留并排在列表最前，
//      防乐观创建的占位行被刷新冲掉。
// 采用方式：并行 WIP 落地后由 adoption patch 把 gateway.ts 上述分支替换为
//   调用本模块；异步编排（等待/清理 promise 生命周期）仍留 gateway。

/** 乐观创建占位 key 前缀（gateway.ts:771 起使用，唯一字面量来源） */
export const PENDING_CREATE_PREFIX = "pending-create:";

/** 前缀识别：gateway.ts:534/675/818/832 四处 `key.startsWith("pending-create:")` 的共用判定 */
export function isPendingCreateKey(key: string): boolean {
  return key.startsWith(PENDING_CREATE_PREFIX);
}

/** 占位 key 生成（gateway.ts:771，randomPart 实际传 crypto.randomUUID()） */
export function makePendingCreateKey(randomPart: string): string {
  return `${PENDING_CREATE_PREFIX}${randomPart}`;
}

/**
 * sendChat 侧取真实 key（逐字对应 gateway.ts:675-683，this.pendingCreates → map 参数）。
 * 返回 null 表示现行实现的「静默 return」（创建已失败被清理 / 等待中失败）；
 * 注意：promise resolve("") 时现行实现会透传空串，本函数同样透传。
 */
export async function resolvePendingCreateKeyForSend(
  map: ReadonlyMap<string, Promise<string>>,
  sessionKey: string,
): Promise<string | null> {
  let key = sessionKey;
  if (key.startsWith(PENDING_CREATE_PREFIX)) {
    const p = map.get(key);
    if (!p) return null;
    try {
      key = await p;
    } catch {
      return null;
    }
    if (!key) return null; // 2026-11-17 拍板：与 delete 侧统一，resolve("")=失败放弃，不再透传空串
  }
  return key;
}

/**
 * deleteSession 侧取真实 key（逐字对应 gateway.ts:832-838）。
 * 与 send 侧语义一致：resolve("") 均按失败放弃（2026-11-17 统一拍板，见头注释第 2 条）。
 */
export async function resolvePendingCreateKeyForDelete(
  map: ReadonlyMap<string, Promise<string>>,
  sessionKey: string,
): Promise<string | null> {
  let key = sessionKey;
  if (key.startsWith(PENDING_CREATE_PREFIX)) {
    const p = map.get(key);
    if (!p) return null;
    const real = await p.catch(() => "");
    if (!real) return null;
    key = real;
  }
  return key;
}

/**
 * refreshSessions 的列表合并映射（对应 gateway.ts:591-594）：
 * 占位会话只要没出现在服务端列表（kept，已过滤 deletingKeys）就保留并排最前；
 * 全保留不了则原样返回 kept（现行实现传的是 kept 本体，此处同样返回原引用）。
 */
export function mergeSessionListWithPending<R extends { key: string }>(
  currentRows: readonly R[],
  keptServerRows: R[],
): R[] {
  const pendingRows = currentRows.filter(
    (x) => x.key.startsWith(PENDING_CREATE_PREFIX) && !keptServerRows.some((m) => m.key === x.key),
  );
  return pendingRows.length ? [...pendingRows, ...keptServerRows] : keptServerRows;
}

/** 迁移时回填的会话行字段（对应 gateway.ts:802-809 的 title/model/sessionId 映射；updatedAt 是 Date.now() 副作用，留 gateway） */
export interface MigratedSessionFields {
  title: string;
  model: string | undefined;
  sessionId: string | undefined;
}

/** 逐字对应 gateway.ts:804-808：displayName → derivedTitle → "新会话" 回退链 + sessionId 归一化 */
export function computeMigratedSessionFields(row: Record<string, unknown>): MigratedSessionFields {
  return {
    title: (row.displayName as string) ?? (row.derivedTitle as string) ?? "新会话",
    model: row.model as string | undefined,
    sessionId: row.sessionId ? String(row.sessionId) : undefined,
  };
}
