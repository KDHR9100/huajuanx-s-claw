// 早报页：独立大页展示每日资讯（新闻联播条目 + 分类搜索结果），数据来自 /__rana/news。
// 生成由 cron 任务 news-report（每天 08:00）完成，与聊天会话解耦。
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
}

function fmtTime(ts: number) {
  const d = new Date(ts);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function ItemRow({ item }: { item: NewsItem }) {
  return (
    <a className="news-item" href={item.url} target="_blank" rel="noreferrer">
      <span className="n-title">{item.title}</span>
      {item.summary && <span className="n-sum">{item.summary}</span>}
      {item.source && <span className="n-src">{item.source}</span>}
    </a>
  );
}

export default function NewsPage() {
  const [data, setData] = useState<Report | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/__rana/news");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData((await r.json()) as Report);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (data?.empty) {
    return (
      <div className="wallboard">
        <div className="board-inner">
          <div className="page-intro">
            <h2>早报</h2>
            <p>……还没印出来。</p>
          </div>
          <div className="card pending">
            <p className="pending-text">
              今天还没生成过早报。每天早上 8 点自动生成；想现在看，去「⏰ 定时任务」页找到「每日早报」点「▶ 跑一次」。
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="wallboard">
      <div className="board-inner" style={{ maxWidth: 900 }}>
        <div className="page-intro">
          <h2>早报</h2>
          <p>
            {data ? `${data.date} · 今晨 ${fmtTime(data.generatedAt)} 印好 · 点击条目看原文` : "……在拿。"}
            {error && <span className="sys-err">（{error}）</span>}
          </p>
        </div>

        {data && (
          <>
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
                {s.items.map((it, i) => (
                  <ItemRow key={`${s.id}-${i}`} item={it} />
                ))}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
