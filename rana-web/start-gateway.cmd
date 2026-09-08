@echo off
rem Rana/OpenClaw gateway launcher wrapper.
rem Uses --tls-max-v1.2 flag (not NODE_OPTIONS) so respawned children inherit it.
rem Kept after the provider switch to dashscope; harmless there, still avoids
rem any TLS 1.3 post-quantum ClientHello issues on other endpoints.
set "OPENCLAW_STATE_DIR=K:\openclaw\.openclaw\.openclaw"
"G:\node\node.exe" --tls-max-v1.2 "C:\Users\Administrator\AppData\Roaming\npm\node_modules\openclaw\openclaw.mjs" gateway
