import fs from "node:fs";
import path from "node:path";
import { execFileP } from "../lib/exec";
import { RANA_WEB } from "../lib/paths";
import { json, readBody, isLoopback } from "../lib/http";
import type { Plugin } from "vite";

/**
 * 学习计划端点 v2（数据只存本地 .study/ 目录，已进 .gitignore 不入公开仓库）：
 * - GET    /__rana/study                  读课程表 schedule.json（v1 自动迁移 v2）
 * - POST   /__rana/study/save             保存 {courses?, plans?, contract?}（materials 由上传/删除端点管理）
 * - POST   /__rana/study/material?name=   上传学习资料（raw body ≤10MB）
 * - DELETE /__rana/study/material?id=     删除资料（挂着它的课自动解绑，课本身不动）
 * - POST   /__rana/study/plan             排课（Rana 按 study-planner skill 直接改 schedule.json）
 * - POST   /__rana/study/lesson-start    开始今天的课：{context:{history,schedule,materials,mistakes,reports,contract}, model?}
 *                                        勾什么附什么（信息直接写进指令，不让她读文件）；不带历史=一次性干净会话
 * - POST   /__rana/study/quiz-gen         出题：{courseId} | {mistakeIds:错题重考} | {planId, final:期末考}
 * - POST   /__rana/study/quiz-grade       判分；错题自动回收、错题重考自动销账、期末考成绩记到计划
 * - GET    /__rana/study/goals            读待办 goals.json（大方向学习目标，独立文件不与课程表互扰）
 * - POST   /__rana/study/goals            新增待办 {text}
 * - DELETE /__rana/study/goals?id=        删除待办（已排入的课程不受影响）
 * - POST   /__rana/study/goals/parse      大方向拆解（Rana 按 study-goal skill 只出方案，不写文件）
 * - POST   /__rana/study/goals/push       方案确认后写入课程表：生成课程 id、挂默认计划、过期日期自动顺延
 * 服务端还负责：done 课自动排复习课（+1/+7/+16 天）、连续打卡计算、打卡里程碑评语（异步）。
 */
export function ranaStudyMiddleware(): Plugin {
  const here = RANA_WEB;
  const studyDir = path.join(here, ".study");
  const scheduleFile = path.join(studyDir, "schedule.json");
  const goalsFile = path.join(studyDir, "goals.json");
  const materialsDir = path.join(studyDir, "materials");
  let agentBusy = false;

  interface StudyQuiz {
    status?: "none" | "pending" | "done";
    score?: number;
    comment?: string;
    at?: number;
  }
  interface StudyCourse {
    id: string;
    title: string;
    date: string;
    timeStart?: string;
    timeEnd?: string;
    status: "planned" | "done";
    kind?: "lesson" | "review";
    reviewOf?: string;
    reviewGap?: number;
    planId?: string;
    dependsOn?: string[];
    estMin?: number;
    materialIds?: string[];
    note?: string;
    postponedCount?: number;
    doneAt?: number;
    quiz?: StudyQuiz;
  }
  interface StudyMaterial {
    id: string;
    name: string;
    file: string;
    size: number;
    addedAt: number;
  }
  interface StudyPlan {
    id: string;
    name: string;
    createdAt: number;
    lastFinal?: { score: number; comment: string; at: number };
  }
  interface StudyMistake {
    id: string;
    courseId?: string;
    courseTitle: string;
    q: string;
    myAnswer: string;
    review?: string;
    addedAt: number;
    resolvedAt?: number;
  }
  interface StudyReport {
    id: string;
    kind: "weekly";
    title: string;
    text: string;
    at: number;
  }
  interface StudySchedule {
    version: number;
    plans: StudyPlan[];
    courses: StudyCourse[];
    materials: StudyMaterial[];
    mistakes: StudyMistake[];
    reports: StudyReport[];
    streak: { days: number; best: number; lastDay: string; comment?: string; commentDay?: string };
    contract?: { text: string; updatedAt: number };
    updatedAt: number;
  }
  /** 待办页：大方向学习目标。plan 是她拆解出的方案（未确认），push 后课程才进 schedule.json */
  interface GoalPlanCourse {
    title: string;
    date: string;
    timeStart?: string;
    timeEnd?: string;
    estMin?: number;
    note?: string;
  }
  interface StudyGoal {
    id: string;
    text: string;
    createdAt: number;
    status: "open" | "planned";
    plan?: { analysis: string; summary: string; courses: GoalPlanCourse[] } | null;
    pushedCourseIds?: string[];
    pushedAt?: number;
  }
  interface StudyGoalsFile {
    version: number;
    goals: StudyGoal[];
    updatedAt: number;
  }

  const DEFAULT_PLAN_ID = "p-default";
  /** 学完一节正课自动安排的复习间隔（天）：1 / 7 / 16 */
  const REVIEW_GAPS = [1, 7, 16];
  /** 打卡里程碑（连续天数），到了让她说一句 */
  const STREAK_MILESTONES = [3, 7, 14, 21, 30, 50, 100, 365];

  const pad2 = (n: number) => String(n).padStart(2, "0");
  const localDate = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const addDays = (ds: string, n: number) => {
    const [y, m, d] = ds.split("-").map(Number);
    return localDate(new Date(y, m - 1, d + n));
  };
  const todayStr = () => localDate(new Date());
  /** 从 from 的第二天起，找第一个当天没有任何课的日期（与页面顺延规则一致；测验不过重学用） */
  const nextFreeDay = (s: StudySchedule, from: string): string => {
    const taken = new Set(s.courses.map((c) => c.date));
    let d = addDays(from, 1);
    for (let i = 0; i < 400; i++) {
      if (!taken.has(d)) return d;
      d = addDays(d, 1);
    }
    return d;
  };

  const emptySchedule = (): StudySchedule => ({
    version: 2,
    plans: [{ id: DEFAULT_PLAN_ID, name: "默认计划", createdAt: Date.now() }],
    courses: [],
    materials: [],
    mistakes: [],
    reports: [],
    streak: { days: 0, best: 0, lastDay: "" },
    updatedAt: 0,
  });

  const readSchedule = (): StudySchedule => {
    try {
      const s = JSON.parse(fs.readFileSync(scheduleFile, "utf8")) as StudySchedule;
      // v1 → v2 迁移：补齐新字段，旧数据原样保留
      if (!Array.isArray(s.plans) || !s.plans.length) s.plans = emptySchedule().plans;
      if (!Array.isArray(s.courses)) s.courses = [];
      if (!Array.isArray(s.materials)) s.materials = [];
      if (!Array.isArray(s.mistakes)) s.mistakes = [];
      if (!Array.isArray(s.reports)) s.reports = [];
      if (!s.streak) s.streak = { days: 0, best: 0, lastDay: "" };
      s.version = 2;
      return s;
    } catch {
      return emptySchedule();
    }
  };

  const readGoals = (): StudyGoalsFile => {
    try {
      const g = JSON.parse(fs.readFileSync(goalsFile, "utf8")) as StudyGoalsFile;
      if (!Array.isArray(g.goals)) g.goals = [];
      g.version = 1;
      return g;
    } catch {
      return { version: 1, goals: [], updatedAt: 0 };
    }
  };

  const writeGoals = (g: StudyGoalsFile) => {
    fs.mkdirSync(studyDir, { recursive: true });
    try {
      fs.copyFileSync(goalsFile, goalsFile + ".bak");
    } catch {
      // 首次写入没有旧文件
    }
    g.updatedAt = Date.now();
    fs.writeFileSync(goalsFile, JSON.stringify(g, null, 2), "utf8");
  };

  /** 连续打卡：按 doneAt 的本地日期，从最近一天（今天或昨天）往前数连续有完成的天数 */
  const computeStreak = (s: StudySchedule) => {
    const days = new Set(
      s.courses.filter((c) => c.status === "done" && c.doneAt).map((c) => localDate(new Date(c.doneAt!))),
    );
    if (!days.size) {
      s.streak.days = 0;
      s.streak.lastDay = "";
      return;
    }
    const sorted = [...days].sort().reverse();
    let last = sorted[0];
    const t = todayStr();
    if (last !== t && last !== addDays(t, -1)) {
      // 最近一次完成既不是今天也不是昨天：断卡
      s.streak.days = 0;
      s.streak.lastDay = last;
      return;
    }
    let n = 1;
    while (days.has(addDays(last, -1))) {
      last = addDays(last, -1);
      n++;
    }
    s.streak.days = n;
    s.streak.lastDay = sorted[0];
    s.streak.best = Math.max(s.streak.best ?? 0, n);
  };

  const writeSchedule = (s: StudySchedule) => {
    // 写入前校验：materials[].file 一律纯文件名，脏数据就地拒绝（与 materialAbs 同一规则）
    for (const m of s.materials ?? []) {
      if (typeof m.file === "string" && (!m.file || /[\\/]|\.\./.test(m.file))) {
        throw new Error(`资料文件名非法，拒绝写入：${m.file}`);
      }
    }
    fs.mkdirSync(studyDir, { recursive: true });
    try {
      fs.copyFileSync(scheduleFile, scheduleFile + ".bak");
    } catch {
      // 首次写入没有旧文件
    }
    computeStreak(s);
    s.updatedAt = Date.now();
    fs.writeFileSync(scheduleFile, JSON.stringify(s, null, 2), "utf8");
  };

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const TIME_RE = /^\d{2}:\d{2}$/;

  /** 校验并规整页面提交的 courses：未知字段丢弃，坏行抛错（页面直接展示错误） */
  const cleanCourses = (input: unknown): StudyCourse[] => {
    if (!Array.isArray(input)) throw new Error("courses 需为数组");
    if (input.length > 2000) throw new Error("课程数超出上限（2000）");
    const ids = new Set<string>();
    return input.map((raw, i) => {
      const c = raw as Partial<StudyCourse>;
      if (!c || typeof c !== "object") throw new Error(`第 ${i + 1} 条课程格式不对`);
      const id = String(c.id ?? "");
      const title = String(c.title ?? "").trim();
      const date = String(c.date ?? "");
      if (!id || !title || !DATE_RE.test(date)) throw new Error(`第 ${i + 1} 条课程缺 id/标题，或日期不是 YYYY-MM-DD`);
      if (ids.has(id)) throw new Error(`课程 id 重复：${id}`);
      ids.add(id);
      const quizRaw = (c.quiz ?? {}) as StudyQuiz;
      const quiz: StudyQuiz = {
        status: quizRaw.status === "done" || quizRaw.status === "pending" ? quizRaw.status : "none",
        ...(typeof quizRaw.score === "number" ? { score: quizRaw.score } : {}),
        ...(typeof quizRaw.comment === "string" ? { comment: quizRaw.comment } : {}),
        ...(typeof quizRaw.at === "number" ? { at: quizRaw.at } : {}),
      };
      return {
        id,
        title,
        date,
        status: c.status === "done" ? "done" : "planned",
        ...(c.kind === "review" ? { kind: "review" as const } : { kind: "lesson" as const }),
        ...(typeof c.reviewOf === "string" ? { reviewOf: c.reviewOf } : {}),
        ...(typeof c.reviewGap === "number" ? { reviewGap: c.reviewGap } : {}),
        ...(typeof c.planId === "string" && c.planId ? { planId: c.planId } : { planId: DEFAULT_PLAN_ID }),
        ...(Array.isArray(c.dependsOn) && c.dependsOn.length ? { dependsOn: c.dependsOn.map(String) } : {}),
        ...(typeof c.estMin === "number" && c.estMin > 0 ? { estMin: Math.round(c.estMin) } : {}),
        ...(typeof c.timeStart === "string" && TIME_RE.test(c.timeStart) ? { timeStart: c.timeStart } : {}),
        ...(typeof c.timeEnd === "string" && TIME_RE.test(c.timeEnd) ? { timeEnd: c.timeEnd } : {}),
        ...(Array.isArray(c.materialIds) ? { materialIds: c.materialIds.map(String) } : {}),
        ...(typeof c.note === "string" ? { note: c.note } : {}),
        ...(typeof c.postponedCount === "number" ? { postponedCount: c.postponedCount } : {}),
        ...(typeof c.doneAt === "number" ? { doneAt: c.doneAt } : {}),
        quiz,
      };
    });
  };

  const cleanPlans = (input: unknown): StudyPlan[] => {
    if (!Array.isArray(input)) throw new Error("plans 需为数组");
    if (input.length > 20) throw new Error("计划数超出上限（20）");
    const out: StudyPlan[] = [];
    for (const raw of input) {
      const p = raw as Partial<StudyPlan>;
      const id = String(p.id ?? "");
      const name = String(p.name ?? "").trim().slice(0, 40);
      if (!id || !name) continue;
      if (out.some((x) => x.id === id)) continue;
      out.push({
        id,
        name,
        createdAt: typeof p.createdAt === "number" ? p.createdAt : Date.now(),
        ...(p.lastFinal && typeof p.lastFinal.score === "number"
          ? { lastFinal: { score: p.lastFinal.score, comment: String(p.lastFinal.comment ?? ""), at: p.lastFinal.at ?? Date.now() } }
          : {}),
      });
    }
    if (!out.some((p) => p.id === DEFAULT_PLAN_ID)) out.unshift({ id: DEFAULT_PLAN_ID, name: "默认计划", createdAt: Date.now() });
    return out;
  };

  /** Windows 文件名安全化：去掉非法字符与前导点，限长 */
  const safeFilename = (name: string): string => {
    const cut = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/^\.+/, "").trim().slice(0, 80);
    return cut || "material";
  };

  const materialAbs = (m: StudyMaterial) => {
    // fail-closed：file 字段只允许纯文件名（上传时 safeFilename 的产物）。
    // schedule.json 若被写坏（分隔符/..），宁可炸掉出题请求，也不能把 materialsDir
    // 之外的路径喂给 agent 的 read 工具。
    if (typeof m.file !== "string" || !m.file || /[\\/]|\.\./.test(m.file)) {
      throw new Error(`资料文件名非法：${String(m.file)}`);
    }
    const abs = path.join(materialsDir, m.file);
    // 二次防线（containment）：join 的结果必须仍落在 materialsDir 里面，双保险防穿越
    if (path.relative(materialsDir, abs).startsWith("..")) {
      throw new Error(`资料路径越界：${m.file}`);
    }
    return abs;
  };

  /** 唤醒 Rana：子进程跑 study-agent.mjs，解析它 stdout 的最后一行 JSON；model 可选（页面选的模型）
   *  opts.sessionKey/ephemeral：一次性干净会话模式；opts.tail：先从常驻会话摘最近 N 轮对话当背景 */
  const spawnAgent = async (
    message: string,
    model?: string,
    opts?: { sessionKey?: string; ephemeral?: boolean; tail?: number },
  ): Promise<{ ok: boolean; reply?: string; data?: Record<string, unknown>; error?: string }> => {
    // 请求侧来的 model/sessionKey 要进子进程参数：白名单字符集，拒绝一切路径/注入形状
    if (model && !/^[A-Za-z0-9:./_-]+$/.test(model)) throw new Error(`model 含非法字符`);
    if (opts?.sessionKey && !/^[A-Za-z0-9:_-]+$/.test(opts.sessionKey)) throw new Error(`sessionKey 含非法字符`);
    const args = [path.join(here, "study-agent.mjs"), "--message", message];
    if (model) args.push("--model", model);
    if (opts?.sessionKey) args.push("--session-key", opts.sessionKey);
    if (opts?.ephemeral) args.push("--ephemeral");
    if (opts?.tail) args.push("--tail", String(opts.tail));
    const { stdout } = await execFileP(process.execPath, args, {
      encoding: "utf8",
      timeout: 180000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    return JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
  };

  /** 互斥执行也带上会话参数（她一次只干一件事） */
  const runAgent = async (
    message: string,
    model?: string,
    opts?: { sessionKey?: string; ephemeral?: boolean; tail?: number },
  ) => {
    if (agentBusy) throw new Error("她正忙着上一个请求，等一下再试");
    agentBusy = true;
    try {
      return await spawnAgent(message, model, opts);
    } finally {
      agentBusy = false;
    }
  };

  /** 学完一节正课 → 自动排复习课（+1/+7/+16 天，已存在的不重复排） */
  const insertReviews = (s: StudySchedule, course: StudyCourse) => {
    if (course.kind === "review") return; // 复习课不再套娃
    const doneDay = course.doneAt ? localDate(new Date(course.doneAt)) : todayStr();
    for (const gap of REVIEW_GAPS) {
      const id = `rv-${course.id}-${gap}`;
      if (s.courses.some((c) => c.id === id)) continue;
      s.courses.push({
        id,
        title: `复习：${course.title}`,
        date: addDays(doneDay, gap),
        status: "planned",
        kind: "review",
        reviewOf: course.id,
        reviewGap: gap,
        planId: course.planId ?? DEFAULT_PLAN_ID,
        estMin: 30,
        ...(course.materialIds?.length ? { materialIds: [...course.materialIds] } : {}),
        quiz: { status: "none" },
      });
    }
  };

  /** 打卡里程碑：到了给一句她的评语（异步，不挡保存请求） */
  const fireStreakComment = () => {
    const s = readSchedule();
    if (!s.streak.days || !STREAK_MILESTONES.includes(s.streak.days)) return;
    if (s.streak.commentDay === todayStr()) return;
    const days = s.streak.days;
    void runAgent(
      [
        `【打卡评语·页面触发】用户刚把连续学习打卡打到了 ${days} 天。`,
        `给一句评语（就一句，保持你平时的说话风格：话少、直接，坚持这么久可以难得地夸一句，别肉麻）。`,
        '最后输出一个 ```json 代码块：{"comment":"评语"}',
      ].join("\n"),
    )
      .then((r) => {
        const comment = (r.data ?? {}).comment;
        if (typeof comment !== "string" || !comment) return;
        const fresh = readSchedule(); // 写回前重读，别覆盖这期间的改动
        if (fresh.streak.days === days && fresh.streak.commentDay !== todayStr()) {
          fresh.streak.comment = comment;
          fresh.streak.commentDay = todayStr();
          writeSchedule(fresh);
        }
      })
      .catch(() => {
        // 评语失败无所谓，打卡数照算
      });
  };

  /** 判分后回收错题（答错/半对的题），返回新增的错题 */
  const collectMistakes = (
    s: StudySchedule,
    courseTitle: string,
    courseId: string | undefined,
    questions: Array<{ idx: number; q: string }>,
    answers: Array<{ idx: number; answer: string }>,
    verdicts: Array<{ idx: number; correct: boolean | string; review?: string }>,
  ): StudyMistake[] => {
    const out: StudyMistake[] = [];
    for (const v of verdicts) {
      if (v.correct === true) continue;
      const q = questions.find((x) => x.idx === v.idx);
      const a = answers.find((x) => x.idx === v.idx);
      if (!q) continue;
      out.push({
        id: `mk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}-${v.idx}`,
        ...(courseId ? { courseId } : {}),
        courseTitle,
        q: q.q,
        myAnswer: a?.answer ?? "",
        review: v.review ?? "",
        addedAt: Date.now(),
      });
    }
    s.mistakes.push(...out);
    if (s.mistakes.length > 500) s.mistakes = s.mistakes.slice(-500); // 错题本封顶，太老的丢弃
    return out;
  };

  const matLines = (s: StudySchedule) =>
    s.materials.length
      ? s.materials.map((m) => `- ${m.id} ${m.name} → ${materialAbs(m)}`).join("\n")
      : "（资料库目前是空的：提醒用户先上传资料，或把资料发到聊天里。）";

  const courseMats = (course: StudyCourse, s: StudySchedule) => {
    const mats = (course.materialIds ?? [])
      .map((id) => s.materials.find((m) => m.id === id))
      .filter((m): m is StudyMaterial => Boolean(m));
    return mats.length
      ? mats.map((m) => `- ${m.name} → ${materialAbs(m)}`).join("\n")
      : "（这节课没挂资料，按课程标题和笔记出。）";
  };

  /** 「开始今天的课」勾选面板的上下文选项（页面传来的，默认值在页面侧） */
  interface LessonCtx {
    history: "none" | "tail5" | "all";
    schedule: boolean;
    materials: boolean;
    mistakes: boolean;
    reports: boolean;
    contract: boolean;
  }
  /** 按勾选项拼一条自给自足的上课指令：勾了什么附什么，并明确告诉她别再读文件 */
  const lessonMessage = (ctx: LessonCtx, s: StudySchedule): string => {
    const t = todayStr();
    const todays = s.courses.filter((c) => c.date === t && c.status === "planned");
    const parts: string[] = [
      `【开始今天的课·页面触发】今天是 ${t}。`,
      `今天待学的课（信息已经附在下面，不要再去读 schedule.json 或资料文件）：`,
      todays.length
        ? todays
            .map((c) => {
              const bits = [`- ${c.timeStart ? `${c.timeStart}${c.timeEnd ? `-${c.timeEnd}` : ""} ` : ""}${c.title}`];
              if (c.estMin) bits.push(`（预计 ${c.estMin} 分钟）`);
              if (c.note) bits.push(`备注：${c.note}`);
              const mats = (c.materialIds ?? []).map((id) => s.materials.find((m) => m.id === id)).filter(Boolean);
              if (mats.length) {
                // 勾了「带资料」才给路径，否则只给名字（她想读也读不到，省上下文）
                bits.push(
                  ctx.materials
                    ? `资料：${mats.map((m) => `${m!.name}（原文可读 ${materialAbs(m!)}）`).join("、")}`
                    : `资料：${mats.map((m) => m!.name).join("、")}`,
                );
              }
              if (c.kind === "review" && c.reviewOf) bits.push("（这是复习课）");
              return bits.join(" ");
            })
            .join("\n")
        : "（今天没有待学的课。如实说一句，别编课。）",
    ];
    if (ctx.schedule) {
      const lines = [...s.courses]
        .sort((a, b) => a.date.localeCompare(b.date) || (a.timeStart ?? "").localeCompare(b.timeStart ?? ""))
        .map((c) => `- ${c.date}${c.timeStart ? ` ${c.timeStart}` : ""} ${c.title}${c.status === "done" ? "（已学完）" : ""}`);
      parts.push(`课程表全貌（供参考）：\n${lines.join("\n")}`);
      parts.push(`连续打卡：${s.streak.days} 天（最好 ${s.streak.best}）`);
    }
    if (ctx.mistakes) {
      const open = s.mistakes.filter((m) => !m.resolvedAt);
      parts.push(
        open.length
          ? `未解决错题（讲课时顺带照顾一下）：\n${open.slice(-20).map((m) => `- ${m.courseTitle}：${m.q.slice(0, 120)}`).join("\n")}`
          : "错题本：没有未解决的错题。",
      );
    }
    if (ctx.reports && s.reports.length) {
      const latest = [...s.reports].sort((a, b) => b.at - a.at)[0];
      parts.push(`最近周报（${latest.title}）：${latest.text.slice(0, 600)}`);
    }
    if (ctx.contract && s.contract?.text) parts.push(`学习契约：${s.contract.text}`);
    parts.push(
      [
        "要求：按你平时的风格开场带这节课（话少、直接），把今天的课讲起来。",
        "这轮不需要改任何文件，也不要调用排课工具。",
      ].join("\n"),
    );
    return parts.join("\n");
  };

  /** 难度自适应的上下文：近期成绩 + 未解决错题 */
  const difficultyContext = (s: StudySchedule, planId: string) => {
    const recent = s.courses
      .filter((c) => (c.planId ?? DEFAULT_PLAN_ID) === planId && c.quiz?.status === "done")
      .sort((a, b) => (b.quiz?.at ?? 0) - (a.quiz?.at ?? 0))
      .slice(0, 6)
      .map((c) => `${c.title}=${c.quiz?.score}分`);
    const open = s.mistakes.filter((m) => !m.resolvedAt);
    return [
      recent.length ? `该计划近期测验：${recent.join("、")}` : "该计划还没有测验记录",
      open.length ? `未解决错题 ${open.length} 道，例如：${open.slice(0, 3).map((m) => `「${m.q.slice(0, 40)}」`).join("；")}` : "没有未解决错题",
      "出题时自适应：掌握好的点别出重复送分题；错过的、分数低的地方多出、出难一点。",
    ].join("\n");
  };

  const planMessage = (requirements: string) => {
    const s = readSchedule();
    return [
      "【学习排课·页面触发】用户在学习计划页面点了「让Rana排课」。",
      `用户要求：${requirements.trim() || "（没写具体要求。按资料情况合理排，拿不准的假设写进 summary 里说明。）"}`,
      `资料库（可用 read 工具读的绝对路径）：\n${matLines(s)}`,
      `课程表文件：${scheduleFile}（先 read 最新内容，改完写回；数据格式与规则见 study-planner skill）`,
      '按 study-planner skill 的流程处理（估时、超90分钟拆分、负荷均衡、依赖关系都按 skill 里的规则）。完成后回复的最后必须是一个 ```json 代码块：{"ok":true,"summary":"一两句话说明排了什么"}；失败则 {"ok":false,"summary":"原因"}。',
    ].join("\n\n");
  };

  /** 给她的现状摘要：未来 14 天课密度 + 逾期/打卡 + 资料库（拆解大方向时"结合他的情况"用） */
  const goalContext = (s: StudySchedule) => {
    const t = todayStr();
    const load: string[] = [];
    for (let i = 0; i < 14; i++) {
      const d = addDays(t, i);
      const n = s.courses.filter((c) => c.date === d && c.status === "planned").length;
      if (n) load.push(`${d}=${n}节`);
    }
    const overdue = s.courses.filter((c) => c.status === "planned" && c.date < t).length;
    return [
      `今天日期：${t}`,
      `未来 14 天已有课：${load.length ? load.join("、") : "全空"}`,
      `逾期未完成：${overdue} 节；连续打卡：${s.streak.days} 天（最佳 ${s.streak.best}）`,
      `进行中的计划：${s.plans.map((p) => p.name).join("、") || "无"}`,
      `资料库（可用 read 工具读的绝对路径）：\n${matLines(s)}`,
    ].join("\n");
  };

  /** 大方向拆解消息：她只出方案不改表，写入由页面确认后走 /goals/push */
  const goalParseMessage = (goal: StudyGoal) =>
    [
      "【待办拆解·页面触发】用户在待办页面写下了一个大方向学习目标，点了「让Rana拆解」。",
      `大方向原文：${goal.text}`,
      `他的现状：\n${goalContext(readSchedule())}`,
      "按 study-goal skill 拆解：结合他的现状把大方向拆成具体课程方案（只出方案，绝不改 schedule.json/goals.json）。",
      '回复的最后必须是一个 ```json 代码块：{"analysis":"两三句话：学什么、为什么这么拆、结合他现状的考虑","summary":"一句话方案","courses":[{"title":"具体课名","date":"YYYY-MM-DD","timeStart":"HH:MM","timeEnd":"HH:MM","estMin":60,"note":"这节课要掌握什么"}]}（timeStart/timeEnd/estMin/note 可选）。失败则 {"ok":false,"summary":"原因"}。',
    ].join("\n\n");

  /** 校验她拆解出的方案：标题+真实日期必须，字段收窄限长 */
  const cleanGoalPlan = (data: Record<string, unknown> | undefined): { analysis: string; summary: string; courses: GoalPlanCourse[] } => {
    if (!data) throw new Error("没解析到方案 JSON");
    const coursesRaw = Array.isArray(data.courses) ? data.courses : [];
    if (!coursesRaw.length) throw new Error(String(data.summary ?? "她说没法拆").slice(0, 200));
    if (coursesRaw.length > 60) throw new Error("一次拆超过 60 节，超出上限");
    const courses = coursesRaw.map((raw, i) => {
      const c = raw as Partial<GoalPlanCourse>;
      const title = String(c?.title ?? "").trim();
      const date = String(c?.date ?? "");
      if (!title || !DATE_RE.test(date)) throw new Error(`第 ${i + 1} 节课缺标题，或日期不是 YYYY-MM-DD`);
      return {
        title: title.slice(0, 120),
        date,
        ...(typeof c?.timeStart === "string" && TIME_RE.test(c.timeStart) ? { timeStart: c.timeStart } : {}),
        ...(typeof c?.timeEnd === "string" && TIME_RE.test(c.timeEnd) ? { timeEnd: c.timeEnd } : {}),
        ...(typeof c?.estMin === "number" && c.estMin > 0 ? { estMin: Math.round(c.estMin) } : {}),
        ...(typeof c?.note === "string" && c.note.trim() ? { note: c.note.trim().slice(0, 300) } : {}),
      };
    });
    return {
      analysis: String(data.analysis ?? "").slice(0, 1000),
      summary: String(data.summary ?? "").slice(0, 200),
      courses,
    };
  };

  const quizGenMessage = (course: StudyCourse, s: StudySchedule, requirements: string) =>
    [
      `【出题·页面触发】用户学完了课程「${course.title}」（${course.date}${course.kind === "review" ? "，这是复习课，题目要综合一点" : ""}），点了「出题测验」。`,
      `课程笔记：${course.note?.trim() || "无"}`,
      `关联资料（可用 read 工具读的绝对路径）：\n${courseMats(course, s)}`,
      `难度参考（自适应）：\n${difficultyContext(s, course.planId ?? DEFAULT_PLAN_ID)}`,
      `用户附加要求：${requirements.trim() || "无"}`,
      '按 study-quiz skill 出题。回复的最后必须是一个 ```json 代码块：{"questions":[{"idx":1,"type":"choice","q":"…","options":["…","…","…","…"]},{"idx":2,"type":"short","q":"…"}]}。题目里不要带答案。',
    ].join("\n\n");

  const drillMessage = (mistakes: StudyMistake[]) =>
    [
      "【出题·错题重考·页面触发】以下是用户之前的错题（含他当时的错误作答与点评）：",
      JSON.stringify(
        mistakes.map((m) => ({ id: m.id, 课程: m.courseTitle, 题: m.q, 他的答案: m.myAnswer, 当时点评: m.review ?? "" })),
        null,
        1,
      ),
      "针对这些薄弱点出 3~5 道新题：可以换角度、换题型问同一个点，别原题复读。",
      '回复的最后必须是一个 ```json 代码块：{"questions":[{"idx":1,"type":"choice","q":"…","options":[…],"targetMistake":"对应的错题id"}]}，每题标 targetMistake。',
    ].join("\n\n");

  const finalMessage = (plan: StudyPlan, s: StudySchedule) => {
    const cs = s.courses.filter((c) => (c.planId ?? DEFAULT_PLAN_ID) === plan.id);
    const mats = [...new Set(cs.flatMap((c) => c.materialIds ?? []))]
      .map((id) => s.materials.find((m) => m.id === id))
      .filter((m): m is StudyMaterial => Boolean(m));
    return [
      `【期末考·页面触发】用户要对计划「${plan.name}」发起期末考。`,
      `计划内课程：\n${cs.map((c) => `- ${c.title}（${c.status === "done" ? "已学完" : "未完成"}${c.quiz?.score != null ? `，测验${c.quiz.score}分` : ""}）`).join("\n") || "（还没有课程）"}`,
      `涉及资料（可用 read 工具读的绝对路径）：\n${mats.map((m) => `- ${m.name} → ${materialAbs(m)}`).join("\n") || "（无资料）"}`,
      `难度参考（自适应）：\n${difficultyContext(s, plan.id)}`,
      "按 study-quiz skill 的期末考模式：综合全部资料出 10 题混合大卷，覆盖面要全，错过的点重点考。",
      '回复的最后必须是一个 ```json 代码块：{"questions":[…]}（格式同学规出题）。',
    ].join("\n\n");
  };

  const quizGradeMessage = (courseTitle: string, matText: string, questions: unknown, answers: unknown, hint: string) =>
    [
      `【判题·页面触发】${courseTitle}，请判分。`,
      matText,
      `题目与用户作答（JSON）：\n${JSON.stringify({ questions, answers }, null, 1)}`,
      hint,
      '按 study-quiz skill 判题。回复的最后必须是一个 ```json 代码块：{"score":0到100的整数,"comment":"总评","verdicts":[{"idx":1,"correct":true,"review":"一句点评"}]}。',
    ].join("\n\n");





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
      json(res, 200, readSchedule());
      return;
    }
    if (req.method === "GET" && route === "/goals") {
      json(res, 200, readGoals());
      return;
    }
    if (!isLoopback(req)) {
      json(res, 403, { error: "仅本机可操作" });
      return;
    }

    if (req.method === "POST" && route === "/save") {
      readBody(req).then((body) => {
        try {
          const parsed = JSON.parse(body || "{}") as { courses?: unknown; plans?: unknown; contract?: { text?: string } };
          const s = readSchedule();
          const before = new Map(s.courses.map((c) => [c.id, c]));
          if (parsed.plans !== undefined) s.plans = cleanPlans(parsed.plans);
          if (parsed.courses !== undefined) s.courses = cleanCourses(parsed.courses);
          if (parsed.contract !== undefined) {
            const text = String(parsed.contract?.text ?? "").trim().slice(0, 500);
            s.contract = text ? { text, updatedAt: Date.now() } : undefined;
          }
          // 新学完的课：补 doneAt + 自动排复习课
          let reviewsAdded = 0;
          for (const c of s.courses) {
            if (c.status === "done" && !c.doneAt && !before.get(c.id)?.doneAt) {
              c.doneAt = Date.now();
              const n0 = s.courses.length;
              insertReviews(s, c);
              reviewsAdded += s.courses.length - n0;
            }
          }
          writeSchedule(s);
          fireStreakComment(); // 内部自判：到里程碑且今天没说过才让她说一句（异步，不挡保存）
          json(res, 200, { ok: true, reviewsAdded, updatedAt: s.updatedAt, streak: s.streak });
        } catch (e) {
          json(res, 400, { error: (e as Error).message });
        }
      });
      return;
    }

    if (req.method === "POST" && route === "/material") {
      const name = safeFilename(decodeURIComponent(u.searchParams.get("name") ?? "material"));
      const chunks: Buffer[] = [];
      let size = 0;
      let tooBig = false;
      req.on("data", (c?: string) => {
        size += c?.length ?? 0;
        if (size > 10 * 1024 * 1024) {
          tooBig = true;
          return;
        }
        chunks.push(Buffer.from(c ?? "", "binary"));
      });
      req.on("end", () => {
        if (tooBig) {
          json(res, 413, { error: "文件太大（限 10MB）" });
          return;
        }
        try {
          const s = readSchedule();
          const id = `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
          const file = `${id}-${name}`;
          fs.mkdirSync(materialsDir, { recursive: true });
          fs.writeFileSync(path.join(materialsDir, file), Buffer.concat(chunks));
          const material: StudyMaterial = { id, name, file, size, addedAt: Date.now() };
          s.materials.push(material);
          writeSchedule(s);
          json(res, 200, { ok: true, material });
        } catch (e) {
          json(res, 500, { error: (e as Error).message });
        }
      });
      return;
    }

    if (req.method === "DELETE" && route === "/material") {
      const id = u.searchParams.get("id") ?? "";
      try {
        const s = readSchedule();
        const m = s.materials.find((x) => x.id === id);
        if (!m) throw new Error(`资料不存在：${id || "(空id)"}`);
        // 课件更新是常态：删登记+文件，挂着它的课自动解绑（课本身不动）
        let unbound = 0;
        for (const c of s.courses) {
          if (!(c.materialIds ?? []).includes(id)) continue;
          const rest = c.materialIds!.filter((x) => x !== id);
          if (rest.length) c.materialIds = rest;
          else delete c.materialIds;
          unbound++;
        }
        s.materials = s.materials.filter((x) => x.id !== id);
        try {
          fs.rmSync(materialAbs(m));
        } catch {
          // 文件没了也不阻塞登记清理
        }
        writeSchedule(s);
        json(res, 200, { ok: true, deleted: id, unbound });
      } catch (e) {
        json(res, 400, { error: (e as Error).message });
      }
      return;
    }

    // ---- 待办（大方向学习目标）：goals.json 独立存档；parse 走她出方案，push 才写课程表 ----
    if (req.method === "POST" && route === "/goals") {
      readBody(req).then((body) => {
        try {
          const { text } = JSON.parse(body || "{}") as { text?: string };
          const t = String(text ?? "").trim();
          if (!t) throw new Error("写点什么再记");
          if (t.length > 500) throw new Error("大方向 500 字以内就行，细节让她拆的时候聊");
          const g = readGoals();
          if (g.goals.length >= 50) throw new Error("待办太多啦（上限 50），先清清已排的");
          const goal: StudyGoal = {
            id: `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
            text: t,
            createdAt: Date.now(),
            status: "open",
            plan: null,
            pushedCourseIds: [],
          };
          g.goals.unshift(goal);
          writeGoals(g);
          json(res, 200, { ok: true, goal, updatedAt: g.updatedAt });
        } catch (e) {
          json(res, 400, { error: (e as Error).message });
        }
      });
      return;
    }

    if (req.method === "DELETE" && route === "/goals") {
      const id = u.searchParams.get("id") ?? "";
      try {
        const g = readGoals();
        const hit = g.goals.find((x) => x.id === id);
        if (!hit) throw new Error(`待办不存在：${id || "(空id)"}`);
        g.goals = g.goals.filter((x) => x.id !== id);
        writeGoals(g);
        json(res, 200, { ok: true, deleted: id });
      } catch (e) {
        json(res, 400, { error: (e as Error).message });
      }
      return;
    }

    if (req.method === "POST" && route === "/goals/parse") {
      readBody(req)
        .then(async (body) => {
          const parsed = JSON.parse(body || "{}") as { goalId?: string; model?: string };
          const g = readGoals();
          const goal = g.goals.find((x) => x.id === parsed.goalId);
          if (!goal) {
            json(res, 400, { error: `待办不存在：${parsed.goalId || "(空id)"}` });
            return;
          }
          const model = typeof parsed.model === "string" && parsed.model ? parsed.model : undefined;
          const r = await runAgent(goalParseMessage(goal), model);
          try {
            goal.plan = cleanGoalPlan(r.data);
            goal.status = "open";
            writeGoals(g);
            json(res, 200, { ok: true, goal, updatedAt: g.updatedAt });
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

    if (req.method === "POST" && route === "/goals/push") {
      readBody(req).then((body) => {
        try {
          const { goalId } = JSON.parse(body || "{}") as { goalId?: string };
          const g = readGoals();
          const goal = g.goals.find((x) => x.id === goalId);
          if (!goal) throw new Error(`待办不存在：${goalId || "(空id)"}`);
          if (!goal.plan?.courses.length) throw new Error("这条待办还没有拆解方案，先「让Rana拆解」");
          const s = readSchedule();
          const t = todayStr();
          let shifted = 0;
          const added: StudyCourse[] = goal.plan.courses.map((c) => {
            let date = c.date;
            let note = c.note;
            if (date < t) {
              // 拆完放了几天日期过期了：挪到明天起第一个没课的日子，note 里留痕
              date = nextFreeDay(s, t);
              shifted++;
              note = [note, `（原定 ${c.date}，排入时已过期自动顺延）`].filter(Boolean).join(" ");
            }
            const course: StudyCourse = {
              id: `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
              title: c.title,
              date,
              status: "planned",
              kind: "lesson",
              planId: DEFAULT_PLAN_ID,
              ...(c.timeStart ? { timeStart: c.timeStart } : {}),
              ...(c.timeEnd ? { timeEnd: c.timeEnd } : {}),
              ...(c.estMin && c.estMin > 0 ? { estMin: c.estMin } : {}),
              ...(note ? { note } : {}),
              postponedCount: 0,
              quiz: { status: "none" },
            };
            s.courses.push(course);
            return course;
          });
          writeSchedule(s);
          goal.status = "planned";
          goal.pushedCourseIds = added.map((c) => c.id);
          goal.pushedAt = Date.now();
          writeGoals(g);
          json(res, 200, { ok: true, added: added.length, shifted, goals: g, updatedAt: s.updatedAt });
        } catch (e) {
          json(res, 400, { error: (e as Error).message });
        }
      });
      return;
    }

    if (req.method === "POST" && route === "/lesson-start") {
      readBody(req)
        .then(async (body) => {
          const parsed = JSON.parse(body || "{}") as { context?: Partial<LessonCtx>; model?: string };
          const c = parsed.context ?? {};
          const ctx: LessonCtx = {
            history: c.history === "none" || c.history === "all" ? c.history : "tail5",
            schedule: c.schedule !== false, // 默认带课表
            materials: c.materials === true, // 默认不带资料路径
            mistakes: c.mistakes === true,
            reports: c.reports === true,
            contract: c.contract === true,
          };
          const model = typeof parsed.model === "string" && parsed.model ? parsed.model : undefined;
          const message = lessonMessage(ctx, readSchedule());
          // 历史选项：none=一次性干净会话（用完即删）；tail5=一次性会话+摘常驻会话最近5轮；all=常驻会话（全量历史）
          const opts =
            ctx.history === "all"
              ? undefined
              : {
                  sessionKey: `agent:main:study-lesson-${Date.now().toString(36)}`,
                  ephemeral: true,
                  ...(ctx.history === "tail5" ? { tail: 5 } : {}),
                };
          const r = await runAgent(message, model, opts);
          json(res, r.ok ? 200 : 500, r.ok ? { ok: true, reply: r.reply ?? "" } : { ok: false, error: r.error ?? "她没回话" });
        })
        .catch((e) => json(res, 400, { error: (e as Error).message }));
      return;
    }

    if (req.method === "POST" && (route === "/plan" || route === "/quiz-gen" || route === "/quiz-grade")) {
      readBody(req)
        .then(async (body) => {
          const parsed = JSON.parse(body || "{}") as Record<string, unknown>;
          const model = typeof parsed.model === "string" && parsed.model ? parsed.model : undefined;

          if (route === "/plan") {
            const r = await runAgent(planMessage(String(parsed.requirements ?? "")), model);
            const d = (r.data ?? {}) as { ok?: boolean; summary?: string };
            const ok = r.ok && d.ok !== false;
            json(res, ok ? 200 : 500, {
              ok,
              summary: d.summary ?? (r.reply ?? r.error ?? "").slice(0, 300),
              schedule: readSchedule(),
            });
            return;
          }

          if (route === "/quiz-gen") {
            const s = readSchedule();
            // 三种出题：错题重考 > 期末考 > 普通课程
            if (Array.isArray(parsed.mistakeIds) && parsed.mistakeIds.length) {
              const mistakes = s.mistakes.filter(
                (m) => !m.resolvedAt && (parsed.mistakeIds as string[]).includes(m.id),
              );
              if (!mistakes.length) {
                json(res, 400, { error: "这些错题不存在或都已销账" });
                return;
              }
              const r = await runAgent(drillMessage(mistakes), model);
              const questions = (r.data ?? {}).questions;
              if (!r.ok || !Array.isArray(questions) || !questions.length) {
                json(res, 500, { ok: false, error: "她没按契约出题：" + (r.error ?? (r.reply ?? "").slice(0, 200)) });
                return;
              }
              json(res, 200, { ok: true, questions });
              return;
            }
            if (parsed.final === true && typeof parsed.planId === "string") {
              const plan = s.plans.find((p) => p.id === parsed.planId);
              if (!plan) {
                json(res, 400, { error: `计划不存在：${parsed.planId}` });
                return;
              }
              const r = await runAgent(finalMessage(plan, s), model);
              const questions = (r.data ?? {}).questions;
              if (!r.ok || !Array.isArray(questions) || !questions.length) {
                json(res, 500, { ok: false, error: "她没按契约出期末考卷：" + (r.error ?? (r.reply ?? "").slice(0, 200)) });
                return;
              }
              json(res, 200, { ok: true, questions });
              return;
            }
            const courseId = String(parsed.courseId ?? "");
            const course = s.courses.find((c) => c.id === courseId);
            if (!course) {
              json(res, 400, { error: `课程不存在：${courseId || "(空id)"}` });
              return;
            }
            const r = await runAgent(quizGenMessage(course, s, String(parsed.requirements ?? "")), model);
            const questions = (r.data ?? {}).questions;
            if (!r.ok || !Array.isArray(questions) || !questions.length) {
              json(res, 500, { ok: false, error: "她没按契约出题：" + (r.error ?? (r.reply ?? "").slice(0, 200)) });
              return;
            }
            json(res, 200, { ok: true, questions });
            return;
          }

          // quiz-grade：课程 / 错题重考 / 期末考三种
          const s = readSchedule();
          const questions = Array.isArray(parsed.questions) ? (parsed.questions as Array<Record<string, unknown>>) : [];
          const answers = Array.isArray(parsed.answers) ? (parsed.answers as Array<{ idx: number; answer: string }>) : [];
          let courseTitle = "测验";
          let matText = "（无资料）";
          let hint = "判分由页面写回课程表，你不要动 schedule.json。";

          const courseId = typeof parsed.courseId === "string" ? parsed.courseId : "";
          const course = courseId ? s.courses.find((c) => c.id === courseId) : undefined;
          let relearn = "";
          if (course) {
            courseTitle = `课程「${course.title}」的测验`;
            matText = `关联资料（判定有疑问时可 read 核对）：\n${courseMats(course, s)}`;
          } else if (parsed.drill === true) {
            courseTitle = "错题重考";
            hint = "这是错题重考：逐题判定。页面会按你的 verdict 把 targetMistake 对应的错题销账（全对才销），你不要动 schedule.json。";
          } else if (typeof parsed.forPlanId === "string") {
            const plan = s.plans.find((p) => p.id === parsed.forPlanId);
            courseTitle = `计划「${plan?.name ?? parsed.forPlanId}」的期末考`;
            hint = "这是期末考：判分严格一点，总评按整个计划的学习质量给。成绩由页面写回计划，你不要动 schedule.json。";
          }

          const r = await runAgent(quizGradeMessage(courseTitle, matText, questions, answers, hint), model);
          const d = (r.data ?? {}) as { score?: number; comment?: string; verdicts?: Array<{ idx: number; correct: boolean | string; review?: string }> };
          if (!r.ok || typeof d.score !== "number" || !Array.isArray(d.verdicts)) {
            json(res, 500, { ok: false, error: "她没按契约判分：" + (r.error ?? (r.reply ?? "").slice(0, 200)) });
            return;
          }

          // 错题回收（三种模式都收）
          const added = collectMistakes(s, course?.title ?? courseTitle, course?.id, questions as Array<{ idx: number; q: string }>, answers, d.verdicts);

          if (course) {
            course.quiz = { status: "done", score: d.score, comment: d.comment ?? "", at: Date.now() };
            // 测验不过（<60 分）不算学会：打回未学，自动顺延到后面的空位重学；
            // 清掉 doneAt 保打卡诚实（这节不算完成过），quiz 留着上次分数供页面标「上次 X 分」
            if (d.score < 60) {
              const relearnDate = nextFreeDay(s, todayStr());
              course.status = "planned";
              course.doneAt = undefined;
              course.date = relearnDate;
              course.postponedCount = (course.postponedCount ?? 0) + 1;
              course.quiz = { status: "pending", score: d.score, comment: d.comment ?? "", at: Date.now() };
              relearn = relearnDate;
            }
          } else if (parsed.drill === true) {
            // 错题重考销账：题目标了 targetMistake 且判全对 → 该错题 resolved
            for (const q of questions as Array<{ idx: number; targetMistake?: string }>) {
              const v = d.verdicts.find((x) => x.idx === q.idx);
              if (v?.correct === true && q.targetMistake) {
                const m = s.mistakes.find((x) => x.id === q.targetMistake && !x.resolvedAt);
                if (m) m.resolvedAt = Date.now();
              }
            }
          } else if (typeof parsed.forPlanId === "string") {
            const plan = s.plans.find((p) => p.id === parsed.forPlanId);
            if (plan) plan.lastFinal = { score: d.score, comment: d.comment ?? "", at: Date.now() };
          }
          writeSchedule(s);
          json(res, 200, { ok: true, verdict: d, mistakesAdded: added.length, relearn, schedule: s });
        })
        .catch((e: Error) => {
          json(res, 500, { error: e.message });
        });
      return;
    }

    json(res, 405, { error: "method not allowed" });
  };

  return {
    name: "rana-study",
    configureServer(server) {
      server.middlewares.use("/__rana/study", handler as Parameters<typeof server.middlewares.use>[1]);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/__rana/study", handler as Parameters<typeof server.middlewares.use>[1]);
    },
  };
}
