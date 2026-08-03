param()

$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$DependencyCheckScript = Join-Path $ProjectRoot 'scripts\check-dependencies.mjs'
$DependencyMutex = $null
$DependencyMutexOwned = $false

function Project-DependencyMutexName {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($ProjectRoot.ToLowerInvariant())
    $hash = $sha.ComputeHash($bytes)
    $short = -join ($hash[0..7] | ForEach-Object { $_.ToString('x2') })
    return "Local\wx-summary-dependencies-$short"
  } finally {
    $sha.Dispose()
  }
}

function Invoke-NativeCommand {
  param(
    $Command,
    [string[]]$Arguments
  )
  & $Command.Source @Arguments
  return [int]$LASTEXITCODE
}

try {
  $node = Get-Command node -ErrorAction Stop
  $DependencyMutex = [System.Threading.Mutex]::new($false, (Project-DependencyMutexName))
  try {
    $DependencyMutexOwned = $DependencyMutex.WaitOne([TimeSpan]::FromMinutes(15))
  } catch [System.Threading.AbandonedMutexException] {
    $DependencyMutexOwned = $true
  }
  if (-not $DependencyMutexOwned) {
    throw 'Timed out waiting for another wx-summary dependency installation.'
  }

  $lockAcquired = $true
  $checkExit = Invoke-NativeCommand $node @($DependencyCheckScript)
  if ($checkExit -eq 0) { exit 0 }

  Write-Host 'Dependencies are missing or outdated. Installing...'
  $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $npm) { $npm = Get-Command npm -ErrorAction SilentlyContinue }
  if ($npm) {
    $installExit = Invoke-NativeCommand $npm @('ci')
  } else {
    $corepack = Get-Command corepack.cmd -ErrorAction SilentlyContinue
    if (-not $corepack) { $corepack = Get-Command corepack -ErrorAction SilentlyContinue }
    if (-not $corepack) { throw 'npm/corepack not found. Please install Node.js 20+.' }
    $installExit = Invoke-NativeCommand $corepack @('npm', 'ci')
  }
  if ($installExit -ne 0) { throw "Dependency install failed with exit code $installExit." }

  $verifyExit = Invoke-NativeCommand $node @($DependencyCheckScript, '--write-stamp')
  if ($verifyExit -ne 0) { throw "Dependency verification failed with exit code $verifyExit." }
  exit 0
} catch {
  [Console]::Error.WriteLine([string]$_.Exception.Message)
  exit 1
} finally {
  if ($DependencyMutexOwned -and $DependencyMutex) {
    try { $DependencyMutex.ReleaseMutex() } catch {}
  }
  if ($DependencyMutex) {
    try { $DependencyMutex.Dispose() } catch {}
  }
}
