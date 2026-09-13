// DshPage：🔨 派活——把编码重活委派给 DSH（WSL 里的 DeepSeek 工人，经 acpx/ACP 协议）。
// 表单组装一条结构化委派指令发进 main 主会话，Rana 按 delegate-to-dsh 技能派后台任务；
// 进度与结果在「会话」页聊天流里看（完成后 announce 回报）。
import { useState } from "react";
import { gateway } from "../lib/gateway";

const PRESETS: Array<{ name: string; cwd: string }> = [
  { name: "Aetheran（NPC 游戏 AI）", cwd: "K:/Aetheran" },
  { name: "Agent_feishu（飞书电商 Agent）", cwd: "K:/home/<user>/Agent_feishu" },
  { name: "OpenClaw 仓库", cwd: "K:/OpenClaw" },
];

export default function DshPage() {
  const [cwd, setCwd] = useState(PRESETS[0].cwd);
  const [task, setTask] = useState("");
  const [accept, setAccept] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const send = async () => {
    const t = task.trim();
    if (!t || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    const lines = [
      "[DSH委派]",
      `cwd：${cwd.trim() || PRESETS[0].cwd}`,
      `任务：${t}`,
      accept.trim() ? `验收：${accept.trim()}` : "验收：完成后自测并说明验了什么。",
      "请按 delegate-to-dsh 技能派给 DSH 执行；开工前先确认 WSL 可用与 git 状态，完成后用大白话汇报改了哪、验了什么。",
    ].join("\n");
    try {
      await gateway.sendChat("agent:main:main", lines);
      setTask("");
      setAccept("");
      setNotice("已发进会话——Rana 会先检查 WSL 与 git 状态再派活。进度和结果去「💬 会话」页看。");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wallboard">
      <div className="board-inner" style={{ maxWidth: 720 }}>
        <div className="page-intro">
          <h2>派活给 DSH</h2>
          <p>编码重活交给 WSL 里的 DeepSeek 工人，算力走云端、不占你的显卡。</p>
        </div>

        <div className="card">
          <h3><span className="ic">🔨</span> 新任务 <small>经 acpx · ACP 协议</small></h3>
          <div className="field-row">
            <label>项目 / 工作目录</label>
            <select value={cwd} onChange={(e) => setCwd(e.target.value)}>
              {PRESETS.map((p) => (
                <option key={p.cwd} value={p.cwd}>{p.name}</option>
              ))}
            </select>
          </div>
          {cwd === PRESETS[PRESETS.length - 1].cwd && (
            <div className="field-row">
              <label>自定义路径</label>
              <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="K:/项目目录" />
            </div>
          )}
          <div className="field-row">
            <label>要做什么</label>
            <textarea
              value={task}
              onChange={(e) => setTask(e.target.value)}
              rows={5}
              placeholder="例：给灰石村十人 profiles 加一套季节台词，改完跑 test_soul_hash_guard.py"
            />
          </div>
          <div className="field-row">
            <label>验收标准（可选）</label>
            <input
              value={accept}
              onChange={(e) => setAccept(e.target.value)}
              placeholder="例：pytest 全绿 + 基线哈希不变"
            />
          </div>
          <div className="dsh-actions">
            <button className="btn" onClick={() => void send()} disabled={busy || !task.trim()}>
              {busy ? "派单中…" : "派出去"}
            </button>
            {notice && <span className="dsh-ok">{notice}</span>}
            {error && <span className="sys-err">派单失败：{error}</span>}
          </div>
        </div>

        <div className="card">
          <h3><span className="ic">📌</span> 委派守则</h3>
          <ul className="dsh-notes">
            <li>派活前 Rana 会先确认 WSL 可用——虚拟化没开（WSL 起不来）时单子会被退回，先去开虚拟化。</li>
            <li>DSH 的 API key 只在 WSL 仓库 .env 里，界面和配置文件都碰不到它。</li>
            <li>她只干活不碰显存：LM Studio 本地端点在红线里，永远不会被指过去。</li>
            <li>想直接聊着派也行：会话里 <code>/acp spawn dsh --mode oneshot --bind here --cwd 目录</code>。</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
