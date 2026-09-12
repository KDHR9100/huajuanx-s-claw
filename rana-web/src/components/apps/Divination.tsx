// 问卜：三枚铜钱摇六爻成卦（本卦/变卦/动爻/卦辞），连同档案命盘交给云端 Rana 解卦。
// 快捷四域（事业/金钱/爱情/健康）+ 自定义问题；解卦结果按 markdown 渲染。
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

  // 问卦要带的命盘材料（档案齐才排；不齐就只发卦象+黄历）
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
    if (profile && /^\d{4}-\d{2}-\d{2}$/.test(profile.birthday) && (profile.gender === "男" || profile.gender === "女")) {
      const [y, m, d] = profile.birthday.split("-").map(Number);
      const hour = /^\d{2}:\d{2}$/.test(profile.birthTime) ? Number(profile.birthTime.slice(0, 2)) : null;
      const bz = bazi(y, m, d, hour, profile.gender === "男" ? 1 : 0);
      baziSum = {
        四柱: bz.pillars.map((p) => p.gz).join(" "),
        日主: `${bz.dayMaster}(${bz.dayMasterWx})`,
        五行: bz.wuxing.map((w) => `${w.name}${w.count}`).join(" "),
      };
      if (hour !== null) {
        try {
          const zw = ziwei(profile.birthday, hourToTimeIndex(hour), profile.gender);
          const soul = zw.palaces.find((p) => p.isSoul);
          ziweiSum = {
            五行局: zw.fiveElements,
            命宫: `${zw.soulZhi}（${soul?.majors ?? "空宫"}）`,
            四化: zw.palaces
              .flatMap((p) => (p.majors.match(/\S\[[禄权科忌]\]/g) ?? []).map((x) => `${p.name}:${x}`))
              .join("、"),
          };
        } catch {
          ziweiSum = null;
        }
      }
    }
    return { almanac, baziSum, ziweiSum };
  }, [profile]);

  const ask = async () => {
    if (!hex || asking) return;
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
          hexagram: {
            本卦: `${hex.ben.name}（${hex.ben.gong}）`,
            卦辞: hex.ben.ci,
            变卦: hex.bian ? `${hex.bian.name}（${hex.bian.gong}）` : "无动爻，不变卦",
            动爻: hex.moving.length ? hex.moving.map((i) => `第${i}爻`).join("、") : "无",
            六爻自初至上: lines.map((l, i) => `${YAO_NAMES[i]}爻${l.yao}(${l.coins.map((c) => (c ? "背" : "字")).join("")})`).join("；"),
          },
          almanac: material.almanac,
          bazi: material.baziSum ?? "档案缺生日，未排",
          ziwei: material.ziweiSum ?? "档案缺时辰，未排紫微",
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

  const canAsk = Boolean(hex) && !asking && (domain !== null || customQ.trim().length > 0) && !spinning;

  return (
    <div className="divi-wrap">
      {/* 问题域 */}
      <div className="divi-domains">
        {DOMAINS.map((d) => (
          <button key={d.id} type="button" className={`mat-check${domain === d.id ? " on" : ""}`} onClick={() => setDomain(domain === d.id ? null : d.id)}>
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
            <span key={i} className={`coin${spinning ? " spin" : ""}${coins ? (coins[i] ? " tails" : " heads") : ""}`} style={{ animationDelay: `${i * 0.09}s` }}>
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

      {/* 问她解卦 */}
      {hex && (
        <div className="divi-ask">
          <button className="btn" onClick={() => void ask()} disabled={!canAsk}>
            {asking ? "她在起卦推演……" : "问她解卦"}
          </button>
          {!domain && !customQ.trim() && <span className="tune-hint">先选一个快捷方向或写下问题</span>}
          {!profile && <span className="tune-hint err">没存生辰档案也能问，但她就只看卦象不看命盘（建议先填档案）</span>}
        </div>
      )}
      {asking && <div className="card pending"><p className="pending-text">她把你的八字、命盘和卦象摊开看了……稍等。</p></div>}
      {reply && (
        <div className="card fate-reply">
          <h3>🔮 她说</h3>
          <Markdown text={reply} />
        </div>
      )}
      {error && <p className="sys-err">{error}</p>}
    </div>
  );
}
