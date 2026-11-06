// 解锁脚本的「真 shell」回归测试。
//
// 背景：KEYGUARD 里塞了两条 dumpsys，如果不用 `{ ...; }` 包起来，
// `${KEYGUARD} | grep -q ...` 的管道只会接到第二条命令上，判断永远为假，
// 结果就是「检测到锁屏 → 撤锁屏 → 跳过上滑和输 PIN → 报 PIN 不对」。
// 纯字符串断言拦不住这种问题，所以这里用桩命令真的跑一遍脚本。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { unlockScript } from '../lib/unlock.js'

const hasSh = spawnSync('sh', ['-c', 'exit 0']).status === 0

test('解锁脚本在真 shell 里会走到「上滑 + 输 PIN」分支', { skip: hasSh ? false : '当前环境没有 sh' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'dqy-mirror-sh-'))
  const stub = (name, body) => {
    const p = join(dir, name)
    writeFileSync(p, '#!/bin/sh\n' + body + '\n')
    chmodSync(p, 0o755)
  }

  // 模拟一台「锁着、息屏」的 Android 10：window 里有 isStatusBarKeyguard=true
  stub(
    'dumpsys',
    [
      'case "$*" in',
      '  "window")',
      "    printf '%s\\n' '    mDreamingLockscreen=true' '    mStatusBar=Window{bb5d559 u0 StatusBar} isStatusBarKeyguard=true' ;;",
      '  "window policy")',
      "    printf '%s\\n' '      mKeyguardShowing=false' ;;",
      '  "power")',
      "    printf '%s\\n' '  mWakefulness=Asleep' ;;",
      'esac',
    ].join('\n'),
  )
  stub('wm', 'case "$*" in "size") echo "Physical size: 1080x2310" ;; esac\nexit 0')
  stub('input', 'exit 0')
  stub('sleep', 'exit 0')

  const r = spawnSync('sh', ['-c', unlockScript('000000')], {
    encoding: 'utf8',
    env: { ...process.env, PATH: dir + delimiter + (process.env.PATH || '') },
  })

  assert.equal(r.status, 0, '脚本不该报错：' + r.stderr)
  const out = r.stdout || ''
  assert.match(out, /MARK:state/, '应该先读一次状态')
  assert.match(out, /MARK:dismiss/, '锁屏时应该撤锁屏')
  assert.match(out, /MARK:swipe/, '撤完还锁着，应该上滑')
  assert.match(out, /MARK:pin/, '上滑后应该输 PIN')
})
