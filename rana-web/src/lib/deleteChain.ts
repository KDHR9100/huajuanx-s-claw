// deleteChain.ts —— gateway.ts「删除队列原语」的纯函数提取（测试安全网，锁现行行为）。
//
// 提取来源：rana-web/src/lib/gateway.ts
//   行 121     —— deleteChain 字段声明（初始 Promise.resolve()）
//   行 866     —— const task = this.deleteChain.then(work)（链上排队）
//   行 886-889 —— this.deleteChain = task.then(noop, noop)（链推进 + 吞错）
// 提取日期：2026-11-14。
// 现行行为语义：
//   1) 串行：每个新任务挂在上一任务的「吞错影子」之后，启动顺序=注册顺序，
//      上一个没 settle 完下一个绝不开始（服务端逐个删除 ~7s，并发会在 30s
//      默认超时处堆积误报）。
//   2) 链不断：链上传递的是 task.then(() => undefined, () => undefined)——
//      某个任务失败（含重试后仍失败 rethrow）只影响它自己的 task，队列继续走。
//   3) 成败透传：task 把 work 的返回值/异常原样交给本次调用方；链本体只看
//      settle 与否。
// 范围说明：gateway.ts:868-884 的重试/回滚编排（attempt、sessionStillActive、
//   mergeSession 等副作用）不收进本模块，留 gateway；这里只锁「排队/链式推进」骨架。
// 采用方式：并行 WIP 落地后由 adoption patch 把 gateway.ts:866/886-889 的
//   内联骨架替换为调用本模块。

/** 一次链式排队的产物：task 给调用方看真实成败，nextChain 接回字段当新链尾 */
export interface ChainedTask<T> {
  task: Promise<T>;
  nextChain: Promise<void>;
}

/**
 * 逐字对应 gateway.ts:866 + 886-889 的链推进骨架（work 参数化）：
 *   const task = this.deleteChain.then(work);          // 866
 *   this.deleteChain = task.then(() => undefined, () => undefined); // 886-889
 * chain 传当前 deleteChain 字段值；调用方把返回的 nextChain 写回该字段。
 */
export function appendToDeleteChain<T>(chain: Promise<void>, work: () => Promise<T>): ChainedTask<T> {
  const task = chain.then(work);
  const nextChain = task.then(
    () => undefined,
    () => undefined,
  );
  return { task, nextChain };
}
