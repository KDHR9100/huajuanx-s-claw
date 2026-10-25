# 家里电脑状态探针(手动小工具,不注册任何自启)——迁移后云端状态页「🏠家里电脑」卡的数据源。
# 配置:同目录 home-probe.config.json({"url":"http://<云的Tailscale地址>:5173","token":"..."},gitignore,模板见 home-probe.config.example.json)
# 用法:单次上报  powershell -File home-probe.ps1
#       持续上报  powershell -File home-probe.ps1 -Loop   (每 60 秒一报,关窗口即停)
param([switch]$Loop)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$cfgPath = Join-Path $PSScriptRoot 'home-probe.config.json'
if (!(Test-Path $cfgPath)) {
  Write-Host "缺配置文件 $cfgPath —— 复制 home-probe.config.example.json 改名后填云端地址和 token"
  exit 1
}
$cfg = Get-Content $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (!$cfg.url -or !$cfg.token) { Write-Host "配置里 url/token 没填全"; exit 1 }

function Get-Report {
  # 采集逻辑与 rana-web/server/plugins/sys-status.ts 的 Windows 查询层同构(前端「家里」卡直接吃这个结构)
  $os = Get-CimInstance Win32_OperatingSystem
  $cpu = (Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average
  $disks = @(Get-Volume | Where-Object DriveLetter | ForEach-Object {
    [pscustomobject]@{ drive = [string]$_.DriveLetter; label = [string]$_.FileSystemLabel; sizeGB = [math]::Round($_.Size / 1GB); freeGB = [math]::Round($_.SizeRemaining / 1GB) }
  })
  $sys = @{
    disks        = $disks
    cpu          = $cpu
    memTotalGB   = [math]::Round($os.TotalVisibleMemorySize / 1MB, 1)
    memFreeGB    = [math]::Round($os.FreePhysicalMemory / 1MB, 1)
    uptimeHours  = [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalHours, 1)
  }

  $gpu = $null
  try {
    $smi = & nvidia-smi --query-gpu=name,memory.total,memory.used,temperature.gpu,utilization.gpu --format=csv,noheader,nounits 2>$null
    if ($LASTEXITCODE -eq 0 -and $smi) {
      $p = (($smi -split "`r?`n")[0] -split ',') | ForEach-Object { $_.Trim() }
      if ($p.Count -ge 5) {
        $gpu = @{ name = $p[0]; memTotalMB = [double]$p[1]; memUsedMB = [double]$p[2]; tempC = [double]$p[3]; utilPct = [double]$p[4] }
      }
    }
  } catch { $gpu = $null }

  $power = $null
  try {
    $guid = $null
    $active = (& powercfg /getactivescheme) -join ' '
    if ($active -match '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})') { $guid = $Matches[1] }
    $plans = @()
    foreach ($line in (& powercfg /list)) {
      if ($line -match '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*\*?\s*\(([^)]+)\)') {
        $plans += @{ guid = $Matches[1]; name = $Matches[2].Trim() }
      }
    }
    $power = @{ plans = $plans; activeGuid = $guid }
  } catch { $power = $null }

  @{ ts = [DateTimeOffset]::Now.ToUnixTimeMilliseconds(); sys = $sys; gpu = $gpu; power = $power }
}

function Send-Report {
  $r = Get-Report
  $json = $r | ConvertTo-Json -Depth 5 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  try {
    Invoke-RestMethod -Method Post -Uri ($cfg.url.TrimEnd('/') + '/__rana/sys/home-report') `
      -Headers @{ 'x-home-token' = $cfg.token } -ContentType 'application/json' -Body $bytes | Out-Null
    $memUsed = [math]::Round($r.sys.memTotalGB - $r.sys.memFreeGB, 1)
    Write-Host ("[{0}] 已上报云端:CPU {1}% / 内存 {2}GB(共{3}GB) / {4}" -f (Get-Date -Format 'HH:mm:ss'), $r.sys.cpu, $memUsed, $r.sys.memTotalGB, ($(if ($r.gpu) { $r.gpu.name } else { '无独显数据' })))
  } catch {
    Write-Host ("[{0}] 上报失败:{1}" -f (Get-Date -Format 'HH:mm:ss'), $_.Exception.Message)
  }
}

if ($Loop) {
  Write-Host "持续上报中(每 60 秒一次,Ctrl+C 或关窗口停止)……"
  while ($true) { Send-Report; Start-Sleep -Seconds 60 }
} else {
  Send-Report
}
