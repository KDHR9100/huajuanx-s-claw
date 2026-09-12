// 排盘：八字（lunar-javascript）+ 紫微斗数（iztro），全部本地计算。
// 八字表对齐专业排盘软件的"专业细盘"：主星十神/天干/地支/藏干/星运/自坐/空亡/旬首/纳音，
// 大运竖排在右侧并高亮当前一步+今年流年；紫微盘悬停宫位画三方四正（连线+三角）。
// 所有术语走本地注释库（Term 组件悬停出大白话）。
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { bazi, GAN_WX, gzPillarInfo, hourToTimeIndex, liuNianOfRange, sanFangSiZheng, yearGanZhi, ziwei, ZHI_WX } from "../../lib/fateCore";
import type { ZiweiResult } from "../../lib/fateCore";
import type { FateProfile } from "./FateProfile";
import Term from "./Term";

const WX_CLASS: Record<string, string> = { 木: "wx-mu", 火: "wx-huo", 土: "wx-tu", 金: "wx-jin", 水: "wx-shui" };
const gzWxClass = (ch: string) => {
  const wx = GAN_WX[ch] ?? ZHI_WX[ch];
  return wx ? WX_CLASS[wx] : "";
};

type ZwMode = "natal" | "decadal" | "yearly";

/** 紫微盘渲染：本命/大运/流年三种模式 + 三方四正（悬停预览、点按常驻） */
function ZwLines({ zw, mode }: { zw: ZiweiResult; mode: ZwMode }) {
  const boardRef = useRef<HTMLDivElement | null>(null);
  const cellRefs = useRef(new Map<string, HTMLDivElement | null>());
  const [hoverView, setHoverView] = useState<{ zhi: string; lines: Array<[number, number, number, number]>; tri: string } | null>(null);
  const [pin, setPin] = useState<string | null>(null);
  const [pinView, setPinView] = useState<{ zhi: string; lines: Array<[number, number, number, number]>; tri: string } | null>(null);

  const scope = mode === "natal" ? null : zw.yun[mode];

  const compute = (zhi: string) => {
    const board = boardRef.current;
    if (!board) return null;
    const br = board.getBoundingClientRect();
    const center = (z: string) => {
      const el = cellRefs.current.get(z);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2 - br.left, y: r.top + r.height / 2 - br.top };
    };
    const from = center(zhi);
    if (!from) return null;
    const { dui, san1, san2 } = sanFangSiZheng(zhi);
    const cDui = center(dui);
    const c1 = center(san1);
    const c2 = center(san2);
    if (!cDui || !c1 || !c2) return null;
    return {
      zhi,
      lines: [
        [from.x, from.y, cDui.x, cDui.y],
        [from.x, from.y, c1.x, c1.y],
        [from.x, from.y, c2.x, c2.y],
      ] as Array<[number, number, number, number]>,
      tri: `${from.x},${from.y} ${c1.x},${c1.y} ${c2.x},${c2.y}`,
    };
  };

  const view = pinView ?? hoverView;

  return (
    <div className="zw-board" ref={boardRef} onMouseLeave={() => setHoverView(null)}>
      {view && (
        <svg className="zw-lines" aria-hidden>
          <polygon points={view.tri} className="zw-tri" />
          {view.lines.map((l, i) => (
            <line key={i} x1={l[0]} y1={l[1]} x2={l[2]} y2={l[3]} className={i === 0 ? "zw-line-dui" : "zw-line-san"} />
          ))}
        </svg>
      )}
      {zw.palaces.map((p) => {
        const isYunSoul = Boolean(scope && p.zhi === scope.zhi);
        const badgeOf = (star: string) => scope?.mutagenAt.find((m) => m.star === star && m.zhi === p.zhi);
        return (
          <div
            key={p.zhi}
            ref={(el) => {
              cellRefs.current.set(p.zhi, el);
            }}
            className={[
              "zw-cell",
              mode === "natal" && p.isSoul ? "soul" : "",
              isYunSoul ? (mode === "decadal" ? "yun-soul" : "nian-soul") : "",
              view?.zhi === p.zhi ? "hot" : "",
              pin === p.zhi ? "pinned" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            style={{ gridRow: p.row + 1, gridColumn: p.col + 1 }}
            onMouseEnter={() => {
              if (!pin) setHoverView(compute(p.zhi));
            }}
            onClick={() => {
              if (pin === p.zhi) {
                setPin(null);
                setPinView(null);
              } else {
                setPin(p.zhi);
                setPinView(compute(p.zhi));
              }
            }}
            title="点一下固定三方四正连线，再点取消"
          >
            <div className="zw-head">
              <span className="zw-name">
                {p.name === "命宫" ? <Term k="命宫">命宫</Term> : p.name}
                {p.isBody && (
                  <i className="zw-body" title="身宫">
                    身
                  </i>
                )}
                {p.isSoul && <i className="zw-yun-tag natal">本命命宫</i>}
                {isYunSoul && (
                  <i className={`zw-yun-tag ${mode === "decadal" ? "dy" : "ln"}`}>{mode === "decadal" ? "大限命宫" : "流年命宫"}</i>
                )}
              </span>
              <span className="zw-gz">
                {p.gan}
                {p.zhi}
              </span>
            </div>
            <div className="zw-stars">
              {p.majorList.length ? (
                p.majorList.map((s) => {
                  const badge = badgeOf(s.name);
                  return (
                    <span key={s.name}>
                      <Term k={`星·${s.name}`}>{s.name}</Term>
                      {s.mutagen && (
                        <Term k={`化${s.mutagen}`}>
                          <sup>[{s.mutagen}]</sup>
                        </Term>
                      )}
                      {badge && (
                        <Term k={`化${badge.tag}`}>
                          <sup className={`mut-badge ${mode}`}>{(mode === "decadal" ? "运" : "流") + badge.tag}</sup>
                        </Term>
                      )}{" "}
                    </span>
                  );
                })
              ) : (
                <Term k="空宫">空宫</Term>
              )}
            </div>
            <div className="zw-minors">
              {p.minorList.map((n, i) => {
                const badge = badgeOf(n);
                return (
                  <span key={n + i}>
                    {i > 0 && " "}
                    <Term k={`星·${n}`}>{n}</Term>
                    {badge && (
                      <Term k={`化${badge.tag}`}>
                        <sup className={`mut-badge ${mode}`}>{(mode === "decadal" ? "运" : "流") + badge.tag}</sup>
                      </Term>
                    )}
                  </span>
                );
              })}
            </div>
            {scope?.flowStars[p.zhi]?.length ? (
              <div className="zw-flow">
                <Term k="流曜">{scope.flowStars[p.zhi].join(" ")}</Term>
              </div>
            ) : null}
            {p.decadal && (
              <span className="zw-decadal">
                <Term k="大限">{p.decadal}</Term>
              </span>
            )}
          </div>
        );
      })}
      <div className="zw-center" style={{ gridRow: "2 / 4", gridColumn: "2 / 4" }}>
        {mode === "natal" ? (
          <>
            <b>
              <Term k="五行局">{zw.fiveElements}</Term>
            </b>
            <span>
              命宫在{zw.soulZhi} · 身宫在{zw.bodyZhi}
            </span>
            <span>
              <Term k="三方四正">悬停或点按任一宫看三方四正</Term>（点按常驻，再点取消）
            </span>
            <span className="zw-gz">{zw.chineseDate}</span>
          </>
        ) : scope ? (
          <>
            <b>
              {scope.label} {scope.gz}
            </b>
            <span>
              <Term k={mode === "decadal" ? "大运命盘" : "流年命盘"}>
                {scope.label}命宫在{scope.zhi}
              </Term>
              {scope.nominalAge ? ` · 小限${scope.nominalAge}虚岁` : ""}
            </span>
            <span className="zw-yun-mut">
              {scope.label}四化：
              {scope.mutagenAt.map((m) => `${m.star}[${m.tag}]→${m.zhi}宫`).join("、")}
            </span>
            <span>
              <Term k="流曜">{scope.label}盘新增流曜已标在各宫</Term>
            </span>
          </>
        ) : (
          <span>运限数据没取到</span>
        )}
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
  // 十年流年条跟随所选大运（默认当前步）；换了盘自动回落到当前步
  const [dyKey, setDyKey] = useState<number | null>(null);
  useEffect(() => setDyKey(null), [bz]);
  const selDy = bz?.daYun.find((d) => d.startYear === dyKey) ?? curDy;
  const liuNian = useMemo(
    () => (bz && selDy ? liuNianOfRange(selDy.startYear, selDy.endYear, bz.dayMaster) : []),
    [bz, selDy],
  );
  // 表头「流年」列跟着流年条点击走（默认今年）；换了盘回落到今年
  const [lnYear, setLnYear] = useState<number | null>(null);
  useEffect(() => setLnYear(null), [bz]);
  const lnSel = { year: lnYear ?? bz?.liuNian.year ?? 0, gz: yearGanZhi(lnYear ?? bz?.liuNian.year ?? 2000) };
  const lnCol = useMemo(
    () => (bz ? { gz: lnSel.gz, info: gzPillarInfo(lnSel.gz, bz.dayMaster) } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bz, lnSel.gz, lnSel.year],
  );
  const dyCol = useMemo(
    () => (bz && selDy ? { gz: selDy.gz, info: gzPillarInfo(selDy.gz, bz.dayMaster) } : null),
    [bz, selDy],
  );
  // 紫微盘模式：本命 / 大运 / 流年
  const [zwMode, setZwMode] = useState<ZwMode>("natal");

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
                    <th className="col-cur" title="点下方流年条可换年份">
                      <Term k="流年">流年</Term>
                      <small className="col-sub">{lnCol?.gz}</small>
                    </th>
                    <th className={dyCol ? "col-cur" : ""}>
                      <Term k="大运">大运</Term>
                      <small className="col-sub">{dyCol?.gz}</small>
                    </th>
                    {bz.pillars.map((p) => (
                      <th key={p.label}>{p.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th>主星</th>
                    <td className="col-cur">{lnCol && <Term k={lnCol.info.shiShenGan}>{lnCol.info.shiShenGan}</Term>}</td>
                    <td className={dyCol ? "col-cur" : ""}>{dyCol && <Term k={dyCol.info.shiShenGan}>{dyCol.info.shiShenGan}</Term>}</td>
                    {bz.pillars.map((p) => (
                      <td key={p.label}>
                        <Term k={p.shiShenGan}>{p.shiShenGan}</Term>
                      </td>
                    ))}
                  </tr>
                  <tr className="row-gz">
                    <th>天干</th>
                    <td className={`col-cur ${gzWxClass(lnCol?.gz[0] ?? "")}`}>{lnCol?.gz[0]}</td>
                    <td className={dyCol ? `col-cur ${gzWxClass(dyCol.gz[0])}` : ""}>{dyCol?.gz[0]}</td>
                    {bz.pillars.map((p) => (
                      <td key={p.label} className={gzWxClass(p.gz[0])}>
                        {p.gz[0]}
                      </td>
                    ))}
                  </tr>
                  <tr className="row-gz">
                    <th>地支</th>
                    <td className={`col-cur ${gzWxClass(lnCol?.gz[1] ?? "")}`}>{lnCol?.gz[1]}</td>
                    <td className={dyCol ? `col-cur ${gzWxClass(dyCol.gz[1])}` : ""}>{dyCol?.gz[1]}</td>
                    {bz.pillars.map((p) => (
                      <td key={p.label} className={gzWxClass(p.gz[1])}>
                        {p.gz[1]}
                      </td>
                    ))}
                  </tr>
                  {(
                    [
                      [
                        "藏干",
                        (i: { hideGan: string[]; hideShiShen: string[] }) =>
                          i.hideGan.map((hg, k) => (
                            <span key={hg + k} className="hidegan">
                              <b className={gzWxClass(hg)}>{hg}</b>
                              <Term k={i.hideShiShen[k] ?? ""}>{i.hideShiShen[k]}</Term>
                            </span>
                          )),
                      ],
                      ["星运", (i: { xingYun: string }) => <Term k={i.xingYun}>{i.xingYun}</Term>],
                      ["自坐", (i: { ziZuo: string }) => <Term k={i.ziZuo}>{i.ziZuo}</Term>],
                      ["空亡", (i: { xunKong: string }) => i.xunKong],
                      ["旬首", (i: { xunShou: string }) => i.xunShou],
                      ["纳音", (i: { naYin: string }) => i.naYin],
                    ] as Array<[string, (i: any) => ReactNode]>
                  ).map(([label, cell]) => (
                    <tr key={label}>
                      <th>
                        <Term k={label}>{label}</Term>
                      </th>
                      <td className="col-cur">{lnCol ? cell(lnCol.info) : "—"}</td>
                      <td className={dyCol ? "col-cur" : ""}>{dyCol ? cell(dyCol.info) : "—"}</td>
                      {bz.pillars.map((p) => (
                        <td key={p.label}>{cell(p as any)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <aside className="dayun-col">
              <div className="dy-head">
                <Term k="大运">大运</Term> <small>{bz.yunStart}起运</small>
              </div>
              <div className="dy-item cur liunian" title="表头流年列显示的就是这里选中的年份">
                <Term k="流年">流年</Term>
                <b>
                  {lnCol?.gz} {lnCol && <span className={gzWxClass(lnCol.gz[0])}>{lnCol.info.shiShenGan}</span>}
                </b>
                <small>{lnSel.year === bz.liuNian.year ? `今年 ${lnSel.year}` : `${lnSel.year}（点流年条可换）`}</small>
              </div>
              <div className="dy-list">
                {bz.daYun.map((d) => (
                  <div
                    key={d.startYear}
                    className={`dy-item${d.current ? " cur" : ""}${selDy?.startYear === d.startYear ? " sel" : ""}`}
                    onClick={() => setDyKey(d.startYear)}
                    title="点这步大运，下面的十年流年跟着换"
                  >
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
          {selDy && liuNian.length > 0 && (
            <div className="liunian-strip">
              <div className="ln-title">
                <Term k="大运">{selDy.gz}</Term>
                的十年<Term k="流年">流年</Term>
                <small>
                  {selDy.startAge}-{selDy.endAge}岁 · {selDy.startYear}-{selDy.endYear} · 点右侧大运可换
                </small>
              </div>
              <div className="ln-cells">
                {liuNian.map((n) => (
                  <div
                    key={n.year}
                    className={`ln-cell${n.now ? " now" : ""}${lnSel.year === n.year ? " sel" : ""}`}
                    onClick={() => setLnYear(n.year)}
                    title="点这年：表头流年列跟着换"
                  >
                    <span className="ln-year">{n.year}</span>
                    <b className={gzWxClass(n.gz[0])}>{n.gz}</b>
                    <span className="ln-ss">
                      <Term k={n.shiShen}>{n.shiShen}</Term>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
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
          <div className="zw-modes">
            {(
              [
                ["natal", "本命命盘"],
                ["decadal", "大运命盘"],
                ["yearly", "流年命盘"],
              ] as Array<[ZwMode, string]>
            ).map(([m, label]) => (
              <button key={m} type="button" className={`mat-check${zwMode === m ? " on" : ""}`} onClick={() => setZwMode(m)}>
                {label}
              </button>
            ))}
          </div>
          <ZwLines zw={zw} mode={zwMode} />
        </div>
      )}
    </div>
  );
}
