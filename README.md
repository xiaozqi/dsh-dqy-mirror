# dfy蓝色大肥鱼手机镜像 · dsh-dfy-mirror

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

给 [DSH](https://github.com/deepseek-ai) 加一个「手机投屏」：点一下，桌面上出现一个 **scrcpy 原生窗口**（可选置顶）。

两个入口，同一套接口：

| 入口 | 位置 | 说明 |
| --- | --- | --- |
| **DSH 胶囊 / 面板** | 胶囊固定在 DSH 顶部正中 | 点胶囊展开：投屏 / 置顶 两个开关、返回/主屏/多任务、一键解锁；面板可以拖到任意位置 |
| **设置 → 手机投屏** | DSH 个人头像 → 设置（`Ctrl+,`） | 选设备、起停、一键解锁、改参数 |

## 长什么样

![DSH 面板](docs/panel.png)

## 设计：一个进程，一个状态机

| 角色 | 谁来做 |
| --- | --- |
| 画面 | **scrcpy 自己的窗口**（就是那个能点的窗口），可选 `--always-on-top` |
| 控制 | DSH 面板的按钮 → `adb shell input ...`；点窗口 = 直接操作手机（scrcpy 自带） |
| 状态 | `idle → starting → running → stopping → idle`，异常一律落到 `error` |
| 失败 | 进程退出就是失败，没有「进程死了状态还活着」 |

**刻意放弃的东西**：

1. 面板里再嵌一份手机画面。那需要在 scrcpy 和浏览器之间架一条视频链
   （代理 + ffmpeg + MJPEG），上一版 90% 的崩溃、黑屏、假死都出在那条链上。
2. **桌面上的第二个控制窗**（v3.0 删掉）。它需要单独一个进程、一条心跳、
   一堆「窗口关了 DSH 怎么同步」「没激活时第一次点击被 Windows 吃掉」的补丁，
   而它能做的事 DSH 面板都能做。取舍见 [LESSONS.md](LESSONS.md)。

## 依赖

- Windows（用了 `taskkill`；换平台改 `lib/session.js` 里一处）
- [adb](https://developer.android.com/tools/releases/platform-tools)
- [scrcpy](https://github.com/Genymobile/scrcpy) 2.x / 5.x

两个都在 PATH 里最省事；也可以在设置里填绝对路径。任何开了 adb 调试的 Android 都能投，
换手机 = 在设置里选设备。

## 安装

1. 把本目录放到 `~/.dsh/plugins/dsh-dfy-mirror`
2. 在 profile 的 `package.json` 里加：

   ```json
   "dependencies": { "dsh-dfy-mirror": "file:C:/Users/<you>/.dsh/plugins/dsh-dfy-mirror" },
   "dsh": { "profile": { "bundles": [ "...", "dsh-dfy-mirror" ] } }
   ```

3. 重启 DSH

## 配置（`~/.dsh/dsh-dfy-mirror.json`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `serial` | `""` | `ip:5555` 或 USB 序列号 |
| `adb` | `""` | 留空自动找 |
| `scrcpy` | `""` | 留空自动找 |
| `autoStart` | `false` | DSH 起来后自动投屏 |
| `alwaysOnTop` | `true` | 手机窗口置顶 |
| `windowWidth` | `460` | 窗口内容宽度（物理像素） |
| `turnScreenOff` | `true` | 投屏时关手机屏幕（省电，窗口照常显示） |
| `graceMs` | `1200` | scrcpy 活过这么久才算启动成功 |
| `reconnect` | `true` | 意外掉线后重试（1.5s / 3s / 8s / 10s…，最多 6 次） |
| `pin` | `000000` | 锁屏 PIN，一键解锁用；只收 4~12 位数字，存在本机配置文件里 |

## 一键解锁

`POST /dsh-dfy-mirror/unlock`（DSH 面板、设置页的解锁按钮都调它）会：

1. `input keyevent 224` 点亮屏幕；
2. `wm dismiss-keyguard` 撤掉非安全锁屏；
3. 如果还在锁屏（`dumpsys window` 里 `isStatusBarKeyguard=true`）：
   `input swipe` 上滑 → `input text <pin>` → `input keyevent 66`；
4. 再读一次 keyguard 状态，把 `{ok, locked, awake, steps}` 返回给界面。

**已经解锁时不会上滑、也不会打字**（约 2 秒返回 `already:true`），
所以不会把 PIN 打进正在用的 App 里。锁着的时候大约 8 秒。

面板里它是整行按钮：请求期间变「解锁中…」并禁用。

## 接口（全部同源可写，跨站写操作一律 403）

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/dsh-dfy-mirror/status` | 状态机当前状态、错误、设备型号 |
| GET/POST | `/dsh-dfy-mirror/config` | 读/写配置 |
| GET | `/dsh-dfy-mirror/devices` | `adb devices -l` |
| POST | `/dsh-dfy-mirror/start` `/stop` | 起停投屏窗口（启动前会先清掉残留的 scrcpy，避免两个窗口抢端口） |
| POST | `/dsh-dfy-mirror/key` | `{code}` 发送按键（4 返回 / 3 主屏 / 187 多任务） |
| POST | `/dsh-dfy-mirror/unlock` | 一键解锁：唤醒 + 上滑 + 输 PIN |
| POST | `/dsh-dfy-mirror/topmost` | `{on:true|false}` 切换置顶（scrcpy 重启一次窗口，约 1~2 秒） |
| GET | `/dsh-dfy-mirror/log` | 最后 120 行日志 |
| GET | `/dsh-dfy-mirror/panel.js` | 面板脚本本身（宿主注入页面用） |

## 常见问题

- **scrcpy 崩溃 `0xC0000005`**：通常是端口/驱动冲突。停掉再来一次，或换 USB / 换 `adb tcpip` 端口。
- **窗口是黑的**：手机息屏或锁屏了。点「一键解锁」。
- **点窗口没反应**：确认手机没锁屏；scrcpy 的鼠标输入需要窗口在前台。
- **窗口太大/太小**：设置里的「窗口宽度」是物理像素，125% 缩放时 460 ≈ 368 逻辑像素。
- **掉线了**：默认自动重连（1.5 秒先试一次，之后 3/8/10 秒，最多 6 次）；也可以在设置里关掉。
- **胶囊/面板找不到了**：面板藏在屏幕外时会在窗口缩放后自动拉回来；实在找不到就刷新页面
  （收起状态记在 localStorage，`?dpm=1` 可以强制展开）。
- **日志在哪**：`~/.dsh/dsh-dfy-mirror.log`（会滚动）。在浏览器里打开 `/dsh-dfy-mirror/log`
  看最后 120 行；用 Windows PowerShell 直接 `Get-Content` 看需要 `-Encoding UTF8`。

## 测试

```bash
npm test        # 等价于 node --test
```

22 个用例，不依赖手机、不启动 scrcpy：

- **纯函数**：scrcpy 参数拼装、`adb devices -l` / `wm size` 解析、退出码翻译、配置校验、
  锁屏判据 / 解锁坐标
- **宿主冒烟**：用假 `ctx` 跑 `apply()`，确认核心路由都注册上了、桌面窗的遗留路由已经删干净、
  `/status` 和 `/config` 返回结构正确、跨站写操作会被 403 拦掉

CI 在 GitHub Actions 上跑 Node 20 / 22（ubuntu）。

## License

MIT
