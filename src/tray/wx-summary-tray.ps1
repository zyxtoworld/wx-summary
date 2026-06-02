$ErrorActionPreference = 'Stop'

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$DataDir = Join-Path $ProjectRoot 'data'
$TmpDir = Join-Path $ProjectRoot 'outputs\.tmp'
$RuntimeFile = Join-Path $TmpDir 'server.json'
$LauncherEvidenceFile = Join-Path $DataDir 'launcher-weixin-binary.json'
$StdoutLog = Join-Path $TmpDir 'tray-node.out.log'
$StderrLog = Join-Path $TmpDir 'tray-node.err.log'
$NodeProcess = $null
$TrayMutex = $null
$ServerUrl = 'http://127.0.0.1:7788'
$ExitingByTray = $false
$OpenedOnReady = $false
$ReadyTicks = 0

function Utf8Label {
  param([string]$Base64)
  [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Base64))
}

function Show-StartupError {
  param([string]$Message)
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show($Message, (Utf8Label 'd3gtc3VtbWFyeSDlkK/liqjlpLHotKU='), 'OK', 'Error') | Out-Null
}

function Read-ServerUrl {
  if (-not (Test-Path $RuntimeFile)) { return $ServerUrl }
  try {
    $info = Get-Content -LiteralPath $RuntimeFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($NodeProcess -and $info.pid -and ([int]$info.pid) -ne $NodeProcess.Id) { return $ServerUrl }
    if ($info.url) { return [string]$info.url }
  } catch {}
  return $ServerUrl
}

function Open-Web {
  $script:ServerUrl = Read-ServerUrl
  try {
    Start-Process -FilePath 'rundll32.exe' -ArgumentList @('url.dll,FileProtocolHandler', $script:ServerUrl) | Out-Null
  } catch {
    Start-Process $script:ServerUrl | Out-Null
  }
}

function Try-AttachExistingServer {
  if (-not (Test-Path $RuntimeFile)) { return $null }
  try {
    $info = Get-Content -LiteralPath $RuntimeFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $info.pid -or -not $info.url) { return $null }

    $existingPid = [int]$info.pid
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $existingPid" -ErrorAction SilentlyContinue
    if (-not $processInfo) { return $null }
    if ([string]$processInfo.CommandLine -notmatch 'src[\\/]main\.js') { return $null }

    $response = Invoke-WebRequest -Uri ([string]$info.url) -UseBasicParsing -TimeoutSec 2
    if ($response.StatusCode -lt 200 -or $response.StatusCode -ge 500) { return $null }

    return Get-Process -Id $existingPid -ErrorAction Stop
  } catch {
    return $null
  }
}

function Get-Sha256Hex {
  param([string]$Path)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $bytes = $sha.ComputeHash($stream)
  } finally {
    $stream.Dispose()
    $sha.Dispose()
  }
  return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Write-LauncherWeixinEvidence {
  try {
    New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
    $capturedAt = (Get-Date).ToUniversalTime().ToString('o')
    $processes = @(Get-CimInstance Win32_Process -Filter "name = 'Weixin.exe'" -ErrorAction SilentlyContinue)
    $main = $processes |
      Where-Object { $_.ExecutablePath -and $_.CommandLine -match 'Weixin\.exe' -and $_.CommandLine -notmatch '--type=' } |
      Select-Object -First 1
    if (-not $main) {
      $main = $processes | Where-Object { $_.ExecutablePath } | Select-Object -First 1
    }
    $evidence = [ordered]@{
      ok = $false
      source = 'tray_pre_node'
      captured_at = $capturedAt
      running = ($processes.Count -gt 0)
      process_count = $processes.Count
    }
    if ($main -and $main.ExecutablePath) {
      $file = Get-Item -LiteralPath ([string]$main.ExecutablePath) -ErrorAction Stop
      $evidence.ok = $true
      $evidence.pid = [int]$main.ProcessId
      $evidence.path = [string]$file.FullName
      $evidence.bytes = [int64]$file.Length
      $evidence.modified_at = $file.LastWriteTimeUtc.ToString('o')
      $evidence.sha256 = Get-Sha256Hex $file.FullName
    } else {
      $evidence.reason = 'weixin_not_found_or_no_main_path'
    }
    $json = $evidence | ConvertTo-Json -Compress -Depth 5
    $tmp = "$LauncherEvidenceFile.$PID.$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()).tmp"
    [System.IO.File]::WriteAllText($tmp, $json, [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $tmp -Destination $LauncherEvidenceFile -Force
  } catch {
    try {
      $fallback = [ordered]@{
        ok = $false
        source = 'tray_pre_node'
        captured_at = (Get-Date).ToUniversalTime().ToString('o')
        error = [string]$_.Exception.Message
      } | ConvertTo-Json -Compress -Depth 3
      [System.IO.File]::WriteAllText($LauncherEvidenceFile, $fallback, [System.Text.UTF8Encoding]::new($false))
    } catch {}
  }
}

function Stop-Node {
  if (-not $script:NodeProcess) { return }
  try {
    if (-not $script:NodeProcess.HasExited -and (Test-Path $RuntimeFile)) {
      $info = Get-Content -LiteralPath $RuntimeFile -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($info.url -and $info.shutdown_token -and ([int]$info.pid) -eq $script:NodeProcess.Id) {
        $body = @{ shutdown_token = [string]$info.shutdown_token } | ConvertTo-Json -Compress
        Invoke-RestMethod -Uri "$($info.url)/api/shutdown" -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 3 | Out-Null
        $deadline = (Get-Date).AddSeconds(6)
        while ((Get-Date) -lt $deadline -and -not $script:NodeProcess.HasExited) {
          Start-Sleep -Milliseconds 200
          $script:NodeProcess.Refresh()
        }
      }
    }
  } catch {}
  try {
    if (-not $script:NodeProcess.HasExited) {
      Stop-Process -Id $script:NodeProcess.Id -Force
    }
  } catch {}
}

try {
  $createdMutex = $false
  $script:TrayMutex = [System.Threading.Mutex]::new($true, 'wx-summary-tray', [ref]$createdMutex)
  if (-not $createdMutex) {
    Open-Web
    exit 0
  }

  New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null

  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { throw (Utf8Label '5pyq5om+5YiwIG5vZGXjgILor7flhYjlronoo4UgTm9kZS5qcyAyMCsg5ZCO6YeN5paw5Y+M5Ye75ZCv5Yqo44CC') }

  Write-LauncherWeixinEvidence

  $script:NodeProcess = Try-AttachExistingServer
  if (-not $script:NodeProcess) {
    if (Test-Path $RuntimeFile) { Remove-Item -LiteralPath $RuntimeFile -Force -ErrorAction SilentlyContinue }
    $script:NodeProcess = Start-Process `
      -FilePath $node.Source `
      -ArgumentList @('src\main.js', '--no-open') `
      -WorkingDirectory $ProjectRoot `
      -WindowStyle Hidden `
      -RedirectStandardOutput $StdoutLog `
      -RedirectStandardError $StderrLog `
      -PassThru
  }

  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  [System.Windows.Forms.Application]::EnableVisualStyles()

  $notify = New-Object System.Windows.Forms.NotifyIcon
  $notify.Icon = [System.Drawing.SystemIcons]::Application
  $notify.Text = 'wx-summary'
  $notify.Visible = $true

  $menu = New-Object System.Windows.Forms.ContextMenuStrip
  $openItem = New-Object System.Windows.Forms.ToolStripMenuItem((Utf8Label '5omT5byA572R6aG1'))
  $exitItem = New-Object System.Windows.Forms.ToolStripMenuItem((Utf8Label '6YCA5Ye6'))
  [void]$menu.Items.Add($openItem)
  [void]$menu.Items.Add($exitItem)
  $notify.ContextMenuStrip = $menu

  $openItem.Add_Click({ Open-Web })
  $notify.Add_DoubleClick({ Open-Web })
  $exitItem.Add_Click({
    $script:ExitingByTray = $true
    Stop-Node
    $notify.Visible = $false
    $notify.Dispose()
    [System.Windows.Forms.Application]::Exit()
  })

  $readyTimer = New-Object System.Windows.Forms.Timer
  $readyTimer.Interval = 500
  $readyTimer.Add_Tick({
    $script:ReadyTicks++
    $script:ServerUrl = Read-ServerUrl
    if ($script:ServerUrl -and (Test-Path $RuntimeFile)) {
      $notify.Text = "wx-summary $script:ServerUrl"
      $readyTimer.Stop()
      if (-not $script:OpenedOnReady) {
        $script:OpenedOnReady = $true
        Open-Web
      }
      $notify.ShowBalloonTip(1500, (Utf8Label 'd3gtc3VtbWFyeSDlt7LlkK/liqg='), $script:ServerUrl, 'Info')
    } elseif ($script:ReadyTicks -ge 40) {
      $readyTimer.Stop()
      $notify.ShowBalloonTip(4000, (Utf8Label 'd3gtc3VtbWFyeSDmraPlnKjlkK/liqg='), (Utf8Label '5pyN5Yqh5LuN5Zyo5YeG5aSH5Lit77yM5Y+v5Lul56iN5ZCO5Y+z6ZSu5omT5byA572R6aG144CC'), 'Info')
    }
  })
  $readyTimer.Start()

  $healthTimer = New-Object System.Windows.Forms.Timer
  $healthTimer.Interval = 2000
  $healthTimer.Add_Tick({
    if ($script:NodeProcess -and $script:NodeProcess.HasExited -and -not $script:ExitingByTray) {
      $healthTimer.Stop()
      $readyTimer.Stop()
      $notify.ShowBalloonTip(5000, (Utf8Label 'd3gtc3VtbWFyeSDlt7LlgZzmraI='), (Utf8Label '5ZCO56uv6L+b56iL5bey6YCA5Ye677yM6K+36YeN5paw5Y+M5Ye75ZCv5Yqo44CC'), 'Warning')
      $notify.Visible = $false
      $notify.Dispose()
      [System.Windows.Forms.Application]::Exit()
    }
  })
  $healthTimer.Start()

  [System.Windows.Forms.Application]::Run()
} catch {
  Stop-Node
  Show-StartupError ([string]$_.Exception.Message)
  exit 1
} finally {
  if ($ExitingByTray) { Stop-Node }
  if ($script:TrayMutex) {
    try { $script:TrayMutex.ReleaseMutex() } catch {}
    try { $script:TrayMutex.Dispose() } catch {}
  }
}
