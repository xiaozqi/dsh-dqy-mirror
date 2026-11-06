// 设备选择是「插两台就出错」的根因，这里把规则钉死：
// 配置那台在线就用它；只有「同一台手机换了 IP」才敢替用户换；其它一律交给用户选。
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildScrcpyArgs, pickDevice, WINDOW_TITLE } from '../lib/args.js'

const DEV = (serial, model = '') => ({ serial, state: 'device', model })

test('配置那台在线：就用它，哪怕还有别的设备', () => {
  const list = [DEV('W899VKEY6TZDPRZ5', '2407FRK8EC'), DEV('192.168.137.195:5555', 'VCE_AL00')]
  const p = pickDevice(list, 'W899VKEY6TZDPRZ5')
  assert.equal(p.serial, 'W899VKEY6TZDPRZ5')
  assert.equal(p.source, 'configured')
  assert.equal(p.online.length, 2)
})

test('配置是无线串号、只剩一台无线在线：认为是换了 IP', () => {
  const p = pickDevice([DEV('192.168.137.235:5555', 'VCE_AL00')], '192.168.137.195:5555')
  assert.equal(p.serial, '192.168.137.235:5555')
  assert.equal(p.source, 'dhcp')
})

test('配置是无线串号、插进来的是一台 USB 手机：不接管，交给用户选', () => {
  const p = pickDevice([DEV('W899VKEY6TZDPRZ5', '2407FRK8EC')], '192.168.137.195:5555')
  assert.equal(p.serial, '')
  assert.equal(p.source, '')
  assert.equal(p.online.length, 1, '在线的列表仍要带回去，面板要用它列按钮')
})

test('两台无线同时在线：分不清是谁，不猜', () => {
  const list = [DEV('192.168.137.195:5555'), DEV('192.168.137.236:5555')]
  assert.equal(pickDevice(list, '192.168.137.99:5555').serial, '')
})

test('配置是 USB 串号、在线的却是另一台 USB：不接管', () => {
  const list = [DEV('ABC123'), DEV('DEF456')]
  assert.equal(pickDevice(list, 'ZZZ999').serial, '')
})

test('离线 / 未授权的设备不算在线', () => {
  const list = [
    { serial: 'X1', state: 'offline', model: '' },
    { serial: 'X2', state: 'unauthorized', model: '' },
  ]
  const p = pickDevice(list, 'X1')
  assert.equal(p.serial, '')
  assert.deepEqual(p.online, [])
})

test('没配手机：什么都不选', () => {
  assert.equal(pickDevice([DEV('A')], '').serial, '')
  assert.equal(pickDevice([DEV('A')], undefined).serial, '')
})

test('scrcpy 拿到的串号以「这次实际在用」的为准', () => {
  const cfg = { serial: '192.168.137.195:5555', windowWidth: 460 }
  const explicit = buildScrcpyArgs(cfg, WINDOW_TITLE, '192.168.137.235:5555')
  assert.equal(explicit[explicit.indexOf('--serial') + 1], '192.168.137.235:5555')

  // 不传第三个参数时退回配置里的串号（保持原有调用方式）
  const fallback = buildScrcpyArgs(cfg, WINDOW_TITLE)
  assert.equal(fallback[fallback.indexOf('--serial') + 1], '192.168.137.195:5555')
})
