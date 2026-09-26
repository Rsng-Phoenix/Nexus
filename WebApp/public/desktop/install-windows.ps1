# Nexus Desk for Windows - installer.
#
#   Install / update (PowerShell):  irm https://rsng-phoenix.github.io/Nexus/desktop/install-windows.ps1 | iex
#   Uninstall: right-click the Nexus tray icon > Uninstall Nexus Desk
#
# What it does (no admin rights needed):
#   1. downloads nexus-desk-windows.ps1 (a short, readable script) and the Nexus icon into
#      %LOCALAPPDATA%\NexusDesk,
#   2. adds Start menu and start-with-Windows shortcuts,
#   3. starts it: the Nexus icon appears in the tray and a small Nexus window opens.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$NexusUrl = $env:NEXUS_URL
if (-not $NexusUrl) { $NexusUrl = 'https://rsng-phoenix.github.io/Nexus/' }
if (-not $NexusUrl.EndsWith('/')) { $NexusUrl += '/' }
$Dir = Join-Path $env:LOCALAPPDATA 'NexusDesk'
$Script = Join-Path $Dir 'nexus-desk.ps1'

function Say($text) { Write-Host $text -ForegroundColor Cyan }

Say 'Installing Nexus Desk...'
New-Item -ItemType Directory -Force -Path $Dir | Out-Null

# Stop a running copy so it can be replaced.
Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*NexusDesk\nexus-desk.ps1*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

$code = (Invoke-WebRequest -UseBasicParsing -Uri ($NexusUrl + 'desktop/nexus-desk-windows.ps1')).Content
if ($code -is [byte[]]) { $code = [System.Text.Encoding]::UTF8.GetString($code) }
if ($code -notmatch 'Nexus Desk for Windows') { throw 'Download failed (unexpected content).' }
$code = $code.Replace('__NEXUS_URL__', $NexusUrl.Replace("'", "''"))
[System.IO.File]::WriteAllText($Script, $code, (New-Object System.Text.UTF8Encoding($true)))

# Icon: the PNG for the tray, and an .ico (PNG inside) for the shortcuts.
$png = Join-Path $Dir 'nexus.png'
try {
  Invoke-WebRequest -UseBasicParsing -Uri ($NexusUrl + 'icons/icon-192.png') -OutFile $png
  $bytes = [System.IO.File]::ReadAllBytes($png)
  $ms = New-Object System.IO.MemoryStream
  $w = New-Object System.IO.BinaryWriter($ms)
  $w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]1)          # ICONDIR: 1 image
  $w.Write([byte]192); $w.Write([byte]192); $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([uint16]1); $w.Write([uint16]32); $w.Write([uint32]$bytes.Length); $w.Write([uint32]22)
  $w.Write($bytes)
  [System.IO.File]::WriteAllBytes((Join-Path $Dir 'nexus.ico'), $ms.ToArray())
} catch { }
Get-ChildItem $Dir | Unblock-File -ErrorAction SilentlyContinue

function New-Link($path) {
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut($path)
  $lnk.TargetPath = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
  $lnk.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Script`""
  $lnk.WorkingDirectory = $Dir
  $ico = Join-Path $Dir 'nexus.ico'
  if (Test-Path $ico) { $lnk.IconLocation = $ico }
  $lnk.Description = 'Nexus Desk'
  $lnk.Save()
}
New-Link (Join-Path ([Environment]::GetFolderPath('Programs')) 'Nexus Desk.lnk')
New-Link (Join-Path ([Environment]::GetFolderPath('Startup')) 'Nexus Desk.lnk')

Start-Process -WindowStyle Hidden -FilePath "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" `
  -ArgumentList @('-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', "`"$Script`"")

Say 'Nexus Desk is running. Look for the Nexus icon in the tray (^ next to the clock).'
Write-Host '  - Left-click: show / hide Nexus.  Right-click: keep on top, size, hot corner, start with Windows.'
Write-Host '  - Ctrl+Alt+N from any app opens Quick Add (right-click > Shortcut > Change shortcut... to pick your own).'
Write-Host '  - Right-click > Open full Nexus: the whole app in its own window, signed in as in your browser.'
Write-Host '  - It uses your browser (Edge, Chrome or Brave), so you stay signed in as you are there.'
Write-Host '  - Windows 11 widgets board: open Nexus in Edge > ... > Apps > Install, then Win + W > Add widgets > Nexus.'
