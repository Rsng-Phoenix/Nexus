# Nexus Desk for Windows: a tray companion that keeps a small Nexus window on your desktop.
#
# It opens the Nexus web app as a compact app window of your browser (Edge, Chrome or Brave,
# so you stay signed in exactly as in that browser), and adds from the tray icon:
#   - Keep on top of every app, or behave like a normal window
#   - A hot corner that shows / hides it (pick any corner, or none)
#   - What the main window shows, and an optional separate calendar window
#   - Size presets, start with Windows, uninstall
#   - A shortcut you choose (Ctrl+Alt+N by default) from any app: a Quick Add window in the
#     middle of the screen, or the widget with its add field ready
#   - Open full Nexus: the whole app as its own browser app window
#
# Installed by install-windows.ps1 into %LOCALAPPDATA%\NexusDesk. Settings: settings.json there.
# Plain PowerShell 5.1 + Windows Forms that ship with Windows: nothing else is installed.

$ErrorActionPreference = 'Stop'
$NexusUrl = '__NEXUS_URL__'
$WidgetUrl = $NexusUrl + '?mode=widget'
$QuickUrl = $NexusUrl + '?mode=quickadd&from=br'
$WindowTitle = 'Nexus Widget'             # the widget page's document.title
$CalendarTitle = 'Nexus Calendar Widget'   # the separate calendar window's title
$FullTitle = 'Nexus'                       # the full app's title (starts with it; never "Widget" / "Quick")
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
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
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
  /// A visible window whose title starts with prefix and contains none of the excluded words.
  public static IntPtr FindPrefix(string prefix, string[] exclude) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      StringBuilder sb = new StringBuilder(256);
      GetWindowText(h, sb, 256);
      string t = sb.ToString();
      if (!t.StartsWith(prefix)) return true;
      foreach (string x in exclude) { if (t.Contains(x)) return true; }
      found = h; return false;
    }, IntPtr.Zero);
    return found;
  }
  /// Is the Windows key held right now (the recorder can't see it through KeyEventArgs)?
  public static bool WinKeyDown() { return (GetAsyncKeyState(0x5B) & 0x8000) != 0 || (GetAsyncKeyState(0x5C) & 0x8000) != 0; }
  public static void OnTop(IntPtr h, bool top) {
    // HWND_TOPMOST / HWND_NOTOPMOST, keep size and position (SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)
    SetWindowPos(h, top ? new IntPtr(-1) : new IntPtr(-2), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
  }
  public static void Resize(IntPtr h, int w, int ht) {
    RECT r; GetWindowRect(h, out r);
    SetWindowPos(h, IntPtr.Zero, r.Left, r.Top, w, ht, 0x0004 | 0x0010); // SWP_NOZORDER | SWP_NOACTIVATE
  }
}

/// The shortcut (Ctrl+Alt+N by default) from any app. A registered hot key: Windows tells us, nothing is polled.
public class NexusHotKey : System.Windows.Forms.NativeWindow, IDisposable {
  [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr h, int id, uint mods, uint vk);
  [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr h, int id);
  public event EventHandler Pressed;
  public bool Registered;
  public NexusHotKey() { CreateHandle(new System.Windows.Forms.CreateParams()); }
  // mods: MOD_ALT 1 | MOD_CONTROL 2 | MOD_SHIFT 4 | MOD_WIN 8 (MOD_NOREPEAT is added); vk: a virtual key code.
  public bool Register(uint mods, uint vk) { if (!Registered) Registered = RegisterHotKey(Handle, 1, mods | 0x4000, vk); return Registered; }
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

# hotMods / hotVk: the shortcut (MOD_CONTROL | MOD_ALT, N); quickAddStyle: what it opens ('panel' | 'widget').
# quickW / quickH / fullW / fullH: window sizes in pixels (edit here; the pages fit any size).
$script:Cfg = [ordered]@{
  onTop = $true; corner = 'off'; browser = ''; welcomed = $false; mainView = 'tabs'; calWindow = $false
  hotKey = $true; hotMods = 3; hotVk = 0x4E; quickAddStyle = 'panel'
  quickW = 680; quickH = 440; fullW = 1040; fullH = 720
}
if (Test-Path $SettingsPath) {
  try {
    $saved = Get-Content $SettingsPath -Raw | ConvertFrom-Json
    foreach ($k in @($script:Cfg.Keys)) { if ($null -ne $saved.$k) { $script:Cfg[$k] = $saved.$k } }
  } catch { }
}
foreach ($k in @('hotMods', 'hotVk', 'quickW', 'quickH', 'fullW', 'fullH')) { $script:Cfg[$k] = [int]$script:Cfg[$k] }
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

# --- Quick Add window and the full app ---------------------------------------

# A Spotlight-like app window in the middle of the screen under the pointer (top edge at 22 %);
# the page closes itself with window.close() when a task is added or Esc is pressed.
function Show-QuickAdd {
  $exe = Find-Browser
  if (-not $exe) { Quick-Add; return }
  $wa = [System.Windows.Forms.Screen]::FromPoint([System.Windows.Forms.Cursor]::Position).WorkingArea
  $w = $script:Cfg.quickW
  $h = $script:Cfg.quickH
  $x = $wa.Left + [int](($wa.Width - $w) / 2)
  $y = $wa.Top + [int]($wa.Height * 0.22)
  Start-Process -FilePath $exe -ArgumentList @("--app=$QuickUrl", "--window-size=$w,$h", "--window-position=$x,$y")
}

$script:FullHwnd = [IntPtr]::Zero
function Get-Full {
  if ($script:FullHwnd -ne [IntPtr]::Zero -and [NexusWin]::IsWindow($script:FullHwnd)) { return $script:FullHwnd }
  $script:FullHwnd = [NexusWin]::FindPrefix($FullTitle, [string[]]@('Widget', 'Quick'))
  return $script:FullHwnd
}

# The whole Nexus app as a normal (never topmost) app window of the same browser: same sign-in.
function Open-Full {
  $h = Get-Full
  if ($h -ne [IntPtr]::Zero) {
    [NexusWin]::ShowWindow($h, 9) | Out-Null   # SW_RESTORE
    [NexusWin]::SetForegroundWindow($h) | Out-Null
    return
  }
  $exe = Find-Browser
  if (-not $exe) { Start-Process $NexusUrl; return }
  Start-Process -FilePath $exe -ArgumentList @("--app=$NexusUrl", "--window-size=$($script:Cfg.fullW),$($script:Cfg.fullH)")
}

# The shortcut was pressed: the Quick Add window, or the widget's add field ("Shortcut opens").
function HotKey-Pressed {
  if ($script:Cfg.quickAddStyle -eq 'widget') { Quick-Add } else { Show-QuickAdd }
}

# --- The shortcut: label and recorder --------------------------------------------

function Get-KeyName([int]$vk) {
  if ($vk -ge 0x30 -and $vk -le 0x39) { return [string][char]$vk }   # D0..D9 print as 0..9
  $name = ([System.Windows.Forms.Keys]$vk).ToString()
  switch ($name) {
    'Oemplus' { return '=' }
    'OemMinus' { return '-' }
    'Oemcomma' { return ',' }
    'OemPeriod' { return '.' }
    'OemQuestion' { return '/' }
    'Oemtilde' { return '`' }
    'OemOpenBrackets' { return '[' }
    'Oem6' { return ']' }
    'Oem1' { return ';' }
    'Oem7' { return "'" }
    'Return' { return 'Enter' }
    'Back' { return 'Backspace' }
    'Next' { return 'PageDown' }
    'Prior' { return 'PageUp' }
    default { return $name }
  }
}

# "Ctrl+Alt+N": MOD_CONTROL 2 · MOD_ALT 1 · MOD_SHIFT 4 · MOD_WIN 8, then the key.
function Get-HotKeyLabel([int]$mods, [int]$vk) {
  $parts = @()
  if ($mods -band 2) { $parts += 'Ctrl' }
  if ($mods -band 1) { $parts += 'Alt' }
  if ($mods -band 4) { $parts += 'Shift' }
  if ($mods -band 8) { $parts += 'Win' }
  $parts += (Get-KeyName $vk)
  return ($parts -join '+')
}

function Get-CurrentHotKeyLabel { return (Get-HotKeyLabel $script:Cfg.hotMods $script:Cfg.hotVk) }

# Menu texts that name the shortcut; refreshed after the recorder saves a new one.
function Update-HotKeyLabels {
  $label = Get-CurrentHotKeyLabel
  $miAdd.Text = 'New task    ' + $label
  $miKey.Text = $label + ' adds a task from any app'
  $miKey.Checked = $hotKey.Registered
}

# "Change shortcut...": press a combination with Ctrl, Alt or Win; Enter saves, Esc cancels.
function Show-ShortcutRecorder {
  $form = New-Object System.Windows.Forms.Form
  $form.Text = 'Nexus shortcut'
  $form.ClientSize = New-Object System.Drawing.Size(360, 170)
  $form.StartPosition = 'CenterScreen'
  $form.FormBorderStyle = 'FixedDialog'
  $form.MaximizeBox = $false
  $form.MinimizeBox = $false
  $form.TopMost = $true
  $form.KeyPreview = $true
  $title = New-Object System.Windows.Forms.Label
  $title.Text = 'Press the new shortcut'
  $title.Font = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
  $title.Location = New-Object System.Drawing.Point(16, 14)
  $title.AutoSize = $true
  $box = New-Object System.Windows.Forms.TextBox
  $box.ReadOnly = $true
  $box.Location = New-Object System.Drawing.Point(16, 42)
  $box.Width = 328
  $box.Font = New-Object System.Drawing.Font('Segoe UI', 16)
  $box.TextAlign = 'Center'
  $box.Text = Get-CurrentHotKeyLabel
  $msg = New-Object System.Windows.Forms.Label
  $msg.Text = 'Use Ctrl, Alt or Win with a key. Esc cancels, Enter saves.'
  $msg.Location = New-Object System.Drawing.Point(16, 90)
  $msg.Size = New-Object System.Drawing.Size(328, 34)
  $ok = New-Object System.Windows.Forms.Button
  $ok.Text = 'Save'
  $ok.Location = New-Object System.Drawing.Point(256, 130)
  $ok.Size = New-Object System.Drawing.Size(88, 28)
  $cancel = New-Object System.Windows.Forms.Button
  $cancel.Text = 'Cancel'
  $cancel.Location = New-Object System.Drawing.Point(160, 130)
  $cancel.Size = New-Object System.Drawing.Size(88, 28)
  $cancel.DialogResult = 'Cancel'
  $form.CancelButton = $cancel
  $form.Controls.AddRange(@($title, $box, $msg, $ok, $cancel))
  $script:RecMods = -1
  $script:RecVk = 0
  $box.add_KeyDown({
    param($s, $e)
    $e.SuppressKeyPress = $true
    $e.Handled = $true
    $code = [int]$e.KeyCode
    if ($code -eq 27 -and $e.Modifiers -eq 'None') { $form.DialogResult = 'Cancel'; $form.Close(); return }
    if ($code -eq 13 -and $e.Modifiers -eq 'None') { $ok.PerformClick(); return }
    # A modifier on its own (Shift, Ctrl, Alt, Win) is not a shortcut yet.
    if ($code -in @(16, 17, 18, 91, 92, 160, 161, 162, 163, 164, 165)) { return }
    $m = 0
    if ($e.Control) { $m = $m -bor 2 }
    if ($e.Alt) { $m = $m -bor 1 }
    if ($e.Shift) { $m = $m -bor 4 }
    if ([NexusWin]::WinKeyDown()) { $m = $m -bor 8 }
    $script:RecMods = $m
    $script:RecVk = $code
    $box.Text = Get-HotKeyLabel $m $code
    if (($m -band 11) -eq 0) { $msg.Text = 'Include Ctrl, Alt or Win so typing is not affected.' } else { $msg.Text = 'Enter saves, Esc cancels.' }
  })
  $ok.add_Click({
    if ($script:RecMods -lt 0) { $form.DialogResult = 'Cancel'; $form.Close(); return }   # nothing recorded: keep the current one
    if (($script:RecMods -band 11) -eq 0) { $msg.Text = 'Include Ctrl, Alt or Win so typing is not affected.'; return }
    $hotKey.Unregister()
    if ($hotKey.Register([uint32]$script:RecMods, [uint32]$script:RecVk)) {
      $script:Cfg.hotMods = $script:RecMods
      $script:Cfg.hotVk = $script:RecVk
      $script:Cfg.hotKey = $true
      Save-Settings
      Update-HotKeyLabels
      $form.DialogResult = 'OK'
      $form.Close()
      return
    }
    # Taken by another app: back to the old one, the dialog stays up with the reason.
    $msg.Text = (Get-HotKeyLabel $script:RecMods $script:RecVk) + ' is used by another app. Try a different key.'
    if ($script:Cfg.hotKey) { [void]$hotKey.Register([uint32]$script:Cfg.hotMods, [uint32]$script:Cfg.hotVk) }
  })
  $form.add_Shown({ $box.Focus() | Out-Null })
  [void]$form.ShowDialog()
  $form.Dispose()
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
$miAdd = $menu.Items.Add('New task    ' + (Get-CurrentHotKeyLabel))
$miAdd.add_Click({ HotKey-Pressed })
$miFull = $menu.Items.Add('Open full Nexus')
# The same browser as the widget, so you're signed in the same way.
$miFull.add_Click({ Open-Full })
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

# Shortcut > on/off, change, what it opens
$miShortcut = New-Object System.Windows.Forms.ToolStripMenuItem('Shortcut')
$miKey = New-Object System.Windows.Forms.ToolStripMenuItem((Get-CurrentHotKeyLabel) + ' adds a task from any app')
$miKey.Checked = [bool]$script:Cfg.hotKey
$miKey.add_Click({
  $script:Cfg.hotKey = -not [bool]$script:Cfg.hotKey
  if ($script:Cfg.hotKey) { [void]$hotKey.Register([uint32]$script:Cfg.hotMods, [uint32]$script:Cfg.hotVk) } else { $hotKey.Unregister() }
  $miKey.Checked = $hotKey.Registered
  Save-Settings
})
$miShortcut.DropDownItems.Add($miKey) | Out-Null
$miChange = New-Object System.Windows.Forms.ToolStripMenuItem('Change shortcut...')
$miChange.add_Click({ Show-ShortcutRecorder })
$miShortcut.DropDownItems.Add($miChange) | Out-Null
$miShortcut.DropDownItems.Add('-') | Out-Null
$styles = [ordered]@{ panel = 'Quick Add window'; widget = 'The widget' }
$miStyle = New-Object System.Windows.Forms.ToolStripMenuItem('Shortcut opens')
foreach ($key in $styles.Keys) {
  $it = New-Object System.Windows.Forms.ToolStripMenuItem($styles[$key])
  $it.Tag = $key
  $it.Checked = ($script:Cfg.quickAddStyle -eq $key)
  $it.add_Click({
    param($sender)
    $script:Cfg.quickAddStyle = $sender.Tag
    foreach ($x in $miStyle.DropDownItems) { $x.Checked = ($x.Tag -eq $sender.Tag) }
    Save-Settings
  })
  $miStyle.DropDownItems.Add($it) | Out-Null
}
$miShortcut.DropDownItems.Add($miStyle) | Out-Null
$menu.Items.Add($miShortcut) | Out-Null

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

# --- The shortcut -------------------------------------------------------------

$hotKey = New-Object NexusHotKey
$hotKey.add_Pressed({ HotKey-Pressed })
# Another app may already own the combination: the menu item then shows unticked.
if ([bool]$script:Cfg.hotKey) { [void]$hotKey.Register([uint32]$script:Cfg.hotMods, [uint32]$script:Cfg.hotVk) }
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
