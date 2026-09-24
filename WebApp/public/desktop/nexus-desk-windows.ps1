# Nexus Desk for Windows: a tray companion that keeps a small Nexus window on your desktop.
#
# It opens the Nexus web app as a compact app window of your browser (Edge, Chrome or Brave,
# so you stay signed in exactly as in that browser), and adds from the tray icon:
#   - Keep on top of every app, or behave like a normal window
#   - A hot corner that shows / hides it (pick any corner, or none)
#   - Size presets, start with Windows, uninstall
#
# Installed by install-windows.ps1 into %LOCALAPPDATA%\NexusDesk. Settings: settings.json there.
# Plain PowerShell 5.1 + Windows Forms that ship with Windows: nothing else is installed.

$ErrorActionPreference = 'Stop'
$NexusUrl = '__NEXUS_URL__'
$WidgetUrl = $NexusUrl + '?mode=widget'
$WindowTitle = 'Nexus Widget'   # the widget page's document.title
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$SettingsPath = Join-Path $Here 'settings.json'
$StartupLink = Join-Path ([Environment]::GetFolderPath('Startup')) 'Nexus Desk.lnk'
$MenuLink = Join-Path ([Environment]::GetFolderPath('Programs')) 'Nexus Desk.lnk'

# One copy at a time.
$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\NexusDesk', [ref]$created)
if (-not $created) { exit 0 }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
# A failed action (a closed window, a missing browser) must never take the tray icon down.
[System.Windows.Forms.Application]::SetUnhandledExceptionMode([System.Windows.Forms.UnhandledExceptionMode]::CatchException)
[System.Windows.Forms.Application]::add_ThreadException({ param($s, $e) })
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class NexusWin {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  public static IntPtr Find(string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      StringBuilder sb = new StringBuilder(256);
      GetWindowText(h, sb, 256);
      if (sb.ToString().Contains(title)) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static void OnTop(IntPtr h, bool top) {
    // HWND_TOPMOST / HWND_NOTOPMOST, keep size and position (SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)
    SetWindowPos(h, top ? new IntPtr(-1) : new IntPtr(-2), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
  }
  public static void Resize(IntPtr h, int w, int ht) {
    RECT r; GetWindowRect(h, out r);
    SetWindowPos(h, IntPtr.Zero, r.Left, r.Top, w, ht, 0x0004 | 0x0010); // SWP_NOZORDER | SWP_NOACTIVATE
  }
}
'@

# --- Settings ---------------------------------------------------------------

$script:Cfg = [ordered]@{ onTop = $true; corner = 'off'; browser = ''; welcomed = $false }
if (Test-Path $SettingsPath) {
  try {
    $saved = Get-Content $SettingsPath -Raw | ConvertFrom-Json
    foreach ($k in @('onTop', 'corner', 'browser', 'welcomed')) { if ($null -ne $saved.$k) { $script:Cfg[$k] = $saved.$k } }
  } catch { }
}
function Save-Settings { $script:Cfg | ConvertTo-Json | Set-Content -Path $SettingsPath -Encoding UTF8 }

# --- Browser ----------------------------------------------------------------

function Find-Browser {
  $pf86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
  $all = [ordered]@{
    edge   = @("$pf86\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe")
    chrome = @("$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe", "$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "$pf86\Google\Chrome\Application\chrome.exe")
    brave  = @("$env:LOCALAPPDATA\BraveSoftware\Brave-Browser\Application\brave.exe", "$env:ProgramFiles\BraveSoftware\Brave-Browser\Application\brave.exe")
  }
  $order = @()
  if ($script:Cfg.browser) { $order += $script:Cfg.browser }
  $order += @('edge', 'chrome', 'brave')
  foreach ($name in $order) {
    if (-not $all.Contains($name)) { continue }
    foreach ($p in $all[$name]) { if ($p -and (Test-Path $p)) { return $p } }
  }
  return $null
}

# --- Widget window ----------------------------------------------------------

$script:Hwnd = [IntPtr]::Zero

function Get-Widget {
  if ($script:Hwnd -ne [IntPtr]::Zero -and [NexusWin]::IsWindow($script:Hwnd)) { return $script:Hwnd }
  $script:Hwnd = [NexusWin]::Find($WindowTitle)
  return $script:Hwnd
}

function Open-Widget {
  $exe = Find-Browser
  if (-not $exe) {
    [System.Windows.Forms.MessageBox]::Show('Nexus Desk needs Microsoft Edge, Google Chrome or Brave.', 'Nexus Desk') | Out-Null
    return
  }
  Start-Process -FilePath $exe -ArgumentList @("--app=$WidgetUrl", '--window-size=380,620')
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 250
    if ((Get-Widget) -ne [IntPtr]::Zero) { break }
  }
  Apply-OnTop
}

function Apply-OnTop {
  $h = Get-Widget
  if ($h -ne [IntPtr]::Zero) { [NexusWin]::OnTop($h, [bool]$script:Cfg.onTop) }
}

function Show-Widget {
  $h = Get-Widget
  if ($h -eq [IntPtr]::Zero) { Open-Widget; return }
  [NexusWin]::ShowWindow($h, 9) | Out-Null   # SW_RESTORE
  [NexusWin]::SetForegroundWindow($h) | Out-Null
  Apply-OnTop
}

function Hide-Widget {
  $h = Get-Widget
  if ($h -ne [IntPtr]::Zero) { [NexusWin]::ShowWindow($h, 0) | Out-Null }   # SW_HIDE
}

function Toggle-Widget {
  $h = Get-Widget
  if ($h -ne [IntPtr]::Zero -and [NexusWin]::IsWindowVisible($h) -and -not [NexusWin]::IsIconic($h) -and ([NexusWin]::GetForegroundWindow() -eq $h -or $script:Cfg.onTop)) {
    Hide-Widget
  } else {
    Show-Widget
  }
}

# --- Start with Windows -----------------------------------------------------

function New-Link($path) {
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut($path)
  $lnk.TargetPath = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
  $lnk.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Here\nexus-desk.ps1`""
  $lnk.WorkingDirectory = $Here
  $ico = Join-Path $Here 'nexus.ico'
  if (Test-Path $ico) { $lnk.IconLocation = $ico }
  $lnk.Description = 'Nexus Desk'
  $lnk.Save()
}

# --- Tray -------------------------------------------------------------------

$tray = New-Object System.Windows.Forms.NotifyIcon
$pngPath = Join-Path $Here 'nexus.png'
$tray.Icon = [System.Drawing.SystemIcons]::Application
if (Test-Path $pngPath) {
  try {
    $src = New-Object System.Drawing.Bitmap($pngPath)
    $bmp = New-Object System.Drawing.Bitmap($src, 32, 32)
    $tray.Icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
  } catch { }
}
$tray.Text = 'Nexus Desk'
$menu = New-Object System.Windows.Forms.ContextMenuStrip

$miShow = $menu.Items.Add('Show / hide Nexus')
$miShow.Font = New-Object System.Drawing.Font($miShow.Font, [System.Drawing.FontStyle]::Bold)
$miShow.add_Click({ Toggle-Widget })
$miFull = $menu.Items.Add('Open full Nexus in browser')
$miFull.add_Click({ Start-Process $NexusUrl })
$menu.Items.Add('-') | Out-Null

$miTop = New-Object System.Windows.Forms.ToolStripMenuItem('Keep on top of all apps')
$miTop.Checked = [bool]$script:Cfg.onTop
$miTop.add_Click({
  $script:Cfg.onTop = -not [bool]$script:Cfg.onTop
  $miTop.Checked = [bool]$script:Cfg.onTop
  Save-Settings
  Apply-OnTop
})
$menu.Items.Add($miTop) | Out-Null

$miSize = New-Object System.Windows.Forms.ToolStripMenuItem('Size')
foreach ($s in @(@('Small', 330, 500), @('Medium', 390, 640), @('Large (two-column matrix)', 580, 760))) {
  $it = New-Object System.Windows.Forms.ToolStripMenuItem($s[0])
  $it.Tag = $s
  $it.add_Click({ param($sender) $h = Get-Widget; if ($h -ne [IntPtr]::Zero) { [NexusWin]::Resize($h, $sender.Tag[1], $sender.Tag[2]); Show-Widget } })
  $miSize.DropDownItems.Add($it) | Out-Null
}
$menu.Items.Add($miSize) | Out-Null

$corners = [ordered]@{ off = 'Off'; tl = 'Top left'; tr = 'Top right'; bl = 'Bottom left'; br = 'Bottom right' }
$miCorner = New-Object System.Windows.Forms.ToolStripMenuItem('Hot corner')
foreach ($key in $corners.Keys) {
  $it = New-Object System.Windows.Forms.ToolStripMenuItem($corners[$key])
  $it.Tag = $key
  $it.Checked = ($script:Cfg.corner -eq $key)
  $it.add_Click({
    param($sender)
    $script:Cfg.corner = $sender.Tag
    foreach ($x in $miCorner.DropDownItems) { if ($x -is [System.Windows.Forms.ToolStripMenuItem]) { $x.Checked = ($x.Tag -eq $sender.Tag) } }
    Save-Settings
  })
  $miCorner.DropDownItems.Add($it) | Out-Null
}
$miCorner.DropDownItems.Add('-') | Out-Null
$hint = $miCorner.DropDownItems.Add('Push the pointer into the corner to show or hide Nexus')
$hint.Enabled = $false
$menu.Items.Add($miCorner) | Out-Null

$miStart = New-Object System.Windows.Forms.ToolStripMenuItem('Start with Windows')
$miStart.Checked = (Test-Path $StartupLink)
$miStart.add_Click({
  if (Test-Path $StartupLink) { Remove-Item $StartupLink -Force } else { New-Link $StartupLink }
  $miStart.Checked = (Test-Path $StartupLink)
})
$menu.Items.Add($miStart) | Out-Null
$menu.Items.Add('-') | Out-Null

$miUninstall = $menu.Items.Add('Uninstall Nexus Desk...')
$miUninstall.add_Click({
  $answer = [System.Windows.Forms.MessageBox]::Show(
    'Remove Nexus Desk and its start-with-Windows entry? Your tasks are not touched: they stay in Nexus and in your Google Drive backup.',
    'Uninstall Nexus Desk', 'OKCancel', 'Question')
  if ($answer -ne 'OK') { return }
  foreach ($p in @($StartupLink, $MenuLink)) { if (Test-Path $p) { Remove-Item $p -Force } }
  $tray.Visible = $false
  # The folder is removed a moment after this script exits.
  Start-Process -WindowStyle Hidden -FilePath 'cmd.exe' -ArgumentList "/c timeout /t 2 >nul & rmdir /s /q `"$Here`""
  [System.Windows.Forms.Application]::Exit()
})
$miQuit = $menu.Items.Add('Quit Nexus Desk')
$miQuit.add_Click({ $tray.Visible = $false; [System.Windows.Forms.Application]::Exit() })

$tray.ContextMenuStrip = $menu
$tray.add_MouseClick({ param($s, $e) if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Toggle-Widget } })
$tray.Visible = $true

# --- Hot corner -------------------------------------------------------------

$script:Dwell = 0
$script:Armed = $true
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 120
$timer.add_Tick({
  $c = $script:Cfg.corner
  if ($c -eq 'off') { return }
  $p = [System.Windows.Forms.Cursor]::Position
  $b = [System.Windows.Forms.Screen]::FromPoint($p).Bounds
  $left = $p.X -le $b.Left + 1
  $right = $p.X -ge $b.Right - 2
  $top = $p.Y -le $b.Top + 1
  $bottom = $p.Y -ge $b.Bottom - 2
  $hit = ($c -eq 'tl' -and $left -and $top) -or ($c -eq 'tr' -and $right -and $top) -or ($c -eq 'bl' -and $left -and $bottom) -or ($c -eq 'br' -and $right -and $bottom)
  if ($hit) {
    $script:Dwell += $timer.Interval
    if ($script:Armed -and $script:Dwell -ge 250) { $script:Armed = $false; Toggle-Widget }
  } else {
    $script:Dwell = 0
    $script:Armed = $true
  }
})
$timer.Start()

$ErrorActionPreference = 'Continue'
Show-Widget
if (-not $script:Cfg.welcomed) {
  # Once, on the first run only.
  $tray.ShowBalloonTip(5000, 'Nexus Desk', 'Nexus is in the tray (^ by the clock). Click it to show or hide; right-click for options.', 'Info')
  $script:Cfg.welcomed = $true
  Save-Settings
}
[System.Windows.Forms.Application]::Run()
$timer.Stop()
$tray.Dispose()
$mutex.ReleaseMutex()
