// 「🧰 程序」页：多用途工具壳。第一个专区是玄学全套（万年历/生辰档案/排盘/问卜），
// 页内小节导航锚点跳转；以后新工具往这儿加专区就行。
import { useState } from "react";
import CalendarAlmanac from "./apps/CalendarAlmanac";
import FateProfileCard from "./apps/FateProfile";
import type { FateProfile } from "./apps/FateProfile";
import FateCharts from "./apps/FateCharts";
import Divination from "./apps/Divination";

const SECTIONS = [
  { id: "app-sec-cal", label: "📜 万年历" },
  { id: "app-sec-profile", label: "🧧 我的档案" },
  { id: "app-sec-charts", label: "🀄 排盘" },
  { id: "app-sec-divi", label: "🪙 问卜" },
];

const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

export default function AppsPage() {
  const [profile, setProfile] = useState<FateProfile | null>(null);

  return (
    <div className="wallboard">
      <div className="board-inner" style={{ maxWidth: 1100 }}>
        <div className="page-intro">
          <h2>程序</h2>
          <p>一些长在手边的小工具 · 玄学专区全部本地计算，问卦才联网问她</p>
        </div>

        <nav className="apps-nav">
          {SECTIONS.map((s) => (
            <button key={s.id} className="chip green big" onClick={() => jump(s.id)}>
              {s.label}
            </button>
          ))}
        </nav>

        <section id="app-sec-cal" className="app-sec">
          <h3 className="sec-title">📜 万年历</h3>
          <CalendarAlmanac />
        </section>

        <section id="app-sec-profile" className="app-sec">
          <h3 className="sec-title">🧧 我的档案</h3>
          <div className="card">
            <FateProfileCard onSaved={setProfile} />
          </div>
        </section>

        <section id="app-sec-charts" className="app-sec">
          <h3 className="sec-title">🀄 排盘 · 八字 &amp; 紫微</h3>
          <FateCharts profile={profile} />
        </section>

        <section id="app-sec-divi" className="app-sec">
          <h3 className="sec-title">🪙 摇卦问卜</h3>
          <div className="card">
            <Divination profile={profile} />
          </div>
        </section>
      </div>
    </div>
  );
}
