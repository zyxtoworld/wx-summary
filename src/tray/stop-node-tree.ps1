param(
  [Parameter(Mandatory = $true)]
  [string]$ProjectRoot,
  [Parameter(Mandatory = $true)]
  [ValidateRange(1, 2147483647)]
  [int]$ExpectedPid,
  [Parameter(Mandatory = $true)]
  [string]$ExpectedProcessStartId,
  [ValidateRange(5, 600)]
  [int]$FallbackWaitSeconds = 130,
  [ValidateRange(0, 60)]
  [int]$DeadlineMarginSeconds = 10
)

$ErrorActionPreference = 'Stop'
$ResolvedProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot -ErrorAction Stop).Path
$RuntimeFile = Join-Path $ResolvedProjectRoot 'outputs\.tmp\server.json'

function Get-ProcessStartIdentity {
  param([int]$ProcessId)
  try {
    $process = Get-Process -Id $ProcessId -ErrorAction Stop
    return "win:$($process.StartTime.ToUniversalTime().Ticks)"
  } catch {
    return ''
  }
}

function Expected-ProcessAlive {
  $actual = Get-ProcessStartIdentity $ExpectedPid
  return $actual -and [string]::Equals($actual, $ExpectedProcessStartId, [System.StringComparison]::Ordinal)
}

function Trusted-TaskkillExecutable {
  $windowsRoot = [string]$env:SystemRoot
  if (-not $windowsRoot) { throw 'SystemRoot is unavailable.' }
  $expected = [System.IO.Path]::GetFullPath((Join-Path $windowsRoot 'System32\taskkill.exe'))
  if (-not (Test-Path -LiteralPath $expected -PathType Leaf)) { throw 'Trusted taskkill.exe is unavailable.' }
  $resolved = (Resolve-Path -LiteralPath $expected -ErrorAction Stop).Path
  if (-not [string]::Equals($resolved, $expected, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Trusted taskkill.exe resolved to an unexpected path.'
  }
  return $resolved
}

function Trusted-LoopbackUri {
  param([string]$Value)
  $uri = $null
  if (-not [System.Uri]::TryCreate($Value, [System.UriKind]::Absolute, [ref]$uri)) { return $null }
  if ($uri.Scheme -ne 'http' -or $uri.Host -ne '127.0.0.1' -or $uri.Port -le 0) { return $null }
  if ($uri.UserInfo -or $uri.Fragment) { return $null }
  return $uri
}

function Read-MatchingRuntimeInfo {
  if (-not (Test-Path -LiteralPath $RuntimeFile -PathType Leaf)) { return $null }
  try {
    $info = Get-Content -LiteralPath $RuntimeFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([int]$info.pid -ne $ExpectedPid) { return $null }
    if (-not [string]::Equals([string]$info.process_start_id, $ExpectedProcessStartId, [System.StringComparison]::Ordinal)) { return $null }
    $runtimeRoot = (Resolve-Path -LiteralPath ([string]$info.project_root) -ErrorAction Stop).Path
    if (-not [string]::Equals($runtimeRoot, $ResolvedProjectRoot, [System.StringComparison]::OrdinalIgnoreCase)) { return $null }
    $uri = Trusted-LoopbackUri ([string]$info.url)
    if (-not $uri -or -not $info.shutdown_token) { return $null }
    return [pscustomobject]@{ Info = $info; Uri = $uri }
  } catch {
    return $null
  }
}

if (-not (Expected-ProcessAlive)) { exit 0 }

$deadline = (Get-Date).AddSeconds($FallbackWaitSeconds)
$runtime = Read-MatchingRuntimeInfo
if ($runtime) {
  try {
    $shutdownToken = [string]$runtime.Info.shutdown_token
    $body = @{ shutdown_token = $shutdownToken } | ConvertTo-Json -Compress
    $shutdownUri = [System.Uri]::new($runtime.Uri, '/api/shutdown')
    $shutdown = Invoke-RestMethod `
      -Uri $shutdownUri.AbsoluteUri `
      -Method Post `
      -Headers @{ 'X-WX-Shutdown' = $shutdownToken } `
      -Body $body `
      -ContentType 'application/json' `
      -UseBasicParsing `
      -TimeoutSec 3
    $publishedDeadline = [DateTimeOffset]::MinValue
    if ($shutdown.shutdown_deadline_at -and [DateTimeOffset]::TryParse([string]$shutdown.shutdown_deadline_at, [ref]$publishedDeadline)) {
      $candidate = $publishedDeadline.LocalDateTime.AddSeconds($DeadlineMarginSeconds)
      if ($candidate -gt (Get-Date)) { $deadline = $candidate }
    }
  } catch {}
}

while ((Get-Date) -lt $deadline -and (Expected-ProcessAlive)) {
  Start-Sleep -Milliseconds 200
}
if (-not (Expected-ProcessAlive)) { exit 0 }

$taskkill = Trusted-TaskkillExecutable
$taskkillArguments = @('/PID', [string]$ExpectedPid, '/T', '/F')
$kill = Start-Process -FilePath $taskkill -ArgumentList $taskkillArguments -WindowStyle Hidden -Wait -PassThru -ErrorAction Stop
Start-Sleep -Milliseconds 300
if (Expected-ProcessAlive) {
  [Console]::Error.WriteLine("taskkill.exe failed with exit code $($kill.ExitCode).")
  exit 1
}
exit 0
