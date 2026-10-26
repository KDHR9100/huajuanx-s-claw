@echo off
rem 开机自动拉回云端记忆(迁移方案批5,#9 主人已批)。
rem 生效位置:启动文件夹的快捷方式指向本文件。想停用:Win+R 运行 shell:startup,删掉「Rana cloud-sync」即可。
rem 等 2 分钟让 Tailscale 连上网,再拉一次云端快照;日志在 rana-web\.health\startup-sync.log。
timeout /t 120 /nobreak >nul
"G:\node\node.exe" "K:\OpenClaw\tools\cloud-sync.mjs" >> "K:\OpenClaw\rana-web\.health\startup-sync.log" 2>&1
