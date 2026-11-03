import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS, sanitize } from '../lib/config.js'

test('空对象得到全默认值', () => {
  assert.deepEqual(sanitize({}), DEFAULTS)
  assert.deepEqual(sanitize(null), DEFAULTS)
})

test('类型收敛：字符串去空格、布尔转真值、数字取整', () => {
  const cfg = sanitize({
    serial: '  192.168.1.2:5555  ',
    windowWidth: '500',
    alwaysOnTop: 0,
    turnScreenOff: 'yes',
    autoStart: 1,
  })
  assert.equal(cfg.serial, '192.168.1.2:5555')
  assert.equal(cfg.windowWidth, 500)
  assert.equal(cfg.alwaysOnTop, false)
  assert.equal(cfg.turnScreenOff, true)
  assert.equal(cfg.autoStart, true)
})

test('未知字段被丢掉', () => {
  const cfg = sanitize({ serial: 'x', evil: 'rm -rf /', preview: true })
  assert.equal('evil' in cfg, false)
  assert.equal('preview' in cfg, false)
})

test('宽度和 graceMs 会被夹到合理区间', () => {
  assert.equal(sanitize({ windowWidth: 10 }).windowWidth, DEFAULTS.windowWidth)
  assert.equal(sanitize({ windowWidth: 99999 }).windowWidth, 2000)
  assert.equal(sanitize({ graceMs: 1 }).graceMs, DEFAULTS.graceMs)
  assert.equal(sanitize({ windowWidth: 'abc' }).windowWidth, DEFAULTS.windowWidth)
})

test('PIN 只收 4~12 位数字，别的一律退回默认', () => {
  assert.equal(sanitize({ pin: '1234' }).pin, '1234')
  assert.equal(sanitize({ pin: ' 000000 ' }).pin, '000000')
  assert.equal(sanitize({ pin: '12' }).pin, DEFAULTS.pin)
  assert.equal(sanitize({ pin: '1234567890123' }).pin, DEFAULTS.pin)
  assert.equal(sanitize({ pin: '000000; rm -rf /' }).pin, DEFAULTS.pin)
  assert.equal(sanitize({ pin: '' }).pin, DEFAULTS.pin)
})
