# dsh-notify — toast activation handler.
#
# Windows runs this through the `dshnotify:` protocol that the host half
# registers in HKCU\Software\Classes\dshnotify. The toast passes the session id
# in the URI, e.g.
#
#   dshnotify:activate?sid=session-f6c44ee7-0ace-4db1-b30b-afa56c25b8b6
#
# This script restores/foregrounds the DSH window and hands the session id to
# the loopback endpoint served by the host half; the renderer half polls that
# endpoint and switches the view with uiWorkspace.openSession().
#
# Everything is best-effort: a failure here must never show a dialog or leave a
# console window behind (the registry entry launches it hidden).
param([Parameter(Mandatory = $true)][string]$Uri)

$ErrorActionPreference = "SilentlyContinue"

# ── session id out of the activation URI ────────────────────────────────────
$sid = ""
if ($Uri -match '[?&]sid=([^&]+)') {
  try { $sid = [System.Uri]::UnescapeDataString($matches[1]) } catch { $sid = $matches[1] }
}
if (-not $sid) { exit 1 }

# ── bring the DSH window back ───────────────────────────────────────────────
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class DshNotifyActivate {
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@
$window = Get-Process | Where-Object { $_.ProcessName -eq "DeepSeek Harness" -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($window) {
  # 9 = SW_RESTORE: un-minimizes and activates.
  [void][DshNotifyActivate]::ShowWindowAsync($window.MainWindowHandle, 9)
  Start-Sleep -Milliseconds 120
  [void][DshNotifyActivate]::SetForegroundWindow($window.MainWindowHandle)
}

# ── hand the session id to the running plugin ───────────────────────────────
$ports = @()
$endpoint = Join-Path $env:TEMP "dsh-notify-host\endpoint.json"
if (Test-Path -LiteralPath $endpoint) {
  try {
    $port = (Get-Content -LiteralPath $endpoint -Raw -Encoding UTF8 | ConvertFrom-Json).port
    if ($port) { $ports += [int]$port }
  } catch { }
}
foreach ($candidate in 48235, 48236, 48237, 48238) {
  if ($ports -notcontains $candidate) { $ports += $candidate }
}

$encoded = [System.Uri]::EscapeDataString($sid)
foreach ($port in $ports) {
  try {
    Invoke-RestMethod -Uri "http://127.0.0.1:$port/activate?sid=$encoded" -Method Post -TimeoutSec 2 | Out-Null
    exit 0
  } catch {
    # try the next port
  }
}
exit 1
