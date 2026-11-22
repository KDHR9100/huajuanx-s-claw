// 「🐾 桌宠」页：同源代理嵌入本机桌宠设置页（RanaPet 的 HTTP 服务，127.0.0.1:47690）。
// iframe 走 /__rana/pet-console/（同源代理，见 server/plugins/pet-console.ts）：
// 宠物没跑时代理直接返回「没在跑」提示页，iframe 里可见，本组件零健康检查逻辑。
export default function PetPage() {
  return (
    <div className="wallboard">
      <iframe
        src="/__rana/pet-console/"
        title="RanaPet 设置"
        style={{ display: "block", width: "100%", height: "100%", minHeight: 600, border: "none" }}
      />
    </div>
  );
}
