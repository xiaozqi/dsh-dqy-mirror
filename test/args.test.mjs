import test from 'node:test'
import assert from 'node:assert/strict'
import { buildScrcpyArgs, describeExit, parseDevices, parseWmSize, WINDOW_TITLE } from '../lib/args.js'

test('默认参数：串号、宽度、置顶、关屏，一个不少', () => {
  const args = buildScrcpyArgs(
    { serial: '192.168.1.2:5555', windowWidth: 460, alwaysOnTop: true, turnScreenOff: true },
    WINDOW_TITLE,
  )
  assert.deepEqual(args, [
    '--no-audio',
    '--window-title',
    '手机投屏',
    '--serial',
    '192.168.1.2:5555',
    '--window-width',
    '460',
    '--always-on-top',
    '--turn-screen-off',
  ])
})

test('永远不出现 v1 的那些私货参数', () => {
  const args = buildScrcpyArgs({ serial: 'x', windowWidth: 400, alwaysOnTop: false, turnScreenOff: false })
  for (const banned of ['--stay-awake', '--window-borderless', '--max-size', '--window-x', '--window-y']) {
    assert.equal(args.includes(banned), false, banned + ' 不应该出现')
  }
  assert.equal(args.includes('--always-on-top'), false)
  assert.equal(args.includes('--turn-screen-off'), false)
})

test('没有串号时不传 --serial', () => {
  const args = buildScrcpyArgs({ serial: '', windowWidth: 460, alwaysOnTop: true, turnScreenOff: true })
  assert.equal(args.includes('--serial'), false)
})

test('adb devices -l 解析', () => {
  const text = [
    'List of devices attached',
    '192.168.137.235:5555   device product:VCE-AL00 model:VCE_AL00 device:HWVCE transport_id:43',
    'emulator-5554          device product:ALN-AL10 model:ALN_AL10 device:gracelte transport_id:42',
    '0123456789ABCDEF       offline',
    '',
  ].join('\r\n')
  const list = parseDevices(text)
  assert.equal(list.length, 3)
  assert.deepEqual(list[0], { serial: '192.168.137.235:5555', state: 'device', model: 'VCE_AL00' })
  assert.deepEqual(list[1], { serial: 'emulator-5554', state: 'device', model: 'ALN_AL10' })
  assert.deepEqual(list[2], { serial: '0123456789ABCDEF', state: 'offline', model: '' })
})

test('wm size 解析', () => {
  assert.deepEqual(parseWmSize('Physical size: 1080x2310'), { width: 1080, height: 2310 })
  assert.equal(parseWmSize('garbage'), null)
})

test('退出码翻译成人话', () => {
  assert.equal(describeExit(0), '投屏窗口已关闭')
  assert.match(describeExit(3221225620), /0xC0000005/)
  assert.match(describeExit(1), /启动失败/)
  assert.match(describeExit(2), /参数或设备/)
})
