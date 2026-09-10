// 早报页：独立大页展示每日资讯（新闻联播条目 + 分类搜索结果 + 右侧乐奈总结）。
// 省额度：只有今天打开了这个页面才会触发生成（POST /__rana/news），cron 不自动跑。
import { useCallback, useEffect, useState } from "react";

interface NewsItem {
  title: string;
  summary?: string;
  source?: string;
  url?: string;
}
interface Section {
  id: string;
  name: string;
  items: NewsItem[];
  error?: string;
}
interface Report {
  empty?: boolean;
  date: string;
  generatedAt: number;
  xwlbDay: string;
  xwlb: Array<{ title: string; url: string }>;
  sections: Section[];
  summary?: string;
  queries?: number;
}

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function fmtTime(ts: number) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function ItemCard({ item }: { item: NewsItem }) {
  return (
    <a className="news-card" href={item.url} target="_blank" rel="noreferrer">
      {item.source && <span className="nc-src">{item.source}</span>}
      <span className="n-title">{item.title}</span>
      {item.summary && <span className="n-sum">{item.summary}</span>}
    </a>
  );
}

export default function NewsPage() {
  const [data, setData] = useState<Report | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async (): Promise<Report | null> => {
    try {
      const r = await fetch("/__rana/news");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as Report;
      setData(j);
      setError("");
      return j;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  }, []);

  const generate = useCallback(async () => {
    if (generating) return;
    setGenerating(true);
    setError("");
    try {
      const r = await fetch("/__rana/news", { method: "POST" });
      const j = (await r.json()) as { ok?: boolean; error?: string };
      if (!r.ok || !j.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
    } catch (e) {
      setError(`生成失败：${(e as Error).message}`);
    } finally {
      setGenerating(false);
      void load();
    }
  }, [generating, load]);

  useEffect(() => {
    void (async () => {
      const rep = await load();
      if (!rep) return;
      // 省额度：只有今天第一次打开早报页才生成；已有今日数据直接展示
      if (rep.empty || rep.date !== todayStr()) void generate();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fresh = data && !data.empty && data.date === todayStr();

  return (
    <div className="wallboard">
      <div className="board-inner" style={{ maxWidth: 1100 }}>
        <div className="page-intro">
          <h2>早报</h2>
          <p>
            {generating
              ? "……在印今天的早报（抓联播 + 搜资讯 + 写总结，十几秒）。"
              : fresh
                ? `${data.date} · 今晨 ${fmtTime(data.generatedAt)} 印好 · 点击条目看原文`
                : "今天还没生成过。"}
            {error && <span className="sys-err">（{error}）</span>}
          </p>
        </div>

        {generating && !fresh && (
          <div className="card pending">
            <p className="pending-text">……在印。今天的第一次打开才会查询（联播直抓不花额度，搜索 4 次 + 总结 1 次 flash）。</p>
          </div>
        )}

        {data && !data.empty && (
          <div className="news-layout">
            <div className="news-main">
              <div className="news-group">
                <h3 className="ng-title">📺 新闻联播（{data.xwlbDay.slice(4, 6)}/{data.xwlbDay.slice(6)} 晚）</h3>
                {data.xwlb.length ? (
                  data.xwlb.map((x, i) => (
                    <a key={x.url} className="news-item plain" href={x.url} target="_blank" rel="noreferrer">
                      <span className="n-idx">{i + 1}</span>
                      <span className="n-title">{x.title}</span>
                    </a>
                  ))
                ) : (
                  <p className="pending-text">这期没抓到（CCTV 页面偶尔抽风，明天再看）。</p>
                )}
              </div>

              {data.sections.map((s) => (
                <div className="news-group" key={s.id}>
                  <h3 className="ng-title">
                    {s.id === "ai" ? "🤖" : s.id === "tech" ? "🔧" : s.id === "china" ? "🇨🇳" : "🌍"} {s.name}
                  </h3>
                  {s.error && <p className="pending-text">这组没搜到：{s.error}</p>}
                  <div className="nc-grid">
                    {s.items.map((it, i) => (
                      <ItemCard key={`${s.id}-${i}`} item={it} />
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <aside className="news-side">
              <div className="summary-card">
                <div className="sc-head">
                  <span className="sc-quote">「</span>
                  <h3>乐奈的总结</h3>
                </div>
                {data.summary ? (
                  <p className="summary-text">{data.summary}</p>
                ) : (
                  <p className="pending-text">这次没写出来（flash 偶尔偷懒）。</p>
                )}
                {typeof data.queries === "number" && (
                  <div className="side-foot">今日搜索 {data.queries} 次 · 总结 1 次 · 不打开这页不查询</div>
                )}
              </div>
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}
