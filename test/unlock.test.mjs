// 一键解锁的纯逻辑测试：不需要手机，也不跑 adb。
// 样本就是这台华为 VCE-AL00 上真实 dumpsys 抓下来的关键行。
import test from 'node:test'
import assert from 'node:assert/strict'
import { isLocked, isAwake, swipeFor } from '../lib/unlock.js'

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

test('上滑坐标按屏幕高度算，竖屏 1080x2310 落在验证过的位置', () => {
  const sw = swipeFor({ width: 1080, height: 2310 })
  assert.equal(sw.x, 540)
  assert.equal(sw.from, 1848)
  assert.equal(sw.to, 647)
})

test('拿不到屏幕尺寸时退回 1080x2310，不抛错', () => {
  const sw = swipeFor(null)
  assert.equal(sw.x, 540)
  assert.ok(sw.from > sw.to)
})
