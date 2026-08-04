$ErrorActionPreference = 'Stop'

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$DataDir = Join-Path $ProjectRoot 'data'
$OutputsDir = Join-Path $ProjectRoot 'outputs'
$TmpDir = Join-Path $ProjectRoot 'outputs\.tmp'
$RuntimeFile = Join-Path $TmpDir 'server.json'
$WindowsRoot = [string]$env:SystemRoot
$WindowsPowerShellExe = Join-Path $WindowsRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$TaskkillExe = Join-Path $WindowsRoot 'System32\taskkill.exe'
$ShutdownHelperScript = Join-Path $PSScriptRoot 'stop-node-tree.ps1'
$WebOpenHelperScript = Join-Path $PSScriptRoot 'open-web-foreground.ps1'
$LauncherEvidenceFile = Join-Path $DataDir 'launcher-weixin-binary.json'
$StdoutLog = Join-Path $TmpDir "tray-node-$PID.out.log"
$StderrLog = Join-Path $TmpDir "tray-node-$PID.err.log"
$NodeProcess = $null
$NodeProcessStartId = ''
$TrayMutex = $null
$TrayMutexOwned = $false
$ServerUrl = ''
$ExitingByTray = $false
$GracefulShutdownFallbackWaitSeconds = 130
$GracefulShutdownDeadlineMarginSeconds = 10
$VersionAwareLauncherWaitSeconds = 135
$OpenedOnReady = $false
$ReadyTicks = 0
$ShutdownStarted = $false
$ShutdownHelperProcess = $null
$ShutdownFallbackProcess = $null
$WebOpenHelperProcess = $null
$ShutdownTimer = $null
$ShutdownUiDeadline = [DateTime]::MinValue
$ShutdownFallbackDeadline = [DateTime]::MinValue
$NotifyIcon = $null
$OpenMenuItem = $null
$ExitMenuItem = $null

function Utf8Label {
  param([string]$Base64)
  [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Base64))
}

function Project-MutexName {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($ProjectRoot.ToLowerInvariant())
    $hash = $sha.ComputeHash($bytes)
    $short = -join ($hash[0..7] | ForEach-Object { $_.ToString('x2') })
    return "wx-summary-tray-$short"
  } finally {
    $sha.Dispose()
  }
}

function Show-StartupError {
  param([string]$Message)
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show($Message, (Utf8Label 'd3gtc3VtbWFyeSDlkK/liqjlpLHotKU='), 'OK', 'Error') | Out-Null
}

function Ensure-OrdinaryProjectDirectory {
  param(
    [string]$Path,
    [string]$ExpectedParent,
    [string]$Label
  )
  $resolvedParent = (Resolve-Path -LiteralPath $ExpectedParent -ErrorAction Stop).Path
  $parentItem = Get-Item -LiteralPath $resolvedParent -Force -ErrorAction Stop
  if (-not $parentItem.PSIsContainer -or (($parentItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
    throw "$Label parent must be an ordinary project directory."
  }
  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Path $Path -ErrorAction Stop | Out-Null
  }
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if (-not $item.PSIsContainer -or (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
    throw "$Label must be an ordinary project directory, not a symlink or junction."
  }
  $resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
  $expected = Join-Path $resolvedParent (Split-Path -Leaf $Path)
  if (-not [string]::Equals($resolved, $expected, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label resolved outside the expected project directory."
  }
}

function Assert-Node20 {
  param($Command)
  if (-not $Command) {
    throw 'node not found. Please install Node.js 20+ and restart wx-summary.'
  }
  $majorText = & $Command.Source -p "Number(process.versions.node.split('.')[0])" 2>$null
  $major = 0
  if (-not [int]::TryParse([string]$majorText, [ref]$major) -or $major -lt 20) {
    $version = & $Command.Source -v 2>$null
    throw "Node.js 20+ is required. Current version: $($version -join ' ')"
  }
}

function Get-TrustedLoopbackHttpUri {
  param([string]$Value)
  $uri = $null
  if (-not [System.Uri]::TryCreate([string]$Value, [System.UriKind]::Absolute, [ref]$uri)) { return $null }
  if ($uri.Scheme -ne 'http' -or $uri.Host -ne '127.0.0.1' -or $uri.Port -le 0) { return $null }
  if ($uri.UserInfo -or $uri.Fragment) { return $null }
  return $uri
}

function Get-RuntimeServerUris {
  param($Info)
  $base = Get-TrustedLoopbackHttpUri ([string]$Info.url)
  if (-not $base) { return $null }
  $launch = Get-TrustedLoopbackHttpUri ([string]$Info.launch_url)
  if ($launch -and ($launch.Scheme -ne $base.Scheme -or $launch.Host -ne $base.Host -or $launch.Port -ne $base.Port)) {
    $launch = $null
  }
  return [pscustomobject]@{
    Base = $base
    Launch = $launch
  }
}

function Read-ServerUrl {
  if (-not (Test-Path $RuntimeFile)) { return $null }
  try {
    $info = Get-Content -LiteralPath $RuntimeFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not (RuntimeInfo-MatchesProject $info)) { return $null }
    if ($NodeProcess -and $info.pid -and ([int]$info.pid) -ne $NodeProcess.Id) { return $null }
    $uris = Get-RuntimeServerUris $info
    if (-not $uris) { return $null }
    if ($uris.Launch) { return $uris.Launch.AbsoluteUri }
    return $uris.Base.AbsoluteUri
  } catch {}
  return $null
}

function New-WebFocusToken {
  $bytes = New-Object byte[] 12
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($bytes)
  } finally {
    $rng.Dispose()
  }
  return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Start-WebOpenHelper {
  param(
    [string]$Url,
    [string]$FocusToken
  )
  $expectedHelper = [System.IO.Path]::GetFullPath($WebOpenHelperScript)
  $resolvedHelper = (Resolve-Path -LiteralPath $expectedHelper -ErrorAction Stop).Path
  if (-not [string]::Equals($resolvedHelper, $expectedHelper, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Web-open helper resolved outside its expected project path.'
  }
  $powershell = Trusted-SystemExecutable $WindowsPowerShellExe
  $arguments = @(
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', "`"$resolvedHelper`"",
    '-Url', "`"$Url`"",
    '-FocusToken', $FocusToken
  )
  return Start-Process `
    -FilePath $powershell `
    -ArgumentList $arguments `
    -WindowStyle Hidden `
    -PassThru `
    -ErrorAction Stop
}

function Open-Web {
  if ($script:WebOpenHelperProcess) {
    try {
      $script:WebOpenHelperProcess.Refresh()
      if (-not $script:WebOpenHelperProcess.HasExited) { return }
    } catch {}
    $script:WebOpenHelperProcess = $null
  }

  $attached = Try-AttachExistingServer
  if (-not $attached) {
    Show-StartupError (Utf8Label '5pys5Zyw5pyN5Yqh5bCa5pyq5bCx57uq44CB5bey6YCA5Ye65oiW5Luj56CB5bey5pu05paw44CC6K+36YeN5paw5Y+M5Ye75ZCv5YqoIHd4LXN1bW1hcnnvvIznrYnlvoXlkK/liqjlrozmiJDlkI7lho3or5XjgII=')
    return
  }
  $script:NodeProcess = $attached
  $script:NodeProcessStartId = Node-ProcessStartIdentity $attached.Id
  $script:ServerUrl = Read-ServerUrl
  if (-not $script:ServerUrl) {
    Show-StartupError (Utf8Label 'd3gtc3VtbWFyeSDmnI3liqHku43lnKjlkK/liqjmiJbov5DooYzkv6Hmga/kuI3lj6/nlKjvvIzor7fnqI3lkI7lho3or5XjgII=')
    return
  }
  try {
    $focusToken = New-WebFocusToken
    $builder = [System.UriBuilder]::new($script:ServerUrl)
    $query = [string]$builder.Query
    if ($query.StartsWith('?')) { $query = $query.Substring(1) }
    $builder.Query = if ($query) { "$query&focus=$focusToken" } else { "focus=$focusToken" }
    $script:WebOpenHelperProcess = Start-WebOpenHelper $builder.Uri.AbsoluteUri $focusToken
  } catch {
    $script:WebOpenHelperProcess = $null
    Show-StartupError (Utf8Label '5peg5rOV5omT5byA5pys5Zyw6aG16Z2i44CC6K+35Zyo5rWP6KeI5Zmo5Lit5omL5Yqo5omT5byA5pyN5Yqh5Zyw5Z2A44CC')
  }
}

function RuntimeInfo-MatchesProject {
  param($Info)
  try {
    if (-not $Info.project_root) { return $false }
    $runtimeRoot = (Resolve-Path -LiteralPath ([string]$Info.project_root) -ErrorAction Stop).Path
    return [string]::Equals($runtimeRoot, $ProjectRoot, [System.StringComparison]::OrdinalIgnoreCase)
  } catch {
    return $false
  }
}

function Get-ExistingServerProbe {
  if (-not (Test-Path $RuntimeFile)) { return $null }
  try {
    $info = Get-Content -LiteralPath $RuntimeFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not (RuntimeInfo-MatchesProject $info)) { return $null }
    if (-not $info.pid -or -not $info.url) { return $null }
    $uris = Get-RuntimeServerUris $info
    if (-not $uris) { return $null }

    $existingPid = [int]$info.pid
    if ($script:NodeProcess -and $existingPid -ne $script:NodeProcess.Id) { return $null }
    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $existingPid" -ErrorAction SilentlyContinue
    if (-not $processInfo) { return $null }
    if ([string]$processInfo.CommandLine -notmatch 'src[\\/]main\.js') { return $null }

    if (-not $info.health_token) { return $null }
    $healthUri = [System.Uri]::new($uris.Base, '/api/health')
    $health = Invoke-RestMethod -Uri $healthUri.AbsoluteUri -Headers @{ 'X-WX-Health' = [string]$info.health_token } -UseBasicParsing -TimeoutSec 2
    if (-not $health.ok -or -not $health.pid -or ([int]$health.pid) -ne $existingPid) { return $null }
    if (-not (RuntimeInfo-MatchesProject $health)) { return $null }
    if ($info.asset_version -and -not [string]::Equals([string]$info.asset_version, [string]$health.asset_version, [System.StringComparison]::Ordinal)) { return $null }

    return [pscustomobject]@{
      Info = $info
      Uris = $uris
      Health = $health
      Process = (Get-Process -Id $existingPid -ErrorAction Stop)
    }
  } catch {
    return $null
  }
}

function Try-AttachExistingServer {
  $probe = Get-ExistingServerProbe
  if (-not $probe) { return $null }
  $health = $probe.Health
  if ($health.shutting_down -eq $true -or -not $health.asset_version -or -not $health.source_asset_version) { return $null }
  if (-not [string]::Equals([string]$health.asset_version, [string]$health.source_asset_version, [System.StringComparison]::Ordinal)) { return $null }
  return $probe.Process
}

function Request-ExistingTraySourceChangeShutdown {
  $probe = Get-ExistingServerProbe
  if (-not $probe) { return $false }
  $health = $probe.Health
  if (-not $health.asset_version -or -not $health.source_asset_version) { return $false }
  if ([string]::Equals([string]$health.asset_version, [string]$health.source_asset_version, [System.StringComparison]::Ordinal)) { return $false }
  if ($health.shutting_down -eq $true) { return $true }

  $shutdownToken = [string]$probe.Info.shutdown_token
  if (-not $shutdownToken) { return $false }
  $shutdownUri = [System.Uri]::new($probe.Uris.Base, '/api/shutdown')
  $body = @{ shutdown_token = $shutdownToken } | ConvertTo-Json -Compress
  try {
    Invoke-RestMethod `
      -Uri $shutdownUri.AbsoluteUri `
      -Method Post `
      -Headers @{ 'X-WX-Shutdown' = $shutdownToken } `
      -ContentType 'application/json' `
      -Body $body `
      -UseBasicParsing `
      -TimeoutSec 5 | Out-Null
  } catch {}
  return $true
}

function Runtime-ServerPid {
  if (-not (Test-Path $RuntimeFile)) { return 0 }
  try {
    $info = Get-Content -LiteralPath $RuntimeFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not (RuntimeInfo-MatchesProject $info) -or -not $info.pid) { return 0 }
    return [int]$info.pid
  } catch {
    return 0
  }
}

function Start-VersionAwareServerLauncher {
  param($NodeCommand)
  return Start-Process `
    -FilePath $NodeCommand.Source `
    -ArgumentList @('src\main.js', '--no-open') `
    -WorkingDirectory $ProjectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $StdoutLog `
    -RedirectStandardError $StderrLog `
    -PassThru
}

function Read-LauncherFailureDetail {
  $details = @()
  foreach ($path in @($StderrLog, $StdoutLog)) {
    if (-not (Test-Path -LiteralPath $path)) { continue }
    try {
      $lines = @(Get-Content -LiteralPath $path -Tail 12 -Encoding UTF8 -ErrorAction Stop |
        ForEach-Object { [string]$_ } |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
      if ($lines.Count -gt 0) {
        $last = $lines[$lines.Count - 1].Trim()
        if ($last.Length -gt 500) { $last = $last.Substring(0, 500) }
        $details += "$([System.IO.Path]::GetFileName($path)): $last"
      }
    } catch {}
  }
  if ($details.Count -gt 0) { return " $($details -join ' | ')" }
  return " See startup logs: $StderrLog; $StdoutLog"
}

function Wait-VersionAwareServer {
  param($LauncherProcess)
  $deadline = (Get-Date).AddSeconds($VersionAwareLauncherWaitSeconds)
  while ((Get-Date) -lt $deadline) {
    $LauncherProcess.Refresh()
    $runtimePid = Runtime-ServerPid
    if (-not $LauncherProcess.HasExited -and $runtimePid -eq $LauncherProcess.Id) {
      $attached = Try-AttachExistingServer
      if ($attached) { return $attached }
    }
    if ($LauncherProcess.HasExited) {
      $attached = Try-AttachExistingServer
      if ($attached) { return $attached }
      $rawExitCode = $null
      try { $rawExitCode = $LauncherProcess.ExitCode } catch {}
      $exitCodeText = if ($null -eq $rawExitCode -or [string]::IsNullOrWhiteSpace([string]$rawExitCode)) {
        'unknown'
      } else {
        [string]$rawExitCode
      }
      if ($exitCodeText -ne '0') {
        throw "wx-summary version-aware launcher failed with exit code $exitCodeText.$(Read-LauncherFailureDetail)"
      }
    }
    Start-Sleep -Milliseconds 250
  }
  throw 'wx-summary version-aware launcher did not produce a healthy current service in time.'
}

function Wait-ExistingTrayOrAcquireMutex {
  param([System.Threading.Mutex]$Mutex)
  $deadline = (Get-Date).AddSeconds($VersionAwareLauncherWaitSeconds)
  $nextSourceChangeProbeAt = (Get-Date).AddSeconds(2)
  while ((Get-Date) -lt $deadline) {
    $attached = Try-AttachExistingServer
    if ($attached) {
      return [pscustomobject]@{
        acquired = $false
        process = $attached
      }
    }
    $now = Get-Date
    if ($now -ge $nextSourceChangeProbeAt) {
      [void](Request-ExistingTraySourceChangeShutdown)
      $nextSourceChangeProbeAt = $now.AddSeconds(2)
    }
    try {
      if ($Mutex.WaitOne(250)) {
        return [pscustomobject]@{
          acquired = $true
          process = $null
        }
      }
    } catch [System.Threading.AbandonedMutexException] {
      return [pscustomobject]@{
        acquired = $true
        process = $null
      }
    }
  }
  throw (Utf8Label '5Y+m5LiA5LiqIHd4LXN1bW1hcnkg5omY55uY5LuN5Zyo5ZCv5Yqo77yM5L2G5rKh5pyJ5Zyo6ZmQ5a6a5pe26Ze05YaF5o+Q5L6b5Y+v55So5pyN5Yqh44CC')
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

function Node-ProcessStartIdentity {
  param([int]$ProcessId)
  try {
    $process = Get-Process -Id $ProcessId -ErrorAction Stop
    return "win:$($process.StartTime.ToUniversalTime().Ticks)"
  } catch {
    return ''
  }
}

function Test-ExpectedNodeProcessAlive {
  if (-not $script:NodeProcess) { return $false }
  $expectedIdentity = [string]$script:NodeProcessStartId
  if ($expectedIdentity) {
    $actualIdentity = Node-ProcessStartIdentity $script:NodeProcess.Id
    return $actualIdentity -and [string]::Equals($actualIdentity, $expectedIdentity, [System.StringComparison]::Ordinal)
  }
  try {
    $script:NodeProcess.Refresh()
    return -not $script:NodeProcess.HasExited
  } catch {
    return $true
  }
}

function Trusted-SystemExecutable {
  param([string]$Path)
  $expected = [System.IO.Path]::GetFullPath($Path)
  if (-not (Test-Path -LiteralPath $expected -PathType Leaf)) {
    throw "Trusted system executable is missing: $expected"
  }
  $resolved = (Resolve-Path -LiteralPath $expected -ErrorAction Stop).Path
  if (-not [string]::Equals($resolved, $expected, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Trusted system executable resolved to an unexpected path: $expected"
  }
  return $resolved
}

function Start-FallbackTaskkillTree {
  if (-not $script:NodeProcess) { return $null }
  $expectedIdentity = [string]$script:NodeProcessStartId
  if (-not $expectedIdentity) { return $null }
  $actualIdentity = Node-ProcessStartIdentity $script:NodeProcess.Id
  if (-not [string]::Equals($actualIdentity, $expectedIdentity, [System.StringComparison]::Ordinal)) { return $null }
  $taskkill = Trusted-SystemExecutable $TaskkillExe
  return Start-Process `
    -FilePath $taskkill `
    -ArgumentList @('/PID', [string]$script:NodeProcess.Id, '/T', '/F') `
    -WindowStyle Hidden `
    -PassThru `
    -ErrorAction Stop
}

function Start-NodeShutdownHelper {
  if ($script:ShutdownStarted) { return $script:ShutdownHelperProcess }
  if (-not $script:NodeProcess) { return $null }
  $identity = Node-ProcessStartIdentity $script:NodeProcess.Id
  if (-not $identity) { return $null }
  $script:NodeProcessStartId = $identity
  $expectedHelper = [System.IO.Path]::GetFullPath($ShutdownHelperScript)
  $resolvedHelper = (Resolve-Path -LiteralPath $expectedHelper -ErrorAction Stop).Path
  if (-not [string]::Equals($resolvedHelper, $expectedHelper, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Shutdown helper resolved outside its expected project path.'
  }
  $powershell = Trusted-SystemExecutable $WindowsPowerShellExe
  $arguments = @(
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', "`"$resolvedHelper`"",
    '-ProjectRoot', "`"$ProjectRoot`"",
    '-ExpectedPid', [string]$script:NodeProcess.Id,
    '-ExpectedProcessStartId', $identity,
    '-FallbackWaitSeconds', [string]$GracefulShutdownFallbackWaitSeconds,
    '-DeadlineMarginSeconds', [string]$GracefulShutdownDeadlineMarginSeconds
  )
  try {
    $script:ShutdownHelperProcess = Start-Process `
      -FilePath $powershell `
      -ArgumentList $arguments `
      -WindowStyle Hidden `
      -PassThru `
      -ErrorAction Stop
  } catch {
    $script:ShutdownHelperProcess = Start-FallbackTaskkillTree
  }
  $script:ShutdownStarted = $true
  return $script:ShutdownHelperProcess
}

function Stop-Node {
  [void](Start-NodeShutdownHelper)
}

function Complete-TrayExit {
  if ($script:ShutdownTimer) {
    try { $script:ShutdownTimer.Stop() } catch {}
    try { $script:ShutdownTimer.Dispose() } catch {}
    $script:ShutdownTimer = $null
  }
  if ($script:NotifyIcon) {
    try { $script:NotifyIcon.Visible = $false } catch {}
    try { $script:NotifyIcon.Dispose() } catch {}
    $script:NotifyIcon = $null
  }
  [System.Windows.Forms.Application]::Exit()
}

function Restore-TrayAfterShutdownFailure {
  if ($script:ShutdownTimer) {
    try { $script:ShutdownTimer.Stop() } catch {}
    try { $script:ShutdownTimer.Dispose() } catch {}
    $script:ShutdownTimer = $null
  }
  foreach ($coordinator in @($script:ShutdownHelperProcess, $script:ShutdownFallbackProcess)) {
    if (-not $coordinator) { continue }
    try {
      $coordinator.Refresh()
      if (-not $coordinator.HasExited) { $coordinator.Kill() }
    } catch {}
  }
  $script:ShutdownHelperProcess = $null
  $script:ShutdownFallbackProcess = $null
  $script:ShutdownStarted = $false
  $script:ExitingByTray = $false
  if ($script:OpenMenuItem) { $script:OpenMenuItem.Enabled = $true }
  if ($script:ExitMenuItem) { $script:ExitMenuItem.Enabled = $true }
  if ($script:NotifyIcon) {
    $script:NotifyIcon.Text = 'wx-summary'
    $script:NotifyIcon.ShowBalloonTip(
      6000,
      (Utf8Label 'd3gtc3VtbWFyeSDlhbPpl63lpLHotKU='),
      (Utf8Label '5ZCO5Y+w5pyN5Yqh5LuN5Zyo6L+Q6KGM77yM5omY55uY5LiN5Lya6YCA5Ye644CC6K+356iN5ZCO6YeN6K+V77yb6Iul5oyB57ut5aSx6LSl77yM6K+35YWI562J5b6F5b2T5YmN5Lu75Yqh57uT5p2f44CC'),
      'Warning'
    )
  }
}

function Request-TrayExit {
  if ($script:ExitingByTray) { return }
  $script:ExitingByTray = $true
  if ($script:OpenMenuItem) { $script:OpenMenuItem.Enabled = $false }
  if ($script:ExitMenuItem) { $script:ExitMenuItem.Enabled = $false }
  if ($script:NotifyIcon) { $script:NotifyIcon.Text = 'wx-summary is shutting down safely' }
  try {
    $shutdownProcess = Start-NodeShutdownHelper
  } catch {
    try {
      $script:ShutdownHelperProcess = Start-FallbackTaskkillTree
    } catch {
      $script:ShutdownHelperProcess = $null
    }
    $shutdownProcess = $script:ShutdownHelperProcess
  }
  if (-not $shutdownProcess) {
    if (-not (Test-ExpectedNodeProcessAlive)) {
      Complete-TrayExit
    } else {
      Restore-TrayAfterShutdownFailure
    }
    return
  }
  $script:ShutdownUiDeadline = (Get-Date).AddSeconds($GracefulShutdownFallbackWaitSeconds + $GracefulShutdownDeadlineMarginSeconds + 20)
  $script:ShutdownTimer = New-Object System.Windows.Forms.Timer
  $script:ShutdownTimer.Interval = 250
  $script:ShutdownTimer.Add_Tick({
    if (-not (Test-ExpectedNodeProcessAlive)) {
      Complete-TrayExit
      return
    }
    if ($script:ShutdownFallbackProcess) {
      try { $script:ShutdownFallbackProcess.Refresh() } catch {}
      if ($script:ShutdownFallbackProcess.HasExited) {
        if (-not (Test-ExpectedNodeProcessAlive)) {
          Complete-TrayExit
        } else {
          Restore-TrayAfterShutdownFailure
        }
        return
      }
      if ((Get-Date) -ge $script:ShutdownFallbackDeadline) {
        Restore-TrayAfterShutdownFailure
      }
      return
    }
    try { $script:ShutdownHelperProcess.Refresh() } catch {}
    if ($script:ShutdownHelperProcess.HasExited) {
      if (-not (Test-ExpectedNodeProcessAlive)) {
        Complete-TrayExit
      } else {
        Restore-TrayAfterShutdownFailure
      }
      return
    }
    if ((Get-Date) -ge $script:ShutdownUiDeadline) {
      try {
        $script:ShutdownFallbackProcess = Start-FallbackTaskkillTree
      } catch {
        $script:ShutdownFallbackProcess = $null
      }
      if (-not $script:ShutdownFallbackProcess) {
        if (-not (Test-ExpectedNodeProcessAlive)) {
          Complete-TrayExit
        } else {
          Restore-TrayAfterShutdownFailure
        }
        return
      }
      $script:ShutdownFallbackDeadline = (Get-Date).AddSeconds(10)
    }
  })
  $script:ShutdownTimer.Start()
}

try {
  $createdMutex = $false
  $script:TrayMutex = [System.Threading.Mutex]::new($true, (Project-MutexName), [ref]$createdMutex)
  $script:TrayMutexOwned = $createdMutex

  if (-not $createdMutex) {
    [void](Request-ExistingTraySourceChangeShutdown)
    $handoff = Wait-ExistingTrayOrAcquireMutex $script:TrayMutex
    if (-not $handoff.acquired) {
      $script:NodeProcess = $handoff.process
      Open-Web
      exit 0
    }
    $createdMutex = $true
    $script:TrayMutexOwned = $true
  }

  Ensure-OrdinaryProjectDirectory $DataDir $ProjectRoot 'data'
  Ensure-OrdinaryProjectDirectory $OutputsDir $ProjectRoot 'outputs'
  Ensure-OrdinaryProjectDirectory $TmpDir $OutputsDir 'outputs/.tmp'

  $node = Get-Command node -ErrorAction SilentlyContinue
  Assert-Node20 $node

  Write-LauncherWeixinEvidence

  $launcherProcess = Start-VersionAwareServerLauncher $node
  $script:NodeProcess = $launcherProcess
  $script:NodeProcessStartId = Node-ProcessStartIdentity $launcherProcess.Id
  $attachedProcess = Wait-VersionAwareServer $launcherProcess
  $script:NodeProcess = $attachedProcess
  $script:NodeProcessStartId = Node-ProcessStartIdentity $script:NodeProcess.Id

  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  [System.Windows.Forms.Application]::EnableVisualStyles()

  $notify = New-Object System.Windows.Forms.NotifyIcon
  $script:NotifyIcon = $notify
  $notify.Icon = [System.Drawing.SystemIcons]::Application
  $notify.Text = 'wx-summary'
  $notify.Visible = $true

  $menu = New-Object System.Windows.Forms.ContextMenuStrip
  $openItem = New-Object System.Windows.Forms.ToolStripMenuItem((Utf8Label '5omT5byA572R6aG1'))
  $exitItem = New-Object System.Windows.Forms.ToolStripMenuItem((Utf8Label '6YCA5Ye6'))
  $script:OpenMenuItem = $openItem
  $script:ExitMenuItem = $exitItem
  [void]$menu.Items.Add($openItem)
  [void]$menu.Items.Add($exitItem)
  $notify.ContextMenuStrip = $menu

  $openItem.Add_Click({ Open-Web })
  $notify.Add_DoubleClick({ Open-Web })
  $exitItem.Add_Click({
    Request-TrayExit
  })

  $readyTimer = New-Object System.Windows.Forms.Timer
  $readyTimer.Interval = 500
  $readyTimer.Add_Tick({
    $script:ReadyTicks++
    $script:ServerUrl = Read-ServerUrl
    if ($script:ServerUrl -and (Test-Path $RuntimeFile)) {
      $notify.Text = 'wx-summary'
      $readyTimer.Stop()
      if (-not $script:OpenedOnReady) {
        $script:OpenedOnReady = $true
        Open-Web
      }
      $notify.ShowBalloonTip(1500, (Utf8Label 'd3gtc3VtbWFyeSDlt7LlkK/liqg='), (Utf8Label '5pys5Zyw5pyN5Yqh5bey5bCx57uq77yM5Y+M5Ye75omY55uY5Zu+5qCH5Y2z5Y+v5omT5byA44CC'), 'Info')
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
  if ($script:TrayMutexOwned) { Stop-Node }
  Show-StartupError ([string]$_.Exception.Message)
  exit 1
} finally {
  if ($ExitingByTray) { Stop-Node }
  if ($script:TrayMutex) {
    if ($script:TrayMutexOwned) {
      try { $script:TrayMutex.ReleaseMutex() } catch {}
    }
    try { $script:TrayMutex.Dispose() } catch {}
  }
}
