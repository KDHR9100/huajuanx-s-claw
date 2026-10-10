import fs from "node:fs";
import path from "node:path";
import { RANA_WEB } from "../lib/paths";
import { json, readBody, isLoopback } from "../lib/http";
import type { Plugin } from "vite";

/**
 * 全局日历端点（数据存本地 .life/events.json，不进公开仓库）：
 * - GET    /__rana/events           读全部事件（按日期+时段排序；课表课程不在这里，前端去 /__rana/study 镜像）
 * - POST   /__rana/events           新增 {title, type, date, timeStart?, timeEnd?, remindMin?, location?, note?}
 * - POST   /__rana/events/done      {id, done} 切换完成
 * - DELETE /__rana/events?id=       删除事件
 * 事件类型：interview 面试 / appointment 约会事务 / activity Live·漫展·出门 / game 游戏活动 / deadline 截止。
 * 课程（course）是 schedule.json 的镜像，由前端当日合并展示，不落本文件（不双写）。
 */
export function ranaEventsMiddleware(): Plugin {
  const here = RANA_WEB;
  const lifeDir = path.join(here, ".life");
  const eventsFile = path.join(lifeDir, "events.json");

  type EventType = "interview" | "appointment" | "activity" | "game" | "deadline";
  interface CalEvent {
    id: string;
    title: string;
    type: EventType;
    date: string; // YYYY-MM-DD
    timeStart?: string; // HH:MM（deadline 可不设时段）
    timeEnd?: string;
    /** 提前多少分钟提醒，默认 30 */
    remindMin?: number;
    location?: string;
    note?: string;
    done?: boolean;
    createdAt: number;
  }
  interface EventsFile {
    version: number;
    events: CalEvent[];
    updatedAt: number;
  }

  const EVENT_TYPES: EventType[] = ["interview", "appointment", "activity", "game", "deadline"];
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const TIME_RE = /^\d{2}:\d{2}$/;

  const emptyEvents = (): EventsFile => ({ version: 1, events: [], updatedAt: 0 });
  const readEvents = (): EventsFile => {
    try {
      const j = JSON.parse(fs.readFileSync(eventsFile, "utf8")) as EventsFile;
      if (!Array.isArray(j.events)) j.events = [];
      j.version = 1;
      return j;
    } catch {
      return emptyEvents();
    }
  };
  const writeEvents = (f: EventsFile) => {
    fs.mkdirSync(lifeDir, { recursive: true });
    try {
      fs.copyFileSync(eventsFile, eventsFile + ".bak");
    } catch {
      // 首次写入没有旧文件
    }
    f.updatedAt = Date.now();
    fs.writeFileSync(eventsFile, JSON.stringify(f, null, 2), "utf8");
  };
  const sortedEvents = (f: EventsFile): EventsFile => ({
    ...f,
    events: [...f.events].sort(
      (a, b) => a.date.localeCompare(b.date) || (a.timeStart ?? "99:99").localeCompare(b.timeStart ?? "99:99"),
    ),
  });





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

    if (req.method === "GET" && route === "/") {
      json(res, 200, sortedEvents(readEvents()));
      return;
    }
    if (!isLoopback(req)) {
      json(res, 403, { error: "仅本机可操作" });
      return;
    }

    if (req.method === "POST" && route === "/") {
      readBody(req).then((body) => {
        try {
          const p = JSON.parse(body || "{}") as Record<string, unknown>;
          const title = String(p.title ?? "").trim().slice(0, 80);
          const type = String(p.type ?? "") as EventType;
          const date = String(p.date ?? "").trim();
          if (!title) {
            json(res, 400, { error: "标题不能为空" });
            return;
          }
          if (!EVENT_TYPES.includes(type)) {
            json(res, 400, { error: `type 只能是 ${EVENT_TYPES.join(" / ")}` });
            return;
          }
          if (!DATE_RE.test(date)) {
            json(res, 400, { error: "date 要是 YYYY-MM-DD" });
            return;
          }
          const timeStart = String(p.timeStart ?? "").trim();
          const timeEnd = String(p.timeEnd ?? "").trim();
          if (timeStart && !TIME_RE.test(timeStart)) {
            json(res, 400, { error: "timeStart 要是 HH:MM" });
            return;
          }
          if (timeEnd && !TIME_RE.test(timeEnd)) {
            json(res, 400, { error: "timeEnd 要是 HH:MM" });
            return;
          }
          let remindMin = 30;
          if (p.remindMin !== undefined && p.remindMin !== null && String(p.remindMin) !== "") {
            remindMin = Math.max(0, Math.min(1440, Number(p.remindMin) || 0));
          }
          const f = readEvents();
          const ev: CalEvent = {
            id: `e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
            title,
            type,
            date,
            ...(timeStart ? { timeStart } : {}),
            ...(timeEnd ? { timeEnd } : {}),
            remindMin,
            ...(String(p.location ?? "").trim() ? { location: String(p.location).trim().slice(0, 200) } : {}),
            ...(String(p.note ?? "").trim() ? { note: String(p.note).trim().slice(0, 500) } : {}),
            done: false,
            createdAt: Date.now(),
          };
          f.events.push(ev);
          writeEvents(f);
          json(res, 200, { ok: true, event: ev, ...sortedEvents(f) });
        } catch (e) {
          json(res, 500, { error: (e as Error).message });
        }
      });
      return;
    }

    if (req.method === "POST" && route === "/done") {
      readBody(req).then((body) => {
        try {
          const p = JSON.parse(body || "{}") as { id?: string; done?: boolean };
          const f = readEvents();
          const ev = f.events.find((x) => x.id === p.id);
          if (!ev) {
            json(res, 404, { error: "没有这个事件" });
            return;
          }
          ev.done = Boolean(p.done);
          writeEvents(f);
          json(res, 200, { ok: true, ...sortedEvents(f) });
        } catch (e) {
          json(res, 500, { error: (e as Error).message });
        }
      });
      return;
    }

    if (req.method === "DELETE" && route === "/") {
      const id = u.searchParams.get("id") ?? "";
      const f = readEvents();
      if (!f.events.some((x) => x.id === id)) {
        json(res, 404, { error: "没有这个事件" });
        return;
      }
      f.events = f.events.filter((x) => x.id !== id);
      writeEvents(f);
      json(res, 200, { ok: true, ...sortedEvents(f) });
      return;
    }

    json(res, 405, { error: "method not allowed" });
  };

  return {
    name: "rana-events",
    configureServer(server) {
      server.middlewares.use("/__rana/events", handler as Parameters<typeof server.middlewares.use>[1]);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/__rana/events", handler as Parameters<typeof server.middlewares.use>[1]);
    },
  };
}
