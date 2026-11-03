// 一键解锁的纯逻辑测试：不需要手机，也不跑 adb。
// 样本就是这台华为 VCE-AL00 上真实 dumpsys 抓下来的关键行。
import test from 'node:test'
import assert from 'node:assert/strict'
import { isLocked, isAwake, unlockScript } from '../lib/unlock.js'

const LOCKED = `
    mShowingDream=false mDreamingLockscreen=true mDreamingSleepToken=null
    mStatusBar=Window{bb5d559 u0 StatusBar} isStatusBarKeyguard=true
  mWakefulness=Awake
`

const UNLOCKED = `
    mShowingDream=false mDreamingLockscreen=false mDreamingSleepToken=null
    mStatusBar=Window{bb5d559 u0 StatusBar} isStatusBarKeyguard=false
  mWakefulness=Awake
`

test('isStatusBarKeyguard=true 判成锁屏', () => {
  assert.equal(isLocked(LOCKED), true)
})

test('解锁后 isStatusBarKeyguard=false 不再判成锁屏', () => {
  assert.equal(isLocked(UNLOCKED), false)
})

test('mDreamingLockscreen / mShowingLockscreen 任一为 true 也算锁屏', () => {
  assert.equal(isLocked('mDreamingLockscreen=true'), true)
  assert.equal(isLocked('mShowingLockscreen=true'), true)
  assert.equal(isLocked('mDreamingLockscreen=false'), false)
})

test('空输出 / 没抓到关键行时不误判成锁屏', () => {
  assert.equal(isLocked(''), false)
  assert.equal(isLocked(null), false)
  assert.equal(isLocked('mCurrentFocus=Window{abc u0 com.example}'), false)
})

test('isAwake 只认 mWakefulness=Awake', () => {
  assert.equal(isAwake(LOCKED), true)
  assert.equal(isAwake('mWakefulness=Asleep'), false)
  assert.equal(isAwake(''), false)
})

test('解锁脚本是一条命令：分支和等待都在手机端', () => {
  const s = unlockScript('000000')
  assert.ok(s.includes('MARK:state'))
  assert.ok(s.includes('FINAL:'))
  assert.ok(s.includes('input text 000000'))
  // 自动提交后不该无条件按回车：整个脚本里只允许出现一次 keyevent 66
  assert.equal(s.split('input keyevent 66').length - 1, 1)
})

test('PIN 里的数字直接进脚本，不做额外转义', () => {
  assert.ok(unlockScript('123456').includes('input text 123456'))
})
