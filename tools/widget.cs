// 桌面控制窗：一个小的 WinForms 程序（不是 PowerShell，进程里只有 PhoneMirrorWidget.exe）。
// 交互和 DSH 里的浮窗一样：标题条可拖、两个滑动开关（投屏/置顶）、四个按键。
// 通过 HTTP 调本机插件：/status、/start、/stop、/topmost、/key、/widget/ping。
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;
using System.Runtime.InteropServices;

public class SwitchCtl : Control
{
    public bool On = false;
    public SwitchCtl()
    {
        SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
        Cursor = Cursors.Hand;
    }
    protected override void OnMouseDown(MouseEventArgs e)
    {
        base.OnMouseDown(e);
        On = !On;
        Invalidate();
    }
    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        Color track = On ? Color.FromArgb(59, 130, 246) : Color.FromArgb(70, 76, 90);
        int d = Height - 4;
        var path = new GraphicsPath();
        path.AddArc(0, 0, Height, Height, 90, 180);
        path.AddArc(Width - Height, 0, Height, Height, 270, 180);
        path.CloseFigure();
        using (var b = new SolidBrush(track)) g.FillPath(b, path);
        int x = On ? Width - d - 2 : 2;
        using (var b2 = new SolidBrush(Color.FromArgb(232, 234, 239))) g.FillEllipse(b2, x, 2, d, d);
    }
}

public class WidgetForm : Form
{
    [DllImport("user32.dll")] static extern bool ReleaseCapture();
    [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, IntPtr l);

    readonly string Base;
    readonly string statePath;
    Label lblStatus;
    SwitchCtl swPower;
    SwitchCtl swTop;
    bool syncing;
    System.Windows.Forms.Timer timer;

    static readonly Color Card = Color.FromArgb(18, 20, 26);
    static readonly Color BarBg = Color.FromArgb(27, 31, 39);
    static readonly Color RowBg = Color.FromArgb(30, 34, 42);
    static readonly Color Fg = Color.FromArgb(232, 234, 239);
    static readonly Color Dim = Color.FromArgb(150, 158, 172);
    static readonly Font FontUi = new Font("Microsoft YaHei UI", 9f);

    public WidgetForm(string baseUrl)
    {
        Base = baseUrl.TrimEnd('/');
        statePath = Path.Combine(Path.GetTempPath(), "dsh-phone-widget.json");

        Text = "dfy蓝色大肥鱼手机镜像";
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        TopMost = true;
        ShowInTaskbar = true;
        BackColor = Card;
        ClientSize = new Size(240, 214);

        Point loc = new Point(Screen.PrimaryScreen.WorkingArea.Right - 310, Screen.PrimaryScreen.WorkingArea.Bottom - 300);
        LoadPos(ref loc);
        Location = loc;

        Resize += (s, e) => ApplyRoundRegion();

        var header = new Panel { BackColor = BarBg, Bounds = new Rectangle(0, 0, 240, 32) };
        Controls.Add(header);

        // 标题直接画在标题条上：如果用 Label，按在文字上时鼠标事件被 Label 吃掉，
        // 拖拽的模态循环跟不动（实测：标题文字上拖不动，标题条空白处能拖）。
        var titleFont = new Font("Microsoft YaHei UI", 9f, FontStyle.Bold);
        header.Paint += (s, e) => e.Graphics.DrawString("手机投屏", titleFont, new SolidBrush(Fg), 12, 7);

        var btnMin = new Label { Text = "–", ForeColor = Dim, Font = FontUi, TextAlign = ContentAlignment.MiddleCenter, Bounds = new Rectangle(182, 5, 24, 22) };
        btnMin.MouseEnter += (s, e) => btnMin.ForeColor = Color.White;
        btnMin.MouseLeave += (s, e) => btnMin.ForeColor = Dim;
        btnMin.Click += (s, e) => WindowState = FormWindowState.Minimized;
        header.Controls.Add(btnMin);

        var btnClose = new Label { Text = "✕", ForeColor = Dim, Font = FontUi, TextAlign = ContentAlignment.MiddleCenter, Bounds = new Rectangle(208, 5, 24, 22) };
        btnClose.MouseEnter += (s, e) => btnClose.ForeColor = Color.White;
        btnClose.MouseLeave += (s, e) => btnClose.ForeColor = Dim;
        btnClose.Click += (s, e) => Close();
        header.Controls.Add(btnClose);

        header.MouseDown += (s, e) => StartDrag();

        lblStatus = new Label { Text = "连接中…", ForeColor = Dim, Font = FontUi, Bounds = new Rectangle(12, 40, 216, 18) };
        Controls.Add(lblStatus);

        var row1 = NewRow(66);
        AddRowLabel(row1, "投屏");
        swPower = new SwitchCtl { Bounds = new Rectangle(168, 7, 40, 22) };
        row1.Controls.Add(swPower);

        var row2 = NewRow(108);
        AddRowLabel(row2, "窗口置顶");
        swTop = new SwitchCtl { Bounds = new Rectangle(168, 7, 40, 22) };
        row2.Controls.Add(swTop);

        AddKey("← 返回", 10, 150, 4);
        AddKey("⌂ 主屏", 126, 150, 3);
        AddKey("▣ 多任务", 10, 182, 187);
        // 一键解锁：唤醒 + 上滑 + 输 PIN 全在宿主做，这里只发一个请求。
        // 要 2~8 秒，所以放进线程池，别把窗口卡住。
        AddButton("解锁", 126, 182, () =>
        {
            lblStatus.Text = "解锁中…";
            ThreadPool.QueueUserWorkItem(_ =>
            {
                Post("/dsh-dfy-mirror/unlock", "{}", 25000);
                Sync();
            });
        });

        swPower.Click += (s, e) =>
        {
            if (syncing) return;
            Post("/dsh-dfy-mirror/start", "{}");
            Thread.Sleep(300);
            Sync();
        };
        swTop.Click += (s, e) =>
        {
            if (syncing) return;
            Post("/dsh-dfy-mirror/topmost", "{\"on\":" + (swTop.On ? "true" : "false") + "}");
            Thread.Sleep(500);
            Sync();
        };

        timer = new System.Windows.Forms.Timer { Interval = 1000 };
        timer.Tick += (s, e) => Sync();
        timer.Start();

        FormClosing += (s, e) =>
        {
            SavePos();
            try { timer.Stop(); } catch { }
            // 告诉宿主「我关了」：DSH 上的「桌面窗」开关下一次轮询就同步成关，
            // 不用等 4 秒心跳过期。
            try { Post("/dsh-dfy-mirror/widget/bye", "{}", 1500); } catch { }
        };
        Shown += (s, e) => Sync();
    }

    Panel NewRow(int y)
    {
        var row = new Panel { BackColor = RowBg, Bounds = new Rectangle(10, y, 220, 36) };
        Controls.Add(row);
        return row;
    }

    static void AddRowLabel(Panel row, string text)
    {
        row.Controls.Add(new Label { Text = text, ForeColor = Fg, Font = FontUi, Bounds = new Rectangle(10, 9, 120, 18) });
    }

    void AddKey(string text, int x, int y, int code)
    {
        AddButton(text, x, y, () => Post("/dsh-dfy-mirror/key", "{\"code\":" + code + "}"));
    }

    void AddButton(string text, int x, int y, Action onClick)
    {
        var b = new Button
        {
            Text = text,
            Bounds = new Rectangle(x, y, 104, 28),
            FlatStyle = FlatStyle.Flat,
            BackColor = RowBg,
            ForeColor = Fg,
            Font = FontUi,
        };
        b.FlatAppearance.BorderSize = 0;
        b.FlatAppearance.MouseOverBackColor = Color.FromArgb(40, 45, 56);
        b.Click += (s, e) => onClick();
        Controls.Add(b);
    }

    void ApplyRoundRegion()
    {
        var p = new GraphicsPath();
        int r = 16, w = Width, h = Height;
        p.AddArc(0, 0, r, r, 180, 90);
        p.AddArc(w - r - 1, 0, r, r, 270, 90);
        p.AddArc(w - r - 1, h - r - 1, r, r, 0, 90);
        p.AddArc(0, h - r - 1, r, r, 90, 90);
        p.CloseAllFigures();
        Region = new Region(p);
    }

    void StartDrag()
    {
        try
        {
            ReleaseCapture();
            SendMessage(Handle, 0xA1, (IntPtr)2, IntPtr.Zero);
        }
        catch { }
        SavePos();
    }

    string Get(string path)
    {
        var req = (HttpWebRequest)WebRequest.Create(Base + path);
        req.Timeout = 2500;
        req.ReadWriteTimeout = 2500;
        req.Proxy = null;
        using (var resp = (HttpWebResponse)req.GetResponse())
        using (var stream = resp.GetResponseStream())
        using (var reader = new StreamReader(stream, Encoding.UTF8))
            return reader.ReadToEnd();
    }

    void Post(string path, string json, int timeoutMs = 8000)
    {
        try
        {
            var req = (HttpWebRequest)WebRequest.Create(Base + path);
            req.Method = "POST";
            req.ContentType = "application/json";
            req.Timeout = timeoutMs;
            req.Proxy = null;
            var bytes = Encoding.UTF8.GetBytes(json);
            req.ContentLength = bytes.Length;
            using (var s = req.GetRequestStream()) s.Write(bytes, 0, bytes.Length);
            using (var resp = (HttpWebResponse)req.GetResponse()) { }
        }
        catch { }
    }

    static bool BoolField(string body, string name)
    {
        return Regex.IsMatch(body, "\"" + name + "\"\\s*:\\s*true");
    }

    static string StrField(string body, string name)
    {
        var m = Regex.Match(body, "\"" + name + "\"\\s*:\\s*\"([^\"]*)\"");
        return m.Success ? m.Groups[1].Value : "";
    }

    void Sync()
    {
        ThreadPool.QueueUserWorkItem(_ =>
        {
            string body = null;
            try { body = Get("/dsh-dfy-mirror/status"); } catch { }
            try { Post("/dsh-dfy-mirror/widget/ping", "{\"pid\":" + System.Diagnostics.Process.GetCurrentProcess().Id + "}"); } catch { }
            if (body == null)
            {
                SafeUi(() => lblStatus.Text = "连不上宿主");
                return;
            }
            bool running = BoolField(body, "running");
            bool top = BoolField(body, "alwaysOnTop");
            string state = StrField(body, "state");
            string error = StrField(body, "error");
            string device = StrField(body, "device");
            SafeUi(() =>
            {
                syncing = true;
                swPower.On = running;
                swPower.Invalidate();
                swTop.On = top;
                swTop.Invalidate();
                syncing = false;
                if (error.Length > 0) lblStatus.Text = "出错：" + error;
                else if (state == "starting" || state == "stopping") lblStatus.Text = "处理中…";
                else if (running) lblStatus.Text = (device.Length > 0 ? device : "手机") + " · 运行中";
                else lblStatus.Text = "已停止";
            });
        });
    }

    void SafeUi(Action action)
    {
        try
        {
            if (IsDisposed) return;
            if (InvokeRequired) BeginInvoke(action);
            else action();
        }
        catch { }
    }

    void LoadPos(ref Point loc)
    {
        try
        {
            if (!File.Exists(statePath)) return;
            var text = File.ReadAllText(statePath);
            var mx = Regex.Match(text, "\"x\"\\s*:\\s*(-?\\d+)");
            var my = Regex.Match(text, "\"y\"\\s*:\\s*(-?\\d+)");
            if (mx.Success && my.Success)
                loc = new Point(int.Parse(mx.Groups[1].Value), int.Parse(my.Groups[1].Value));
        }
        catch { }
    }

    void SavePos()
    {
        try
        {
            if (WindowState == FormWindowState.Minimized) return;
            File.WriteAllText(statePath, "{\"x\":" + Location.X + ",\"y\":" + Location.Y + "}");
        }
        catch { }
    }

    [STAThread]
    public static void Main(string[] args)
    {
        SetProcessDpiAwarenessContext_Safe();

        // CLI 模式：给宿主用的窗口小工具，不打开控制窗。
        //   --topmost on|off   秒切 scrcpy 窗口置顶（不需要重启 scrcpy）
        //   --getsize          打印投屏窗口的客户区尺寸 WxH
        if (args.Length > 0 && args[0] == "--topmost")
        {
            var h = WinWin.FindMirror();
            if (h == IntPtr.Zero) Environment.Exit(2);
            bool on = args.Length > 1 && args[1] == "on";
            WinWin.SetWindowPos(h, on ? new IntPtr(-1) : new IntPtr(-2), 0, 0, 0, 0, 0x0001 | 0x0002);
            Environment.Exit(0);
        }
        if (args.Length > 0 && args[0] == "--getsize")
        {
            var h = WinWin.FindMirror();
            if (h == IntPtr.Zero) Environment.Exit(2);
            WinWin.RECT r;
            WinWin.GetClientRect(h, out r);
            // WinExe 没有 stdout，写临时文件让宿主读
            File.WriteAllText(Path.Combine(Path.GetTempPath(), "dsh-phone-size.txt"), (r.Right - r.Left) + "x" + (r.Bottom - r.Top));
            Environment.Exit(0);
        }

        using (var mutex = new Mutex(false, "Local\\DSHPhoneMirrorWidget"))
        {
            if (!mutex.WaitOne(0, false)) return;
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
            Application.EnableVisualStyles();
            string url = args.Length > 0 ? args[0] : "http://127.0.0.1:55167";
            Application.Run(new WidgetForm(url));
            try { mutex.ReleaseMutex(); } catch { }
        }
    }

    static void SetProcessDpiAwarenessContext_Safe()
    {
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }
    }

    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr c);
}

// 给宿主用的窗口小工具：按标题/类名找 scrcpy 窗口，直接改置顶属性、读客户区尺寸。
public static class WinWin
{
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    public static IntPtr FindMirror()
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows((h, l) =>
        {
            if (!IsWindowVisible(h)) return true;
            var t = new StringBuilder(256);
            GetWindowText(h, t, 256);
            var c = new StringBuilder(256);
            GetClassName(h, c, 256);
            if (t.ToString() == "手机投屏" || c.ToString() == "SDL_app")
            {
                found = h;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
