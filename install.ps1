# Install dsh-notify into a DeepSeek Harness profile.
#   pwsh -File install.ps1
#   pwsh -File install.ps1 -ProfileDir "D:\other-dsh\.dsh\profiles\desktop"
#   pwsh -File install.ps1 -UnregisterProtocol   # remove only the dshnotify: handler
param(
  [string]$ProfileDir = (Join-Path $env:USERPROFILE ".dsh\profiles\desktop"),
  [switch]$UnregisterProtocol
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$scheme = "dshnotify"
$helperDir = Join-Path $env:LOCALAPPDATA "dsh-notify"
$helper = Join-Path $helperDir "activate.ps1"
$powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$protocolKey = "HKCU:\Software\Classes\$scheme"

if ($UnregisterProtocol) {
  Remove-Item -Path $protocolKey -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -Path $helperDir -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "Removed the ${scheme}: protocol handler."
  return
}

$pkgJson = Join-Path $ProfileDir "package.json"
if (-not (Test-Path $pkgJson)) { throw "No package.json at $ProfileDir" }

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
Copy-Item $pkgJson "$pkgJson.bak-$stamp"

$editor = Join-Path $env:TEMP "dsh-notify-register.mjs"
@"
import { readFileSync, writeFileSync } from "node:fs";
const [file, dir] = process.argv.slice(2);
const pkg = JSON.parse(readFileSync(file, "utf8"));
pkg.dependencies ??= {};
pkg.dependencies["dsh-notify"] = "file:" + dir.replace(/\\/g, "/");
pkg.dsh ??= {};
pkg.dsh.profile ??= {};
pkg.dsh.profile.bundles ??= [];
if (!pkg.dsh.profile.bundles.includes("dsh-notify")) pkg.dsh.profile.bundles.push("dsh-notify");
writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n", "utf8");
console.log("registered dsh-notify ->", pkg.dependencies["dsh-notify"]);
"@ | Set-Content -Path $editor -Encoding UTF8
node $editor $pkgJson $root

$pnpm = Join-Path $env:USERPROFILE ".dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.cjs"
Push-Location $ProfileDir
try {
  if (Test-Path $pnpm) { node $pnpm install } else { pnpm install }
  if ($LASTEXITCODE -ne 0) { throw "pnpm install failed" }
} finally {
  Pop-Location
}

# ── the dshnotify: protocol ──────────────────────────────────────────────────
# A Windows toast cannot call back into the running renderer, so the toast
# activates this scheme instead; the handler hands the session id to the host
# half's loopback endpoint. The host half re-registers this on every start, so
# this block only makes a fresh install work before the first apply.
New-Item -ItemType Directory -Force -Path $helperDir | Out-Null
$activate = Join-Path $root "lib\activate.ps1"
if (-not (Test-Path $activate)) { throw "lib\activate.ps1 missing" }
Copy-Item $activate $helper -Force

New-Item -Path "$protocolKey\shell\open\command" -Force | Out-Null
New-ItemProperty -Path $protocolKey -Name "URL Protocol" -Value "" -PropertyType String -Force | Out-Null
Set-ItemProperty -Path $protocolKey -Name "(default)" -Value "URL:$scheme"
Set-ItemProperty -Path "$protocolKey\DefaultIcon" -Name "(default)" -Value "`"$powershell`",0"
Set-ItemProperty -Path "$protocolKey\shell\open\command" -Name "(default)" `
  -Value "`"$powershell`" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$helper`" `"%1`""

Write-Host ""
Write-Host "Done. Restart DeepSeek Harness, refresh the page, then:"
Write-Host "  dshNotify.test()          # in-app card only (focused window)"
Write-Host "  dshNotify.endpoint()      # host-half diagnostics (port, pending activations)"
Write-Host ""
Write-Host "Toast clicks use the ${scheme}: protocol installed under HKCU; remove it with"
Write-Host "  pwsh -File install.ps1 -UnregisterProtocol"
