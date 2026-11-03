# 踩过的坑（v1 → v2 的全部经验）

这份文档是重写的原因和代价清单。v1 能跑，但它是「一层层补丁」堆出来的；
v2 把那些补丁连同它们的问题一起删掉了。下面这些结论都是实测出来的，不是猜的。

## 一、scrcpy 本身

1. **`--stay-awake` 会顶掉 `--turn-screen-off`。**
   插电时 Android 会强制定屏常亮，`--turn-screen-off` 完全失效（实测黑屏/常亮两种表现都出现过）。
   要「窗口里有画面、手机屏幕不亮」，就别加 `--stay-awake`。

2. **scrcpy 崩 `0xC0000005`（访问冲突）最常见的诱因是端口冲突。**
   上一轮 scrcpy 还没退干净、固定端口被占，新的 scrcpy 会直接崩。
   结论：端口交给 scrcpy 自己选，别写死。

3. **无边框窗口（`--window-borderless`）没有标题栏，放出来拖不动。**
   如果要做「先藏起来、之后再摆出来」的窗口，就不能用无边框。

4. **窗口完全移出屏幕后，注入失效。**
   v1 用代理往 scrcpy 的 control 连接写报文；窗口在 `-4000` 时写进去无效，
   留 1px 在屏幕里就正常。这条只对「自己注入触摸」的架构成立，v2 不再需要。

5. **`--max-size` 会让 v1 的触摸注入失效。**（原因不明，实测如此；跟 v2 无关了）

6. **触摸报文里的 screenWidth/Height 必须是视频真实尺寸。**
   这台机 `wm size` 报 1080×2310，实际视频 1080×2308，差 2px 注入就被丢弃。

## 二、v1 的架构为什么放弃

v1 的画面是「代理截 h264 → ffmpeg → MJPEG → 浏览器 `<img>`」，为了毫秒级触控还自己编了
一个 adb 包装器把 `adb reverse` 改道。问题：

- **私有协议**：scrcpy 的 control 报文（32 字节触摸 / 14 字节按键）没有兼容承诺，版本一变就废。
- **层数太多**：adb 包装器 → 代理 → h264 解析 → ffmpeg → JPEG → MJPEG → `<img>`，
  每一层都有自己的失败方式，而且互相不知道对方死了没有。
- **MJPEG 拖死浏览器**：piggy 通道能出 60~90fps，原样推给 `<img>`，Chromium 解码跟不上就停在最后一帧，
  表现为「面板黑了、像卡死」——但服务器那边的帧其实是好的。限速到 ≤30fps 能缓解，
  可这仍然是一条只为「在面板里再显示一遍」而存在的链。
- **PrintWindow 抓帧**：16fps，窗口最小化就失效，还得处理 125% DPI 的坐标。
- **三种模式互备**（piggy / fast / compat）：失败回退时状态更乱，排障成本翻倍。

v2 的结论：**画面只留一份（scrcpy 窗口），控制用 adb 按键**。
牺牲的是「DSH 里也能看到画面」，换来的是一个能讲清楚、能开源、不会自己卡死的插件。

## 三、DSH 插件机制

1. 宿主模块：`export const name`、`export const inject = ['webServer']`、`export function apply(ctx)`。
2. 路由：`ctx.effect(() => ctx.webServer.register({ kind: 'exact', path, handler }))`；
   `ctx.effect` 负责卸载时清理。
3. 面板注入：监听 `webserver/index-inject`，往表里 push `{ kind: 'script-src', placement: 'body', src }`；
   纯网页形态走 `ctx.webServer.tapIndex(html => ...)`。
4. 面板脚本用**普通 `<script>`**（不依赖模块加载器），宿主每次请求现读文件 → 改完刷新页面即可。
5. **写操作必须校验 Origin**，并且**不要**给接口加 CORS 头，否则任意网页都能 `POST /start`、`/key` 控制你的手机。
6. 热重载/重启有风险：管线正在跑的时候重启宿主，可能把 scrcpy 带崩（见过两次 0xC0000005）。

## 四、Windows 细节

1. **125% 缩放**：DPI-unaware 进程拿到的坐标是虚拟化的（1920×1200 的屏报 1536×960），
   而 `SetWindowPos` / 截图用的是物理像素。要么开头调 `SetProcessDpiAwarenessContext(-4)`，要么别碰坐标。
2. **Electron 无边框窗口**：标了 `-webkit-app-region: drag` 的区域会吞掉所有点击（表现为「点不动」）。
   面板和按钮必须显式 `no-drag`。
3. `PrintWindow(PW_RENDERFULLCONTENT)` 能抓被遮挡的窗口，但最小化不行。
4. 结束 scrcpy 要用 `taskkill /PID <pid> /T /F`，`proc.kill()` 只杀父进程。

## 五、进程与状态

- 只要出现「进程死了但界面还显示运行中」，就是没做 supervisor。
  v2 的做法：进程 `exit` 就是唯一真相，退出码 0 = 用户关窗，非 0 = 出错并把最后几行 stderr 显示在面板上。
- 启动判定不要等「窗口出现」这种不可靠信号：活过 `graceMs` 就算 running，之前退出就是 error。
- 停止要有兜底超时，别让状态永远停在 `stopping`。
- 日志写文件（`~/.dsh/phone-mirror.log`，1MB 轮转）——出问题时 `/log` 接口能直接看最后 120 行。

## 六、别在宿主里做同步阻塞（2026-11-03）

DSH 的 HTTP 服务和 Agent 跑在同一个 Node 事件循环里，**任何同步调用都会把整个界面一起按住**。
这次实测出来两处：

1. **`spawnSync(PhoneMirrorWidget.exe, ...)`**：这个 exe 光是启动就要 **1 秒左右**
   （`--getsize` / `--topmost` 实测 1019~1106ms，没有窗口时也一样，是 .NET/WinForms 的启动开销）。
   点「停止」会走 `--getsize`，点「置顶」会走 `--topmost`——每次都卡 1 秒；
   进程要是没响应，`timeout: 4000` 就是卡 4 秒。改成异步 `spawn` + `await` 后不再阻塞。
2. **`/status` 每次都扫 PATH + WinGet 目录找 adb/scrcpy**：同步 `existsSync`/`readdirSync`，
   暖机状态一次 31ms；前端每秒轮询一次，冷启动时更久。现在按配置缓存 30 秒。

另外，前端轮询也收紧了：2 秒一次、页面在后台不轮询、上一次没回来不发下一次。

**结论**：宿主里只允许异步 IO；`spawnSync` / `readFileSync` / 大目录扫描别出现在请求路径上。

## 七、一键解锁的判据（2026-11-03）

这台华为 VCE-AL00（Android 10）上：

| 状态 | `dumpsys window` | `dumpsys power` |
| --- | --- | --- |
| 锁屏 | `isStatusBarKeyguard=true`、`mDreamingLockscreen=true` | `mWakefulness=Awake` |
| 解锁 | 两项都 `false` | `mWakefulness=Awake` |

`mDreamingLockscreen` 必须是 `=true` 才算；解锁后它确实会变 false。
**截图大小不可靠**：解锁后的桌面截图只有 9KB（老脚本用 `>50000` 会误判成锁屏）；
但锁屏时 `screencap` 正好返回 **0 字节**（FLAG_SECURE），所以「0 字节 = 安全锁屏」是可信的。

安全锁屏必须先 `input swipe` 上滑，PIN 键盘才会出现；少了这步 `input text` 打不进任何地方。

## 八、桌面窗为什么被删掉（v3.0，2026-11-03）

用户的原话是：「直接把桌面窗删了」。删之前它身上已经摞了这些补丁：

- 独立进程（先是 PowerShell + VBS，后来是 17KB 的 C# WinForms）
- 心跳 + `/widget/ping` + `/widget/bye` + 4 秒过期判定
- 「窗口关了 DSH 开关怎么变灰」「DSH 关了窗口为什么还在」
- CLI 双职责（`--topmost` / `--getsize`），其中 `spawnSync` 调它一次要 1 秒，直接卡住宿主
- 位置记忆、防抖、单实例互斥……

最后两个 bug 是压死它的原因：

1. **开关永远发 `/start`。** `swPower.Click` 里写死了 `Post("/start")`，根本没看
   `swPower.On`。所以「关」按下去只是又发了一次启动，状态一刷新开关又弹回蓝色。
   正确做法：`On` 在 `MouseDown` 里已经翻成「点完之后想要的状态」，按它选 `/start` 或 `/stop`。

2. **没激活的窗口，第一下点击被吃掉。** 实测：scrcpy 抢走焦点后点开关，
   控件连 `MouseDown` 都收不到，只收到一条 `WM_MOUSEACTIVATE`；点第二下才生效。
   这是 Windows 的「激活并吃掉」（`MA_ACTIVATEANDEAT`）。
   修法：窗口加 `WS_EX_NOACTIVATE`，并且 `WM_MOUSEACTIVATE` 返回 **`MA_NOACTIVATE`(3)**。

   ⚠️ 常量别记反：`MA_ACTIVATE=1`、`MA_ACTIVATEANDEAT=2`、`MA_NOACTIVATE=3`。
   我第一版写成了 `2`，等于亲手「激活并丢弃」，越修越点不动。加 `WS_EX_NOACTIVATE` 后
   标题条拖动仍然正常（`WM_NCLBUTTONDOWN` + `HTCAPTION` 不依赖激活）。

顺带：`/start` 在 WiFi 上要连 adb，最长 6~7 秒，点击处理必须丢进线程池，
否则点一下窗口就冻住 7 秒——看起来又像「点不动」。

**结论**：这个窗口能做的事（开关投屏/置顶、发按键、解锁），DSH 面板全能做，
而它每多一个功能就多一条跨进程同步路径。v3.0 直接删除：`bin/`、`tools/` 整个目录，
`/widget*` 四条路由、`widget` 配置项、面板里的「桌面窗」开关全部去掉。
置顶改回「重启一次 scrcpy」（1~2 秒），这是删掉它唯一的功能损失。

