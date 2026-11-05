// 一键解锁：唤醒 → 撤锁屏 → 需要时上滑 + 输 PIN → 复核 keyguard 状态。
//
// 判据是在华为 VCE-AL00 / Android 10 上实测出来的：
//   锁屏时   dumpsys window 里有 isStatusBarKeyguard=true、mDreamingLockscreen=true
//   解锁后   两项都变 false，mWakefulness=Awake
// Android 12 之后这些字段改过名/搬过家，所以这里不做「猜」：
// 一个判据字段都读不到时返回 null，让上层明确报「读不到状态」，而不是假装已解锁。
// 这一点很关键——假判「已解锁」会把 PIN 打进正在使用的 App 里。
//
// 性能：adb 在 WiFi 上一个来回就要 0.3~1 秒，`input` 每条也要 0.5~0.8 秒，
// 所以整个流程压成 **一条 adb shell 命令**，所有分支和等待都在手机端做：
//   已解锁     → 一次 dumpsys 就返回（~0.4s）
//   锁屏但醒着 → 跳过唤醒（省一次 input）
//   锁着       → 上滑 + 输 PIN，PIN 自动提交就不再补回车
// 主机只负责把输出里的 MARK / FINAL 解析成步骤和最终状态。
//
// 纯判断函数（isLocked / isAwake / isSecure / keyguardSignals）单独导出，方便单测。
import { run } from './exec.js'

// 「锁屏中」的几种写法，按系统版本从新到旧。命中任意一条就算锁着。
const LOCKED_PATTERNS = [
  /isStatusBarKeyguard\s*=\s*true/,
  /mDreamingLockscreen\s*=\s*true/,
  /mShowingLockscreen\s*=\s*true/,
  /mKeyguardShowing\s*=\s*true/,
  /KeyguardServiceDelegate[\s\S]{0,240}?\bshowing\s*=\s*true/,
]

// 「系统有没有在输出里给锁屏判据」。给了（哪怕全是 false）才敢下结论。
const SIGNAL_PATTERNS = [
  /isStatusBarKeyguard\s*=/,
  /mDreamingLockscreen\s*=/,
  /mShowingLockscreen\s*=/,
  /mKeyguardShowing\s*=/,
  /KeyguardServiceDelegate/,
  /mWakefulness\s*=/,
]

/**
 * 输出里出现了几种判据字段（0 = 这个系统不认，别下结论）。
 * @param {string} dump
 * @returns {number}
 */
export function keyguardSignals(dump) {
  const text = String(dump || '')
  let n = 0
  for (const re of SIGNAL_PATTERNS) if (re.test(text)) n++
  return n
}

/**
 * dumpsys 的关键行 → 是否还停在锁屏。
 * @returns {boolean|null} null = 判据字段一个都没有（系统不支持/输出被裁剪）
 */
export function isLocked(dump) {
  const text = String(dump || '')
  if (LOCKED_PATTERNS.some((re) => re.test(text))) return true
  return keyguardSignals(text) > 0 ? false : null
}

/**
 * dumpsys power 的关键行 → 屏幕是否醒着。
 * @returns {boolean|null} null = 没读到 mWakefulness
 */
export function isAwake(dump) {
  const m = /mWakefulness\s*=\s*(\w+)/.exec(String(dump || ''))
  return m ? m[1] === 'Awake' : null
}

/**
 * keyguard 是不是「安全锁」——有没有设 PIN / 图案 / 密码。
 * dumpsys window 里 KeyguardServiceDelegate 那一段有一行 `secure=true`；
 * 没设密码时是 `secure=false`。注意别匹配到 `mSimSecure=`，所以要锚定行首。
 * @returns {boolean|null} null = 没读到（老系统没有这一行）
 */
export function isSecure(dump) {
  const m = /^\s*secure=(true|false)\s*$/m.exec(String(dump || ''))
  return m ? m[1] === 'true' : null
}

const KEYGUARD =
  "dumpsys window 2>/dev/null | grep -E 'isStatusBarKeyguard|mDreamingLockscreen|mShowingLockscreen|mKeyguardShowing|showing='; " +
  "dumpsys window policy 2>/dev/null | grep -E 'mKeyguardShowing|isStatusBarKeyguard'"
const AWAKE = 'dumpsys power 2>/dev/null | grep mWakefulness='

// 一条命令做完所有事；MARK 用来回放步骤，FINAL 后面是结束时的状态。
//
// 省时间的三处：
//   1. 只有真睡着才发 WAKE（`input` 一次 0.5~0.8 秒）
//   2. 输完 PIN 那次 dumpsys 直接当 FINAL 用，不再多查一遍
//   3. 等待都压到刚好够用的长度
export function unlockScript(pin) {
  const hasPin = typeof pin === 'string' && /^\d{4,12}$/.test(pin)
  const swipe =
    `S=$(wm size | sed -n 's/.*: \\([0-9]*\\)x\\([0-9]*\\).*/\\1 \\2/p' | tail -1); set -- $S; W=$1; H=$2; ` +
    `input swipe $((W/2)) $((H*8/10)) $((W/2)) $((H*28/100)) 220; echo MARK:swipe; sleep 0.35`

  const lines = [
    `S0=$(${KEYGUARD}; ${AWAKE})`,
    'echo MARK:state',
    'echo "$S0"',
    // 先唤醒（不管锁没锁）：已解锁但息屏时也要把屏幕点亮
    `if ! echo "$S0" | grep -q 'mWakefulness=Awake'; then input keyevent 224; echo MARK:wake; sleep 0.25; fi`,
    `if echo "$S0" | grep -q 'isStatusBarKeyguard=true'; then`,
    `  wm dismiss-keyguard; echo MARK:dismiss; sleep 0.2`,
    `  if ${KEYGUARD} | grep -q 'isStatusBarKeyguard=true'; then`,
  ]
  if (hasPin) {
    lines.push(
      `    ${swipe}`,
      `    input text ${pin}; echo MARK:pin; sleep 0.8`,
      // 这次查询就是最终状态：解锁了就不再查第二遍
      `    F=$(${KEYGUARD}; ${AWAKE})`,
      `    if echo "$F" | grep -q 'isStatusBarKeyguard=true'; then`,
      `      sleep 0.4; F=$(${KEYGUARD}; ${AWAKE})`,
      `      if echo "$F" | grep -q 'isStatusBarKeyguard=true'; then input keyevent 66; echo MARK:enter; sleep 0.8; F=$(${KEYGUARD}; ${AWAKE}); fi`,
      '    fi',
    )
  } else {
    // 没设锁屏密码：dismiss-keyguard 一般就开了；个别机器还要上滑一下
    lines.push(`    ${swipe}`, `    F=$(${KEYGUARD}; ${AWAKE})`)
  }
  lines.push(
    '  else',
    `    F=$(${KEYGUARD}; ${AWAKE})`,
    '  fi',
    'else',
    '  echo MARK:unlocked',
    `  F=$(${KEYGUARD}; ${AWAKE})`,
    'fi',
    'echo FINAL:',
    'echo "$F"',
  )
  return lines.join('\n')
}

/**
 * 把手机弄到「亮着且已解锁」的状态。
 * @param {{adb?: string, serial?: string, pin?: string, log?: (m: string) => void}} opts
 */
export async function unlockPhone({ adb, serial, pin, log = () => {} }) {
  if (!adb) return { ok: false, steps: [], error: '找不到 adb' }
  if (!serial) return { ok: false, steps: [], error: '还没填设备地址' }

  const r = await run(adb, ['-s', serial, 'shell', unlockScript(pin)], 25000)
  const out = r.out || ''
  if (r.code === -1) return { ok: false, steps: [], error: 'adb 执行失败：' + (r.err || '').trim() }

  const cut = out.lastIndexOf('FINAL:')
  const actions = cut >= 0 ? out.slice(0, cut) : out
  const finalDump = cut >= 0 ? out.slice(cut + 6) : out

  const steps = []
  const already = /MARK:unlocked/.test(actions)
  if (/MARK:wake/.test(actions)) steps.push('唤醒')
  if (/MARK:swipe/.test(actions)) steps.push('上滑')
  if (/MARK:pin/.test(actions)) steps.push('输入 PIN')
  if (/MARK:enter/.test(actions)) steps.push('回车')

  const locked = isLocked(finalDump)
  const awake = isAwake(finalDump)

  // 判据不可用：宁可报错，也不要谎报「已解锁」——上层会据此决定要不要继续操作
  if (locked === null) {
    return {
      ok: false,
      steps,
      locked: null,
      awake,
      unsupported: true,
      error: '读不到锁屏状态：这台 Android 版本的 dumpsys 输出不认识，解锁已跳过',
    }
  }

  if (already) {
    return { ok: locked === false && awake !== false, locked, awake, already: true, steps }
  }
  const result = { ok: locked === false && awake !== false, locked, awake, steps }
  if (!result.ok) {
    result.error =
      locked === true ? '解锁失败：还停在锁屏（PIN 可能不对）' : '手机没醒'
  }
  if (result.ok) log('解锁完成：' + steps.join(' → '))
  return result
}
