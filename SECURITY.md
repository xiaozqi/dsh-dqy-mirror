# 安全说明

## 威胁模型

这个插件把「操作一台 Android 手机」的能力开在本地 HTTP 上（`/dsh-dfy-mirror/*`），
能力包括：启动/停止投屏窗口、发按键、解锁、锁屏、改配置。

因此它的安全边界等同 **DSH Web 服务本身**：

- **只应该在 localhost 使用。** 如果 DSH Web 绑到 `0.0.0.0`、做了反向代理或端口转发，
  同网络的人就能控制这台被投屏的手机。
- 接口没有账号体系，不要把它当成多用户服务。

## 已有的防护

| 威胁 | 防护 |
| --- | --- |
| 恶意网页 CSRF（`<img>`、`<form>`、导航） | 改状态的接口只接受 `POST`；带 Origin 的请求强制同源（GET 也查） |
| 跨站读取（CORS） | 不返回任何 `access-control-allow-origin` 头 |
| 猜到接口直接写 | 每次宿主启动随机生成 `x-dpm-token`，只嵌入同源可读的 `/panel.js` |
| 命令注入（PIN） | PIN 仅接受 `4~12` 位数字，其它一律拒绝 |
| 请求体撑爆内存 | 超过 200KB 返回 413 |

**仍然存在的风险**（已知边界，不是 bug）：

- 同一台机器上的任意进程都能读 `~/.dsh/dsh-dfy-mirror.json`（含明文 PIN），
  以及 `~/.dsh/dsh-dfy-mirror.log`。
- 同一台机器上的本地进程可以用 `curl` 读 `/panel.js` 拿到 token，然后调用写接口。
  这是刻意的：本机客户端没有可信身份可区分。
- 重启宿主会重新生成 token，旧页面需要刷新才能继续写操作（读操作不受影响）。

## 报告漏洞

请**不要**开公开 issue。用 GitHub 的 [Private vulnerability reporting](https://github.com/xiaozqi/dsh-dfy-mirror/security/advisories/new)，
或者发邮件到仓库 owner 的 GitHub 邮箱。

请在报告里带上：

1. 复现步骤（含 `curl` 命令最好）；
2. 影响（能做什么：解锁？启动窗口？读日志？）；
3. 插件版本与 DSH 版本。

一般 72 小时内回复。修复会先发一个 patch 版本，再公开细节。
