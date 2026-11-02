param([string]$Base = 'http://127.0.0.1:55167')

# 桌面控制窗（全局置顶）。纯 PowerShell + WinForms，不需要编译 exe。
# 外观和 DSH 里的浮窗一模一样：深色圆角卡片、标题条、两个「滑动开关」、四个按键。
# 文件必须 UTF-8 BOM，否则 Windows PowerShell 5.1 会把中文读成乱码（直接语法错误）。

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$native = @(
  'using System;',
  'using System.Drawing;',
  'using System.Drawing.Drawing2D;',
  'using System.Windows.Forms;',
  'using System.Runtime.InteropServices;',
  'public class W32 {',
  '  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr c);',
  '  [DllImport("user32.dll")] public static extern bool ReleaseCapture();',
  '  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, IntPtr l);',
  '  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();',
  '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);',
  '}',
  'public class SwitchCtl : Control {',
  '  public bool On = false;',
  '  public SwitchCtl() {',
  '    SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);',
  '    Cursor = Cursors.Hand;',
  '  }',
  '  protected override void OnMouseDown(MouseEventArgs e) {',
  '    base.OnMouseDown(e);',
  '    On = !On;',
  '    Invalidate();',
  '  }',
  '  protected override void OnPaint(PaintEventArgs e) {',
  '    var g = e.Graphics;',
  '    g.SmoothingMode = SmoothingMode.AntiAlias;',
  '    Color track = On ? Color.FromArgb(59, 130, 246) : Color.FromArgb(70, 76, 90);',
  '    int d = Height - 4;',
  '    var path = new GraphicsPath();',
  '    path.AddArc(0, 0, Height, Height, 90, 180);',
  '    path.AddArc(Width - Height, 0, Height, Height, 270, 180);',
  '    path.CloseFigure();',
  '    using (var b = new SolidBrush(track)) g.FillPath(b, path);',
  '    int x = On ? Width - d - 2 : 2;',
  '    using (var b2 = new SolidBrush(Color.FromArgb(232, 234, 239))) g.FillEllipse(b2, x, 2, d, d);',
  '  }',
  '}'
) -join "`n"
try {
  Add-Type -TypeDefinition $native -ReferencedAssemblies System.Windows.Forms, System.Drawing -ErrorAction Stop
} catch {
  $logPath = Join-Path $env:TEMP 'dsh-phone-widget-error.log'
  try { ('Add-Type failed: ' + $_.Exception.Message) | Out-File -FilePath $logPath -Append -Encoding utf8 } catch {}
  throw
}
try { [void][W32]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch {}
try { $ch = [W32]::GetConsoleWindow(); if ($ch -ne [IntPtr]::Zero) { [void][W32]::ShowWindow($ch, 0) } } catch {}

$mutex = New-Object System.Threading.Mutex($false, 'Local\DSHPhoneMirrorWidget')
if (-not $mutex.WaitOne(0)) { exit 0 }

$statePath = Join-Path $env:TEMP 'dsh-phone-widget.json'
$global:syncing = $false

function SaveState {
  try {
    if ($null -ne $form -and $form.WindowState -ne 'Minimized') {
      @{ x = $form.Location.X; y = $form.Location.Y } | ConvertTo-Json -Compress | Set-Content -Path $statePath -Encoding utf8
    }
  } catch {}
}

function Api ([string]$path, $body) {
  try {
    if ($null -eq $body) {
      Invoke-RestMethod -Uri ($Base + $path) -TimeoutSec 3 | Out-Null
    } else {
      Invoke-RestMethod -Uri ($Base + $path) -Method Post -ContentType 'application/json' -Body ($body | ConvertTo-Json -Compress) -TimeoutSec 25 | Out-Null
    }
  } catch { }
}

function GetStatus {
  try { return Invoke-RestMethod -Uri ($Base + '/dsh-dfy-mirror/status') -TimeoutSec 3 } catch { return $null }
}

$card = [System.Drawing.Color]::FromArgb(18, 20, 26)
$barBg = [System.Drawing.Color]::FromArgb(27, 31, 39)
$rowBg = [System.Drawing.Color]::FromArgb(30, 34, 42)
$fg = [System.Drawing.Color]::FromArgb(232, 234, 239)
$dim = [System.Drawing.Color]::FromArgb(150, 158, 172)
$font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
$fontSmall = New-Object System.Drawing.Font('Microsoft YaHei UI', 8)

$form = New-Object System.Windows.Forms.Form
$form.Text = 'dfy蓝色大肥鱼手机镜像'
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.TopMost = $true
$form.MinimizeBox = $true
$form.ShowInTaskbar = $true
$form.BackColor = $card
$form.ClientSize = New-Object System.Drawing.Size(240, 214)

$loc = $null
try { if (Test-Path $statePath) { $saved = Get-Content $statePath -Raw | ConvertFrom-Json; $loc = New-Object System.Drawing.Point([int]$saved.x, [int]$saved.y) } } catch {}
if ($null -eq $loc) {
  $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
  $loc = New-Object System.Drawing.Point(($wa.Right - 310), ($wa.Bottom - 300))
}
$form.Location = $loc

$form.Add_Resize({
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $r = 16
  $w = $form.Width; $h = $form.Height
  $p.AddArc(0, 0, $r, $r, 180, 90)
  $p.AddArc($w - $r - 1, 0, $r, $r, 270, 90)
  $p.AddArc($w - $r - 1, $h - $r - 1, $r, $r, 0, 90)
  $p.AddArc(0, $h - $r - 1, $r, $r, 90, 90)
  $p.CloseAllFigures()
  $form.Region = New-Object System.Drawing.Region($p)
})

$header = New-Object System.Windows.Forms.Panel
$header.SetBounds(0, 0, 240, 32)
$header.BackColor = $barBg
$form.Controls.Add($header)

$title = New-Object System.Windows.Forms.Label
$title.SetBounds(12, 7, 140, 20)
$title.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9, [System.Drawing.FontStyle]::Bold)
$title.ForeColor = $fg
$title.Text = 'dfy蓝色大肥鱼手机镜像'
$header.Controls.Add($title)

$btnClose = New-Object System.Windows.Forms.Label
$btnClose.SetBounds(208, 5, 24, 22)
$btnClose.TextAlign = 'MiddleCenter'
$btnClose.Font = $font
$btnClose.ForeColor = $dim
$btnClose.Text = '✕'
$btnClose.Add_MouseEnter({ $btnClose.ForeColor = [System.Drawing.Color]::White })
$btnClose.Add_MouseLeave({ $btnClose.ForeColor = $dim })
$btnClose.Add_Click({ $form.Close() })
$header.Controls.Add($btnClose)

$btnMin = New-Object System.Windows.Forms.Label
$btnMin.SetBounds(182, 5, 24, 22)
$btnMin.TextAlign = 'MiddleCenter'
$btnMin.Font = $font
$btnMin.ForeColor = $dim
$btnMin.Text = '–'
$btnMin.Add_MouseEnter({ $btnMin.ForeColor = [System.Drawing.Color]::White })
$btnMin.Add_MouseLeave({ $btnMin.ForeColor = $dim })
$btnMin.Add_Click({ $form.WindowState = 'Minimized' })
$header.Controls.Add($btnMin)

function StartFormDrag {
  try {
    [void][W32]::ReleaseCapture()
    [void][W32]::SendMessage($form.Handle, 0xA1, [IntPtr]2, [IntPtr]0)
  } catch {}
  # SendMessage 的移动循环会一直阻塞到松开鼠标，回来时位置已经是新的了
  SaveState
}

# 标题条上所有「不是按钮」的地方都能拖：WinForms 子控件不会把鼠标事件冒泡给父面板，
# 只给 $header 挂 MouseDown 的话，按在标题文字上是拖不动的（之前就是这样）。
$header.Add_MouseDown({ StartFormDrag })
$title.Add_MouseDown({ StartFormDrag })
# 拖完立刻记位置，别等关窗（宿主重启时可能直接 kill，收不到 FormClosing）
$header.Add_MouseUp({ SaveState })
$title.Add_MouseUp({ SaveState })

$lbl = New-Object System.Windows.Forms.Label
$lbl.SetBounds(12, 40, 216, 18)
$lbl.Font = $font
$lbl.ForeColor = $dim
$lbl.Text = '连接中…'
$form.Controls.Add($lbl)

function NewRow ([int]$y) {
  $row = New-Object System.Windows.Forms.Panel
  $row.SetBounds(10, $y, 220, 36)
  $row.BackColor = $rowBg
  $form.Controls.Add($row)
  return $row
}

function NewRowSwitch ([System.Windows.Forms.Panel]$row, [string]$text) {
  $lab = New-Object System.Windows.Forms.Label
  $lab.SetBounds(10, 9, 120, 18)
  $lab.Font = $font
  $lab.ForeColor = $fg
  $lab.Text = $text
  $row.Controls.Add($lab)
  $sw = New-Object SwitchCtl
  $sw.SetBounds(168, 7, 40, 22)
  $row.Controls.Add($sw)
  return $sw
}

$row1 = NewRow 66
$swPower = NewRowSwitch $row1 '投屏'
$row2 = NewRow 108
$swTop = NewRowSwitch $row2 '窗口置顶'

function NewKeyButton ([string]$text, [int]$x, [int]$y, [int]$code) {
  $b = New-Object System.Windows.Forms.Button
  $b.SetBounds($x, $y, 104, 28)
  $b.FlatStyle = 'Flat'
  $b.BackColor = $rowBg
  $b.ForeColor = $fg
  $b.Font = $font
  $b.Text = $text
  $b.FlatAppearance.BorderSize = 0
  $b.FlatAppearance.MouseOverBackColor = [System.Drawing.Color]::FromArgb(40, 45, 56)
  $b.Add_Click({ Api '/dsh-dfy-mirror/key' @{ code = $code } }.GetNewClosure())
  $form.Controls.Add($b)
}
NewKeyButton '← 返回' 10 150 4
NewKeyButton '⌂ 主屏' 126 150 3
NewKeyButton '▣ 多任务' 10 182 187
NewKeyButton '☀ 唤醒' 126 182 224

function Sync {
  $s = GetStatus
  if ($null -eq $s) { $lbl.Text = '连不上宿主'; return }
  $global:syncing = $true
  $swPower.On = [bool]$s.running
  $swPower.Invalidate()
  $swTop.On = [bool]$s.alwaysOnTop
  $swTop.Invalidate()
  $global:syncing = $false
  if ($s.error) {
    $lbl.Text = '出错：' + $s.error
  } elseif ($s.busy) {
    $lbl.Text = '处理中…'
  } elseif ($s.running) {
    if ($s.device) { $lbl.Text = $s.device + ' · 运行中' } else { $lbl.Text = '运行中' }
  } else {
    $lbl.Text = '已停止'
  }
  try { Api '/dsh-dfy-mirror/widget/ping' @{ pid = $PID } } catch {}
}

$swPower.Add_Click({
  if ($global:syncing) { return }
  if ($swPower.On) { Api '/dsh-dfy-mirror/start' @{ } } else { Api '/dsh-dfy-mirror/stop' @{ } }
  Start-Sleep -Milliseconds 300
  Sync
})

$swTop.Add_Click({
  if ($global:syncing) { return }
  Api '/dsh-dfy-mirror/topmost' @{ on = [bool]$swTop.On }
  Start-Sleep -Milliseconds 500
  Sync
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.Add_Tick({ Sync })
$timer.Start()

$form.Add_FormClosing({
  try {
    if ($form.WindowState -ne 'Minimized') {
      @{ x = $form.Location.X; y = $form.Location.Y } | ConvertTo-Json -Compress | Set-Content -Path $statePath -Encoding utf8
    }  } catch {}
})

$form.Add_Shown({ Sync })
[System.Windows.Forms.Application]::Run($form)
$mutex.ReleaseMutex()
