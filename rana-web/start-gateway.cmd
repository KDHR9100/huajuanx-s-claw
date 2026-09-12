@echo off
rem Rana/OpenClaw gateway launcher wrapper.
rem Uses --tls-max-v1.2 flag (not NODE_OPTIONS) so respawned children inherit it.
rem Kept after the provider switch to dashscope; harmless there, still avoids
rem any TLS 1.3 post-quantum ClientHello issues on other endpoints.
set "OPENCLAW_STATE_DIR=K:\openclaw\.openclaw\.openclaw"

rem embedding 看门狗：锁死 LM Studio 里 qwen3-embedding 恒定一份、纯 CPU 常驻。
rem 已有实例在跑时会因端口锁自动退出，不怕网关重启造成多开。日志见 %TEMP%\openclaw\embedding-watchdog.log
start "" /B "G:\node\node.exe" "K:\OpenClaw\tools\embedding-watchdog.mjs"

"G:\node\node.exe" --tls-max-v1.2 "C:\Users\Administrator\AppData\Roaming\npm\node_modules\openclaw\openclaw.mjs" gateway
