# 参与开发

## 环境

- Windows 10 / 11（插件只支持 Windows，见 README「已知限制」）
- Node.js 20 或 22
- 可选：真机 + `adb` + `scrcpy`，用来测真实投屏与解锁

不需要安装任何依赖：插件运行时不依赖第三方包，测试用 Node 内置的 `node:test`。

## 跑测试

```bash
npm test            # node --test
node test/args.test.mjs   # 单个文件，调试时更快
```

35 个用例都不需要手机，也不会启动 scrcpy。CI 在 Ubuntu + Windows × Node 20/22 上跑同一套。

## 代码结构

| 文件 | 职责 |
| --- | --- |
| `lib/index.js` | 宿主半边：路由、状态机编排、依赖自检 |
| `lib/panel.js` | 注入到 DSH 页面的浮窗（普通 `<script>`，不依赖框架） |
| `lib/session.js` | 「一个 scrcpy 进程 = 一个会话」的状态机 |
| `lib/args.js` | 纯函数：拼 scrcpy 参数、解析 adb 输出 |
| `lib/unlock.js` | 纯判断（锁屏判据）+ 一条命令完成解锁 |
| `lib/config.js` | 配置读 / 校验 / 热加载 |
| `lib/exec.js` | 跑外部命令，带超时，永不 reject |

## 约定

- **宿主里只允许异步 IO**：请求路径上不要出现 `spawnSync` / 大目录扫描（原因见 LESSONS.md 第六节）。
- **接口改状态必须是 POST + token**：新增路由时用 `route(path, handler, { mode: 'write' })`，
  不要图省事用 GET。
- **解锁相关的判断必须是「读不到就说读不到」**：返回 `null` 表示判据缺失，
  绝不能在缺少判据时假定「已解锁」——那会把 PIN 打进正在使用的 App 里。
- 中文注释、中文 UI 文案；新增面向用户的字符串请保持中文，英文只放在 README.en.md。
- 缩进 2 空格、单引号、行尾不留空格（见 `.editorconfig`）。

## 提交

- 一个 PR 只做一件事；改动 UI 或行为请带上「为什么」，最好附实测数据（LESSONS.md 就是范例）。
- 行为变更要更新 `CHANGELOG.md` 的 `Unreleased` 或新版本小节。
- 涉及安全的改动，先看 [SECURITY.md](SECURITY.md)。

## 发版

1. 更新 `package.json` 的 `version` 与 `CHANGELOG.md`
2. `git tag v<version>`
3. push tag（CI 会再跑一遍测试）
