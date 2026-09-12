// 排盘：八字（lunar-javascript）+ 紫微斗数（iztro），全部本地计算。
// 八字表对齐专业排盘软件的"专业细盘"：主星十神/天干/地支/藏干/星运/自坐/空亡/旬首/纳音，
// 大运竖排在右侧并高亮当前一步+今年流年；紫微盘悬停宫位画三方四正（连线+三角）。
// 所有术语走本地注释库（Term 组件悬停出大白话）。
import { useEffect, useMemo, useRef, useState } from "react";
import { bazi, GAN_WX, hourToTimeIndex, sanFangSiZheng, ziwei, ZHI_WX } from "../../lib/fateCore";
import type { ZiweiResult } from "../../lib/fateCore";
import type { FateProfile } from "./FateProfile";
import Term from "./Term";

const WX_CLASS: Record<string, string> = { 木: "wx-mu", 火: "wx-huo", 土: "wx-tu", 金: "wx-jin", 水: "wx-shui" };
const gzWxClass = (ch: string) => {
  const wx = GAN_WX[ch] ?? ZHI_WX[ch];
  return wx ? WX_CLASS[wx] : "";
};

/** 紫微盘的三方四正连线层 */
function ZwLines({ zw }: { zw: ZiweiResult }) {
  const boardRef = useRef<HTMLDivElement | null>(null);
  const cellRefs = useRef(new Map<string, HTMLDivElement | null>());
  const [hover, setHover] = useState<{ zhi: string; lines: Array<[number, number, number, number]>; tri: string } | null>(null);

  const enter = (zhi: string) => {
    const board = boardRef.current;
    if (!board) return;
    const br = board.getBoundingClientRect();
    const center = (z: string) => {
      const el = cellRefs.current.get(z);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2 - br.left, y: r.top + r.height / 2 - br.top };
    };
    const from = center(zhi);
    if (!from) return;
    const { dui, san1, san2 } = sanFangSiZheng(zhi);
    const cDui = center(dui);
    const c1 = center(san1);
    const c2 = center(san2);
    if (!cDui || !c1 || !c2) return;
    setHover({
      zhi,
      lines: [
        [from.x, from.y, cDui.x, cDui.y],
        [from.x, from.y, c1.x, c1.y],
        [from.x, from.y, c2.x, c2.y],
      ],
      tri: `${from.x},${from.y} ${c1.x},${c1.y} ${c2.x},${c2.y}`,
    });
  };

  return (
    <div className="zw-board" ref={boardRef} onMouseLeave={() => setHover(null)}>
      {hover && (
        <svg className="zw-lines" aria-hidden>
          <polygon points={hover.tri} className="zw-tri" />
          {hover.lines.map((l, i) => (
            <line key={i} x1={l[0]} y1={l[1]} x2={l[2]} y2={l[3]} className={i === 0 ? "zw-line-dui" : "zw-line-san"} />
          ))}
        </svg>
      )}
      {zw.palaces.map((p) => (
        <div
          key={p.zhi}
          ref={(el) => {
            cellRefs.current.set(p.zhi, el);
          }}
          className={`zw-cell${p.isSoul ? " soul" : ""}${hover?.zhi === p.zhi ? " hot" : ""}`}
          style={{ gridRow: p.row + 1, gridColumn: p.col + 1 }}
          onMouseEnter={() => enter(p.zhi)}
        >
          <div className="zw-head">
            <span className="zw-name">
              {p.name === "命宫" ? <Term k="命宫">命宫</Term> : p.name}
              {p.isBody && (
                <i className="zw-body" title="身宫">
                  身
                </i>
              )}
            </span>
            <span className="zw-gz">
              {p.gan}
              {p.zhi}
            </span>
          </div>
          <div className="zw-stars">
            {p.majorList.length ? (
              p.majorList.map((s) => (
                <span key={s.name}>
                  <Term k={`星·${s.name}`}>{s.name}</Term>
                  {s.mutagen && <Term k={`化${s.mutagen}`}><sup>[{s.mutagen}]</sup></Term>}{" "}
                </span>
              ))
            ) : (
              <Term k="空宫">空宫</Term>
            )}
          </div>
          <div className="zw-minors">
            {p.minorList.map((n, i) => (
              <span key={n + i}>
                {i > 0 && " "}
                <Term k={`星·${n}`}>{n}</Term>
              </span>
            ))}
          </div>
          {p.decadal && (
            <span className="zw-decadal">
              <Term k="大限">{p.decadal}</Term>
            </span>
          )}
        </div>
      ))}
      <div className="zw-center" style={{ gridRow: "2 / 4", gridColumn: "2 / 4" }}>
        <b>
          <Term k="五行局">{zw.fiveElements}</Term>
        </b>
        <span>
          命宫在{zw.soulZhi} · 身宫在{zw.bodyZhi}
        </span>
        <span>
          <Term k="三方四正">悬停任一宫看三方四正</Term>（对宫一线 + 三合三角）
        </span>
        <span className="zw-gz">{zw.chineseDate}</span>
      </div>
    </div>
  );
}

export default function FateCharts({ profile }: { profile: FateProfile | null }) {
  const init = (): { date: string; time: string; gender: "男" | "女" } => ({
    date: profile?.birthday && /^\d{4}-\d{2}-\d{2}$/.test(profile.birthday) ? profile.birthday : "",
    time: profile?.birthTime && /^\d{2}:\d{2}$/.test(profile.birthTime) ? profile.birthTime : "",
    gender: profile?.gender === "女" ? "女" : "男",
  });
  const [form, setForm] = useState(init);
  const [touched, setTouched] = useState(false);
  const f = touched ? form : init();
  const setF = (patch: Partial<typeof form>) => {
    setTouched(true);
    setForm((prev) => ({ ...prev, ...patch }));
  };

  // 档案一变（切换人/更新资料/新建），排盘立刻跟着走：清掉手动改动状态
  useEffect(() => {
    setTouched(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile]);

  const ready = /^\d{4}-\d{2}-\d{2}$/.test(f.date);
  const hour = /^\d{2}:\d{2}$/.test(f.time) ? Number(f.time.slice(0, 2)) : null;

  const bz = useMemo(() => {
    if (!ready) return null;
    const [y, m, d] = f.date.split("-").map(Number);
    return bazi(y, m, d, hour, f.gender === "男" ? 1 : 0);
  }, [f.date, hour, f.gender, ready]);

  const zw = useMemo(() => {
    if (!ready || hour === null) return null;
    try {
      return ziwei(f.date, hourToTimeIndex(hour), f.gender);
    } catch {
      return null;
    }
  }, [f.date, hour, f.gender, ready]);

  const maxWx = Math.max(1, ...(bz?.wuxing.map((w) => w.count) ?? [1]));
  const curDy = bz?.daYun.find((d) => d.current) ?? null;

  return (
    <div>
      <div className="chart-form">
        <label className="sf-field">
          <span>阳历日期</span>
          <input className="set-input" type="date" value={f.date} onChange={(e) => setF({ date: e.target.value })} />
        </label>
        <label className="sf-field">
          <span>时辰（紫微需要）</span>
          <input className="set-input" type="time" value={f.time} onChange={(e) => setF({ time: e.target.value })} />
        </label>
        <div className="gender-pick">
          {(["男", "女"] as const).map((g) => (
            <button key={g} type="button" className={`mode-btn${f.gender === g ? " active" : ""}`} onClick={() => setF({ gender: g })}>
              {g}
            </button>
          ))}
        </div>
      </div>

      {!ready && <p className="pending-text">选一个日期就能排盘（默认带出档案生日）。</p>}
      {ready && hour === null && <p className="pending-text">没填时辰：八字只出三柱，紫微盘排不了（紫微必须知道时辰）。</p>}

      {bz && (
        <div className="card chart-bazi">
          <h3>
            ☯ 八字 · 日主 {bz.dayMaster}（{bz.dayMasterWx}）
            <small>
              {bz.hasTime ? "四柱" : "三柱（缺时辰）"} · <Term k="起运">{bz.yunStart}起运</Term>
            </small>
          </h3>
          <div className="bazi-layout">
            <div className="bazi-scroll">
              <table className="bazi-table">
                <thead>
                  <tr>
                    <th />
                    <th className="col-cur">
                      <Term k="流年">流年</Term>
                    </th>
                    <th className={curDy ? "col-cur" : ""}>
                      <Term k="大运">大运</Term>
                    </th>
                    {bz.pillars.map((p) => (
                      <th key={p.label}>{p.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th>主星</th>
                    <td className="col-cur">{bz.liuNian.shiShen}</td>
                    <td className={curDy ? "col-cur" : ""}>{curDy?.shiShen ?? "—"}</td>
                    {bz.pillars.map((p) => (
                      <td key={p.label}>
                        <Term k={p.shiShenGan}>{p.shiShenGan}</Term>
                      </td>
                    ))}
                  </tr>
                  <tr className="row-gz">
                    <th>天干</th>
                    <td className={`col-cur ${gzWxClass(bz.liuNian.gz[0])}`}>{bz.liuNian.gz[0]}</td>
                    <td className={curDy ? `col-cur ${gzWxClass(curDy.gz[0])}` : ""}>{curDy?.gz[0] ?? "—"}</td>
                    {bz.pillars.map((p) => (
                      <td key={p.label} className={gzWxClass(p.gz[0])}>
                        {p.gz[0]}
                      </td>
                    ))}
                  </tr>
                  <tr className="row-gz">
                    <th>地支</th>
                    <td className={`col-cur ${gzWxClass(bz.liuNian.gz[1])}`}>{bz.liuNian.gz[1]}</td>
                    <td className={curDy ? `col-cur ${gzWxClass(curDy.gz[1])}` : ""}>{curDy?.gz[1] ?? "—"}</td>
                    {bz.pillars.map((p) => (
                      <td key={p.label} className={gzWxClass(p.gz[1])}>
                        {p.gz[1]}
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <th>
                      <Term k="藏干">藏干</Term>
                    </th>
                    <td className="col-cur dim">—</td>
                    <td className="dim">—</td>
                    {bz.pillars.map((p) => (
                      <td key={p.label}>
                        {p.hideGan.map((hg, i) => (
                          <span key={hg + i} className="hidegan">
                            <b className={gzWxClass(hg)}>{hg}</b>
                            <Term k={p.hideShiShen[i] ?? ""}>{p.hideShiShen[i]}</Term>
                          </span>
                        ))}
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <th>
                      <Term k="星运">星运</Term>
                    </th>
                    <td className="col-cur dim">—</td>
                    <td className="dim">—</td>
                    {bz.pillars.map((p) => (
                      <td key={p.label}>
                        <Term k={p.xingYun}>{p.xingYun}</Term>
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <th>
                      <Term k="自坐">自坐</Term>
                    </th>
                    <td className="col-cur dim">—</td>
                    <td className="dim">—</td>
                    {bz.pillars.map((p) => (
                      <td key={p.label}>
                        <Term k={p.ziZuo}>{p.ziZuo}</Term>
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <th>
                      <Term k="空亡">空亡</Term>
                    </th>
                    <td className="col-cur dim">—</td>
                    <td className="dim">—</td>
                    {bz.pillars.map((p) => (
                      <td key={p.label}>{p.xunKong}</td>
                    ))}
                  </tr>
                  <tr>
                    <th>
                      <Term k="旬首">旬首</Term>
                    </th>
                    <td className="col-cur dim">—</td>
                    <td className="dim">—</td>
                    {bz.pillars.map((p) => (
                      <td key={p.label}>{p.xunShou}</td>
                    ))}
                  </tr>
                  <tr>
                    <th>
                      <Term k="纳音">纳音</Term>
                    </th>
                    <td className="col-cur dim">—</td>
                    <td className="dim">—</td>
                    {bz.pillars.map((p) => (
                      <td key={p.label}>{p.naYin}</td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </div>
            <aside className="dayun-col">
              <div className="dy-head">
                <Term k="大运">大运</Term> <small>{bz.yunStart}起运</small>
              </div>
              <div className="dy-item cur liunian">
                <Term k="流年">流年</Term>
                <b>
                  {bz.liuNian.gz} <span className={gzWxClass(bz.liuNian.gz[0])}>{bz.liuNian.shiShen}</span>
                </b>
                <small>今年 {bz.liuNian.year}</small>
              </div>
              <div className="dy-list">
                {bz.daYun.map((d) => (
                  <div key={d.startYear} className={`dy-item${d.current ? " cur" : ""}`}>
                    <span className="dy-age">
                      {d.startAge}-{d.endAge}岁
                    </span>
                    <b>
                      {d.gz} <Term k={d.shiShen}>{d.shiShen}</Term>
                    </b>
                    <small>
                      {d.startYear}-{d.endYear}
                    </small>
                  </div>
                ))}
              </div>
            </aside>
          </div>
          <div className="pillars-foot">
            <span className="chip">
              <Term k="胎元">胎元</Term> {bz.taiYuan}
            </span>
            <span className="chip">
              <Term k="命宫">命宫</Term> {bz.mingGong}
            </span>
            <span className="chip">
              <Term k="身宫">身宫</Term> {bz.shenGong}
            </span>
          </div>
          <div className="wuxing-row">
            {bz.wuxing.map((w) => (
              <div key={w.name} className="wx-item" title={`${w.name} ${w.count}`}>
                <span className="wx-n">{w.name}</span>
                <div className="bar">
                  <div style={{ width: `${(w.count / maxWx) * 100}%` }} />
                </div>
                <span className="wx-c">{w.count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {zw && (
        <div className="card chart-ziwei">
          <h3>
            ✦ 紫微命盘 · {zw.fiveElements}
            <small>
              命宫{zw.soulZhi} · 身宫{zw.bodyZhi} · 农历{zw.lunarDate} · {zw.zodiac}年 / {zw.sign}
            </small>
          </h3>
          <ZwLines zw={zw} />
        </div>
      )}
    </div>
  );
}
