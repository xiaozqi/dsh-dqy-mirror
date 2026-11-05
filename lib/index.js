// DSH 手机投屏 · 宿主半边
//
// 架构只有一句话：**一个 scrcpy 进程，一个状态机**。
//   - 画面 = scrcpy 自己的窗口（可选置顶），不再经过代理 / ffmpeg / MJPEG
//   - 控制 = DSH 里的浮窗（投屏/置顶/返回/主屏/多任务/解锁），没有别的窗口
//   - 失败 = 进程退出。没有「进程死了但状态还活着」这种中间态
//
// 所有接口都在 /dsh-dfy-mirror 下。写操作要求：POST + 同源 + 每次启动随机生成的
// token（见 route()），三层缺一不可——否则任意网页都能通过 <img> / <form> 控制手机。
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULTS, HOME, CONFIG_PATH, loadConfig, saveConfig, sanitize } from './config.js'
import { buildScrcpyArgs, parseDevices, WINDOW_TITLE } from './args.js'
import { run } from './exec.js'
import { MirrorSession } from './session.js'
import { isAwake, isLocked, isSecure, keyguardSignals, unlockPhone } from './unlock.js'

export const name = 'dfy-mirror'
export const inject = ['webServer']

const P = '/dsh-dfy-mirror'
const HERE = dirname(fileURLToPath(import.meta.url))
const LOG_PATH = join(HOME, 'dsh-dfy-mirror.log')
const LOG_MAX = 1024 * 1024
// 每次宿主启动重新生成：跨站页面拿不到它（panel.js 只能同源读），
// 但用户用 curl 调试时可以从 /panel.js 里抠出来。
const TOKEN = randomBytes(16).toString('hex')
const TOKEN_HEADER = 'x-dpm-token'
const BODY_LIMIT = 200 * 1024

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

export function apply(ctx) {
  const log = makeLogger('[手机投屏] ')
  let cfg = loadConfig()
  let session = null
  let device = { serial: '', model: '' }
  // 手机锁屏状态缓存：面板的解锁按钮要显示「锁屏中 / 已解锁」
  let phoneCache = { at: 0, serial: '', value: null }
  // 最近一次 adb 成功的时刻：用来跳过多余的 adb connect
  let lastAdbOkAt = 0

  // 配置热加载：设置页删掉之后只能手改 JSON，改完不该还要重启 DSH。
  // 每次读状态前比一下 mtime，变了就重新 loadConfig。
  let cfgMtime = 0
  const noteCfgMtime = () => {
    try {
      cfgMtime = statSync(CONFIG_PATH).mtimeMs
    } catch {
      cfgMtime = 0
    }
  }
  const reloadConfigIfChanged = () => {
    try {
      const m = statSync(CONFIG_PATH).mtimeMs
      if (m === cfgMtime) return
      cfg = loadConfig()
      cfgMtime = m
      log('配置已重新加载')
    } catch {
      /* 文件被删了就先用手里的 */
    }
  }
  noteCfgMtime()

  // 超过 200KB 就把内容丢掉，但继续把流读空——直接 destroy() 会让请求永远不 end，
  // 路由的 await 就挂在那里（之前会留下一个永不返回的连接）。
  const readBody = (req) =>
    new Promise((resolve) => {
      let raw = ''
      let tooLarge = false
      req.on('data', (c) => {
        if (tooLarge) return
        raw += c
        if (raw.length > BODY_LIMIT) {
          tooLarge = true
          raw = ''
        }
      })
      req.on('end', () => {
        if (tooLarge) return resolve({ __tooLarge: true })
        try {
          const parsed = JSON.parse(raw || '{}')
          resolve(parsed && typeof parsed === 'object' ? parsed : {})
        } catch {
          resolve({})
        }
      })
      req.on('error', () => resolve({}))
    })

  const json = (res, code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(obj))
  }

  // 读配置时把 PIN 打码：同源页面能读 /config，没必要把明文 PIN 送到前端。
  const publicConfig = (c) => ({ ...c, pin: c.pin ? '••••••' : '' })

  // 手机 IP 会随热点 DHCP 变（早上 .235，重启后 .195）。配置里的串号不在线时，
  // 如果当前只连着一台设备，就用它——否则每次换 IP 都得手改配置。
  // 有多台在线时不再瞎猜：返回空串，让面板提示用户自己选。
  let activeSerial = ''
  let activeAt = 0
  let ambiguous = false
  const resolveSerial = async () => {
    if (!cfg.serial) return ''
    if (activeSerial && Date.now() - activeAt < 15000) return activeSerial
    const list = parseDevices((await run(resolveCmds(cfg).adb, ['devices'], 4000)).out)
    const wanted = list.find((d) => d.serial === cfg.serial && d.state === 'device')
    let serial = wanted ? cfg.serial : ''
    ambiguous = false
    if (!serial) {
      const online = list.filter((d) => d.state === 'device')
      if (online.length === 1) serial = online[0].serial
      else if (online.length > 1) ambiguous = true
    }
    if (serial && serial !== cfg.serial) log('配置里的 ' + cfg.serial + ' 不在线，改用 ' + serial)
    activeSerial = serial
    activeAt = Date.now()
    return serial
  }

  // 设备型号只用来显示，拿不到就算了。第一次问状态时就顺手取一次，
  // 这样不用等「投屏」启动过才看到型号。
  let modelProbing = false
  const ensureModel = () => {
    if (modelProbing || !cfg.serial || device.model) return
    modelProbing = true
    run(resolveCmds(cfg).adb, ['-s', cfg.serial, 'shell', 'getprop', 'ro.product.model'], 4000)
      .then((m) => {
        const model = (m.out || '').trim()
        if (model) device = { serial: cfg.serial, model }
      })
      .catch(() => {})
      .then(() => {
        modelProbing = false
      })
  }

  const status = () => {
    reloadConfigIfChanged()
    if (device.serial && device.serial !== cfg.serial) device = { serial: '', model: '' }
    ensureModel()
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

  // 启动前把「我们自己起的」残留 scrcpy 清掉，避免两个窗口抢同一个 server 端口。
  // 不能 taskkill /IM：那会连用户自己开的 scrcpy 一起杀掉。这里按窗口标题精确匹配，
  // 只清标题是本插件起的那一类。查不到就当没有，绝不误杀。
  const killStrayScrcpy = async () => {
    if (process.platform !== 'win32') return
    const script =
      'Get-Process -Name scrcpy -ErrorAction SilentlyContinue | ' +
      `Where-Object { $_.MainWindowTitle -eq '${WINDOW_TITLE}' } | ` +
      'ForEach-Object { $_.Kill() }'
    const r = await run(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      5000,
    )
    if (r.code === 0 && !r.err) {
      log('已清理同名残留窗口（若有）')
    } else if (r.err && !/找不到|Cannot find|not recognized/i.test(r.err)) {
      log('清理残留窗口失败（忽略）：' + r.err.trim().slice(0, 120))
    }
  }

  const start = async () => {
    reloadConfigIfChanged()
    if (session && ['running', 'starting', 'stopping'].includes(session.state)) {
      return { ok: true, already: true }
    }
    if (!cfg.serial) return { ok: false, error: '还没配置手机：先在面板里点「查找手机」，或手改 ~/.dsh/dsh-dfy-mirror.json 的 serial' }

    const cmds = resolveCmds(cfg)
    const adb = cmds.adb
    const scrcpy = cmds.scrcpy
    // 只有「显式路径」才做存在性检查：findScrcpy 找不到时返回裸命令名 'scrcpy'，
    // 那种情况交给 PATH / spawn 自己解析（否则 mac/Linux 上装了也会被判成找不到）。
    if (scrcpy !== 'scrcpy' && !existsSync(scrcpy)) {
      return { ok: false, error: '找不到 scrcpy：请先安装 scrcpy，或在配置里填 scrcpy 的绝对路径' }
    }

    // 先看设备在不在线。不在线时 adb connect 要等 6 秒超时，用户点一下什么都看不到；
    // 先问一次 adb devices（~0.1s），不在就立刻说清楚。
    let serial = await resolveSerial()
    if (!serial && cfg.serial.includes(':')) {
      const r = await run(adb, ['connect', cfg.serial], 3000)
      log('adb connect ' + cfg.serial + ' → ' + (r.out || r.err || '').trim())
      activeAt = 0
      serial = await resolveSerial()
    }
    if (!serial) {
      return {
        ok: false,
        error: ambiguous
          ? '有多台手机在线，配置里的 ' + cfg.serial + ' 不在其中：先在面板里选一台'
          : '手机不在线（' + cfg.serial + '）：先 adb connect 一下，或插 USB',
      }
    }

    // 热点的 DHCP 换了 IP：把新串号写回配置，面板和下次启动都对齐
    if (serial !== cfg.serial) {
      cfg.serial = serial
      saveConfig(cfg)
      noteCfgMtime()
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

    ensureModel()
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
    noteCfgMtime()
    const running = !!session && (session.state === 'running' || session.state === 'starting')
    if (!running || !changed) return { ok: true, alwaysOnTop: on, restarted: false }
    session.stop()
    const stopped = await waitIdle()
    if (!stopped) return { ok: false, error: '窗口没能正常停止，置顶没切过去' }
    const r = await start()
    return { ...r, alwaysOnTop: on, restarted: true }
  }

  const key = async (code) => {
    const serial = await resolveSerial()
    if (!serial) return { ok: false, error: '手机不在线' }
    const r = await run(resolveCmds(cfg).adb, ['-s', serial, 'shell', 'input', 'keyevent', String(code)], 8000)
    return r.code === 0 ? { ok: true } : { ok: false, error: (r.err || '').trim() || 'adb 执行失败' }
  }

  // 一键解锁：整条流程压成一条 adb 命令（见 lib/unlock.js），
  // 已解锁 ~0.4s，锁屏 + 息屏 ~4.7s。
  const unlock = async () => {
    reloadConfigIfChanged()
    if (!cfg.serial) return { ok: false, steps: [], error: '还没配置手机' }
    const adb = resolveCmds(cfg).adb
    const serial = await resolveSerial()
    if (!serial) return { ok: false, steps: [], error: '手机不在线：先 adb connect 或插 USB' }
    // 面板刚查过状态就说明 adb 是通的，别再花 0.3 秒 connect 一次
    if (serial.includes(':') && Date.now() - lastAdbOkAt > 15000) {
      await run(adb, ['connect', serial], 6000)
    }
    // 手机有锁屏密码但配置里没有 PIN：不能瞎按，直接告诉面板「要密码」
    if (!cfg.pin) {
      const st = await phoneState()
      if (st.secure === true) {
        return { ok: false, steps: [], needPin: true, error: '手机设了锁屏密码，需要你提供 PIN 才能解锁' }
      }
      // 判据字段一个都没读到：多半是新系统改了 dumpsys，别再往下盲按
      if (st.ok && st.supported === false) {
        return {
          ok: false,
          steps: [],
          unsupported: true,
          error: '读不到这台手机的锁屏状态（系统版本可能不支持），解锁已跳过',
        }
      }
    }
    const r = await unlockPhone({ adb, serial, pin: cfg.pin, log })
    if (r.unsupported) log('解锁判据不可用：' + r.error)
    phoneCache = { at: 0, serial: '', value: null }
    lastAdbOkAt = Date.now()
    log('解锁：' + (r.ok ? '成功' : '失败') + (r.already ? '（本来就是解锁）' : '') + (r.error ? ' - ' + r.error : ''))
    return r
  }

  // 锁屏：KEYCODE_SLEEP(223) 是单向的——只关屏，不会把已经黑着的屏幕点亮。
  // 关屏即锁屏（有安全锁的话），锁完再复核一次状态返回给面板。
  const lock = async () => {
    reloadConfigIfChanged()
    if (!cfg.serial) return { ok: false, error: '还没配置手机' }
    const adb = resolveCmds(cfg).adb
    const serial = await resolveSerial()
    if (!serial) return { ok: false, error: '手机不在线：先 adb connect 或插 USB' }
    if (serial.includes(':') && Date.now() - lastAdbOkAt > 15000) {
      await run(adb, ['connect', serial], 3000)
    }
    const r = await run(adb, ['-s', serial, 'shell', 'input', 'keyevent', '223'], 8000)
    if (r.code !== 0) return { ok: false, error: (r.err || '').trim() || 'adb 执行失败' }
    await new Promise((resolve) => setTimeout(resolve, 400))
    phoneCache = { at: 0, serial: '', value: null }
    lastAdbOkAt = Date.now()
    const state = await phoneState()
    log('锁屏：' + (state.ok ? (state.locked ? '成功' : '屏幕关了但没锁（可能没设锁屏密码）') : '状态未知'))
    return { ok: true, locked: state.locked, awake: state.awake }
  }

  // 手机当前是锁着还是亮着——面板上的解锁按钮要显示这个。
  // adb 一次 0.5 秒左右，所以缓存 2 秒；面板只在展开时每 3 秒问一次。
  const phoneState = async () => {
    reloadConfigIfChanged()
    if (!cfg.serial) return { ok: false, locked: null, awake: null, error: '还没配置手机' }
    const adb = resolveCmds(cfg).adb
    const serial = await resolveSerial()
    if (!serial) return { ok: false, locked: null, awake: null, error: '手机不在线' }
    // 缓存要跟串号绑定：换了台手机不能拿上一台的锁屏状态
    if (phoneCache.value && phoneCache.serial === serial && Date.now() - phoneCache.at < 2000) {
      return phoneCache.value
    }
    const r = await run(
      adb,
      [
        '-s',
        serial,
        'shell',
        "dumpsys window 2>/dev/null | grep -E 'isStatusBarKeyguard|mDreamingLockscreen|mShowingLockscreen|mKeyguardShowing|showing=' ; " +
          "dumpsys window policy 2>/dev/null | grep -E 'mKeyguardShowing|isStatusBarKeyguard' ; " +
          "dumpsys power 2>/dev/null | grep mWakefulness=",
      ],
      5000,
    )
    const out = r.out || ''
    if (r.code !== 0 && !out) {
      return { ok: false, locked: null, awake: null, error: (r.err || '').trim() || 'adb 执行失败' }
    }
    lastAdbOkAt = Date.now()
    const locked = isLocked(out)
    const value = {
      ok: true,
      locked,
      awake: isAwake(out),
      secure: isSecure(out),
      // 一个判据字段都没读到：多半是新系统改了 dumpsys 格式，别假装知道锁没锁
      supported: keyguardSignals(out) > 0 || locked !== null,
      at: Date.now(),
    }
    phoneCache = { at: Date.now(), serial, value }
    return value
  }

  // ---------- HTTP 路由 ----------
  // mode='read'  只读（GET/HEAD）
  // mode='write' 只写（POST + token）
  // mode='rw'    读走 GET、写走 POST + token（/config）
  //
  // 防跨站的三道闸：
  //   1) 带 Origin 的请求必须和 Host 同源（GET 也查，堵掉 <img src=.../unlock>）
  //   2) 改状态的接口只接受 POST（堵掉 <form> / 导航触发）
  //   3) POST 必须带 x-dpm-token（随机、只在同源能读到的 panel.js 里出现）
  const route = (path, handler, { mode = 'read' } = {}) =>
    ctx.effect(() =>
      ctx.webServer.register({
        kind: 'exact',
        path,
        handler: async (req, res) => {
          if (req.method === 'OPTIONS') {
            res.writeHead(204, {
              'access-control-allow-headers': 'content-type, ' + TOKEN_HEADER,
              'access-control-allow-methods': 'GET, POST, OPTIONS',
            })
            res.end()
            return
          }

          const origin = String(req.headers.origin || '')
          if (origin) {
            let same = false
            try {
              same = new URL(origin).host === String(req.headers.host || '')
            } catch {
              same = false
            }
            if (!same) {
              res.writeHead(403)
              res.end()
              return
            }
          }

          const isWrite = req.method === 'POST'
          if (mode === 'write' || (mode === 'rw' && isWrite)) {
            if (!isWrite) {
              res.writeHead(405, { allow: 'POST' })
              res.end()
              return
            }
            if (String(req.headers[TOKEN_HEADER] || '') !== TOKEN) {
              res.writeHead(403)
              res.end()
              return
            }
          } else if (req.method !== 'GET' && req.method !== 'HEAD') {
            res.writeHead(405, { allow: 'GET' })
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

  route(
    P + '/config',
    async (req, res) => {
      reloadConfigIfChanged()
      if (req.method === 'POST') {
        const body = await readBody(req)
        if (body.__tooLarge) return json(res, 413, { ok: false, error: '请求体太大' })
        cfg = sanitize({ ...cfg, ...body })
        saveConfig(cfg)
        noteCfgMtime()
        return json(res, 200, { ok: true, config: publicConfig(cfg) })
      }
      json(res, 200, { ok: true, config: publicConfig(cfg), defaults: DEFAULTS })
    },
    { mode: 'rw' },
  )

  route(P + '/devices', async (req, res) => {
    const cmds = resolveCmds(cfg)
    const r = await run(cmds.adb, ['devices', '-l'], 8000)
    json(res, 200, { ok: true, devices: parseDevices(r.out), adb: cmds.adb })
  })

  // ---------- 依赖自检 / 一键安装 ----------
  // 新用户机器上多半没有 adb / scrcpy。与其让他自己搜，不如面板里直接点一下装。
  let installingDep = ''

  // winget 是 WindowsApps 里的「应用执行别名」（0 字节的 reparse point），
  // existsSync() 对它返回 false——只能看目录里有没有这个名字。
  const hasWinget = () => {
    const local = process.env.LOCALAPPDATA
    if (!local) return false
    const dir = join(local, 'Microsoft', 'WindowsApps')
    try {
      return readdirSync(dir).some((f) => f.toLowerCase() === 'winget.exe')
    } catch {
      return false
    }
  }

  const depsInfo = () => {
    reloadConfigIfChanged()
    const c = resolveCmds(cfg)
    return {
      ok: true,
      adb: { found: existsSync(c.adb), path: c.adb },
      scrcpy: { found: existsSync(c.scrcpy), path: c.scrcpy },
      winget: hasWinget(),
      installing: installingDep,
    }
  }
  route(P + '/deps', (req, res) => json(res, 200, depsInfo()))

  const WINGET_IDS = { adb: 'Google.PlatformTools', scrcpy: 'Genymobile.scrcpy' }
  route(
    P + '/deps/install',
    async (req, res) => {
      const body = await readBody(req)
      if (body.__tooLarge) return json(res, 413, { ok: false, error: '请求体太大' })
      const what = String(body.what || '')
      const id = WINGET_IDS[what]
      if (!id) return json(res, 400, { ok: false, error: 'what 只能是 adb 或 scrcpy' })
      if (installingDep) return json(res, 200, { ok: false, error: '正在装 ' + installingDep + '，稍等一下' })
      if (!hasWinget()) return json(res, 200, { ok: false, error: '这台机器没有 winget，只能手动安装 adb / scrcpy' })
      installingDep = what
      log('winget install ' + id + ' 开始')
      const r = await run(
        'winget',
        ['install', '--id', id, '--exact', '--silent', '--source', 'winget', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'],
        600000,
      )
      installingDep = ''
      cmdCache = { key: '\u0000', adb: '', scrcpy: '', at: 0 }
      const c = resolveCmds(cfg)
      const found = existsSync(what === 'adb' ? c.adb : c.scrcpy)
      log('winget ' + id + ' 结束 code=' + r.code + (found ? '，已找到' : '，仍然找不到'))
      json(res, 200, { ok: found, found, output: ((r.out || '') + (r.err || '')).slice(-1500) })
    },
    { mode: 'write' },
  )

  route(P + '/start', async (req, res) => json(res, 200, await manualStart()), { mode: 'write' })
  route(P + '/stop', (req, res) => json(res, 200, stop()), { mode: 'write' })
  route(P + '/unlock', async (req, res) => json(res, 200, await unlock()), { mode: 'write' })
  route(P + '/lock', async (req, res) => json(res, 200, await lock()), { mode: 'write' })

  route(
    P + '/key',
    async (req, res) => {
      const body = await readBody(req)
      if (body.__tooLarge) return json(res, 413, { ok: false, error: '请求体太大' })
      json(res, 200, await key(body.code || 3))
    },
    { mode: 'write' },
  )

  route(
    P + '/topmost',
    async (req, res) => {
      const body = await readBody(req)
      if (body.__tooLarge) return json(res, 413, { ok: false, error: '请求体太大' })
      if (typeof body.on !== 'boolean') return json(res, 400, { ok: false, error: '需要 {on: true|false}' })
      json(res, 200, await setTopmost(body.on))
    },
    { mode: 'write' },
  )

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
    // 把本次启动的 token 注入到面板脚本里：只有能同源拿到 panel.js 的页面才知道它，
    // 跨站页面既读不到脚本内容，也猜不到这个随机值。
    body = body.replace('__DPM_TOKEN__', TOKEN)
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
  if (process.platform !== 'win32') {
    // 不直接拒绝加载：只读接口（status/config/devices）在别的平台上仍有参考价值，
    // 但投屏、一键解锁、winget 安装这些会失败——提前说清楚，别让用户以为坏了。
    log('当前平台 ' + process.platform + ' 未适配：投屏/解锁/依赖安装只在 Windows 上验证过')
  }
}
