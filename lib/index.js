// DSH 手机投屏 · 宿主半边
//
// 架构只有一句话：**一个 scrcpy 进程，一个状态机**。
//   - 画面 = scrcpy 自己的窗口（可选置顶），不再经过代理 / ffmpeg / MJPEG
//   - 控制 = DSH 里的浮窗（投屏/置顶/返回/主屏/多任务/解锁），没有别的窗口
//   - 失败 = 进程退出。没有「进程死了但状态还活着」这种中间态
//
// 所有接口都在 /dsh-dfy-mirror 下，同源才能写（防跨站控制手机）。
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULTS, HOME, loadConfig, saveConfig, sanitize } from './config.js'
import { buildScrcpyArgs, parseDevices, WINDOW_TITLE } from './args.js'
import { MirrorSession } from './session.js'
import { unlockPhone, isAwake, isLocked } from './unlock.js'

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

// 找命令要扫整条 PATH + WinGet 目录，全是同步 IO。以前 /status 每次都扫：
// 前端每秒轮询一次，就等于每秒阻塞宿主 30ms（开机冷启动更久，像「卡住」）。
// 按配置缓存 30 秒，配置一改（key 变化）立刻重扫。
let cmdCache = { key: '\u0000', adb: '', scrcpy: '', at: 0 }
function resolveCmds(cfg) {
  const key = String((cfg && cfg.adb) || '') + '\u0000' + String((cfg && cfg.scrcpy) || '')
  if (cmdCache.key === key && Date.now() - cmdCache.at < 30000) return cmdCache
  cmdCache = { key, adb: findAdb(cfg), scrcpy: findScrcpy(cfg), at: Date.now() }
  return cmdCache
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
  // 手机锁屏状态缓存：面板的解锁按钮要显示「锁屏中 / 已解锁」
  let phoneCache = { at: 0, value: null }
  // 最近一次 adb 成功的时刻：用来跳过多余的 adb connect
  let lastAdbOkAt = 0

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
    const cmds = resolveCmds(cfg)
    return {
      ok: true,
      ...s,
      serial: cfg.serial,
      device: device.model,
      adb: cmds.adb,
      scrcpy: cmds.scrcpy,
      autoStart: cfg.autoStart,
      alwaysOnTop: cfg.alwaysOnTop,
    }
  }

  // 自动重连：网络抖动 / 手机休眠导致 scrcpy 退出时重试，最多 6 次。
  // 前两次要快（1.5s / 3s）——开机时 scrcpy 常因为另一个残留进程抢 server 端口而
  // 「Server connection failed」，等 10 秒才重试看起来就像卡死了。
  const RECONNECT_DELAYS = [1500, 3000, 8000, 10000, 10000, 10000]
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
    if (retries >= RECONNECT_DELAYS.length) {
      log('自动重连放弃：已重试 ' + retries + ' 次')
      return
    }
    const delay = RECONNECT_DELAYS[retries]
    retries++
    log('自动重连：' + Math.round(delay / 100) / 10 + ' 秒后第 ' + retries + ' 次尝试')
    retryTimer = setTimeout(() => {
      retryTimer = null
      if (!session || session.state !== 'error') return
      start().catch((e) => log('自动重连失败：' + String((e && e.message) || e)))
    }, delay)
  }

  // 启动前把不是这次会话拉起来的 scrcpy 清掉（例如开机脚本起的那个旧窗口）。
  // 规则沿用旧版 start-mirror.ps1：先清残留，绝不叠成两个窗口抢同一个 server 端口。
  const killStrayScrcpy = () =>
    new Promise((resolve) => {
      let out = ''
      try {
        const p = spawn('taskkill', ['/IM', 'scrcpy.exe', '/F'], { windowsHide: true })
        p.stdout.on('data', (d) => (out += d))
        p.stderr.on('data', (d) => (out += d))
        p.on('close', () => {
          if (/SUCCESS|成功/.test(out)) log('清掉了残留的 scrcpy 窗口')
          resolve()
        })
        p.on('error', () => resolve())
      } catch {
        resolve()
      }
    })

  const start = async () => {
    if (session && ['running', 'starting', 'stopping'].includes(session.state)) {
      return { ok: true, already: true }
    }
    if (!cfg.serial) return { ok: false, error: '还没填设备地址（设置 → 手机投屏）' }

    const cmds = resolveCmds(cfg)
    const adb = cmds.adb
    const scrcpy = cmds.scrcpy
    if (!existsSync(scrcpy)) {
      return { ok: false, error: '找不到 scrcpy.exe：请先安装 scrcpy，或在设置里填绝对路径' }
    }

    // 网络设备先 connect；USB 序列号没有冒号，connect 会失败，忽略即可
    if (cfg.serial.includes(':')) {
      const r = await run(adb, ['connect', cfg.serial], 6000)
      log('adb connect ' + cfg.serial + ' → ' + (r.out || r.err || '').trim())
    }

    await killStrayScrcpy()

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

  const stop = () => {
    if (!session) return { ok: true, already: true }
    cancelRetry()
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

  // 置顶切换。scrcpy 的 --always-on-top 只在启动时生效，没有运行时开关，
  // 所以要「用新参数重启一次窗口」（约 1~2 秒）——以前靠桌面窗 exe 走
  // SetWindowPos 原生切换，那个 exe 已经随桌面窗一起删了。
  const setTopmost = async (on) => {
    const changed = !!cfg.alwaysOnTop !== on
    cfg.alwaysOnTop = on
    saveConfig(cfg)
    const running = !!session && (session.state === 'running' || session.state === 'starting')
    if (!running || !changed) return { ok: true, alwaysOnTop: on, restarted: false }
    session.stop()
    const stopped = await waitIdle()
    if (!stopped) return { ok: false, error: '窗口没能正常停止，置顶没切过去' }
    const r = await start()
    return { ...r, alwaysOnTop: on, restarted: true }
  }

  const key = async (code) => {
    if (!cfg.serial) return { ok: false, error: '还没填设备地址' }
    const r = await run(resolveCmds(cfg).adb, ['-s', cfg.serial, 'shell', 'input', 'keyevent', String(code)], 8000)
    return r.code === 0 ? { ok: true } : { ok: false, error: (r.err || '').trim() || 'adb 执行失败' }
  }

  // 一键解锁：整条流程压成一条 adb 命令（见 lib/unlock.js），
  // 已解锁 ~0.4s，锁屏 + 息屏 ~4.7s。
  const unlock = async () => {
    if (!cfg.serial) return { ok: false, steps: [], error: '还没填设备地址' }
    const adb = resolveCmds(cfg).adb
    // 面板刚查过状态就说明 adb 是通的，别再花 0.3 秒 connect 一次
    if (cfg.serial.includes(':') && Date.now() - lastAdbOkAt > 15000) {
      await run(adb, ['connect', cfg.serial], 6000)
    }
    const r = await unlockPhone({ adb, serial: cfg.serial, pin: cfg.pin, log })
    phoneCache = { at: 0, value: null }
    lastAdbOkAt = Date.now()
    log('解锁：' + (r.ok ? '成功' : '失败') + (r.already ? '（本来就是解锁）' : '') + (r.error ? ' - ' + r.error : ''))
    return r
  }

  // 锁屏：KEYCODE_SLEEP(223) 是单向的——只关屏，不会把已经黑着的屏幕点亮。
  // 关屏即锁屏（有安全锁的话），锁完再复核一次状态返回给面板。
  const lock = async () => {
    if (!cfg.serial) return { ok: false, error: '还没填设备地址' }
    const adb = resolveCmds(cfg).adb
    const r = await run(adb, ['-s', cfg.serial, 'shell', 'input', 'keyevent', '223'], 8000)
    if (r.code !== 0) return { ok: false, error: (r.err || '').trim() || 'adb 执行失败' }
    await new Promise((resolve) => setTimeout(resolve, 400))
    phoneCache = { at: 0, value: null }
    lastAdbOkAt = Date.now()
    const state = await phoneState()
    log('锁屏：' + (state.ok ? (state.locked ? '成功' : '屏幕关了但没锁（可能没设锁屏密码）') : '状态未知'))
    return { ok: true, locked: state.locked, awake: state.awake }
  }

  // 手机当前是锁着还是亮着——面板上的解锁按钮要显示这个。
  // adb 一次 0.5 秒左右，所以缓存 2 秒；面板只在展开时每 3 秒问一次。
  const phoneState = async () => {
    if (!cfg.serial) return { ok: false, locked: null, awake: null, error: '还没填设备地址' }
    if (phoneCache.value && Date.now() - phoneCache.at < 2000) return phoneCache.value
    const adb = resolveCmds(cfg).adb
    const r = await run(
      adb,
      ['-s', cfg.serial, 'shell', "dumpsys window | grep -E 'isStatusBarKeyguard|mDreamingLockscreen'; dumpsys power | grep mWakefulness="],
      5000,
    )
    const out = r.out || ''
    if (r.code !== 0) return { ok: false, locked: null, awake: null, error: (r.err || '').trim() || 'adb 执行失败' }
    lastAdbOkAt = Date.now()
    const value = { ok: true, locked: isLocked(out), awake: isAwake(out), at: Date.now() }
    phoneCache = { at: Date.now(), value }
    return value
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

  // 锁屏状态（给解锁按钮显示用）。缓存 2 秒，见 phoneState()。
  route(P + '/phone', async (req, res) => json(res, 200, await phoneState()))

  route(P + '/config', async (req, res) => {
    if (req.method === 'POST') {
      cfg = sanitize({ ...cfg, ...(await readBody(req)) })
      saveConfig(cfg)
      return json(res, 200, { ok: true, config: cfg })
    }
    json(res, 200, { ok: true, config: cfg, defaults: DEFAULTS })
  })

  route(P + '/devices', async (req, res) => {
    const cmds = resolveCmds(cfg)
    const r = await run(cmds.adb, ['devices', '-l'], 8000)
    json(res, 200, { ok: true, devices: parseDevices(r.out), adb: cmds.adb })
  })

  route(P + '/start', async (req, res) => json(res, 200, await manualStart()))
  route(P + '/stop', (req, res) => json(res, 200, stop()))
  route(P + '/unlock', async (req, res) => json(res, 200, await unlock()))
  route(P + '/lock', async (req, res) => json(res, 200, await lock()))

  route(P + '/key', async (req, res) => {
    const body = await readBody(req)
    json(res, 200, await key(body.code || 3))
  })

  route(P + '/topmost', async (req, res) => {
    const body = await readBody(req)
    if (typeof body.on !== 'boolean') return json(res, 400, { ok: false, error: '需要 {on: true|false}' })
    json(res, 200, await setTopmost(body.on))
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

  // DSH 里的浮窗脚本：宿主每次请求现读文件 → 改完刷新页面即可
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

  const ready = resolveCmds(cfg)
  log('已加载；scrcpy=' + ready.scrcpy + ' adb=' + ready.adb)
}
