// lunar-javascript 没带 TS 类型，这里给个最小垫片（实际 API 以运行时为准，探针已验证）
declare module "lunar-javascript" {
  /** 值都是"够用就好"的宽松类型：库方法全部按名调用，写错会在编译期兜不住但运行期可测 */
  export const Solar: any;
  export const Lunar: any;
  export const LunarUtil: any;
}
