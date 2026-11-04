# dfy蓝色大肥鱼手机镜像 · dsh-dfy-mirror

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

给 [DSH](https://github.com/deepseek-ai) 加一个「手机投屏」：点一下，桌面上出现一个 **scrcpy 原生窗口**（可选置顶）。

一个入口：

| 入口 | 位置 | 说明 |
| --- | --- | --- |
| **DSH 胶囊 / 面板** | 胶囊固定在 DSH 顶部正中 | 点胶囊展开：投屏 / 置顶 两个开关、返回/主屏/多任务、解锁/锁屏；面板每次打开都在**上方正中**，打开后可以拖走 |

> v4 删掉了「设置 → 手机投屏」那一页——配置项一共就几个，直接改
> `~/.dsh/dsh-dfy-mirror.json` 更省事，也不想在设置里塞一个半成品的控制面板。

- 快捷键：`Ctrl+Shift+M` 开合面板（DSH 窗口有焦点时）
- 标题上的型号在第一次查询状态时就取回来了，不用先点投屏
- 手机断开时状态栏显示「手机未连接」，不是只显示「已停止」

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

第一次用不用先改配置：展开面板，它会自己 `adb devices` 找手机，
点「用它」就把串号写进配置。找不到会提示先 `adb connect` 或插 USB。

## 配置（`~/.dsh/dsh-dfy-mirror.json`）

没有设置页，直接改这个 JSON。宿主每次请求状态时比一下文件 mtime，改了自动重载，
**不用重启 DSH**（改完等下一次轮询，或者刷新页面）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `serial` | `""` | `ip:5555` 或 USB 序列号 |
| `adb` | `""` | 留空自动找 |
| `scrcpy` | `""` | 留空自动找 |
| `autoStart` | `false` | DSH 起来后自动投屏 |
| `alwaysOnTop` | `true` | 手机窗口置顶（默认开） |
| `windowWidth` | `460` | 窗口内容宽度（物理像素） |
| `turnScreenOff` | `true` | 投屏时关手机屏幕（省电，窗口照常显示） |
| `graceMs` | `1200` | scrcpy 活过这么久才算启动成功 |
| `reconnect` | `true` | 意外掉线后重试（1.5s / 3s / 8s / 10s…，最多 6 次） |
| `pin` | `000000` | 锁屏 PIN，一键解锁用；只收 4~12 位数字，存在本机配置文件里 |

## 一键解锁 / 锁屏

`POST /dsh-dfy-mirror/unlock` 把整个流程压成**一条 adb 命令**，分支和等待都在手机端做：

1. 先读一次 `dumpsys`：醒着吗、锁着吗；
2. 已解锁 → 直接返回（实测 **0.4 秒**）；
3. 睡着 → `input keyevent 224` 点亮；醒着就跳过这一条（省一次 `input`）；
4. 锁着 → `wm dismiss-keyguard`，还是锁着才：上滑露 PIN 键盘 → `input text <pin>`；
5. 输完**等 0.8 秒复核**：6 位 PIN 会自己提交，解锁了就直接结束，**不按回车**；
   仍锁屏再等 0.4 秒复核一次，确认才补 `input keyevent 66`；
6. 复核的那次 `dumpsys` 直接当最终状态返回，不再多查一遍。

实测：锁屏 + 息屏 **4.7 秒**，已解锁 **0.4 秒**。

> 为什么抠这一下回车：PIN 自动提交后手机已经回到桌面，此时再按回车会激活桌面上
> 选中的图标——实测会打开华为音乐。这是「解锁后误开 App」的根因。

面板里它是整行按钮，**按钮上直接显示手机当前状态**（数据来自 `GET /phone`，展开面板时每 3 秒问一次，缓存 2 秒）：

| 手机状态 | 按钮 | 点一下 |
| --- | --- | --- |
| 已解锁 | 绿色「已解锁 · 点一下锁屏」 | `POST /lock` 锁屏 |
| 锁屏（亮屏） | 蓝色「一键解锁 · 锁屏中」 | 解锁 |
| 息屏 | 蓝色「一键解锁 · 息屏」 | 唤醒并解锁 |
| 请求中 | 「解锁中…」/「锁屏中…」，禁用 | — |

锁屏走 `KEYCODE_SLEEP(223)`：单向关屏（不会把黑着的屏幕点亮），有安全锁时关屏即锁屏，锁完会复核一次状态。

## 接口（全部同源可写，跨站写操作一律 403）

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/dsh-dfy-mirror/status` | 状态机当前状态、错误、设备型号 |
| GET | `/dsh-dfy-mirror/phone` | 手机现在锁没锁：`{ok, locked, awake}`（缓存 2 秒） |
| GET/POST | `/dsh-dfy-mirror/config` | 读/写配置 |
| GET | `/dsh-dfy-mirror/devices` | `adb devices -l` |
| POST | `/dsh-dfy-mirror/start` `/stop` | 起停投屏窗口（启动前会先清掉残留的 scrcpy，避免两个窗口抢端口） |
| POST | `/dsh-dfy-mirror/key` | `{code}` 发送按键（4 返回 / 3 主屏 / 187 多任务） |
| POST | `/dsh-dfy-mirror/unlock` | 一键解锁：唤醒 + 上滑 + 输 PIN |
| POST | `/dsh-dfy-mirror/lock` | 锁屏：`KEYCODE_SLEEP`，返回锁完后的 `{locked, awake}` |
| POST | `/dsh-dfy-mirror/topmost` | `{on:true|false}` 切换置顶（scrcpy 重启一次窗口，约 1~2 秒） |
| GET | `/dsh-dfy-mirror/log` | 最后 120 行日志 |
| GET | `/dsh-dfy-mirror/panel.js` | 面板脚本本身（宿主注入页面用） |

## 常见问题

- **面板说「未配置」**：它没从配置里读到串号。点「查找手机」，会自动列出 `adb devices` 里在线的设备，
  点「用它」写进配置；没有设备就先 `adb connect ip:5555` 或插 USB。
- **手机 IP 变了**（热点 DHCP 重新分配）：配置里的串号不在线、而当前只连着一台设备时，
  插件会自动用那台，并在下次启动投屏时把新串号写回配置。
- **点投屏说「手机不在线」**：3 秒内就返回了（先查 `adb devices`，不在线就不再等 6 秒超时）。
- **scrcpy 崩溃 `0xC0000005`**：通常是端口/驱动冲突。停掉再来一次，或换 USB / 换 `adb tcpip` 端口。
- **窗口是黑的**：手机息屏或锁屏了。点「一键解锁」。
- **点窗口没反应**：确认手机没锁屏；scrcpy 的鼠标输入需要窗口在前台。
- **窗口太大/太小**：改配置里的 `windowWidth`，单位是物理像素，125% 缩放时 460 ≈ 368 逻辑像素。
- **掉线了**：默认自动重连（1.5 秒先试一次，之后 3/8/10 秒，最多 6 次）；设置 `reconnect: false` 可关。
- **胶囊/面板找不到了**：点胶囊（或 `Ctrl+Shift+M`）就会回到上方正中；
  面板藏在屏幕外时也会在窗口缩放后自动拉回来（`?dpm=1` 可以强制展开）。
- **看错误全文**：面板里错误区点一下就是复制（长错误显示不全时用）。
- **日志在哪**：`~/.dsh/dsh-dfy-mirror.log`（会滚动）。在浏览器里打开 `/dsh-dfy-mirror/log`
  看最后 120 行；用 Windows PowerShell 直接 `Get-Content` 看需要 `-Encoding UTF8`。

## 测试

```bash
npm test        # 等价于 node --test
```

22 个用例，不依赖手机、不启动 scrcpy：

- **纯函数**：scrcpy 参数拼装、`adb devices -l` / `wm size` 解析、退出码翻译、配置校验、
  锁屏判据
- **宿主冒烟**：用假 `ctx` 跑 `apply()`，确认核心路由都注册上了、桌面窗的遗留路由已经删干净、
  `/status` 和 `/config` 返回结构正确、跨站写操作会被 403 拦掉

CI 在 GitHub Actions 上跑 Node 20 / 22（ubuntu）。

## License

MIT
