param(
  [Parameter(Mandatory = $true)]
  [string]$Url,
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-f0-9]{24}$')]
  [string]$FocusToken
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$WindowsRoot = [string]$env:SystemRoot
$Rundll32Exe = Join-Path $WindowsRoot 'System32\rundll32.exe'
$ExplorerExe = Join-Path $WindowsRoot 'explorer.exe'

function Utf8Label {
  param([string]$Base64)
  [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Base64))
}

function Project-WebOpenMutexName {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($ProjectRoot.ToLowerInvariant())
    $hash = $sha.ComputeHash($bytes)
    $short = -join ($hash[0..7] | ForEach-Object { $_.ToString('x2') })
    return "wx-summary-web-open-$short"
  } finally {
    $sha.Dispose()
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

function Trusted-LaunchUri {
  $uri = $null
  if (-not [System.Uri]::TryCreate($Url, [System.UriKind]::Absolute, [ref]$uri)) {
    throw 'Invalid web launch URL.'
  }
  if ($uri.Scheme -ne 'http' -or $uri.Host -ne '127.0.0.1' -or $uri.Port -le 0) {
    throw 'Web launch URL must be loopback HTTP.'
  }
  if ($uri.UserInfo -or $uri.Fragment) { throw 'Web launch URL contains forbidden components.' }
  $focusPattern = '(^|[?&])focus=' + [Regex]::Escape($FocusToken) + '(&|$)'
  if ($uri.Query -notmatch $focusPattern) { throw 'Web launch URL does not match the focus token.' }
  return $uri
}

function Show-HelperMessage {
  param(
    [string]$Message,
    [string]$Icon = 'Warning'
  )
  try {
    Add-Type -AssemblyName System.Windows.Forms
    $owner = New-Object System.Windows.Forms.Form
    $owner.TopMost = $true
    $owner.ShowInTaskbar = $false
    $owner.FormBorderStyle = 'None'
    $owner.StartPosition = 'CenterScreen'
    $owner.Size = New-Object System.Drawing.Size(1, 1)
    $owner.Opacity = 0
    $owner.Show()
    try {
      [System.Windows.Forms.MessageBox]::Show(
        $owner,
        $Message,
        (Utf8Label 'd3gtc3VtbWFyeSDmiZPlvIDnvZHpobU='),
        'OK',
        $Icon
      ) | Out-Null
    } finally {
      $owner.Close()
      $owner.Dispose()
    }
  } catch {}
}

function Start-UrlHandler {
  param(
    [string]$Executable,
    [string[]]$Arguments
  )
  $process = Start-Process -FilePath $Executable -ArgumentList $Arguments -PassThru -ErrorAction Stop
  if ($process.WaitForExit(3000) -and $process.ExitCode -ne 0) {
    throw "URL handler exited with code $($process.ExitCode)."
  }
}

function Initialize-WebForegroundApi {
  $source = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace WxSummary {
  public static class WebForeground {
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr hWnd, int command);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool AllowSetForegroundWindow(int processId);
    [DllImport("user32.dll")] private static extern void SwitchToThisWindow(IntPtr hWnd, bool altTab);

    public static IntPtr FindExact(string marker) {
      if (String.IsNullOrWhiteSpace(marker)) return IntPtr.Zero;
      IntPtr found = IntPtr.Zero;
      EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
        if (!IsWindowVisible(hWnd)) return true;
        StringBuilder title = new StringBuilder(1024);
        if (GetWindowText(hWnd, title, title.Capacity) <= 0) return true;
        if (title.ToString().IndexOf(marker, StringComparison.Ordinal) < 0) return true;
        found = hWnd;
        return false;
      }, IntPtr.Zero);
      return found;
    }

    public static bool Activate(IntPtr hWnd) {
      if (hWnd == IntPtr.Zero) return false;
      const uint noMoveNoSizeShow = 0x0001 | 0x0002 | 0x0040;
      IntPtr topmost = new IntPtr(-1);
      IntPtr notTopmost = new IntPtr(-2);
      try { AllowSetForegroundWindow(-1); } catch {}
      try { ShowWindowAsync(hWnd, 9); } catch {}
      try { BringWindowToTop(hWnd); } catch {}
      try { SetForegroundWindow(hWnd); } catch {}
      Thread.Sleep(80);
      if (GetForegroundWindow() != hWnd) {
        try { SetWindowPos(hWnd, topmost, 0, 0, 0, 0, noMoveNoSizeShow); } catch {}
        try { BringWindowToTop(hWnd); } catch {}
        try { SetForegroundWindow(hWnd); } catch {}
        Thread.Sleep(100);
        if (GetForegroundWindow() != hWnd) {
          try { SwitchToThisWindow(hWnd, true); } catch {}
          try { SetForegroundWindow(hWnd); } catch {}
          Thread.Sleep(80);
        }
        try { SetWindowPos(hWnd, notTopmost, 0, 0, 0, 0, noMoveNoSizeShow); } catch {}
      }
      return GetForegroundWindow() == hWnd;
    }
  }
}
'@
  Add-Type -TypeDefinition $source -ErrorAction Stop
}

$webOpenMutex = $null
$webOpenMutexOwned = $false
try {
  $webOpenMutex = [System.Threading.Mutex]::new($false, (Project-WebOpenMutexName))
  try {
    $webOpenMutexOwned = $webOpenMutex.WaitOne(0)
  } catch [System.Threading.AbandonedMutexException] {
    $webOpenMutexOwned = $true
  }
  if (-not $webOpenMutexOwned) { exit 0 }

  try {
    $launchUri = Trusted-LaunchUri
    $rundll32 = Trusted-SystemExecutable $Rundll32Exe
    $explorer = Trusted-SystemExecutable $ExplorerExe
    try {
      Start-UrlHandler $rundll32 @('url.dll,FileProtocolHandler', $launchUri.AbsoluteUri)
    } catch {
      Start-UrlHandler $explorer @($launchUri.AbsoluteUri)
    }
  } catch {
    Show-HelperMessage (Utf8Label '5peg5rOV5omT5byA5pys5Zyw6aG16Z2i44CC6K+35Zyo5rWP6KeI5Zmo5Lit5omL5Yqo5omT5byA5pyN5Yqh5Zyw5Z2A44CC') 'Error'
    exit 1
  }

  try {
    Initialize-WebForegroundApi
    $marker = "wx-focus-$FocusToken"
    $deadline = (Get-Date).AddSeconds(10)
    while ((Get-Date) -lt $deadline) {
      $handle = [WxSummary.WebForeground]::FindExact($marker)
      if ($handle -ne [IntPtr]::Zero -and [WxSummary.WebForeground]::Activate($handle)) {
        exit 0
      }
      Start-Sleep -Milliseconds 120
    }
  } catch {}

  Show-HelperMessage (Utf8Label '572R6aG15bey5omT5byA77yM5L2G5pyq6IO9572u5LqO5pyA5YmN44CC6K+35LuO5Lu75Yqh5qCP5YiH5o2i5Yiw5rWP6KeI5Zmo44CC')
  exit 2
} finally {
  if ($webOpenMutexOwned -and $webOpenMutex) {
    try { $webOpenMutex.ReleaseMutex() } catch {}
  }
  if ($webOpenMutex) {
    try { $webOpenMutex.Dispose() } catch {}
  }
}
