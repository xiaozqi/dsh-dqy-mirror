# Changelog

本项目从 4.6.0 开始按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 记录，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [4.6.0] - 2026-11-05

开源前的加固与整理。

### Security

- **修复 CSRF**：`/start` `/stop` `/unlock` `/lock` `/key` `/topmost` `/deps/install`
  原先只要是 GET 就绕过 Origin 校验，任意网页用 `<img src=".../unlock">` 就能解锁手机。
  现在改状态的接口**只接受 POST**，带 Origin 的请求一律同源校验（GET 也查），
  并且 POST 必须带每次启动随机生成的 `x-dpm-token`（只出现在同源可读的 `/panel.js` 里）。
- `GET /config` 不再回显明文 PIN（返回 `••••••`），写配置时内部仍用真值合并，不会丢 PIN。

### Added

- `audio` 配置项：默认仍是 `--no-audio`，需要声音时置 `true`。
- 多设备：面板会列出所有在线设备让你选；多台在线且配置的串号不在线时不再随机挑一台，
  而是明确报错。
- `README.en.md`、`SECURITY.md`、`CONTRIBUTING.md`、`CHANGELOG.md`、issue / PR 模板。
- 零基础教程重写：按品牌列开发者选项路径、教怎么判断 USB 线/授权、`adb devices` 输出怎么读、
  每步的「成功标志」、排障顺序、卸载步骤。
- CI 增加 Windows runner（之前只跑 ubuntu，而插件是 Windows-only）。
- `package.json`：`engines.node >= 20`、`os: ["win32"]`、英文 description、更全的 keywords。

### Changed

- 清理残留窗口不再 `taskkill /IM scrcpy.exe /F`（会连用户自己开的 scrcpy 一起杀），
  改为按窗口标题精确匹配，只清本插件起的窗口。
- 锁屏判据增加 Android 12+ 写法（`mKeyguardShowing`、`KeyguardServiceDelegate showing=`）；
  一个判据都读不到时返回 `null` 并明确报错，不再假装「已解锁」。
- `/phone` 增加 `supported` 字段；缓存按设备串号隔离，换手机不会读到上一台的状态。
- 面板收起时不再每 2 秒轮询 `/status`；展开时立刻刷新。
- `readBody` 超过 200KB 返回 413，不再 `req.destroy()` 导致请求永远不结束。
- 提取共享的 `lib/exec.js`（原先 `index.js` 和 `unlock.js` 各有一份 `run()`）。
- `start()` 不再用 `existsSync(scrcpy)` 判断，PATH 里的裸命令名交给系统解析。
- 平台提示：非 Windows 加载时日志会明确说「未适配」。

### Fixed

- README 里「换平台只改一处」和「22 个用例」两处与代码不符的描述。
- **解锁回归（4.6.0 开发中引入，已修）**：`KEYGUARD` 里加的第二条 `dumpsys window policy`
  没包在 `{ ...; }` 里，导致 `${KEYGUARD} | grep -q ...` 的管道只接到第二条命令上，
  判断永远为假 —— 表现是「撤锁屏后跳过上滑和输 PIN，最后报 PIN 可能不对」。
  已用花括号分组，并补了一个真 shell 桩测试（`test/unlock-script.test.mjs`）防复发。

## 更早

| 版本 | 内容 |
| --- | --- |
| 4.5.0 | 有锁屏密码时向用户要 PIN |
| 4.4.0 | 依赖自检 + winget 一键安装 + 连接向导 |
| 4.3.0 | 手机 IP 变了也能用 |
| 4.2.1 | 面板每次打开回到上方正中 |
| 4.2.0 | 快捷键、提前显示型号、未连接状态 |
| 4.1.0 | 配置热加载、首次引导、离线快速报错 |
| 4.0.1 | 每次启动固定从胶囊开始 |
| 4.0.0 | 解锁压成一条 adb 命令；删除设置页 |
| 3.2.0 | 解锁按钮可反向锁屏 |
