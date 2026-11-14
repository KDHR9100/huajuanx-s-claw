// 守卫门面（2026-11-14 架构体检卡2）：纯转发层——核心实现与契约规格表全部单源在
// lib/contract-guard.mjs（边车 .mjs 直接 import 它；插件 TS 世界经本门面引用），
// 不重演「同款修复漏姊妹脚本」。类型见 lib/contract-guard.d.mts。
// 用法：guardReadJson({ contract, file, fields: CONTRACT_FIELDS["xxx"], fallback })
// ——文件缺失静默 fallback（与 readJson 现状一致），坏数据留痕+记台账+降级
// （本卡唯一被批准的行为变化，状态页亮灯接线列后续）。
export {
  checkFields,
  recordViolation,
  guardParsedText,
  guardReadJson,
  contractGuardsFile,
  ranaWebRoot,
  CONTRACT_FIELDS,
} from "../../lib/contract-guard.mjs";
export type {
  GuardField,
  GuardResult,
  GuardFieldType,
  ContractName,
} from "../../lib/contract-guard.d.mts";
