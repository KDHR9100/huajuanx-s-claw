// 万年历：真实日期月历 + 当日黄历（农历/干支/宜忌/纳音）+ 十二时辰吉凶。全部本地计算。
import { useMemo, useState } from "react";
import { dayAlmanac, lunarCellLabel, monthCells } from "../../lib/fateCore";
import Term from "./Term";

const WEEK = ["一", "二", "三", "四", "五", "六", "日"];

export default function CalendarAlmanac() {
  const now = new Date();
  const [sel, setSel] = useState({ y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() });
  const [cursor, setCursor] = useState({ y: now.getFullYear(), m: now.getMonth() + 1 });

  const alm = useMemo(() => dayAlmanac(sel.y, sel.m, sel.d), [sel.y, sel.m, sel.d]);
  const cells = useMemo(() => monthCells(cursor.y, cursor.m), [cursor]);
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  const shift = (delta: number) => {
    setCursor(({ y, m }) => {
      const d = new Date(y, m - 1 + delta, 1);
      return { y: d.getFullYear(), m: d.getMonth() + 1 };
    });
  };

  return (
    <div className="study-layout">
      {/* 左：月历 */}
      <div className="card alm-cal">
        <div className="cal-nav">
          <button className="btn ghost sm" onClick={() => shift(-1)}>
            ‹
          </button>
          <b>
            {cursor.y} 年 {cursor.m} 月
          </b>
          <div className="cal-btns">
            <button
              className="btn ghost sm"
              onClick={() => {
                setCursor({ y: now.getFullYear(), m: now.getMonth() + 1 });
                setSel({ y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() });
              }}
            >
              今天
            </button>
            <button className="btn ghost sm" onClick={() => shift(1)}>
              ›
            </button>
          </div>
        </div>
        <div className="cal-week">
          {WEEK.map((w) => (
            <span key={w}>{w}</span>
          ))}
        </div>
        <div className="cal-grid">
          {cells.map((c) => {
            const label = lunarCellLabel(c.y, c.m, c.d);
            const ymd = `${c.y}-${String(c.m).padStart(2, "0")}-${String(c.d).padStart(2, "0")}`;
            return (
              <button
                key={ymd}
                type="button"
                className={[
                  "al-cell",
                  c.inMonth ? "" : "other",
                  ymd === todayStr ? "today" : "",
                  ymd === alm.ymd ? "sel" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={() => {
                  setSel(c);
                  if (!c.inMonth) setCursor({ y: c.y, m: c.m });
                }}
              >
                <span className="al-d">{c.d}</span>
                <span className={`al-lunar${label.isJieQi ? " jq" : ""}`}>{label.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 右：当日黄历 */}
      <div className="alm-side">
        <div className="card">
          <h3>
            📜 {alm.ymd.replace(/-/g, "/")} · {alm.week}
            <small>{alm.lunarText}</small>
          </h3>
          <div className="alm-kv">
            <span className="k">年柱</span>
            <b>{alm.yearGZ}</b>
            <span className="k">月柱</span>
            <b>{alm.monthGZ}</b>
            <span className="k">日柱</span>
            <b>{alm.dayGZ}</b>
            <span className="k">生肖</span>
            <b>{alm.shengXiao}</b>
            <span className="k">
              <Term k="纳音">纳音</Term>
            </span>
            <b>{alm.naYin}</b>
          </div>
          {(alm.yi.length > 0 || alm.ji.length > 0) && (
            <div className="alm-yiji">
              <div className="yj yi">
                <span className="yj-t">宜</span>
                <span>{alm.yi.join(" · ") || "—"}</span>
              </div>
              <div className="yj ji">
                <span className="yj-t">忌</span>
                <span>{alm.ji.join(" · ") || "—"}</span>
              </div>
            </div>
          )}
          {(alm.festivals.length > 0 || alm.jieQi) && (
            <p className="alm-feast">
              {alm.jieQi && `节气 ${alm.jieQi}`}
              {alm.jieQi && alm.festivals.length > 0 && " · "}
              {alm.festivals.join(" · ")}
            </p>
          )}
        </div>

        <div className="card">
          <h3>🕐 时辰吉凶（当日天神）</h3>
          <div className="hour-grid">
            {alm.hours.map((h) => (
              <div key={h.zhi + h.hm} className={`hour-cell ${h.luck === "吉" ? "luck" : h.luck === "凶" ? "bad" : ""}`}>
                <b>
                  {h.zhi}
                  <span className={`hour-luck ${h.luck === "吉" ? "luck" : h.luck === "凶" ? "bad" : ""}`}>{h.luck}</span>
                </b>
                <span className="hour-hm">{h.hm}</span>
                <span className="hour-gz">{h.ganZhi}</span>
              </div>
            ))}
          </div>
          <p className="tune-hint">吉凶按当日十二值神（青龙、明堂、天刑…）轮值口径，黄历参考，别太当真。</p>
        </div>
      </div>
    </div>
  );
}
