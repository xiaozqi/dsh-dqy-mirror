// 一键解锁：唤醒 → 撤锁屏 → 需要时上滑 + 输 PIN → 复核 keyguard 状态。
//
// 这台华为（VCE-AL00 / Android 10）上实测出来的判据：
//   锁屏时   dumpsys window 里有 isStatusBarKeyguard=true、mDreamingLockscreen=true
//   解锁后   两项都变 false，mWakefulness=Awake
// 所以「已解锁」时绝不会去上滑/输 PIN——不会把 000000 打进正在用的 App 里。
//
// 为了少几次 adb 往返（WiFi 上一次约 0.3~1s），每个阶段拼成一条 shell 命令，
// 等待放在手机端 sleep；整个流程从 9s 降到 7s 左右。
//
// 纯判断函数（isLocked / isAwake / swipeFor）单独导出，方便单测。
import { spawn } from 'node:child_process'
import { parseWmSize } from './args.js'

/** dumpsys window 的关键行 → 是否还停在锁屏。 */
export function isLocked(dump) {
  const text = String(dump || '')
  if (/isStatusBarKeyguard\s*=\s*true/.test(text)) return true
  if (/mDreamingLockscreen\s*=\s*true/.test(text)) return true
  if (/mShowingLockscreen\s*=\s*true/.test(text)) return true
  return false
}

/** dumpsys power 的关键行 → 屏幕是否醒着。 */
export function isAwake(dump) {
  return /mWakefulness\s*=\s*Awake/.test(String(dump || ''))
}

/** 上滑坐标：在 1080x2310 上验证过，能稳定把安全锁屏的 PIN 键盘拉出来。 */
export function swipeFor(size) {
  const w = Number(size && size.width) || 1080
  const h = Number(size && size.height) || 2310
  return { x: Math.round(w / 2), from: Math.round(h * 0.8), to: Math.round(h * 0.28), ms: 220 }
}

const KEYGUARD_GREP = "dumpsys window | grep -E 'isStatusBarKeyguard|mDreamingLockscreen|mShowingLockscreen'"
const AWAKE_GREP = 'dumpsys power | grep mWakefulness='

function run(cmd, args, timeoutMs = 10000) {
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

/**
 * 把手机弄到「亮着且已解锁」的状态。
 * @param {{adb?: string, serial?: string, pin?: string, log?: (m: string) => void}} opts
 * @returns {Promise<{ok: boolean, locked?: boolean, awake?: boolean, already?: boolean, steps: string[], error?: string}>}
 */
export async function unlockPhone({ adb, serial, pin, log = () => {} }) {
  if (!adb) return { ok: false, steps: [], error: '找不到 adb' }
  if (!serial) return { ok: false, steps: [], error: '还没填设备地址' }

  const sh = (cmd, timeout = 15000) => run(adb, ['-s', serial, 'shell', cmd], timeout)
  const steps = []

  // 阶段 1：点亮 + 撤锁屏，然后一次性读回 keyguard / 亮屏状态。
  // WAKEUP 只会把屏幕叫醒，不会把已亮的屏幕按灭。
  const first = (await sh(`input keyevent 224; sleep 0.6; wm dismiss-keyguard; sleep 0.5; ${KEYGUARD_GREP}; ${AWAKE_GREP}`)).out
  steps.push('唤醒')
  const awake1 = isAwake(first)

  if (!isLocked(first)) {
    log('解锁：本来就已经解锁')
    return { ok: awake1, locked: false, awake: awake1, already: true, steps }
  }

  // 阶段 2：安全锁屏 → 上滑（PIN 键盘才会出现）→ 输 PIN → 回车 → 复核。
  if (!pin) {
    return { ok: false, locked: true, steps, error: '手机有锁屏 PIN，但配置里没填（设置 → 手机投屏 → 解锁 PIN）' }
  }
  const size = parseWmSize((await sh('wm size', 8000)).out)
  const sw = swipeFor(size)
  const second = (
    await sh(
      `input swipe ${sw.x} ${sw.from} ${sw.x} ${sw.to} ${sw.ms}; sleep 0.7; input text ${pin}; sleep 0.4; ` +
        `input keyevent 66; sleep 1.6; ${KEYGUARD_GREP}; ${AWAKE_GREP}`,
    )
  ).out
  steps.push('上滑', '输入 PIN')

  const locked = isLocked(second)
  const awake = isAwake(second)
  const result = { ok: !locked && awake, locked, awake, steps }
  if (!result.ok) result.error = locked ? '解锁失败：还停在锁屏（PIN 可能不对）' : '手机没醒'
  return result
}
