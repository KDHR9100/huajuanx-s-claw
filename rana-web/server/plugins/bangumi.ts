import fs from "node:fs";
import path from "node:path";
import { execFileP } from "../lib/exec";
import { RANA_WEB } from "../lib/paths";
import { json, readBody, isLoopback } from "../lib/http";
import type { Plugin } from "vite";

/**
 * 追番端点（Bangumi api.bgm.tv 代理 + 本地追番清单，数据存 .bangumi/ 不进公开仓库）：
 * - GET    /__rana/bangumi/calendar            今日放送（服务端 curl 经 Clash 抓 api.bgm.tv，60 分钟缓存）
 * - GET    /__rana/bangumi/search?q=           条目搜索（旧版搜索 API，同链路；供「加进追番」前找条目）
 * - GET    /__rana/bangumi/cover?u=            封面图转发（仅白名单 lain.bgm.tv；浏览器直连不到 CDN，服务端代取）
 * - GET    /__rana/bangumi/collection          我的追番清单（.bangumi/collection.json，本地维护不依赖 access token）
 * - POST   /__rana/bangumi/collection          {subjectId, name, nameCn?, cover?, eps?, airDate?, status?} 加入/更新
 *                                            （status: watching 在追标进度 / done 看过进展馆；airDate 供年份分组）
 * - POST   /__rana/bangumi/collection/update   {subjectId, progress?, status?} 改进度/改状态
 * - DELETE /__rana/bangumi/collection?subjectId= 移出追番
 * 这台机器 bgm.tv 直连不通（实测），所有出站走 curl -x http://127.0.0.1:7897（Clash，与状态页探测同款）。
 */
export function ranaBangumiMiddleware(): Plugin {
  const here = RANA_WEB;
  const bgmDir = path.join(here, ".bangumi");
  const collectionFile = path.join(bgmDir, "collection.json");
  const PROXY = "http://127.0.0.1:7897";
  const UA = "OpenClaw-RanaWeb/1.0 (personal assistant; contact via OpenClaw gateway)";
  const CALENDAR_TTL_MS = 60 * 60 * 1000;

  interface BgmItem {
    id: number;
    name: string;
    name_cn?: string;
    eps?: number;
    air_date?: string;
    images?: { large?: string; common?: string; medium?: string };
  }
  interface CollectionEntry {
    subjectId: number;
    name: string;
    nameCn?: string;
    cover?: string;
    eps?: number;
    /** 放送开始日（YYYY-MM-DD；展馆按它取年份分组） */
    airDate?: string;
    /** watching=在追（标进度）/ done=看过（进展馆） */
    status: "watching" | "done";
    /** 看到第几话（0=还没开看；仅 watching 用） */
    progress: number;
    addedAt: number;
  }
  interface CollectionFile {
    version: number;
    items: CollectionEntry[];
    updatedAt: number;
  }

  /** curl 抓 bgm.tv（数组参数不经 shell；JSON 解析失败/超时都抛错给路由兜底） */
  const bgmCurlJson = async (urlPath: string) => {
    const { stdout } = await execFileP(
      "curl",
      ["-s", "--max-time", "12", "-x", PROXY, "-A", UA, "https://api.bgm.tv" + urlPath],
      { encoding: "utf8", timeout: 15000, windowsHide: true },
    );
    return JSON.parse(stdout) as unknown;
  };

  const emptyCollection = (): CollectionFile => ({ version: 1, items: [], updatedAt: 0 });
  const readCollection = (): CollectionFile => {
    try {
      const j = JSON.parse(fs.readFileSync(collectionFile, "utf8")) as CollectionFile;
      if (!Array.isArray(j.items)) j.items = [];
      // 旧条目补默认值（无 status 的按在追；airDate 缺着由前端归「未分组」）
      for (const it of j.items) {
        if (it.status !== "watching" && it.status !== "done") it.status = "watching";
        if (typeof it.progress !== "number") it.progress = 0;
      }
      j.version = 1;
      return j;
    } catch {
      return emptyCollection();
    }
  };
  const writeCollection = (f: CollectionFile) => {
    fs.mkdirSync(bgmDir, { recursive: true });
    try {
      fs.copyFileSync(collectionFile, collectionFile + ".bak");
    } catch {
      // 首次写入没有旧文件
    }
    f.updatedAt = Date.now();
    fs.writeFileSync(collectionFile, JSON.stringify(f, null, 2), "utf8");
  };
  const sortedCollection = (f: CollectionFile): CollectionFile => ({
    ...f,
    items: [...f.items].sort((a, b) => b.addedAt - a.addedAt),
  });





  // 今日放送缓存
  let calCache: { at: number; data: unknown } | null = null;
  const WEEK_CN = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
  const fetchCalendar = async () => {
    if (calCache && Date.now() - calCache.at < CALENDAR_TTL_MS) return calCache.data;
    const data = (await bgmCurlJson("/calendar")) as Array<{ weekday?: { id?: number }; items?: BgmItem[] }>;
    if (!Array.isArray(data)) throw new Error("bgm.tv /calendar 返回格式不对");
    const todayId = ((new Date().getDay() + 6) % 7) + 1; // bgm weekday.id：1=周一…7=周日
    const today = data.find((d) => d?.weekday?.id === todayId);
    const items = (today?.items ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      nameCn: s.name_cn || "",
      cover: s.images?.large ?? s.images?.common ?? "",
      eps: s.eps ?? 0,
      airDate: s.air_date ?? "",
    }));
    const out = { weekday: WEEK_CN[new Date().getDay()], count: items.length, items };
    calCache = { at: Date.now(), data: out };
    return out;
  };

  const handler = (
    req: {
      method?: string;
      url?: string;
      socket?: { remoteAddress?: string };
      headers?: Record<string, unknown>;
      on: (ev: string, cb: (c?: string) => void) => void;
    },
    res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string | Buffer) => void },
  ) => {
    const u = new URL(req.url ?? "/", "http://x");
    const route = u.pathname.replace(/\/+$/, "") || "/";

    const fail = (e: unknown) =>
      json(res, 502, {
        error: `bgm.tv 拉取失败：${(e as Error).message}（Clash 代理在 7897，挂了就连不上）`,
      });

    if (req.method === "GET" && route === "/calendar") {
      fetchCalendar()
        .then((d) => json(res, 200, d))
        .catch(fail);
      return;
    }

    if (req.method === "GET" && route === "/search") {
      const q = (u.searchParams.get("q") ?? "").trim();
      if (!q) {
        json(res, 400, { error: "q 不能为空" });
        return;
      }
      bgmCurlJson(`/search/subject/${encodeURIComponent(q)}?type=2&max_results=8`)
        .then((raw) => {
          const list = (raw as { list?: BgmItem[] }).list ?? [];
          json(
            res,
            200,
            list.map((s) => ({
              id: s.id,
              name: s.name,
              nameCn: s.name_cn || "",
              cover: s.images?.large ?? "",
              airDate: s.air_date ?? "",
            })),
          );
        })
        .catch(fail);
      return;
    }

    if (req.method === "GET" && route === "/cover") {
      const raw = u.searchParams.get("u") ?? "";
      // 旧接口给的封面是 http://，出站统一按 https 取（同一 CDN）
      const target = raw.replace(/^http:\/\/lain\.bgm\.tv\//, "https://lain.bgm.tv/");
      if (!/^https:\/\/lain\.bgm\.tv\/pic\//.test(target)) {
        json(res, 403, { error: "只转发 lain.bgm.tv 的图" });
        return;
      }
      execFileP("curl", ["-s", "--max-time", "10", "-x", PROXY, "-A", UA, target], {
        timeout: 13000,
        windowsHide: true,
        encoding: "buffer",
        maxBuffer: 8 * 1024 * 1024,
      })
        .then(({ stdout }) => {
          res.setHeader("content-type", "image/jpeg");
          res.setHeader("cache-control", "public, max-age=86400");
          res.statusCode = 200;
          res.end(stdout);
        })
        .catch(() => {
          res.statusCode = 502;
          res.end("");
        });
      return;
    }

    if (req.method === "GET" && route === "/collection") {
      json(res, 200, sortedCollection(readCollection()));
      return;
    }
    if (!isLoopback(req)) {
      json(res, 403, { error: "仅本机可操作" });
      return;
    }

    if (req.method === "POST" && route === "/collection") {
      readBody(req).then(async (body) => {
        try {
          const p = JSON.parse(body || "{}") as Record<string, unknown>;
          const subjectId = Number(p.subjectId);
          const name = String(p.name ?? "").trim().slice(0, 120);
          if (!Number.isInteger(subjectId) || subjectId <= 0 || !name) {
            json(res, 400, { error: "subjectId 和 name 必填" });
            return;
          }
          const status = p.status === "done" ? "done" : "watching";
          const f = readCollection();
          const exists = f.items.find((x) => x.subjectId === subjectId);
          // 旧搜索接口不给 air_date（展馆按年份分组要它）——缺了就查一次条目详情补上，查不到归「其他」
          let airDate = p.airDate !== undefined ? String(p.airDate).slice(0, 10) : undefined;
          const needAirDate = (exists && !exists.airDate) || (!exists && !airDate);
          if (needAirDate) {
            try {
              const det = (await bgmCurlJson(`/v0/subjects/${subjectId}`)) as { date?: string };
              if (det?.date) airDate = det.date;
            } catch {
              // 详情接口抖动就算了，展示归「其他」
            }
          }
          if (exists) {
            exists.name = name;
            if (p.nameCn !== undefined) exists.nameCn = String(p.nameCn).slice(0, 120);
            if (p.cover !== undefined) exists.cover = String(p.cover).slice(0, 300);
            if (p.eps !== undefined) exists.eps = Math.max(0, Number(p.eps) || 0);
            if (airDate !== undefined) exists.airDate = airDate;
            if (p.status !== undefined) exists.status = status;
          } else {
            f.items.push({
              subjectId,
              name,
              nameCn: p.nameCn !== undefined ? String(p.nameCn).slice(0, 120) : undefined,
              cover: p.cover !== undefined ? String(p.cover).slice(0, 300) : undefined,
              eps: p.eps !== undefined ? Math.max(0, Number(p.eps) || 0) : undefined,
              airDate,
              status,
              progress: 0,
              addedAt: Date.now(),
            });
          }
          writeCollection(f);
          json(res, 200, { ok: true, ...sortedCollection(f) });
        } catch (e) {
          json(res, 500, { error: (e as Error).message });
        }
      });
      return;
    }

    if (req.method === "POST" && route === "/collection/update") {
      readBody(req).then((body) => {
        try {
          const p = JSON.parse(body || "{}") as { subjectId?: number; progress?: number; status?: string };
          const f = readCollection();
          const it = f.items.find((x) => x.subjectId === Number(p.subjectId));
          if (!it) {
            json(res, 404, { error: "追番清单里没有这部" });
            return;
          }
          if (p.progress !== undefined) it.progress = Math.max(0, Math.min(9999, Number(p.progress) || 0));
          if (p.status === "done" || p.status === "watching") it.status = p.status;
          writeCollection(f);
          json(res, 200, { ok: true, ...sortedCollection(f) });
        } catch (e) {
          json(res, 500, { error: (e as Error).message });
        }
      });
      return;
    }

    if (req.method === "DELETE" && route === "/collection") {
      const subjectId = Number(u.searchParams.get("subjectId"));
      const f = readCollection();
      if (!f.items.some((x) => x.subjectId === subjectId)) {
        json(res, 404, { error: "追番清单里没有这部" });
        return;
      }
      f.items = f.items.filter((x) => x.subjectId !== subjectId);
      writeCollection(f);
      json(res, 200, { ok: true, ...sortedCollection(f) });
      return;
    }

    json(res, 405, { error: "method not allowed" });
  };

  return {
    name: "rana-bangumi",
    configureServer(server) {
      server.middlewares.use("/__rana/bangumi", handler as Parameters<typeof server.middlewares.use>[1]);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/__rana/bangumi", handler as Parameters<typeof server.middlewares.use>[1]);
    },
  };
}
