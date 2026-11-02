// DSH 手机投屏 · 宿主半边
//
// 架构只有一句话：**一个 scrcpy 进程，一个状态机**。
//   - 画面 = scrcpy 自己的窗口（可选置顶），不再经过代理 / ffmpeg / MJPEG
//   - 面板 = 纯控制台（开关、返回/主屏/多任务/唤醒），不显示画面
//   - 失败 = 进程退出。没有「进程死了但状态还活着」这种中间态
//
// 所有接口都在 /dsh-dfy-mirror 下，同源才能写（防跨站控制手机）。
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULTS, HOME, loadConfig, saveConfig, sanitize } from './config.js'
import { buildScrcpyArgs, parseDevices, WINDOW_TITLE } from './args.js'
import { MirrorSession } from './session.js'

export const name = 'dfy-mirror'
export const inject = ['webServer']

const P = '/dsh-dfy-mirror'
const HERE = dirname(fileURLToPath(import.meta.url))
const LOG_PATH = join(HOME, 'dsh-dfy-mirror.log')
const LOG_MAX = 1024 * 1024

// ---------- 日志 ----------
function rotateIfNeeded() {
  try {
    if (statSync(LOG_PATH).size > LOG_MAX) renameSync(LOG_PATH, LOG_PATH + '.1')
  } catch {
    /* 文件还不存在 */
  }
}

function makeLogger(prefix) {
  return (msg) => {
    const line = new Date().toISOString() + ' ' + msg
    console.log(prefix + msg)
    try {
      mkdirSync(HOME, { recursive: true })
      rotateIfNeeded()
      appendFileSync(LOG_PATH, line + '\n')
    } catch {
      /* 日志写不了也不能影响主流程 */
    }
  }
}

// ---------- 找命令 ----------
function which(cmd) {
  const exts = (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)
  for (const dir of (process.env.PATH || '').split(';').filter(Boolean)) {
    for (const ext of exts) {
      const file = join(dir, cmd + ext.toLowerCase())
      if (existsSync(file)) return file
    }
  }
  return ''
}

function wingetFind(pattern, exe) {
  const local = process.env.LOCALAPPDATA || ''
  const root = local ? join(local, 'Microsoft', 'WinGet', 'Packages') : ''
  if (!root) return ''
  try {
    for (const name of readdirSync(root)) {
      if (!pattern.test(name)) continue
      const dir = join(root, name)
      for (const sub of readdirSync(dir)) {
        const candidate = join(dir, sub, exe)
        if (existsSync(candidate)) return candidate
      }
    }
  } catch {
    /* 没装就是没装 */
  }
  return ''
}

const findAdb = (cfg) => {
  if (cfg.adb && existsSync(cfg.adb)) return cfg.adb
  return (
    which('adb') ||
    join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe') ||
    wingetFind(/platform-?tools/i, 'adb.exe') ||
    'adb'
  )
}

const findScrcpy = (cfg) => {
  if (cfg.scrcpy && existsSync(cfg.scrcpy)) return cfg.scrcpy
  return which('scrcpy') || wingetFind(/scrcpy/i, 'scrcpy.exe') || 'scrcpy'
}

// ---------- 跑命令 ----------
function run(cmd, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let done = false
    const finish = (result) => {
      if (!done) {
        done = true
        resolve(result)
      }
    }
    let proc
    try {
      proc = spawn(cmd, args, { windowsHide: true })
    } catch (e) {
      return finish({ code: -1, out, err: String((e && e.message) || e) })
    }
    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {}
      finish({ code: -1, out, err: 'timeout' })
    }, timeoutMs)
    proc.stdout.on('data', (d) => (out += d))
    proc.stderr.on('data', (d) => (err += d))
    proc.on('error', (e) => {
      clearTimeout(timer)
      finish({ code: -1, out, err: String((e && e.message) || e) })
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      finish({ code, out, err })
    })
  })
}

export function apply(ctx) {
  const log = makeLogger('[手机投屏] ')
  let cfg = loadConfig()
  let session = null
  let device = { serial: '', model: '' }

  const readBody = (req) =>
    new Promise((resolve) => {
      let raw = ''
      req.on('data', (c) => {
        raw += c
        if (raw.length > 100000) req.destroy()
      })
      req.on('end', () => {
        try {
          resolve(JSON.parse(raw || '{}'))
        } catch {
          resolve({})
        }
      })
    })

  const json = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(obj))
  }

  const status = () => {
    const s = session
      ? session.status()
      : { state: 'idle', running: false, busy: false, error: '', since: 0, tail: '' }
    return {
      ok: true,
      ...s,
      serial: cfg.serial,
      device: device.model,
      adb: findAdb(cfg),
      scrcpy: findScrcpy(cfg),
      autoStart: cfg.autoStart,
      alwaysOnTop: cfg.alwaysOnTop,
      widget: !!cfg.widget,
      widgetRunning: Date.now() - widgetPingAt < 7000,
    }
  }

  // 桌面控制窗：纯 PowerShell + WinForms（tools/widget.ps1），不编译任何 exe。
  // 用请求里的 Host 当接口地址，窗口里再自己去调 /status、/start、/topmost…
  //
  // 两个坑（都踩过）：
  //  1. 不能只写 'powershell.exe' 靠 PATH 找——宿主可能被计划任务之类拉起，PATH 里没有
  //     WindowsPowerShell\v1.0，spawn 直接 ENOENT，表现就是「点了没反应」。
  //  2. 不能直接 spawn powershell：它是控制台程序，父进程（Electron）没有 console 时
  //     子进程会立刻 exit 0。必须经过 `cmd /c start`，让 start 给它一个新控制台。
  const powershellExe = () => {
    const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
    const candidates = [join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), which('powershell.exe'), which('powershell')]
    for (const c of candidates) if (c && existsSync(c)) return c
    return 'powershell.exe'
  }

  let lastWidgetAt = 0
  // 桌面控制窗每 2 秒来一次心跳（带自己的 PID），宿主据此知道它是开着还是关着
  let widgetPid = 0
  let widgetPingAt = 0

  // bin/PhoneMirrorWidget.exe：编译好的 C# 小窗口。它同时是一个 CLI 小工具：
  //   --topmost on|off  秒切 scrcpy 窗口置顶（不重启 scrcpy）
  //   --getsize         把投屏窗口客户区尺寸写到 %TEMP%\dsh-phone-size.txt
  const widgetExePath = () => {
    const p = join(HERE, '..', 'bin', 'PhoneMirrorWidget.exe')
    return existsSync(p) ? p : ''
  }

  const runWidgetCli = (args) => {
    const exe = widgetExePath()
    if (!exe) return { ok: false, error: '没有编译好的桌面窗口' }
    try {
      const r = spawnSync(exe, args, { windowsHide: true, timeout: 4000 })
      return { ok: r.status === 0, status: r.status }
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) }
    }
  }

  const spawnWidget = (host) => {
    const script = join(HERE, '..', 'tools', 'widget.ps1')
    if (!existsSync(script)) return { ok: false, error: '缺少 tools/widget.ps1' }
    const clean = String(host || '').trim()
    if (!clean) return { ok: false, error: '拿不到宿主地址' }
    // 防抖：面板/多个页面同时点的时候别一口气拉起一堆
    if (Date.now() - lastWidgetAt < 4000) return { ok: true, skipped: true }
    lastWidgetAt = Date.now()
    const base = 'http://' + clean

    // 首选编译好的 C# 小窗口（bin/PhoneMirrorWidget.exe）：进程就是它自己，不会在后台
    // 留一个 powershell.exe（内存约 40MB，比 PowerShell 版的 117MB 轻得多）。
    const widgetExe = widgetExePath()
    if (widgetExe) {
      try {
        const child = spawn(widgetExe, [base], { detached: true, stdio: 'ignore' })
        child.on('error', (e) => log('桌面控制窗启动失败：' + String((e && e.message) || e)))
        child.unref()
        log('已拉起桌面控制窗（' + base + '）')
        return { ok: true, base }
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) }
      }
    }

    // 没编译 exe 时的兜底：PowerShell + VBS 隐藏启动
    const exe = powershellExe()
    // 用 wscript 跑一个两行 VBS：window style 0 = 完全隐藏，既不会闪 cmd，也能给
    // powershell 一个（隐藏的）控制台——直接 spawn 的话它会因为没有 console 立刻 exit 0。
    const vbs = join(HERE, '..', 'tools', 'widget.vbs')
    if (!existsSync(vbs)) return { ok: false, error: '缺少 tools/widget.vbs' }
    try {
      const child = spawn('wscript.exe', [vbs, exe, script, base], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      child.on('error', (e) => log('桌面控制窗启动失败：' + String((e && e.message) || e)))
      child.unref()
      log('已拉起桌面控制窗（' + base + '）')
      return { ok: true, base }
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) }
    }
  }

  // 自动重连：网络抖动 / 手机休眠导致 scrcpy 退出时，隔 10 秒重试，最多 6 次。
  // 用户手动点「启动」会清零计数。
  const RECONNECT_MAX = 6
  const RECONNECT_DELAY = 10000
  let retryTimer = null
  let retries = 0

  const cancelRetry = () => {
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = null
    }
  }

  const scheduleReconnect = () => {
    if (!cfg.reconnect || retryTimer) return
    if (retries >= RECONNECT_MAX) {
      log('自动重连放弃：已重试 ' + retries + ' 次')
      return
    }
    retries++
    log('自动重连：' + Math.round(RECONNECT_DELAY / 1000) + ' 秒后第 ' + retries + ' 次尝试')
    retryTimer = setTimeout(() => {
      retryTimer = null
      if (!session || session.state !== 'error') return
      start().catch((e) => log('自动重连失败：' + String((e && e.message) || e)))
    }, RECONNECT_DELAY)
  }

  const start = async () => {
    if (session && (session.state === 'running' || session.state === 'starting')) {
      return { ok: true, already: true }
    }
    if (!cfg.serial) return { ok: false, error: '还没填设备地址（设置 → 手机投屏）' }

    const adb = findAdb(cfg)
    const scrcpy = findScrcpy(cfg)
    if (!existsSync(scrcpy)) {
      return { ok: false, error: '找不到 scrcpy.exe：请先安装 scrcpy，或在设置里填绝对路径' }
    }

    // 网络设备先 connect；USB 序列号没有冒号，connect 会失败，忽略即可
    if (cfg.serial.includes(':')) {
      const r = await run(adb, ['connect', cfg.serial], 6000)
      log('adb connect ' + cfg.serial + ' → ' + (r.out || r.err || '').trim())
    }

    session = new MirrorSession({
      scrcpy,
      args: buildScrcpyArgs(cfg, WINDOW_TITLE),
      graceMs: cfg.graceMs,
      log,
      onExit: (code, byUser) => {
        log('会话结束（code=' + code + (byUser ? '，手动停止' : '') + '）')
        if (byUser) {
          retries = 0
          cancelRetry()
          return
        }
        if (code !== 0) scheduleReconnect()
      },
    })
    const r = session.start()
    if (!r.ok) return r

    // 设备型号只用来显示，拿不到就算了
    run(adb, ['-s', cfg.serial, 'shell', 'getprop', 'ro.product.model'], 4000).then((m) => {
      const model = (m.out || '').trim()
      if (model) device = { serial: cfg.serial, model }
    })
    return { ok: true }
  }

  // 用户手动启动：清掉重连计数，别让上一次的失败次数影响这次
  const manualStart = () => {
    retries = 0
    cancelRetry()
    return start()
  }

  // 窗口被拖过大小的话，停止时把客户区宽度记下来，下次按这个开
  const captureWindowWidth = () => {
    if (!widgetExePath()) return
    const file = join(tmpdir(), 'dsh-phone-size.txt')
    try {
      if (existsSync(file)) unlinkSync(file)
    } catch {}
    if (!runWidgetCli(['--getsize']).ok) return
    try {
      const m = /^(\d+)x(\d+)$/.exec(readFileSync(file, 'utf8').trim())
      if (!m) return
      const w = Number(m[1])
      if (w < 120 || w > 2000) return
      if (Math.abs(w - cfg.windowWidth) <= 12) return
      cfg.windowWidth = w
      saveConfig(cfg)
      log('记住窗口宽度：' + w)
    } catch {}
  }

  const stop = () => {
    if (!session) return { ok: true, already: true }
    cancelRetry()
    captureWindowWidth()
    return session.stop()
  }

  const waitIdle = (timeoutMs = 6000) =>
    new Promise((resolve) => {
      const t0 = Date.now()
      const tick = () => {
        if (!session || session.state === 'idle' || session.state === 'error') return resolve(true)
        if (Date.now() - t0 > timeoutMs) return resolve(false)
        setTimeout(tick, 100)
      }
      tick()
    })

  // 置顶切换：首选原生（SetWindowPos，瞬间生效、画面不闪）；
  // 没有编译好的 exe 时退回「用新参数重启 scrcpy」（约 1~2 秒）。
  const setTopmost = async (on) => {
    const changed = !!cfg.alwaysOnTop !== on
    cfg.alwaysOnTop = on
    saveConfig(cfg)
    const running = !!session && (session.state === 'running' || session.state === 'starting')
    if (!running || !changed) return { ok: true, alwaysOnTop: on, restarted: false }
    if (runWidgetCli(['--topmost', on ? 'on' : 'off']).ok) {
      log('置顶已切换（原生，不重启窗口）')
      return { ok: true, alwaysOnTop: on, restarted: false, native: true }
    }
    log('原生置顶不可用，退回重启窗口')
    session.stop()
    const stopped = await waitIdle()
    if (!stopped) return { ok: false, error: '窗口没能正常停止，置顶没切过去' }
    const r = await start()
    return { ...r, alwaysOnTop: on, restarted: true }
  }

  const key = async (code) => {
    if (!cfg.serial) return { ok: false, error: '还没填设备地址' }
    const r = await run(findAdb(cfg), ['-s', cfg.serial, 'shell', 'input', 'keyevent', String(code)], 8000)
    return r.code === 0 ? { ok: true } : { ok: false, error: (r.err || '').trim() || 'adb 执行失败' }
  }

  // ---------- HTTP 路由 ----------
  const route = (path, handler) =>
    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path,
        handler: async (req, res) => {
          // 只放行同源写操作：否则任意网页都能 POST /start、/key 控制手机
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            const origin = String(req.headers.origin || '')
            if (origin) {
              let same = false
              try {
                same = new URL(origin).host === String(req.headers.host || '')
              } catch {}
              if (!same) {
                res.writeHead(403)
                res.end()
                return
              }
            }
          }
          if (req.method === 'OPTIONS') {
            res.writeHead(204, { 'access-control-allow-headers': 'content-type' })
            res.end()
            return
          }
          try {
            await handler(req, res)
          } catch (e) {
            log('路由 ' + path + ' 出错：' + String((e && e.message) || e))
            try {
              json(res, 500, { ok: false, error: String((e && e.message) || e) })
            } catch {}
          }
        },
      }),
    )

  route(P + '/status', (req, res) => json(res, 200, status()))

  route(P + '/config', async (req, res) => {
    if (req.method === 'POST') {
      cfg = sanitize({ ...cfg, ...(await readBody(req)) })
      saveConfig(cfg)
      return json(res, 200, { ok: true, config: cfg })
    }
    json(res, 200, { ok: true, config: cfg, defaults: DEFAULTS })
  })

  route(P + '/devices', async (req, res) => {
    const r = await run(findAdb(cfg), ['devices', '-l'], 8000)
    json(res, 200, { ok: true, devices: parseDevices(r.out), adb: findAdb(cfg) })
  })

  route(P + '/start', async (req, res) => json(res, 200, await manualStart()))
  route(P + '/stop', (req, res) => json(res, 200, stop()))

  route(P + '/key', async (req, res) => {
    const body = await readBody(req)
    json(res, 200, await key(body.code || 3))
  })

  route(P + '/topmost', async (req, res) => {
    const body = await readBody(req)
    if (typeof body.on !== 'boolean') return json(res, 400, { ok: false, error: '需要 {on: true|false}' })
    json(res, 200, await setTopmost(body.on))
  })

  route(P + '/widget', (req, res) => {
    json(res, 200, spawnWidget(req.headers.host))
  })

  // 控制窗每 2 秒来一次心跳，宿主顺手记下它的 PID（关窗时要用）
  route(P + '/widget/ping', async (req, res) => {
    const body = await readBody(req)
    const pid = Number(body.pid)
    if (Number.isFinite(pid) && pid > 0) {
      widgetPid = pid
      widgetPingAt = Date.now()
    }
    json(res, 200, { ok: true })
  })

  route(P + '/widget/close', (req, res) => {
    if (widgetPid) {
      try {
        process.kill(widgetPid)
      } catch {}
    }
    widgetPid = 0
    widgetPingAt = 0
    json(res, 200, { ok: true })
  })

  // 排查用：日志尾巴（只读，同源）
  route(P + '/log', (req, res) => {
    let text = ''
    try {
      text = readFileSync(LOG_PATH, 'utf8')
    } catch {}
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end(text.split(/\r?\n/).filter(Boolean).slice(-120).join('\n'))
  })

  // DSH 里的浮窗（和桌面控制窗同一套交互；浮窗只能在 DSH 窗口里，全局的那个才拖得出去）
  route(P + '/panel.js', (req, res) => {
    let body = ''
    try {
      body = readFileSync(join(HERE, 'panel.js'), 'utf8')
    } catch {
      body = 'console.warn("读不到 panel.js")'
    }
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
  })

  try {
    ctx.effect(() =>
      ctx.on('webserver/index-inject', (table) => {
        if (!Array.isArray(table)) return
        const src = P + '/panel.js'
        if (table.some((r) => r && r.kind === 'script-src' && String(r.src || '').indexOf(src) === 0)) return
        table.push({ kind: 'script-src', placement: 'body', src })
      }),
    )
  } catch {
    log('index-inject 通道不可用（浮窗可能不会自动出现）')
  }

  try {
    ctx.effect(() =>
      ctx.webServer.tapIndex((html) => {
        if (typeof html !== 'string' || html.indexOf(P + '/panel.js') >= 0) return html
        const tag = '<script src="' + P + '/panel.js" defer></script>'
        return html.indexOf('</body>') >= 0 ? html.replace('</body>', tag + '</body>') : html + tag
      }),
    )
  } catch {
    log('tapIndex 通道不可用（桌面壳不需要）')
  }

  if (cfg.autoStart) {
    ctx.effect(() => {
      const timer = setTimeout(() => {
        start().catch((e) => log('自动启动失败：' + String((e && e.message) || e)))
      }, 2500)
      return () => clearTimeout(timer)
    })
  }

  // 应用退出时别把 scrcpy 留成孤儿
  const onExit = () => {
    try {
      if (session) session.stop()
    } catch {}
  }
  process.on('exit', onExit)
  ctx.effect(() => () => {
    process.removeListener('exit', onExit)
    try {
      if (session) session.stop()
    } catch {}
  })

  log('已加载；scrcpy=' + findScrcpy(cfg) + ' adb=' + findAdb(cfg))
}
