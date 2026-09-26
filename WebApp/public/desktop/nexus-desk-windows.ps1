# Nexus Desk for Windows: a tray companion that keeps a small Nexus window on your desktop.
#
# It opens the Nexus web app as a compact app window of your browser (Edge, Chrome or Brave,
# so you stay signed in exactly as in that browser), and adds from the tray icon:
#   - Keep on top of every app, or behave like a normal window
#   - A hot corner that shows / hides it (pick any corner, or none)
#   - What the main window shows, and an optional separate calendar window
#   - Size presets, start with Windows, uninstall
#   - Ctrl+Alt+N from any app: Nexus comes forward with the add field ready
#
# Installed by install-windows.ps1 into %LOCALAPPDATA%\NexusDesk. Settings: settings.json there.
# Plain PowerShell 5.1 + Windows Forms that ship with Windows: nothing else is installed.

$ErrorActionPreference = 'Stop'
$NexusUrl = '__NEXUS_URL__'
$WidgetUrl = $NexusUrl + '?mode=widget'
$WindowTitle = 'Nexus Widget'             # the widget page's document.title
$CalendarTitle = 'Nexus Calendar Widget'   # the separate calendar window's title
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
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr w, IntPtr l);
  public static void Close(IntPtr h) { PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero); } // WM_CLOSE
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

/// Ctrl+Alt+N from any app. A registered hot key: Windows tells us, nothing is polled.
public class NexusHotKey : System.Windows.Forms.NativeWindow, IDisposable {
  [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr h, int id, uint mods, uint vk);
  [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr h, int id);
  public event EventHandler Pressed;
  public bool Registered;
  public NexusHotKey() { CreateHandle(new System.Windows.Forms.CreateParams()); }
  // MOD_ALT | MOD_CONTROL | MOD_NOREPEAT, and the N key.
  public bool Register() { if (!Registered) Registered = RegisterHotKey(Handle, 1, 0x0001 | 0x0002 | 0x4000, 0x4E); return Registered; }
  public void Unregister() { if (Registered) UnregisterHotKey(Handle, 1); Registered = false; }
  protected override void WndProc(ref System.Windows.Forms.Message m) {
    if (m.Msg == 0x0312) { var p = Pressed; if (p != null) p(this, EventArgs.Empty); } // WM_HOTKEY
    base.WndProc(ref m);
  }
  public void Dispose() { Unregister(); DestroyHandle(); }
}

/// Hot corner, checked in compiled code: PowerShell only runs when the corner is actually hit.
/// The timer runs only while a corner is chosen.
public class CornerWatcher {
  public event EventHandler Hit;
  readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
  string corner = "off";
  int dwell;
  bool armed = true;
  public int DwellMs = 250;
  public CornerWatcher() { timer.Interval = 150; timer.Tick += (s, e) => Check(); }
  public void SetCorner(string c) {
    corner = c ?? "off"; dwell = 0; armed = true;
    if (corner == "off") timer.Stop(); else timer.Start();
  }
  void Check() {
    var p = System.Windows.Forms.Cursor.Position;
    var b = System.Windows.Forms.Screen.FromPoint(p).Bounds;
    bool left = p.X <= b.Left + 1, right = p.X >= b.Right - 2, top = p.Y <= b.Top + 1, bottom = p.Y >= b.Bottom - 2;
    bool hit = (corner == "tl" && left && top) || (corner == "tr" && right && top) || (corner == "bl" && left && bottom) || (corner == "br" && right && bottom);
    if (!hit) { dwell = 0; armed = true; return; }
    dwell += timer.Interval;
    if (armed && dwell >= DwellMs) { armed = false; var h = Hit; if (h != null) h(this, EventArgs.Empty); }
  }
}
'@ -ReferencedAssemblies System.Windows.Forms, System.Drawing

# --- Settings ---------------------------------------------------------------

$script:Cfg = [ordered]@{ onTop = $true; corner = 'off'; browser = ''; welcomed = $false; mainView = 'tabs'; calWindow = $false; hotKey = $true }
if (Test-Path $SettingsPath) {
  try {
    $saved = Get-Content $SettingsPath -Raw | ConvertFrom-Json
    foreach ($k in @('onTop', 'corner', 'browser', 'welcomed', 'mainView', 'calWindow', 'hotKey')) { if ($null -ne $saved.$k) { $script:Cfg[$k] = $saved.$k } }
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
$script:CalHwnd = [IntPtr]::Zero

function Main-Url {
  if ($script:Cfg.mainView -eq 'matrix' -or $script:Cfg.mainView -eq 'today') { return $WidgetUrl + '&view=' + $script:Cfg.mainView }
  return $WidgetUrl
}

function Get-Widget {
  if ($script:Hwnd -ne [IntPtr]::Zero -and [NexusWin]::IsWindow($script:Hwnd)) { return $script:Hwnd }
  $script:Hwnd = [NexusWin]::Find($WindowTitle)
  return $script:Hwnd
}

function Get-Calendar {
  if ($script:CalHwnd -ne [IntPtr]::Zero -and [NexusWin]::IsWindow($script:CalHwnd)) { return $script:CalHwnd }
  $script:CalHwnd = [NexusWin]::Find($CalendarTitle)
  return $script:CalHwnd
}

function Open-AppWindow($url, [scriptblock]$find) {
  $exe = Find-Browser
  if (-not $exe) {
    [System.Windows.Forms.MessageBox]::Show('Nexus Desk needs Microsoft Edge, Google Chrome or Brave.', 'Nexus Desk') | Out-Null
    return
  }
  Start-Process -FilePath $exe -ArgumentList @("--app=$url", '--window-size=380,620')
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 250
    if ((& $find) -ne [IntPtr]::Zero) { break }
  }
  Apply-OnTop
}

function Open-Widget { Open-AppWindow (Main-Url) { Get-Widget } }
function Open-Calendar { Open-AppWindow ($WidgetUrl + '&view=calendar') { Get-Calendar } }

function Apply-OnTop {
  foreach ($h in @((Get-Widget), (Get-Calendar))) {
    if ($h -ne [IntPtr]::Zero) { [NexusWin]::OnTop($h, [bool]$script:Cfg.onTop) }
  }
}

function Show-Widget {
  if ([bool]$script:Cfg.calWindow) {
    $c = Get-Calendar
    if ($c -eq [IntPtr]::Zero) { Open-Calendar } else { [NexusWin]::ShowWindow($c, 9) | Out-Null }
  }
  $h = Get-Widget
  if ($h -eq [IntPtr]::Zero) { Open-Widget; return }
  [NexusWin]::ShowWindow($h, 9) | Out-Null   # SW_RESTORE
  [NexusWin]::SetForegroundWindow($h) | Out-Null
  Apply-OnTop
}

function Hide-Widget {
  foreach ($h in @((Get-Widget), (Get-Calendar))) {
    if ($h -ne [IntPtr]::Zero) { [NexusWin]::ShowWindow($h, 0) | Out-Null }   # SW_HIDE
  }
}

function Close-Calendar {
  $c = Get-Calendar
  if ($c -ne [IntPtr]::Zero) { [NexusWin]::ShowWindow($c, 0) | Out-Null; [NexusWin]::Close($c) }
  $script:CalHwnd = [IntPtr]::Zero
}

function Toggle-Widget {
  $h = Get-Widget
  if ($h -ne [IntPtr]::Zero -and [NexusWin]::IsWindowVisible($h) -and -not [NexusWin]::IsIconic($h) -and ([NexusWin]::GetForegroundWindow() -eq $h -or $script:Cfg.onTop)) {
    Hide-Widget
  } else {
    Show-Widget
  }
}

# The page focuses its add field when it gets an "n" (and it isn't typing somewhere already).
function Quick-Add {
  $h = Get-Widget
  $fresh = $h -eq [IntPtr]::Zero
  Show-Widget
  $h = Get-Widget
  if ($h -eq [IntPtr]::Zero) { return }
  Start-Sleep -Milliseconds $(if ($fresh) { 1500 } else { 250 })
  [NexusWin]::SetForegroundWindow($h) | Out-Null
  if ([NexusWin]::GetForegroundWindow() -eq $h) { [System.Windows.Forms.SendKeys]::SendWait('n') }
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
$miAdd = $menu.Items.Add('New task    Ctrl+Alt+N')
$miAdd.add_Click({ Quick-Add })
$miFull = $menu.Items.Add('Open full Nexus')
# The same browser as the widget, so you're signed in the same way.
$miFull.add_Click({ $exe = Find-Browser; if ($exe) { Start-Process -FilePath $exe -ArgumentList @($NexusUrl) } else { Start-Process $NexusUrl } })
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

$views = [ordered]@{ tabs = 'All views (Matrix, Today, Calendar)'; matrix = 'Matrix only'; today = 'Today only' }
$miView = New-Object System.Windows.Forms.ToolStripMenuItem('Main window shows')
foreach ($key in $views.Keys) {
  $it = New-Object System.Windows.Forms.ToolStripMenuItem($views[$key])
  $it.Tag = $key
  $it.Checked = ($script:Cfg.mainView -eq $key)
  $it.add_Click({
    param($sender)
    $script:Cfg.mainView = $sender.Tag
    foreach ($x in $miView.DropDownItems) { $x.Checked = ($x.Tag -eq $sender.Tag) }
    Save-Settings
    # Reopen the main window on its new view.
    $h = Get-Widget
    if ($h -ne [IntPtr]::Zero) { [NexusWin]::Close($h); $script:Hwnd = [IntPtr]::Zero; Start-Sleep -Milliseconds 400 }
    Show-Widget
  })
  $miView.DropDownItems.Add($it) | Out-Null
}
$menu.Items.Add($miView) | Out-Null

$miCal = New-Object System.Windows.Forms.ToolStripMenuItem('Separate calendar window')
$miCal.Checked = [bool]$script:Cfg.calWindow
$miCal.add_Click({
  $script:Cfg.calWindow = -not [bool]$script:Cfg.calWindow
  $miCal.Checked = [bool]$script:Cfg.calWindow
  Save-Settings
  if ($script:Cfg.calWindow) { Show-Widget } else { Close-Calendar }
})
$menu.Items.Add($miCal) | Out-Null

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
    $watcher.SetCorner($script:Cfg.corner)
  })
  $miCorner.DropDownItems.Add($it) | Out-Null
}
$miCorner.DropDownItems.Add('-') | Out-Null
$hint = $miCorner.DropDownItems.Add('Push the pointer into the corner to show or hide Nexus')
$hint.Enabled = $false
$menu.Items.Add($miCorner) | Out-Null

$miKey = New-Object System.Windows.Forms.ToolStripMenuItem('Ctrl+Alt+N adds a task from any app')
$miKey.Checked = [bool]$script:Cfg.hotKey
$miKey.add_Click({
  $script:Cfg.hotKey = -not [bool]$script:Cfg.hotKey
  if ($script:Cfg.hotKey) { [void]$hotKey.Register() } else { $hotKey.Unregister() }
  $miKey.Checked = $hotKey.Registered
  Save-Settings
})
$menu.Items.Add($miKey) | Out-Null

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

$watcher = New-Object CornerWatcher
$watcher.add_Hit({ Toggle-Widget })
$watcher.SetCorner($script:Cfg.corner)

# --- Ctrl+Alt+N -------------------------------------------------------------

$hotKey = New-Object NexusHotKey
$hotKey.add_Pressed({ Quick-Add })
# Another app may already own the combination: the menu item then shows unticked.
if ([bool]$script:Cfg.hotKey) { [void]$hotKey.Register() }
$miKey.Checked = $hotKey.Registered

$ErrorActionPreference = 'Continue'
Show-Widget
if (-not $script:Cfg.welcomed) {
  # Once, on the first run only.
  $tray.ShowBalloonTip(5000, 'Nexus Desk', 'Nexus is in the tray (^ by the clock). Click it to show or hide; right-click for options.', 'Info')
  $script:Cfg.welcomed = $true
  Save-Settings
}
[System.Windows.Forms.Application]::Run()
$watcher.SetCorner('off')
$hotKey.Dispose()
$tray.Dispose()
$mutex.ReleaseMutex()
