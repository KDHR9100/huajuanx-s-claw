@echo off
rem Rana Web 一键启动：gateway(18789) + vite(5173) + 打开聊天页面
rem 已在运行的服务自动跳过，可重复执行
setlocal
rem 1) gateway 未运行则启动（复用 start-gateway.cmd，含 TLS 兼容参数）
netstat -ano | findstr ":18789" | findstr "LISTENING" >nul 2>nul
if errorlevel 1 start "Rana gateway" /min cmd /c ""K:\openclaw\rana-web\start-gateway.cmd""
rem 2) vite dev 未运行则启动
netstat -ano | findstr ":5173" | findstr "LISTENING" >nul 2>nul
if errorlevel 1 start "Rana vite" /min cmd /c "cd /d K:\openclaw\rana-web && npm run dev"
rem 3) 等页面就绪（最长 60 秒）后用默认浏览器打开
powershell -NoProfile -Command "for($i=0;$i -lt 60;$i++){try{Invoke-WebRequest -Uri 'http://localhost:5173' -UseBasicParsing -TimeoutSec 2 | Out-Null; break}catch{Start-Sleep -Seconds 1}}; Start-Process 'http://localhost:5173'"
endlocal
