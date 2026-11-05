// 一个 scrcpy 进程 = 一个会话。状态机只有五个状态：
//   idle → starting → running → stopping → idle，任何异常都落到 error
// 没有代理、没有 ffmpeg、没有第二个窗口：进程活着就是活着，死了就是死了。
import { spawn } from 'node:child_process'
import { describeExit } from './args.js'

export const STATE = {
  IDLE: 'idle',
  STARTING: 'starting',
  RUNNING: 'running',
  STOPPING: 'stopping',
  ERROR: 'error',
}

function killTree(pid) {
  if (!pid) return
  // Windows 上 proc.kill() 只杀父进程，scrcpy 的 adb 子进程会留下，所以要 /T。
  if (process.platform !== 'win32') {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* 进程可能已经没了 */
    }
    return
  }
  try {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  } catch {
    /* 进程可能已经没了 */
  }
}

export class MirrorSession {
  constructor(opts) {
    this.scrcpy = opts.scrcpy
    this.args = opts.args || []
    this.graceMs = opts.graceMs || 1200
    this.log = opts.log || (() => {})
    this.onExit = opts.onExit || (() => {})

    this.state = STATE.IDLE
    this.error = ''
    this.since = 0
    this.proc = null
    this.timer = null
    this.exitTimer = null
    this.stderr = []
  }

  tail() {
    return this.stderr.slice(-3).join(' | ').slice(0, 300)
  }

  start() {
    if (this.state === STATE.RUNNING || this.state === STATE.STARTING) return { ok: true, already: true }

    this.error = ''
    this.since = Date.now()
    this.stderr = []
    this.state = STATE.STARTING
    this.log('启动 scrcpy：' + this.scrcpy + ' ' + this.args.join(' '))

    let proc
    try {
      proc = spawn(this.scrcpy, this.args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      this.error = '启动 scrcpy 失败：' + String((e && e.message) || e)
      this.state = STATE.ERROR
      return { ok: false, error: this.error }
    }
    this.proc = proc

    const collect = (d) => {
      const text = String(d).trim()
      if (!text) return
      this.stderr.push(text)
      if (this.stderr.length > 60) this.stderr.shift()
      this.log(text)
    }
    proc.stdout.on('data', collect)
    proc.stderr.on('data', collect)
    proc.on('error', (e) => {
      this.error = '启动 scrcpy 失败：' + String((e && e.message) || e)
      this.state = STATE.ERROR
    })
    proc.on('exit', (code) => this.handleExit(code))

    // 活过 graceMs 就算起来了；scrcpy 出问题一般会在这之前就退出
    this.timer = setTimeout(() => {
      if (this.state === STATE.STARTING) {
        this.state = STATE.RUNNING
        this.log('scrcpy 已运行')
      }
    }, this.graceMs)

    return { ok: true }
  }

  handleExit(code) {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const wasStopping = this.state === STATE.STOPPING
    this.proc = null
    if (wasStopping) {
      this.state = STATE.IDLE
      this.log('已停止')
      this.onExit(0, true)
      return
    }
    if (code === 0) {
      this.state = STATE.IDLE
      this.error = ''
      this.log('scrcpy 正常退出（窗口被关掉）')
    } else {
      this.state = STATE.ERROR
      this.error = describeExit(code) + (this.tail() ? '：' + this.tail() : '')
      this.log(this.error)
    }
    this.onExit(code, false)
  }

  stop() {
    if (!this.proc) {
      this.state = STATE.IDLE
      return { ok: true, already: true }
    }
    this.state = STATE.STOPPING
    const pid = this.proc.pid
    // 先直接 TerminateProcess：taskkill /T 走一圈要 2~3 秒，状态会一直挂在 stopping
    try {
      this.proc.kill()
    } catch {
      /* 已经没了 */
    }
    // 再补一刀清理子进程（adb 之类），不阻塞状态
    killTree(pid)
    // 兜底：3 秒还没退出就认定它死了，别让状态永远停在 stopping
    this.exitTimer = setTimeout(() => {
      if (this.state === STATE.STOPPING) {
        this.proc = null
        this.state = STATE.IDLE
        this.log('停止超时，已强制标记为 idle')
      }
    }, 3000)
    return { ok: true }
  }

  status() {
    return {
      state: this.state,
      running: this.state === STATE.RUNNING,
      busy: this.state === STATE.STARTING || this.state === STATE.STOPPING,
      error: this.error,
      since: this.since,
      tail: this.state === STATE.ERROR ? this.tail() : '',
    }
  }
}
