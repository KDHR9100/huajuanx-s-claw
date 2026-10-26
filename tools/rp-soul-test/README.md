# rp-soul-test — RP 人格回归测试

把 workspace 里的人格文件（默认 `IDENTITY.md / SOUL.md / USER.md`）拼成 system prompt，
把写死在脚本里的 15 条测试样本逐条发给智谱 GLM，输出带批注位的 Markdown 报告 + 原始 JSON。
只用 Python 标准库（3.10+），无第三方依赖，不接 OpenClaw 网关。

## 跑法（cmd）

```bat
cd /d K:\OpenClaw\tools\rp-soul-test
set ZHIPU_API_KEY=你的智谱key

rem 列出 15 条样本（不需要 key）
python rp_soul_test.py --list

rem 只拼 prompt 不调 API，看拼出来长什么样（不需要 key）
python rp_soul_test.py --dry-run

rem 核心 8 条（P0），默认模型
python rp_soul_test.py --profile p0 --out-dir reports/glm53

rem 核心 8 条，flash 档模型
python rp_soul_test.py --profile p0 --model glm-5.3-flash --out-dir reports/glm53flash

rem 全部 15 条
python rp_soul_test.py --profile full
```

## 输出

每跑一次在 `--out-dir`（默认 `reports`）下生成一对时间戳配对的文件：

- `report-YYYYMMDD-HHMMSS.md` — 逐条样本的回答，每条留了 `<!-- 批注： -->` 批注位
- `raw-YYYYMMDD-HHMMSS.json` — 原始数据；调用失败时 `error` 保留 HTTP 状态码和响应体原文（不截断），用来核对模型 ID 是否写对

## 常用参数

`--model`（默认 glm-5.3）、`--temperature`（默认 0.7）、`--concurrency`（默认 3）、
`--timeout`（默认 120 秒）、`--workspace / --files / --include`（换人格目录或追加文件用）。

key 只从环境变量 `ZHIPU_API_KEY`（或 `--api-key`）读，不写死在脚本里、不落盘、不进报告。

`reports/` 已在本目录 `.gitignore` 里——报告内容是 RP 回答（源自私有人格文件），
不会随 push-public.cmd 推到公开仓库；确要归档哪份就 `git add -f` 单独加。
