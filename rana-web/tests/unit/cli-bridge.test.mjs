// cli-bridge.mjs 测试：解析策略 / runCli 超时与输出看门 / createAgentBridge 互斥与尾行解析 / 定位纯函数。
// 零会话副作用纪律：子进程只用 node -e / 系统临时目录里的沙盒脚本，绝不跑 openclaw CLI、绝不连网关。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  PARSE,
  DEFAULT_WAIT_MS,
  MAX_OUTPUT_BYTES,
  STATE_HOME,
  resolveStateHome,
  resolveOpenclawMjs,
  createAgentBridge,
  runCli,
  spawnCli,
  execFileP,
} from "../../lib/cli-bridge.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// —— 临时沙盒（假边车：干完活输出一行 JSON，模拟 study/fate/life 边车契约） ——
let sandboxDir;
beforeAll(() => {
  sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-bridge-test-"));
  fs.writeFileSync(
    path.join(sandboxDir, "sleepy.mjs"),
    'const wait = Number(process.argv[2] ?? 0);\n' +
    'setTimeout(() => { console.log(JSON.stringify({ ok: true, reply: "hi" })); }, wait);\n',
  );
  fs.writeFileSync(
    path.join(sandboxDir, "noisy.mjs"),
    'console.log("日志行，不是 JSON");\n' +
    'console.log(JSON.stringify({ ok: true, reply: "tail" }));\n',
  );
});
afterAll(() => { fs.rmSync(sandboxDir, { recursive: true, force: true }); });

describe("PARSE.firstToLastJson（qq-sidecar runner 口径）", () => {
  it("纯 JSON 一把过", () => {
    expect(PARSE.firstToLastJson('{"status":"ok","runId":7}')).toEqual({ status: "ok", runId: 7 });
  });
  it("BOM 与首尾空白剥掉后裸 parse", () => {
    expect(PARSE.firstToLastJson('\uFEFF  {"a":1}  ')).toEqual({ a: 1 });
  });
  it("夹日志时兜底抓第一个 { 到最后一个 }", () => {
    expect(PARSE.firstToLastJson('[boot] loading\n{"a":{"b":2}}\n[done]')).toEqual({ a: { b: 2 } });
  });
  it("无大括号回 null", () => {
    expect(PARSE.firstToLastJson("no json here")).toBe(null);
  });
  it("有大括号但坏 JSON 也回 null", () => {
    expect(PARSE.firstToLastJson("{oops")).toBe(null);
  });
});

describe("PARSE.lastLineJson（agent-session-bridge 三桥口径）", () => {
  it("多行 stdout 只取最后一行 JSON", () => {
    expect(PARSE.lastLineJson("噪声行\n{\"ok\":true}")).toEqual({ ok: true });
  });
  it("空串直接抛（与原行为一致，坏输出要炸得响）", () => {
    expect(() => PARSE.lastLineJson("")).toThrow();
  });
});

describe("PARSE.indexOfSliceJson / bareJson / rawText（批2 口径预置）", () => {
  it("indexOf 截取：从第一个 { 截到末尾", () => {
    expect(PARSE.indexOfSliceJson('前缀 {"a":1}')).toEqual({ a: 1 });
    expect(() => PARSE.indexOfSliceJson("没有花括号")).toThrow();
  });
  it("裸 parse：原样 JSON.parse", () => {
    expect(PARSE.bareJson('{"x":2}')).toEqual({ x: 2 });
    expect(() => PARSE.bareJson("nope")).toThrow();
  });
  it("原文返回：stdout+stderr 拼接去首尾空白（approvals 口径）", () => {
    expect(PARSE.rawText("ignored", { stdout: " out ", stderr: " err " })).toBe("out  err");
  });
});

describe("runCli 执行层", () => {
  it("正常收尾：code/stdout/parse/timedOut（command 缺省 = process.execPath）", async () => {
    const r = await runCli({ args: ["-e", "console.log(JSON.stringify({ok:true}))"], parse: PARSE.bareJson });
    expect(r.code).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.parsed).toEqual({ ok: true });
  });
  it("硬超时：到点 kill → timedOut=true，错误话术留给调用方", async () => {
    const r = await runCli({ args: ["-e", "setInterval(() => {}, 1000)"], hardTimeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.parsed).toBe(null);
  });
  it("stdout 超限看门：超限即 kill（qq-sidecar 4MB 看门的等价注入）", async () => {
    const r = await runCli({ args: ["-e", "console.log('x'.repeat(200000))"], maxOutputBytes: 1000 });
    expect(r.stdout.length).toBeGreaterThan(1000);
    expect(r.code).not.toBe(0);
  });
  it("stderr 捕获与非零退出码", async () => {
    const r = await runCli({ args: ["-e", "console.error('boom'); process.exit(3)"] });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("boom");
  });
  it("spawn 失败：error 事件 → reject（同原骨架）", async () => {
    await expect(runCli({ command: "no-such-cmd-for-cli-bridge-test-xyz", args: [] })).rejects.toThrow();
  });
});

describe("spawnCli 低层（memory-bridge detached 触发的原样复刻）", () => {
  it("detached + stdio ignore + unref：返回 ChildProcess 并自然退出", async () => {
    const child = spawnCli({ args: ["-e", "process.exit(0)"], stdio: "ignore", detached: true, unref: true });
    expect(typeof child.pid).toBe("number");
    await new Promise((resolve) => child.on("exit", resolve));
  });
});

describe("createAgentBridge（互斥 + 尾行解析 + 超时，fate/life/study 三桥口径）", () => {
  it("互斥：忙时第二个 run 抛固定话术，第一个照常返回", async () => {
    const bridge = createAgentBridge(path.join(sandboxDir, "sleepy.mjs"), 8000);
    const p1 = bridge.run(["300"]);
    await expect(bridge.run(["0"])).rejects.toThrow("她正忙着上一个请求，等一下再试");
    await expect(p1).resolves.toEqual({ ok: true, reply: "hi" });
  });
  it("spawn 免互斥：busy 期间直跑不受限", async () => {
    const bridge = createAgentBridge(path.join(sandboxDir, "sleepy.mjs"), 8000);
    const p1 = bridge.spawn(["300"]);
    await expect(bridge.spawn(["0"])).resolves.toEqual({ ok: true, reply: "hi" });
    await expect(p1).resolves.toEqual({ ok: true, reply: "hi" });
  });
  it("尾行解析：先打日志再输出 JSON，取最后一行", async () => {
    const bridge = createAgentBridge(path.join(sandboxDir, "noisy.mjs"), 8000);
    await expect(bridge.run([])).resolves.toEqual({ ok: true, reply: "tail" });
  });
  it("默认超时：execFile 到点杀，run 拒绝", async () => {
    const bridge = createAgentBridge(path.join(sandboxDir, "sleepy.mjs"), 300);
    await expect(bridge.run(["5000"])).rejects.toThrow();
  });
});

describe("定位纯函数与常量", () => {
  it("resolveStateHome：env OPENCLAW_STATE_DIR 优先", () => {
    const prev = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = "X:/tmp-state-probe";
    try {
      expect(resolveStateHome()).toBe(path.resolve("X:/tmp-state-probe"));
    } finally {
      if (prev === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = prev;
    }
  });
  it("resolveStateHome：env 缺省回退仓库内布局（lib/ 上两级）", () => {
    const prev = process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_STATE_DIR;
    try {
      // 本测试文件在 rana-web/tests/unit/，仓库根是上三级；桥的回退相对 rana-web/lib/ 上两级，两者同根
      const expected = path.resolve(HERE, "../../../.openclaw/.openclaw");
      expect(resolveStateHome()).toBe(path.resolve(expected));
    } finally {
      if (prev !== undefined) process.env.OPENCLAW_STATE_DIR = prev;
    }
  });
  it("resolveOpenclawMjs：env OPENCLAW_MJS 优先，且每进程只探一次（缓存）", () => {
    const prev = process.env.OPENCLAW_MJS;
    process.env.OPENCLAW_MJS = "X:/custom/openclaw.mjs";
    try {
      expect(resolveOpenclawMjs()).toBe("X:/custom/openclaw.mjs");
      delete process.env.OPENCLAW_MJS;
      expect(resolveOpenclawMjs()).toBe("X:/custom/openclaw.mjs");
    } finally {
      if (prev === undefined) delete process.env.OPENCLAW_MJS;
      else process.env.OPENCLAW_MJS = prev;
    }
  });
  it("常量集中：DEFAULT_WAIT_MS=165000 / MAX_OUTPUT_BYTES=4MB / STATE_HOME 同 resolveStateHome()", () => {
    expect(DEFAULT_WAIT_MS).toBe(165000);
    expect(MAX_OUTPUT_BYTES).toBe(4 * 1024 * 1024);
    expect(STATE_HOME).toBe(resolveStateHome());
  });
});

describe("execFileP（批2 插件侧执行件，错误形状进 API 响应必须保形）", () => {
  it("成功：resolve {stdout, stderr}（utf8 字符串）", async () => {
    const r = await execFileP(process.execPath, ["-e", "console.log('ok-out'); console.error('ok-err');"], { encoding: "utf8" });
    expect(r.stdout.trim()).toBe("ok-out");
    expect(r.stderr.trim()).toBe("ok-err");
  });
  it("非零退出：message 以 'Command failed: ' 开头并含 stderr，code/挂属性与 execFile 原生一致", async () => {
    let err;
    try {
      await execFileP(process.execPath, ["-e", "console.error('boom-line'); process.exit(3);"], { encoding: "utf8" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy();
    expect(err.message.startsWith("Command failed: ")).toBe(true);
    expect(err.message).toContain("boom-line");
    expect(err.code).toBe(3);
    expect(err.stderr).toContain("boom-line");
    expect(err.killed).toBe(false);
  });
  it("超时：killed=true + signal SIGTERM + message 同形状（agent-info 20s / approvals 25s 口径）", async () => {
    let err;
    try {
      await execFileP(process.execPath, ["-e", "setTimeout(() => {}, 60000);"], { encoding: "utf8", timeout: 300 });
    } catch (e) {
      err = e;
    }
    expect(err.killed).toBe(true);
    expect(err.signal).toBe("SIGTERM");
    expect(err.message.startsWith("Command failed: ")).toBe(true);
  });
  it("缺省 encoding（execFile 默认 utf8）：stdout/stderr 为字符串（cron-session-cleanup 自建版同口径）", async () => {
    const r = await execFileP(process.execPath, ["-e", "console.log('plain');"], { windowsHide: true });
    expect(typeof r.stdout).toBe("string");
    expect(r.stdout.trim()).toBe("plain");
  });
});

describe("runCli stdio 直通（git-activity-cron 推送口径）", () => {
  it("stdio 'inherit'：code 原样回传，收集器跳过（stdout 空）", async () => {
    const r = await runCli({ args: ["-e", "process.exit(0)"], stdio: ["ignore", "inherit", "inherit"] });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });
});
