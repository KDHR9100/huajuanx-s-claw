// 问卜：三枚铜钱摇六爻成卦（本卦/变卦/动爻/卦辞），与档案命盘一起交给云端 Rana 解卦。
// 摇卦在上、卦象在中；最底部是「合成条」——自由勾选要带上的材料（八字/紫微/卦象，可单选可多选）
// + 快捷方向（事业/金钱/爱情/健康）+ 自定义问题 + 发送。不摇卦只问命理也行。
import { useEffect, useMemo, useState } from "react";
import Markdown from "../Markdown";
import { bazi, castLine, dayAlmanac, hourToTimeIndex, readHexagram, ziwei, YAO_NAMES } from "../../lib/fateCore";
import type { CastLine } from "../../lib/fateCore";
import type { FateProfile } from "./FateProfile";
import Term from "./Term";

const DOMAINS: Array<{ id: string; label: string; tpl: string }> = [
  { id: "career", label: "💼 事业", tpl: "问近期事业工作走向：该进取还是守成，注意什么" },
  { id: "wealth", label: "💰 金钱", tpl: "问近期财运：正财偏财如何，适合投入还是收手" },
  { id: "love", label: "💗 爱情", tpl: "问感情：这段关系的走向，我该怎么做" },
  { id: "health", label: "🩺 健康", tpl: "问健康：身体有什么要留意的，怎么调" },
];

function YaoBar({ yao }: { yao: CastLine["yao"] }) {
  const yang = yao === "少阳" || yao === "老阳";
  const moving = yao === "老阳" || yao === "老阴";
  return (
    <span className={`yao${yang ? "" : " yin"}${moving ? " moving" : ""}`}>
      <i />
      {moving && <em>{yao === "老阳" ? "○" : "×"}</em>}
    </span>
  );
}

export default function Divination({ profile }: { profile: FateProfile | null }) {
  const [domain, setDomain] = useState<string | null>(null);
  const [customQ, setCustomQ] = useState("");
  const [lines, setLines] = useState<CastLine[]>([]);
  const [coins, setCoins] = useState<boolean[] | null>(null);
  const [spinning, setSpinning] = useState(false);
  const [auto, setAuto] = useState(false);
  const [asking, setAsking] = useState(false);
  const [reply, setReply] = useState("");
  const [error, setError] = useState("");

  // 材料多选：八字 / 紫微 / 卦象（点亮=随问题发给她）
  const prof = profile;
  const hasBazi = Boolean(prof && /^\d{4}-\d{2}-\d{2}$/.test(prof.birthday) && (prof.gender === "男" || prof.gender === "女"));
  const hasZiwei = hasBazi && Boolean(prof) && /^\d{2}:\d{2}$/.test(prof!.birthTime ?? "");
  const [useBazi, setUseBazi] = useState(false);
  const [useZiwei, setUseZiwei] = useState(false);
  const [useHexi, setUseHexi] = useState(true);
  useEffect(() => {
    // 档案一变，材料默认值跟着档案齐备度走
    setUseBazi(hasBazi);
    setUseZiwei(hasZiwei);
  }, [hasBazi, hasZiwei]);

  const hex = useMemo(() => readHexagram(lines), [lines]);

  const castOne = () => {
    if (spinning || lines.length >= 6) return;
    const result = castLine();
    setSpinning(true);
    setCoins(null);
    window.setTimeout(() => {
      setCoins(result.coins);
      setLines((l) => [...l, result]);
      setSpinning(false);
    }, 950);
  };

  // 连摇六次：逐爻自动
  useEffect(() => {
    if (!auto) return;
    if (lines.length >= 6) {
      setAuto(false);
      return;
    }
    if (spinning) return;
    const t = window.setTimeout(castOne, 260);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, lines.length, spinning]);

  const reset = () => {
    setAuto(false);
    setLines([]);
    setCoins(null);
    setReply("");
    setError("");
  };

  // 问卦要带的命理材料（按勾选现算）
  const material = useMemo(() => {
    const now = new Date();
    const alm = dayAlmanac(now.getFullYear(), now.getMonth() + 1, now.getDate());
    const almanac = {
      公历: alm.ymd,
      农历: alm.lunarText,
      干支: `${alm.yearGZ}年 ${alm.monthGZ}月 ${alm.dayGZ}日`,
      宜: alm.yi.slice(0, 4).join("、"),
      忌: alm.ji.slice(0, 4).join("、"),
    };
    let baziSum: Record<string, unknown> | null = null;
    let ziweiSum: Record<string, unknown> | null = null;
    const prof = profile;
    if (hasBazi && prof && (prof.gender === "男" || prof.gender === "女") && /^\d{4}-\d{2}-\d{2}$/.test(prof.birthday)) {
      const gender = prof.gender;
      const [y, m, d] = prof.birthday.split("-").map(Number);
      const hour = hasZiwei && /^\d{2}:\d{2}$/.test(prof.birthTime ?? "") ? Number(prof.birthTime!.slice(0, 2)) : null;
      const bz = bazi(y, m, d, hour, gender === "男" ? 1 : 0);
      baziSum = {
        四柱: bz.pillars.map((p) => p.gz).join(" "),
        日主: `${bz.dayMaster}(${bz.dayMasterWx})`,
        五行: bz.wuxing.map((w) => `${w.name}${w.count}`).join(" "),
        当前大运: (() => {
          const c = bz.daYun.find((x) => x.current);
          return c ? `${c.gz}（${c.shiShen}，${c.startYear}-${c.endYear}）` : "";
        })(),
        今年流年: `${bz.liuNian.gz}（${bz.liuNian.shiShen}）`,
      };
      if (hasZiwei && hour !== null) {
        try {
          const zw = ziwei(prof.birthday, hourToTimeIndex(hour), gender);
          const soul = zw.palaces.find((p) => p.isSoul);
          const dy = zw.yun.decadal;
          const yn = zw.yun.yearly;
          ziweiSum = {
            五行局: zw.fiveElements,
            命宫: `${zw.soulZhi}（${soul?.majors ?? "空宫"}）`,
            生年四化: zw.palaces
              .flatMap((p) => (p.majors.match(/\S\[[禄权科忌]\]/g) ?? []).map((x) => `${p.name}:${x}`))
              .join("、"),
            当前大限: dy ? `${dy.gz}入${dy.zhi}宫，四化${dy.mutagen.map((s, i) => `${s}[${"禄权科忌"[i]}]`).join(" ")}` : "",
            今年流年盘: yn ? `${yn.gz}入${yn.zhi}宫，四化${yn.mutagen.map((s, i) => `${s}[${"禄权科忌"[i]}]`).join(" ")}` : "",
          };
        } catch {
          ziweiSum = null;
        }
      }
    }
    return { almanac, baziSum, ziweiSum };
  }, [profile, hasBazi, hasZiwei]);

  const anyMaterial = (useBazi && hasBazi) || (useZiwei && hasZiwei) || (useHexi && Boolean(hex));
  const canAsk = anyMaterial && !asking && !spinning;

  const ask = async () => {
    if (!canAsk) return;
    setAsking(true);
    setError("");
    setReply("");
    try {
      const r = await fetch("/__rana/fate/ask", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          domain: DOMAINS.find((d) => d.id === domain)?.label ?? (customQ.trim() ? "自定义" : "综合"),
          question: customQ.trim() || (DOMAINS.find((d) => d.id === domain)?.tpl ?? ""),
          ...(useHexi && hex
            ? {
                hexagram: {
                  本卦: `${hex.ben.name}（${hex.ben.gong}）`,
                  卦辞: hex.ben.ci,
                  变卦: hex.bian ? `${hex.bian.name}（${hex.bian.gong}）` : "无动爻，不变卦",
                  动爻: hex.moving.length ? hex.moving.map((i) => `第${i}爻`).join("、") : "无",
                  六爻自初至上: lines
                    .map((l, i) => `${YAO_NAMES[i]}爻${l.yao}(${l.coins.map((c) => (c ? "背" : "字")).join("")})`)
                    .join("；"),
                },
              }
            : {}),
          almanac: material.almanac,
          ...(useBazi && hasBazi ? { bazi: material.baziSum } : {}),
          ...(useZiwei && hasZiwei ? { ziwei: material.ziweiSum } : {}),
        }),
      });
      const j = (await r.json()) as { ok?: boolean; reply?: string; error?: string };
      if (!r.ok || !j.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      setReply(j.reply ?? "（她没说话）");
    } catch (e) {
      setError(`问卦失败：${(e as Error).message}`);
    } finally {
      setAsking(false);
    }
  };

  const matChip = (on: boolean, avail: boolean, label: string, toggle: () => void, why: string) => (
    <button
      key={label}
      type="button"
      className={`mat-check mat-mat${on && avail ? " on" : ""}`}
      disabled={!avail}
      title={avail ? (on ? "点亮=随问题发给她，点一下去掉" : "点一下带上") : why}
      onClick={toggle}
    >
      {label}
    </button>
  );

  return (
    <div className="divi-wrap">
      {/* 摇卦器 */}
      <div className="divi-caster">
        <button
          type="button"
          className={`coin-tray${spinning ? " spinning" : ""}`}
          onClick={castOne}
          disabled={spinning || lines.length >= 6}
          title="点铜钱摇一爻"
        >
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className={`coin${spinning ? " spin" : ""}${coins ? (coins[i] ? " tails" : " heads") : ""}`}
              style={{ animationDelay: `${i * 0.09}s` }}
            >
              <i className="hole" />
              <b>{coins ? (coins[i] ? "背" : "字") : "摇"}</b>
            </span>
          ))}
        </button>
        <div className="divi-cast-btns">
          <button className="btn sm" onClick={castOne} disabled={spinning || lines.length >= 6}>
            摇一爻（{lines.length}/6）
          </button>
          <button className="btn ghost sm" onClick={() => setAuto(!auto)} disabled={lines.length >= 6 && !auto}>
            {auto ? "停" : "连摇六次"}
          </button>
          {lines.length > 0 && (
            <button className="btn ghost sm" onClick={reset}>
              清空重摇
            </button>
          )}
        </div>
      </div>

      {/* 六爻与卦象 */}
      {lines.length > 0 && (
        <div className="divi-hex">
          <div className="yao-stack">
            {[...lines].reverse().map((l, ri) => {
              const idx = lines.length - 1 - ri;
              return (
                <div key={idx} className={`yao-row${l.yao === "老阳" || l.yao === "老阴" ? " moving" : ""}`}>
                  <span className="yao-name">{YAO_NAMES[idx]}</span>
                  <YaoBar yao={l.yao} />
                  <span className="yao-type">
                    <Term k={l.yao}>{l.yao}</Term>
                  </span>
                </div>
              );
            })}
            {Array.from({ length: 6 - lines.length }).map((_, i) => (
              <div key={`empty-${i}`} className="yao-row empty">
                <span className="yao-name">{YAO_NAMES[lines.length + i]}</span>
                <span className="yao-type dim">…</span>
              </div>
            ))}
          </div>

          {hex && (
            <div className="hex-card">
              <div className="hex-ben">
                <span className="hex-sym">{hex.ben.sym}</span>
                <b>
                  <Term k="本卦">{hex.ben.name}</Term>
                </b>
                <small>{hex.ben.gong}</small>
                <p className="hex-ci">
                  <Term k="卦辞">卦辞</Term>：「{hex.ben.ci}」
                </p>
              </div>
              {hex.bian && (
                <div className="hex-arrow">
                  →
                  <span className="hex-sym sm">{hex.bian.sym}</span>
                  <b>
                    <Term k="变卦">{hex.bian.name}</Term>
                  </b>
                  <small>
                    <Term k="动爻">{hex.moving.map((i) => `${i}爻动`).join(" ")}</Term>
                  </small>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {asking && (
        <div className="card pending">
          <p className="pending-text">她把你要的材料摊开看了……稍等。</p>
        </div>
      )}
      {reply && (
        <div className="card fate-reply">
          <h3>🔮 她说</h3>
          <Markdown text={reply} />
        </div>
      )}
      {error && <p className="sys-err">{error}</p>}

      {/* 底部合成条：材料多选 + 问题 + 发送 */}
      <div className="divi-compose">
        <div className="dc-row">
          <span className="dc-label">带什么问她</span>
          {matChip(useBazi, hasBazi, "☯ 八字", () => setUseBazi(!useBazi), "档案里还没有生日（或性别），先去「我的档案」存一份")}
          {matChip(useZiwei, hasZiwei, "✦ 紫微", () => setUseZiwei(!useZiwei), "紫微需要出生时间，档案里补一下时辰")}
          {matChip(useHexi && Boolean(hex), Boolean(hex), "🪙 卦象", () => setUseHexi(!useHexi), "还没摇卦——上面摇一卦，或只问命理不摇也行")}
        </div>
        <div className="dc-row">
          <span className="dc-label">问什么</span>
          {DOMAINS.map((d) => (
            <button
              key={d.id}
              type="button"
              className={`mat-check${domain === d.id ? " on" : ""}`}
              onClick={() => setDomain(domain === d.id ? null : d.id)}
            >
              {d.label}
            </button>
          ))}
          <input
            className="set-input divi-q"
            placeholder="或者自己写问题（可选）"
            value={customQ}
            onChange={(e) => setCustomQ(e.target.value)}
          />
        </div>
        <div className="dc-row dc-send">
          <button className="btn" onClick={() => void ask()} disabled={!canAsk}>
            {asking ? "她在推演……" : useHexi && hex ? "问她解卦" : "问她"}
          </button>
          {!anyMaterial && <span className="tune-hint">至少点亮一样材料（八字/紫微/卦象）</span>}
          {useHexi && !hex && !asking && <span className="tune-hint">没摇卦也不影响——她只看命盘答</span>}
        </div>
      </div>
    </div>
  );
}
