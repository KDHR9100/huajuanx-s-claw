import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { execFileP } from "../lib/exec";
import { RANA_WEB } from "../lib/paths";
import { json, readBody, isLoopback } from "../lib/http";
import type { Plugin } from "vite";

/**
 * 人生规划端点（数据存本地 .life/ 目录，已进 .gitignore 不入公开仓库）：
 * - GET    /__rana/life                    读 life.json（人生目标 + 月度里程碑）
 * - POST   /__rana/life/goals              新建人生目标 {title, why?, horizon?}
 * - DELETE /__rana/life/goals?id=          删除目标（已转出的待办、已排的课不受影响）
 * - POST   /__rana/life/goals/status       {goalId, status} 目标达成/归档/重启
 * - POST   /__rana/life/goals/parse        拆解月度里程碑（Rana 按 life-planning skill 只出方案，校验后写回）
 * - POST   /__rana/life/milestones/todo    里程碑转待办（写 .study/goals.json，带 lifeGoalId/milestoneId，
 *                                          之后照旧走待办页的「让Rana拆解→排进课程表」流程）
 * - POST   /__rana/life/milestones/status  {goalId, milestoneId, status} 里程碑完成/重开
 * - GET    /__rana/life/library            读内容库 library.json
 * - POST   /__rana/life/library/collect    {topic} 联网搜集（Rana 用 web_search 搜真材实料，返回候选不落盘）
 * - POST   /__rana/life/library/feed       {url|text, note?} 投喂：URL 由服务端直抓网页转文本（bocha 只有
 *                                          搜索摘要没整页），交她提炼成草稿（不落盘），页面确认后另存
 * - POST   /__rana/life/library            {entry|entries, addedBy} 页面确认后落盘
 * - DELETE /__rana/life/library?id=        删除条目
 */
export function ranaLifeMiddleware(): Plugin {
  const here = RANA_WEB;
  const lifeDir = path.join(here, ".life");
  const lifeFile = path.join(lifeDir, "life.json");
  const libraryFile = path.join(lifeDir, "library.json");
  const scheduleFile = path.join(here, ".study", "schedule.json");
  const studyGoalsFile = path.join(here, ".study", "goals.json");
  let agentBusy = false;

  interface LifeMilestone {
    id: string;
    month: string; // YYYY-MM
    title: string;
    detail?: string;
    status: "planned" | "done";
    createdAt: number;
    /** 已转成待办（.study/goals.json）时记录，防重复转 */
    todoGoalId?: string;
  }
  interface LifeGoal {
    id: string;
    title: string;
    why?: string;
    horizon?: string;
    status: "active" | "done" | "archived";
    milestones: LifeMilestone[];
    /** 她最近一次拆解的说明（方案本体就是 milestones） */
    analysis?: string;
    summary?: string;
    parsedAt?: number;
    createdAt: number;
    updatedAt?: number;
  }
  interface LifeFile {
    version: 1;
    goals: LifeGoal[];
    updatedAt: number;
  }
  interface LibraryEntry {
    id: string;
    title: string;
    summary: string;
    takeaway?: string;
    source?: string;
    tags?: string[];
    addedBy: "rana" | "owner";
    goalId?: string;
    createdAt: number;
    /** 已消化成学习讲义（存进 .study/materials）时记录，页面标「已成讲义」 */
    digestedAt?: number;
    digestMaterialId?: string;
    digestCourseId?: string;
  }
  interface LibraryFile {
    version: 1;
    entries: LibraryEntry[];
    updatedAt: number;
  }
  /** 待办（.study/goals.json）的形状；ranaStudyMiddleware 读写时未知字段原样保留，lifeGoalId 等能存活 */
  interface TodoGoalLike {
    id: string;
    text: string;
    createdAt: number;
    status: string;
    [k: string]: unknown;
  }

  const pad2 = (n: number) => String(n).padStart(2, "0");
  const localDate = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const todayStr = () => localDate(new Date());
  const curMonth = () => todayStr().slice(0, 7);
  const addDays = (ds: string, n: number) => {
    const [y, m, d] = ds.split("-").map(Number);
    return localDate(new Date(y, m - 1, d + n));
  };
  const MONTH_RE = /^\d{4}-\d{2}$/;
  const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  const readJsonAny = (file: string): Record<string, unknown> | null => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  const writeJsonBak = (file: string, data: unknown) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      fs.copyFileSync(file, file + ".bak");
    } catch {
      // 首次写入没有旧文件
    }
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
  };

  const readLife = (): LifeFile => {
    const raw = readJsonAny(lifeFile) as LifeFile | null;
    if (!raw || !Array.isArray(raw.goals)) return { version: 1, goals: [], updatedAt: 0 };
    raw.goals = raw.goals.filter((g) => g && g.id && g.title && Array.isArray(g.milestones));
    return raw;
  };

  const readLibrary = (): LibraryFile => {
    const raw = readJsonAny(libraryFile) as LibraryFile | null;
    if (!raw || !Array.isArray(raw.entries)) return { version: 1, entries: [], updatedAt: 0 };
    return raw;
  };

  /** 唤醒 Rana：子进程跑 life-agent.mjs；搜集场景联网搜索链长，waitMs 放宽（中间件超时 = waitMs+15s） */
  const spawnLifeAgent = async (
    message: string,
    model?: string,
    waitMs = 165000,
  ): Promise<{ ok: boolean; reply?: string; data?: Record<string, unknown>; error?: string }> => {
    const args = [path.join(here, "life-agent.mjs"), "--message", message, "--wait-ms", String(waitMs)];
    if (model) args.push("--model", model);
    const { stdout } = await execFileP(process.execPath, args, {
      encoding: "utf8",
      timeout: waitMs + 15000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    return JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
  };

  const runLifeAgent = async (message: string, model?: string, waitMs?: number) => {
    if (agentBusy) throw new Error("她正忙着上一个请求，等一下再试");
    agentBusy = true;
    try {
      return await spawnLifeAgent(message, model, waitMs);
    } finally {
      agentBusy = false;
    }
  };

  /** 现状摘要：课程表 + 待办（拆解人生目标、搜集资料时"结合他的情况"用） */
  const lifeContext = () => {
    const t = todayStr();
    const lines = [`今天日期：${t}`];
    const s = readJsonAny(scheduleFile) as
      | { courses?: Array<{ date?: string; status?: string }>; streak?: { days?: number; best?: number }; plans?: Array<{ name?: string }> }
      | null;
    if (s && Array.isArray(s.courses)) {
      const planned = s.courses.filter((c) => c.status === "planned" && typeof c.date === "string");
      const load: string[] = [];
      for (let i = 0; i < 30; i++) {
        const d = addDays(t, i);
        const n = planned.filter((c) => c.date === d).length;
        if (n) load.push(`${d}=${n}节`);
      }
      const overdue = planned.filter((c) => (c.date ?? "") < t).length;
      lines.push(`未来 30 天已有课：${load.length ? load.join("、") : "全空"}`);
      lines.push(`逾期未完成：${overdue} 节；连续打卡：${s.streak?.days ?? 0} 天（最佳 ${s.streak?.best ?? 0}）`);
      const plans = (s.plans ?? []).map((p) => p.name).filter(Boolean);
      lines.push(`进行中的学习计划：${plans.join("、") || "无"}`);
    } else {
      lines.push("（课程表还是空的）");
    }
    const g = readJsonAny(studyGoalsFile) as { goals?: Array<{ text?: string; status?: string }> } | null;
    const open = (g?.goals ?? []).filter((x) => x.status === "open" && x.text);
    lines.push(
      open.length
        ? `待办（未拆解的大方向）：${open.length} 条，例如：${open.slice(0, 5).map((x) => `「${(x.text ?? "").slice(0, 30)}」`).join("；")}`
        : "待办：没有未拆解的",
    );
    return lines.join("\n");
  };

  /** 内容库摘要（拆解时引用用） */
  const libraryContext = () => {
    const lib = readLibrary();
    if (!lib.entries.length) return "（内容库还是空的，没有可引用的材料）";
    return lib.entries
      .slice(0, 20)
      .map((e) => `- 《${e.title}》${e.tags?.length ? `（${e.tags.join("/")}）` : ""}：${e.summary.slice(0, 80)}`)
      .join("\n");
  };

  const lifeGoalsContext = () => {
    const act = readLife().goals.filter((g) => g.status === "active");
    if (!act.length) return "（还没建人生目标）";
    return act.map((g) => `- ${g.title}${g.horizon ? `（${g.horizon}）` : ""}`).join("\n");
  };

  const lifeParseMessage = (goal: LifeGoal) =>
    [
      "【人生目标拆解·页面触发】用户在规划页写下了一个人生目标，点了「让Rana拆解」。",
      `目标：${goal.title}`,
      ...(goal.why ? [`为什么想达成：${goal.why}`] : []),
      ...(goal.horizon ? [`时间跨度：${goal.horizon}`] : []),
      `他的现状：\n${lifeContext()}`,
      `规划内容库（别人踩过的坑、真材实料；拆解时相关的要引用，说清用哪条、怎么用）：\n${libraryContext()}`,
      "按 life-planning skill 把目标拆成月度里程碑（只出方案，绝不改任何文件）。里程碑要具体、可检验（拿到什么 / 做完什么 / 达到什么水平），别写「继续努力」这种空话。",
      `回复的最后必须是一个 \`\`\`json 代码块：{"analysis":"两三句话：这条路怎么走、为什么这么拆、结合他现状与内容库的考虑","summary":"一句话总纲","milestones":[{"month":"YYYY-MM","title":"这个月的里程碑","detail":"达成标准与关键动作"}]}。里程碑 3~12 个，month 必须是不早于 ${curMonth()} 的真实未来月份。失败则 {"ok":false,"summary":"原因"}。`,
    ].join("\n\n");

  const collectMessage = (topic: string) => {
    const lib = readLibrary();
    const known = lib.entries.map((e) => e.source).filter((s) => s && /^https?:\/\//i.test(s)) as string[];
    return [
      "【内容库搜集·页面触发】用户在规划页的内容库点了「让Rana去搜集」。",
      `主题：${topic}`,
      `他的人生目标（搜集方向尽量贴着这些来）：\n${lifeGoalsContext()}`,
      known.length
        ? `内容库里已有的网址（这些已经搜集过、记住了，别重复推荐相同出处；同站不同文章可以推）：\n${[...new Set(known)].slice(0, 40).join("\n")}`
        : "（内容库还空着，没有已记录的网址）",
      "按 life-planning skill 的搜集场景：用 web_search 搜 3~5 组关键词（主题 + 方法论 / 经验 / 复盘 / 避坑 等变体），挑 3~6 条真材实料。",
      "要求：有干货、有出处（有名字的人的总结、经典方法论、深度复盘都算）；营销软文、AI 水文、标题党、纯鸡汤不要，宁缺毋滥。**每条的 source 必须是你真实搜到的完整网址（http(s):// 开头），不许省略、不许编**——这是主人的硬要求，网址要留档记住。",
      "**搜完立刻输出结果，别再点开更多搜索。**回复的最后必须是一个 ```json 代码块：{\"candidates\":[{\"title\":\"材料名（人名+方法名优先）\",\"summary\":\"150 字内讲清这份材料到底说了什么\",\"takeaway\":\"对他的规划具体有什么用\",\"source\":\"https://… 完整真实网址\",\"tags\":[\"职业\",\"方法论\"]}]}。没有合适的就 {\"candidates\":[]}。",
    ].join("\n\n");
  };

  const feedMessage = (content: string, source: string, note: string) =>
    [
      "【内容库提炼·页面触发】用户找来一份材料，投喂给规划内容库。",
      `材料来源：${source}`,
      ...(note ? [`用户的备注：${note}`] : []),
      `材料原文（可能截断）：\n${content}`,
      "按 life-planning skill 的提炼场景：把这份材料提炼成一条内容库条目（只出方案，绝不改任何文件）。summary 提干货别复述套话，takeaway 写对他的规划有什么用。",
      '回复的最后必须是一个 ```json 代码块：{"title":"材料名","summary":"200 字内讲清核心干货","takeaway":"对他的规划具体有什么用","tags":["…"]}。失败则 {"ok":false,"summary":"原因"}。',
    ].join("\n\n");

  /** 校验她拆出的月度里程碑：YYYY-MM 且不早于当前月，标题必填限长 */
  const cleanMilestones = (data: Record<string, unknown> | undefined) => {
    if (!data) throw new Error("没解析到方案 JSON");
    const arr = Array.isArray(data.milestones) ? data.milestones : [];
    if (!arr.length) throw new Error(String(data.summary ?? "她说没法拆").slice(0, 200));
    if (arr.length > 24) throw new Error("一次拆超过 24 个月里程碑，超出上限");
    const cm = curMonth();
    const milestones: LifeMilestone[] = arr.map((raw, i) => {
      const m = raw as Partial<LifeMilestone>;
      const month = String(m?.month ?? "");
      const title = String(m?.title ?? "").trim();
      if (!MONTH_RE.test(month) || month < cm) throw new Error(`第 ${i + 1} 个月里程碑的 month 不是 YYYY-MM，或早于当前月（${cm}）`);
      if (!title) throw new Error(`第 ${i + 1} 个月里程碑缺标题`);
      return {
        id: newId("ms"),
        month,
        title: title.slice(0, 80),
        ...(typeof m?.detail === "string" && m.detail.trim() ? { detail: m.detail.trim().slice(0, 300) } : {}),
        status: "planned",
        createdAt: Date.now(),
      };
    });
    milestones.sort((a, b) => a.month.localeCompare(b.month));
    return {
      analysis: String(data.analysis ?? "").slice(0, 1000),
      summary: String(data.summary ?? "").slice(0, 200),
      milestones,
    };
  };

  /** 条目主体校验（搜集候选 / 投喂草稿 / 落盘共用）：标题+总结必填，字段收窄限长 */
  const entryCore = (raw: unknown): Omit<LibraryEntry, "id" | "addedBy" | "goalId" | "createdAt"> => {
    const c = (raw ?? {}) as Partial<LibraryEntry>;
    const title = String(c.title ?? "").trim();
    const summary = String(c.summary ?? "").trim();
    if (!title || !summary) throw new Error("条目缺标题或总结");
    return {
      title: title.slice(0, 120),
      summary: summary.slice(0, 800),
      ...(String(c.takeaway ?? "").trim() ? { takeaway: String(c.takeaway).trim().slice(0, 300) } : {}),
      ...(String(c.source ?? "").trim() ? { source: String(c.source).trim().slice(0, 300) } : {}),
      ...(Array.isArray(c.tags) && c.tags.length
        ? { tags: c.tags.map((t) => String(t).slice(0, 16)).filter(Boolean).slice(0, 6) }
        : {}),
    };
  };

  /** 搜集候选校验（比投喂草稿严）：source 必须是真实 http(s) 网址（主人要求网址留档），没网址的候选拒收 */
  const cleanCandidates = (data: Record<string, unknown> | undefined) => {
    if (!data) throw new Error("没解析到结果 JSON");
    const arr = Array.isArray(data.candidates) ? data.candidates : [];
    if (!arr.length) throw new Error("这次没搜到值得入库的真材实料（宁缺毋滥，换个主题试试）");
    const kept = arr
      .slice(0, 8)
      .map((raw) => entryCore(raw))
      .filter((c) => /^https?:\/\//i.test(c.source ?? ""));
    if (!kept.length) throw new Error("候选全都没带真实网址（http(s)://），不收——换个主题重搜，或手动投喂");
    return kept;
  };

  /** Windows 文件名安全化（与 study 中间件同款规则）：去非法字符与前导点，限长 */
  const safeFilename = (name: string): string => {
    const cut = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/^\.+/, "").trim().slice(0, 80);
    return cut || "digest";
  };

  /** 从明天起找第一个没有任何课的日期（讲义课的默认落位，与课表页顺延规则一致） */
  const nextFreeDayLife = (courses: Array<{ date?: string }>) => {
    const taken = new Set(courses.map((c) => c.date).filter(Boolean));
    let d = addDays(todayStr(), 1);
    for (let i = 0; i < 400; i++) {
      if (!taken.has(d)) return d;
      d = addDays(d, 1);
    }
    return d;
  };

  /** 讲义生成消息：条目 + （可能的）来源原文 + 他的人生目标与现状 */
  const digestMessage = (entry: LibraryEntry, rawContent: string) =>
    [
      "【讲义生成·页面触发】用户在规划页的内容库点「让她写成讲义」。",
      `材料条目：《${entry.title}》${entry.tags?.length ? `（标签：${entry.tags.join("/")}）` : ""}`,
      `条目摘要：${entry.summary}`,
      ...(entry.takeaway ? [`当初记下的用处：${entry.takeaway}`] : []),
      `他的人生目标：\n${lifeGoalsContext()}`,
      `他的现状：\n${lifeContext()}`,
      rawContent
        ? `材料来源原文（可能截断）：\n${rawContent}`
        : "（没有原文可给——条目只有摘要。用 web_search 补 2~3 组关键词查这份材料的细节和最新进展，别凭空编。）",
      "按 life-planning skill 的讲义场景写成给他学的讲义：总结开头 + 分点干货（有名字、有数字、有反直觉的亮点细节必须原样保留，不许泛化成空话）+ 结合他目标现状的「对你意味着什么」+ 2~3 个自检问题。800~2000 字 markdown。",
      '回复的最后必须是一个 ```json 代码块：{"title":"讲义标题（不带书名号）","digest":"markdown 正文"}。失败则 {"ok":false,"summary":"原因"}。',
    ].join("\n\n");

  /** 校验她写的讲义：标题 + 正文必填，正文要有实质内容 */
  const cleanDigest = (data: Record<string, unknown> | undefined) => {
    if (!data) throw new Error("没解析到讲义 JSON");
    const title = String(data.title ?? "").trim();
    const digest = String(data.digest ?? "").trim();
    const fail = String(data.summary ?? "").slice(0, 200);
    if (!title || digest.length < 200) throw new Error(fail || "讲义缺标题，或正文不足 200 字");
    return { title: title.slice(0, 80), digest: digest.slice(0, 12000) };
  };

  /** 抓取 URL 的安全闸：仅 http/https，host 拒绝 localhost、环回、私网、链路本地等内网地址（防 SSRF 探内网） */
  const assertPublicHttpUrl = (url: string) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new Error("URL 格式不对");
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("URL 需为 http(s)://");
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
      throw new Error("不给抓本机/内网域名");
    }
    if (net.isIP(host)) {
      const bad =
        host === "::1" ||
        host === "0.0.0.0" ||
        host.startsWith("127.") ||
        host.startsWith("10.") ||
        host.startsWith("192.168.") ||
        host.startsWith("169.254.") ||
        host.startsWith("fd") || // IPv6 ULA fc00::/7
        host.startsWith("fe80"); // IPv6 链路本地
      if (host.includes(".")) {
        const seg = host.split(".").map(Number);
        if (seg[0] === 172 && seg[1] >= 16 && seg[1] <= 31) throw new Error("不给抓内网地址");
      }
      if (bad) throw new Error("不给抓内网地址");
    }
  };

  /** 服务端直抓网页转正文文本（bocha 只有搜索摘要，整页要自己抓；学 news-report.mjs 的做法） */
  const httpText = async (url: string): Promise<string> => {
    if (!/^https?:\/\//i.test(url)) throw new Error("URL 需以 http(s):// 开头");
    assertPublicHttpUrl(url); // 安全闸：内网/环回一律拒绝
    const r = await fetch(url, {
      signal: AbortSignal.timeout(20000),
      redirect: "follow",
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) rana-web/1.0",
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.6",
      },
    });
    if (!r.ok) throw new Error(`网页返回 HTTP ${r.status}`);
    const raw = (await r.text()).slice(0, 2 * 1024 * 1024);
    // 轻量 HTML→文本：去脚本样式、块级标签换行、实体解码、空白收敛
    let t = raw
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote|pre)>/gi, "\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ");
    const named: Record<string, string> = {
      amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", middot: "·", hellip: "…",
      mdash: "—", ndash: "–", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’",
    };
    t = t
      .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => {
        try {
          return String.fromCodePoint(parseInt(h, 16));
        } catch {
          return " ";
        }
      })
      .replace(/&#(\d+);/g, (_, d: string) => {
        try {
          return String.fromCodePoint(Number(d));
        } catch {
          return " ";
        }
      })
      .replace(/&([a-z]+);/gi, (m, name: string) => named[name.toLowerCase()] ?? m);
    return t.replace(/[ \t\u00a0]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim();
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

    if (req.method === "GET" && route === "/") {
      json(res, 200, readLife());
      return;
    }
    if (req.method === "GET" && route === "/library") {
      json(res, 200, readLibrary());
      return;
    }
    if (!isLoopback(req)) {
      json(res, 403, { error: "仅本机可操作" });
      return;
    }

    // ---- 人生目标 ----
    if (req.method === "POST" && route === "/goals") {
      readBody(req).then((body) => {
        try {
          const { title, why, horizon } = JSON.parse(body || "{}") as { title?: string; why?: string; horizon?: string };
          const t = String(title ?? "").trim();
          if (!t) throw new Error("给目标起个名");
          if (t.length > 120) throw new Error("目标名 120 字以内");
          const life = readLife();
          if (life.goals.filter((g) => g.status === "active").length >= 20) throw new Error("进行中的目标太多啦（上限 20），先完结几个");
          const goal: LifeGoal = {
            id: newId("lg"),
            title: t,
            ...(String(why ?? "").trim() ? { why: String(why).trim().slice(0, 500) } : {}),
            ...(String(horizon ?? "").trim() ? { horizon: String(horizon).trim().slice(0, 40) } : {}),
            status: "active",
            milestones: [],
            createdAt: Date.now(),
          };
          life.goals.unshift(goal);
          writeJsonBak(lifeFile, { ...life, updatedAt: Date.now() });
          json(res, 200, { ok: true, life });
        } catch (e) {
          json(res, 400, { error: (e as Error).message });
        }
      });
      return;
    }

    if (req.method === "DELETE" && route === "/goals") {
      const id = u.searchParams.get("id") ?? "";
      try {
        const life = readLife();
        if (!life.goals.some((g) => g.id === id)) throw new Error(`目标不存在：${id || "(空id)"}`);
        life.goals = life.goals.filter((g) => g.id !== id);
        writeJsonBak(lifeFile, { ...life, updatedAt: Date.now() });
        json(res, 200, { ok: true, deleted: id });
      } catch (e) {
        json(res, 400, { error: (e as Error).message });
      }
      return;
    }

    if (req.method === "POST" && route === "/goals/status") {
      readBody(req).then((body) => {
        try {
          const { goalId, status } = JSON.parse(body || "{}") as { goalId?: string; status?: string };
          const life = readLife();
          const goal = life.goals.find((g) => g.id === goalId);
          if (!goal) throw new Error(`目标不存在：${goalId || "(空id)"}`);
          if (status !== "active" && status !== "done" && status !== "archived") throw new Error("status 需为 active/done/archived");
          goal.status = status;
          goal.updatedAt = Date.now();
          writeJsonBak(lifeFile, { ...life, updatedAt: Date.now() });
          json(res, 200, { ok: true, life });
        } catch (e) {
          json(res, 400, { error: (e as Error).message });
        }
      });
      return;
    }

    if (req.method === "POST" && route === "/goals/parse") {
      readBody(req)
        .then(async (body) => {
          const parsed = JSON.parse(body || "{}") as { goalId?: string; model?: string };
          const life = readLife();
          const goal = life.goals.find((g) => g.id === parsed.goalId);
          if (!goal) {
            json(res, 400, { error: `目标不存在：${parsed.goalId || "(空id)"}` });
            return;
          }
          const model = typeof parsed.model === "string" && parsed.model ? parsed.model : undefined;
          const r = await runLifeAgent(lifeParseMessage(goal), model);
          try {
            const plan = cleanMilestones(r.data);
            goal.milestones = plan.milestones;
            goal.analysis = plan.analysis;
            goal.summary = plan.summary;
            goal.parsedAt = Date.now();
            goal.updatedAt = Date.now();
            writeJsonBak(lifeFile, { ...life, updatedAt: Date.now() });
            json(res, 200, { ok: true, life });
          } catch (e) {
            json(res, 500, {
              ok: false,
              error: "她没按契约拆：" + ((e as Error).message || r.error || (r.reply ?? "").slice(0, 200)),
            });
          }
        })
        .catch((e: Error) => {
          json(res, 500, { error: e.message });
        });
      return;
    }

    // ---- 里程碑 ----
    if (req.method === "POST" && route === "/milestones/todo") {
      readBody(req).then((body) => {
        try {
          const { goalId, milestoneId } = JSON.parse(body || "{}") as { goalId?: string; milestoneId?: string };
          const life = readLife();
          const goal = life.goals.find((g) => g.id === goalId);
          if (!goal) throw new Error(`目标不存在：${goalId || "(空id)"}`);
          const ms = goal.milestones.find((m) => m.id === milestoneId);
          if (!ms) throw new Error(`里程碑不存在：${milestoneId || "(空id)"}`);
          if (ms.todoGoalId) throw new Error("这条里程碑已经转过待办了");
          // 写 .study/goals.json（形状兼容 ranaStudyMiddleware 的 StudyGoal，多余字段原样保留）
          const gf = (readJsonAny(studyGoalsFile) ?? { version: 1, goals: [], updatedAt: 0 }) as {
            version?: number;
            goals?: TodoGoalLike[];
            updatedAt?: number;
          };
          const goals = Array.isArray(gf.goals) ? gf.goals : [];
          if (goals.length >= 50) throw new Error("待办满了（上限 50），先清清已排的");
          const text = `${ms.title}（${ms.month} 里程碑，人生目标「${goal.title}」${ms.detail ? "：" + ms.detail : ""}）`.slice(0, 480);
          const todo: TodoGoalLike = {
            id: newId("g"),
            text,
            createdAt: Date.now(),
            status: "open",
            plan: null,
            pushedCourseIds: [],
            lifeGoalId: goal.id,
            milestoneId: ms.id,
          };
          goals.unshift(todo);
          writeJsonBak(studyGoalsFile, { version: 1, goals, updatedAt: Date.now() });
          ms.todoGoalId = todo.id;
          goal.updatedAt = Date.now();
          writeJsonBak(lifeFile, { ...life, updatedAt: Date.now() });
          json(res, 200, { ok: true, todo, life });
        } catch (e) {
          json(res, 400, { error: (e as Error).message });
        }
      });
      return;
    }

    if (req.method === "POST" && route === "/milestones/status") {
      readBody(req).then((body) => {
        try {
          const { goalId, milestoneId, status } = JSON.parse(body || "{}") as { goalId?: string; milestoneId?: string; status?: string };
          const life = readLife();
          const goal = life.goals.find((g) => g.id === goalId);
          if (!goal) throw new Error(`目标不存在：${goalId || "(空id)"}`);
          const ms = goal.milestones.find((m) => m.id === milestoneId);
          if (!ms) throw new Error(`里程碑不存在：${milestoneId || "(空id)"}`);
          if (status !== "done" && status !== "planned") throw new Error("status 需为 done/planned");
          ms.status = status;
          goal.updatedAt = Date.now();
          writeJsonBak(lifeFile, { ...life, updatedAt: Date.now() });
          json(res, 200, { ok: true, life });
        } catch (e) {
          json(res, 400, { error: (e as Error).message });
        }
      });
      return;
    }

    // ---- 内容库 ----
    if (req.method === "POST" && route === "/library/collect") {
      readBody(req)
        .then(async (body) => {
          const parsed = JSON.parse(body || "{}") as { topic?: string; model?: string };
          const topic = String(parsed.topic ?? "").trim();
          if (!topic || topic.length < 2) throw new Error("想让她搜集什么主题？写两个字以上");
          if (topic.length > 80) throw new Error("主题 80 字以内");
          const model = typeof parsed.model === "string" && parsed.model ? parsed.model : undefined;
          // 联网搜索链长：等 285s（中间件超时 300s）
          const r = await runLifeAgent(collectMessage(topic), model, 285000);
          try {
            const candidates = cleanCandidates(r.data);
            // 网址记忆：库里已有的出处打标，页面默认不勾（同站不同文章仍可收）
            const known = new Set(
              readLibrary().entries.map((e) => (e.source ?? "").replace(/\/+$/, "")).filter(Boolean),
            );
            const marked = candidates.map((c) => ({
              ...c,
              alreadyIn: Boolean(c.source && known.has(c.source.replace(/\/+$/, ""))),
            }));
            json(res, 200, { ok: true, candidates: marked });
          } catch (e) {
            json(res, 500, {
              ok: false,
              error: "她没按契约交货：" + ((e as Error).message || r.error || (r.reply ?? "").slice(0, 200)),
            });
          }
        })
        .catch((e: Error) => {
          json(res, 500, { error: e.message });
        });
      return;
    }

    if (req.method === "POST" && route === "/library/feed") {
      readBody(req)
        .then(async (body) => {
          const parsed = JSON.parse(body || "{}") as { url?: string; text?: string; note?: string; model?: string };
          const url = String(parsed.url ?? "").trim();
          const rawText = String(parsed.text ?? "").trim();
          const note = String(parsed.note ?? "").trim().slice(0, 200);
          if (!url && !rawText) throw new Error("投喂点内容：贴 URL 或直接粘原文");
          let content = rawText;
          let source = "用户投喂的文字材料";
          if (url) {
            content = await httpText(url);
            source = url;
          }
          if (content.length < 40) throw new Error("内容太短了（URL 可能是动态页抓不到正文，试试直接粘文字）");
          const model = typeof parsed.model === "string" && parsed.model ? parsed.model : undefined;
          const r = await runLifeAgent(feedMessage(content.slice(0, 12000), source, note), model);
          try {
            const draft = entryCore(r.data);
            json(res, 200, { ok: true, draft: { ...draft, ...(draft.source ? {} : { source }) } });
          } catch (e) {
            json(res, 500, {
              ok: false,
              error: "她没按契约提炼：" + ((e as Error).message || r.error || (r.reply ?? "").slice(0, 200)),
            });
          }
        })
        .catch((e: Error) => {
          json(res, 500, { error: e.message });
        });
      return;
    }

    if (req.method === "POST" && route === "/library/digest") {
      readBody(req)
        .then(async (body) => {
          try {
            const parsed = JSON.parse(body || "{}") as { entryId?: string; model?: string };
            const lib = readLibrary();
            const entry = lib.entries.find((e) => e.id === parsed.entryId);
            if (!entry) throw new Error(`条目不存在：${parsed.entryId || "(空id)"}`);
            // 有 http(s) 来源就服务端直抓原文（抓不到就让她自己 web_search 补料）
            let raw = "";
            if (entry.source && /^https?:\/\//i.test(entry.source)) {
              try {
                raw = await httpText(entry.source);
              } catch {
                // 原文抓不到：靠她联网补
              }
            }
            const model = typeof parsed.model === "string" && parsed.model ? parsed.model : undefined;
            // 讲义要联网补料，链长放宽（同搜集：等 285s）
            const r = await runLifeAgent(digestMessage(entry, raw.slice(0, 12000)), model, 285000);
            try {
              const d = cleanDigest(r.data);
              json(res, 200, { ok: true, ...d });
            } catch (e) {
              json(res, 500, {
                ok: false,
                error: "她没按契约写讲义：" + ((e as Error).message || r.error || (r.reply ?? "").slice(0, 200)),
              });
            }
          } catch (e) {
            json(res, 400, { error: (e as Error).message });
          }
        })
        .catch((e: Error) => {
          json(res, 500, { error: e.message });
        });
      return;
    }

    if (req.method === "POST" && route === "/library/digest/save") {
      readBody(req).then((body) => {
        try {
          const parsed = JSON.parse(body || "{}") as {
            entryId?: string;
            title?: string;
            digest?: string;
            schedule?: boolean;
          };
          const lib = readLibrary();
          const entry = lib.entries.find((e) => e.id === parsed.entryId);
          const d = cleanDigest({ title: parsed.title, digest: parsed.digest });
          // 1) 讲义存成学习资料（.study/materials，形状与上传资料一致，课表页资料库直接可见）
          const mid = `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
          const name = `${safeFilename(d.title)}.md`;
          const fileName = `${mid}-${name}`;
          const materialsDir = path.join(here, ".study", "materials");
          fs.mkdirSync(materialsDir, { recursive: true });
          const content = [
            `# ${d.title}`,
            "",
            `> 来源：内容库《${entry?.title ?? d.title}》${entry?.source ? ` · ${entry.source}` : ""} · ${todayStr()} 她消化成讲义`,
            "",
            d.digest,
            "",
          ].join("\n");
          fs.writeFileSync(path.join(materialsDir, fileName), content, "utf8");
          // 2) 登记 schedule.json：资料必挂；默认再排一节「读讲义」的课（明天起第一个空白天）
          const s = (readJsonAny(scheduleFile) ?? {}) as Record<string, unknown> & {
            materials?: Array<Record<string, unknown>>;
            courses?: Array<Record<string, unknown>>;
          };
          if (!Array.isArray(s.materials)) s.materials = [];
          if (!Array.isArray(s.courses)) s.courses = [];
          s.materials.push({ id: mid, name, file: fileName, size: Buffer.byteLength(content, "utf8"), addedAt: Date.now() });
          let courseId: string | null = null;
          if (parsed.schedule !== false) {
            courseId = `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
            s.courses.push({
              id: courseId,
              title: `读讲义：${d.title}`.slice(0, 120),
              date: nextFreeDayLife(s.courses as Array<{ date?: string }>),
              status: "planned",
              kind: "lesson",
              planId: "p-default",
              estMin: 40,
              materialIds: [mid],
              note: `内容库《${entry?.title ?? d.title}》消化成的讲义`,
              postponedCount: 0,
              quiz: { status: "none" },
            });
          }
          s.updatedAt = Date.now();
          writeJsonBak(scheduleFile, s);
          // 3) 条目标记已消化（内容库一眼看清哪些还没学）
          if (entry) {
            entry.digestedAt = Date.now();
            entry.digestMaterialId = mid;
            if (courseId) entry.digestCourseId = courseId;
            writeJsonBak(libraryFile, { ...lib, updatedAt: Date.now() });
          }
          json(res, 200, { ok: true, materialId: mid, courseId, materialName: name, library: readLibrary() });
        } catch (e) {
          json(res, 400, { error: (e as Error).message });
        }
      });
      return;
    }

    if (req.method === "POST" && route === "/library") {
      readBody(req).then((body) => {
        try {
          const parsed = JSON.parse(body || "{}") as {
            entry?: unknown;
            entries?: unknown[];
            addedBy?: string;
            goalId?: string;
          };
          const by: "rana" | "owner" = parsed.addedBy === "rana" ? "rana" : "owner";
          const incoming = Array.isArray(parsed.entries) ? parsed.entries : parsed.entry ? [parsed.entry] : [];
          if (!incoming.length) throw new Error("没有要存的条目");
          if (incoming.length > 8) throw new Error("一次最多入库 8 条");
          const lib = readLibrary();
          if (lib.entries.length >= 500) throw new Error("内容库满了（上限 500），清清旧的");
          const life = readLife();
          let goalId = "";
          if (parsed.goalId) {
            if (!life.goals.some((g) => g.id === parsed.goalId)) throw new Error("goalId 不存在");
            goalId = parsed.goalId;
          }
          for (const raw of incoming) {
            const core = entryCore(raw);
            lib.entries.unshift({
              id: newId("kb"),
              ...core,
              addedBy: by,
              ...(goalId ? { goalId } : {}),
              createdAt: Date.now(),
            });
          }
          writeJsonBak(libraryFile, { ...lib, updatedAt: Date.now() });
          json(res, 200, { ok: true, library: lib });
        } catch (e) {
          json(res, 400, { error: (e as Error).message });
        }
      });
      return;
    }

    if (req.method === "DELETE" && route === "/library") {
      const id = u.searchParams.get("id") ?? "";
      try {
        const lib = readLibrary();
        if (!lib.entries.some((e) => e.id === id)) throw new Error(`条目不存在：${id || "(空id)"}`);
        lib.entries = lib.entries.filter((e) => e.id !== id);
        writeJsonBak(libraryFile, { ...lib, updatedAt: Date.now() });
        json(res, 200, { ok: true, deleted: id });
      } catch (e) {
        json(res, 400, { error: (e as Error).message });
      }
      return;
    }

    json(res, 405, { error: "method not allowed" });
  };

  return {
    name: "rana-life",
    configureServer(server) {
      server.middlewares.use("/__rana/life", handler as Parameters<typeof server.middlewares.use>[1]);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/__rana/life", handler as Parameters<typeof server.middlewares.use>[1]);
    },
  };
}
