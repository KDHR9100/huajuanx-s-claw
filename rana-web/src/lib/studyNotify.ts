// 学习计划·到点弹窗提醒：网页开着时，今天的课到了 timeStart 就发一条浏览器通知。
// 规则：只提醒「设了时段且未完成」的课；过点 15 分钟内补发，再晚不补；一天一课只弹一次（localStorage 记账）。
// 没设时段的课算"今天该学"，由页面常驻卡负责展示，不弹窗。

export interface NotifyCourse {
  id: string;
  title: string;
  date: string;
  timeStart?: string;
  timeEnd?: string;
  status: string;
}

const PREF_KEY = "study.notify.v1";
const FIRED_KEY = "study.notified.v1";
/** 过点多少分钟内仍补发 */
const WINDOW_MIN = 15;

export function getNotifyPref(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) === "on";
  } catch {
    return false;
  }
}
export function setNotifyPref(on: boolean) {
  try {
    localStorage.setItem(PREF_KEY, on ? "on" : "off");
  } catch {
    /* 隐私模式等存不进去就算了 */
  }
}

/** 申请浏览器通知权限；返回最终权限（"unsupported"=浏览器不支持通知） */
export async function requestNotifyPermission(): Promise<string> {
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission === "granted") return "granted";
  try {
    return await Notification.requestPermission();
  } catch {
    return "denied";
  }
}

export function notifyPermission(): string {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};
const nowHM = () => {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

function addMin(hm: string, n: number): string {
  const [h, m] = hm.split(":").map(Number);
  const total = h * 60 + m + n;
  return `${pad2(Math.floor(total / 60) % 24)}:${pad2(total % 60)}`;
}

/** 该弹的课（纯逻辑）：今天 + planned + 有 timeStart + 进入 [timeStart, +15min] 窗口 + 今天没弹过 */
export function dueForNotify(courses: NotifyCourse[], nowDate: string, hm: string, firedIds: string[]): NotifyCourse[] {
  return courses.filter(
    (c) =>
      c.date === nowDate &&
      c.status === "planned" &&
      Boolean(c.timeStart) &&
      c.timeStart! <= hm &&
      hm <= addMin(c.timeStart!, WINDOW_MIN) &&
      !firedIds.includes(c.id),
  );
}

function readFired(date: string): string[] {
  try {
    const m = JSON.parse(localStorage.getItem(FIRED_KEY) ?? "{}") as Record<string, string[]>;
    return Array.isArray(m[date]) ? m[date] : [];
  } catch {
    return [];
  }
}
function writeFired(date: string, ids: string[]) {
  try {
    // 只保留今天的记账，昨天的自然清掉
    localStorage.setItem(FIRED_KEY, JSON.stringify({ [date]: ids }));
  } catch {
    /* 存不进去下次可能重弹一次，可接受 */
  }
}

/**
 * 启动提醒引擎（挂在 App 根部，开哪个页面都有效）：
 * 每 30 秒读一次课程表，到点的课发通知；权限没给/开关没开时静默空转。
 * 到点时顺手查一下电脑状态（/__rana/sys/status 有 8 秒缓存）：
 * 显卡还在高负载（大概率在打游戏/跑本地模型）就换个口吻提醒。
 * 用法：useEffect(() => startStudyNotifier(), [])；返回值即 effect 清理函数。
 */
export function startStudyNotifier(): () => void {
  /** 查显卡是否在忙（状态接口挂了就当不忙，不影响正常提醒） */
  const gpuBusy = async (): Promise<string | null> => {
    try {
      const r = await fetch("/__rana/sys/status");
      if (!r.ok) return null;
      const j = (await r.json()) as { gpu?: { utilPct?: number; memUsedMB?: number } | null };
      const g = j.gpu;
      if (g && typeof g.utilPct === "number" && g.utilPct >= 50) {
        return g.utilPct >= 85 ? "显卡满负荷跑着呢——游戏先存个档吧。" : "显卡还在忙（可能是游戏）。该收心了。";
      }
      return null;
    } catch {
      return null;
    }
  };

  const tick = async () => {
    if (!getNotifyPref() || typeof Notification === "undefined" || Notification.permission !== "granted") return;
    try {
      const r = await fetch("/__rana/study");
      if (!r.ok) return;
      const s = (await r.json()) as { courses?: NotifyCourse[] };
      const date = todayStr();
      const fired = readFired(date);
      const due = dueForNotify(s.courses ?? [], date, nowHM(), fired);
      if (!due.length) return;
      const busy = await gpuBusy();
      for (const c of due) {
        const n = new Notification(`该学习了 · ${c.title}`, {
          body: busy
            ? `${c.timeStart}${c.timeEnd ? ` ~ ${c.timeEnd}` : ""} 这节课到点了。${busy}`
            : `${c.timeStart}${c.timeEnd ? ` ~ ${c.timeEnd}` : ""} 这节课到点了`,
          tag: c.id, // 同一节课重复发会被浏览器去重合并
        });
        n.onclick = () => {
          window.focus();
          n.close();
        };
        fired.push(c.id);
      }
      writeFired(date, fired);
    } catch {
      // 读表失败（dev server 重启中等）就等下一轮
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), 30000);
  return () => clearInterval(timer);
}
