import fs from "node:fs";
import path from "node:path";
import { RANA_WEB, STATE_HOME } from "../lib/paths";
import { json, readBody, isLoopback } from "../lib/http";
import { writeJsonBak } from "../lib/fs-json";
import { createAgentBridge } from "../lib/agent-session-bridge";
import type { Plugin } from "vite";

/**
 * 问卜（玄学）端点——生辰档案本地存 rana-web/.fate/（已进 .gitignore，不入公开仓库）：
 * - GET  /__rana/fate/profile   读档案库（多档案 {list, active}；无则 {empty:true}；旧单档案 profile.json 自动迁入）
 * - POST /__rana/fate/profile   {action:"save" | "select" | "delete", profile?, id?} —— 多档案增改/切换/删除
 * - POST /__rana/fate/ask       解卦：万年历/八字/紫微/卦象由前端本地算好一并传来，
 *   中间件补上当前选中档案后组装提示词 → 子进程跑 fate-agent.mjs（专用会话 agent:main:fate-teller）
 *   → 返回她的解卦正文（markdown，给用户看的，不走 JSON 契约）。
 * 隐私：每次 ask 会把命盘摘要发到云端模型（用户已知情拍板）；档案本体不出本机。
 * 全量资料（2026-11-08 主人拍板）：ask 时若此人名下有问卦档案（STATE_HOME/workspace-main/
 * personal/querents/<nick>.md）则全文注入，连同 USER.md 生活画像一并给到解卦会话，
 * 她结合历次问卦记录与实际处境来讲；读不到就照旧，不阻塞。
 */

/** /ask 的前端 payload：domain/question 自由文本，其余为前端本地排好的盘 */
export interface AskPayload {
  domain?: string;
  question?: string;
  hexagram?: Record<string, unknown> | null;
  almanac?: Record<string, unknown>;
  bazi?: Record<string, unknown> | null;
  ziwei?: Record<string, unknown> | null;
}

/** 此人名下的全量资料（读好的全文，null=没有/读不到，照旧解盘不阻塞） */
export interface DossierBundle {
  querent: string | null;
  user: string | null;
}

/** 此人名下的全量资料路径（main 的 workspace）：问卦档案按 nick 匹配，USER.md 固定；
 *  穿越型 nick（含 ../ 等）返回 querent=""，调用方跳过注入。 */
export function resolveDossierPaths(nick?: string): { querent: string; user: string } {
  const dir = path.resolve(STATE_HOME, "workspace-main", "personal", "querents");
  const p = nick ? path.resolve(dir, `${nick}.md`) : "";
  const safe = !!nick && !/[\\/]/.test(nick) && path.dirname(p) === dir; // 必须直接落在 querents 一层（拒穿越、拒子目录）；含 / 或 \ 一律拒——Linux 上 \ 不是分隔符，dirname 对比挡不住 ..\ 型 nick
  return { querent: safe ? p : "", user: path.resolve(STATE_HOME, "workspace-main", "USER.md") };
}

/** 全量资料注入文案（模块级纯函数，可测）：问卦档案+USER.md 各一段，给 askMessage 拼提示词用。
 *  null 字段整段省略；代问条目提醒是第三方背景，冲突时点明延续/冲突规则。 */
export function dossierSections(d: DossierBundle): string[] {
  const s: string[] = [];
  if (d.querent)
    s.push(
      `【他的历次问卦档案（本人知情，本地注入）】\n${d.querent}\n` +
        `——解盘时结合这份档案：历次断语与新盘/新卦一致就延续口径，冲突就点明「上次说X，这次卦象显示Y」；` +
        `档案里标「(代问)」的是第三方的卦，只当背景，别安到他头上。`,
    );
  if (d.user)
    s.push(
      `【他的生活画像 USER.md（本人知情拍板注入）】\n${d.user}\n` +
        `——画像只用来联系他的实际处境（工作/学习/作息），与本次解卦无关的条目照常忽略。`,
    );
  return s;
}

/** 容错读全文：不存在/读不到/空文件一律返回 null，调用方照旧解盘不阻塞 */
export function readMaybe(p: string): string | null {
  if (!p) return null;
  try {
    const t = fs.readFileSync(p, "utf8");
    return t.trim() ? t : null;
  } catch {
    return null;
  }
}

export function ranaFateMiddleware(): Plugin {
  const here = RANA_WEB;
  const fateDir = path.join(here, ".fate");
  const profilesFile = path.join(fateDir, "profiles.json");
  const legacyProfileFile = path.join(fateDir, "profile.json"); // 单档案时代的老文件，首次访问自动迁入

  interface FateProfile {
    id?: string;
    nick?: string;
    gender: "男" | "女";
    birthday: string; // YYYY-MM-DD 阳历
    birthTime?: string; // HH:MM，可空（八字少时柱、紫微不可排）
    birthplace?: string;
    savedAt?: number;
  }
  interface FateStore {
    version: 1;
    active: string | null;
    list: Array<FateProfile & { id: string }>;
  }

  const newId = () => `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  const writeStore = (store: FateStore) => {
    writeJsonBak(profilesFile, store);
  };

  /** 读多档案库；没有 profiles.json 但有旧单档案 profile.json 时自动迁移（老文件保留不动） */
  const readStore = (): FateStore | { empty: true } => {
    try {
      const s = JSON.parse(fs.readFileSync(profilesFile, "utf8")) as FateStore;
      if (!s || !Array.isArray(s.list)) return { empty: true };
      s.list = s.list.filter((p) => p && p.id && p.birthday && p.gender);
      if (!s.active || !s.list.some((p) => p.id === s.active)) s.active = s.list[0]?.id ?? null;
      return s;
    } catch {
      // 试旧单档案迁移
    }
    try {
      const old = JSON.parse(fs.readFileSync(legacyProfileFile, "utf8")) as FateProfile;
      if (old && old.birthday && old.gender) {
        const id = newId();
        const store: FateStore = { version: 1, active: id, list: [{ ...old, id }] };
        writeStore(store);
        return store;
      }
    } catch {
      /* 也没有旧档案 */
    }
    return { empty: true };
  };

  const validateProfile = (p: FateProfile) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.birthday)) throw new Error("生日需为 YYYY-MM-DD");
    if (p.gender !== "男" && p.gender !== "女") throw new Error("性别需为 男/女（紫微排盘必需）");
    if (p.birthTime && !/^\d{2}:\d{2}$/.test(p.birthTime)) throw new Error("出生时间需为 HH:MM");
    if (p.nick && p.nick.length > 24) throw new Error("昵称太长");
    if (p.birthplace && p.birthplace.length > 60) throw new Error("出生地太长");
  };

  /** 保存（有 id 更新、无 id 新建）并把此人设为当前选中 */
  const upsertProfile = (p: FateProfile): FateStore => {
    validateProfile(p);
    const cur = readStore();
    const store: FateStore = "empty" in cur ? { version: 1, active: null, list: [] } : cur;
    const entry = { ...p, savedAt: Date.now() };
    const idx = p.id ? store.list.findIndex((x) => x.id === p.id) : -1;
    if (idx >= 0) store.list[idx] = { ...entry, id: store.list[idx].id };
    else {
      const id = newId();
      store.list.push({ ...entry, id });
      store.active = id;
    }
    if (p.id) store.active = p.id;
    writeStore(store);
    return store;
  };

  const selectProfile = (id: string): FateStore => {
    const cur = readStore();
    if ("empty" in cur || !cur.list.some((p) => p.id === id)) throw new Error("没有这份档案");
    cur.active = id;
    writeStore(cur);
    return cur;
  };

  const deleteProfile = (id: string): FateStore => {
    const cur = readStore();
    const store: FateStore = "empty" in cur ? { version: 1, active: null, list: [] } : cur;
    store.list = store.list.filter((p) => p.id !== id);
    if (store.active === id) store.active = store.list[0]?.id ?? null;
    writeStore(store);
    return store;
  };


  const bridge = createAgentBridge(path.join(here, "fate-agent.mjs"));
  const runAgent = (message: string) => bridge.run(["--message", message]);

  /** 解卦提示词：档案（服务端补，可能没有）+ 前端按勾选带来的材料；没勾的整段省略；
   *  dossier=读好的全量资料（问卦档案+USER.md），有就整段注入（2026-11-08 主人拍板）。 */
  const askMessage = (
    payload: AskPayload,
    profile: FateProfile | null,
    dossier?: DossierBundle,
  ) => {
    const dom = String(payload.domain ?? "");
    const q = String(payload.question ?? "").trim();
    const parts: string[] = [
      payload.hexagram ? "【问卦·页面触发】用户摇了一卦，请你解卦。" : "【命理咨询·页面触发】用户想问你命理问题。",
      `问题域：${dom || "综合"}${q ? `；他自己的问题：「${q}」` : ""}`,
    ];
    if (profile) {
      parts.push(
        `他的档案：${[
          profile.nick ? `昵称${profile.nick}` : "",
          `性别${profile.gender}`,
          `阳历生日${profile.birthday}`,
          profile.birthTime ? `出生时间${profile.birthTime}` : "出生时间未知",
          profile.birthplace ? `出生地${profile.birthplace}` : "",
        ]
          .filter(Boolean)
          .join("，")}`,
      );
    }
    for (const s of dossierSections(dossier ?? { querent: null, user: null })) parts.push(s);
    if (payload.bazi) parts.push(`八字（前端排好）：${JSON.stringify(payload.bazi)}`);
    if (payload.ziwei) parts.push(`紫微要点（前端排好，含当前大限/流年）：${JSON.stringify(payload.ziwei)}`);
    if (payload.almanac) parts.push(`今日黄历（前端排好）：${JSON.stringify(payload.almanac)}`);
    if (payload.hexagram) parts.push(`卦象（前端排好，六爻从初爻到上爻）：${JSON.stringify(payload.hexagram)}`);
    parts.push(
      [
        "回答要求：",
        "1) 材料有什么用什么：结合命盘（八字五行、紫微命宫大限流年）和/或卦象（本卦变卦、动爻、卦辞，动爻爻辞凭你掌握的《周易》原文引用）回答他的问题；注入了问卦档案/生活画像就必须结合着讲（延续口径与冲突点明的规则见各段尾注）；没给的材料别硬编；",
        "2) 保持你平时的说话风格，话少、直接，别迷信吓唬人，也别灌鸡汤；",
        payload.hexagram
          ? "3) 分三段：卦象说了什么 / 对他这个人的命盘意味着什么 / 落到这件事上一句可执行的建议；"
          : "3) 分两段：命盘怎么说 / 落到这件事上一句可执行的建议；",
        "4) 直接输出给用户看的 markdown 正文，不要输出 ```json 契约块。",
      ].join("\n"),
    );
    return parts.join("\n\n");
  };





  const handler = (
    req: {
      method?: string;
      url?: string;
      socket?: { remoteAddress?: string };
      headers?: Record<string, unknown>;
      on: (ev: string, cb: (c?: string) => void) => void;
    },
    res: { setHeader: (k: string, v: string) => void; statusCode: number; end: (s: string) => void },
  ) => {
    const route = (new URL(req.url ?? "/", "http://x").pathname || "/").replace(/\/+$/, "") || "/";

    if (req.method === "GET" && route === "/profile") {
      const store = readStore();
      json(res, 200, "empty" in store ? { empty: true } : { list: store.list, active: store.active });
      return;
    }
    if (!isLoopback(req)) {
      json(res, 403, { error: "仅本机可操作" });
      return;
    }

    if (req.method === "POST" && route === "/profile") {
      readBody(req).then((body) => {
        try {
          const { action, profile, id } = JSON.parse(body) as {
            action?: "save" | "select" | "delete";
            profile?: FateProfile;
            id?: string;
          };
          let store: FateStore;
          if (action === "select") {
            if (!id) throw new Error("缺 id");
            store = selectProfile(id);
          } else if (action === "delete") {
            if (!id) throw new Error("缺 id");
            store = deleteProfile(id);
          } else {
            if (!profile) throw new Error("缺 profile");
            store = upsertProfile(profile);
          }
          json(res, 200, { ok: true, list: store.list, active: store.active });
        } catch (e) {
          json(res, 400, { error: (e as Error).message });
        }
      });
      return;
    }

    if (req.method === "POST" && route === "/ask") {
      readBody(req)
        .then(async (body) => {
          const payload = JSON.parse(body || "{}") as Parameters<typeof askMessage>[0];
          const store = readStore();
          const prof = "empty" in store ? null : store.list.find((p) => p.id === store.active) ?? store.list[0];
          // 没档案也放行——只问卦象（不排命盘）是合法用法；但带了八字/紫微就必须有档案
          if (!prof && (payload.bazi || payload.ziwei)) {
            json(res, 400, { error: "还没填生辰档案——先在「我的档案」里存一份" });
            return;
          }
          const paths = resolveDossierPaths(prof?.nick);
          const dossier = {
            querent: paths.querent ? readMaybe(paths.querent) : null,
            user: readMaybe(paths.user),
          };
          const r = await runAgent(askMessage(payload, prof, dossier));
          if (!r.ok) {
            json(res, 500, { error: r.error ?? "她没回话" });
            return;
          }
          json(res, 200, { ok: true, reply: r.reply ?? "" });
        })
        .catch((e: Error) => {
          json(res, 500, { error: e.message });
        });
      return;
    }

    json(res, 405, { error: "method not allowed" });
  };

  return {
    name: "rana-fate",
    configureServer(server) {
      server.middlewares.use("/__rana/fate", handler as Parameters<typeof server.middlewares.use>[1]);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/__rana/fate", handler as Parameters<typeof server.middlewares.use>[1]);
    },
  };
}
