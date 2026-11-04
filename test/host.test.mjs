// 宿主侧的冒烟测试：用一个假的 ctx 把 apply() 跑起来，再调几个路由，
// 确认「注册成功 / 状态返回 / 跨站写被拒」这三件事没坏。
// 不启动 scrcpy（配置用临时目录里的默认值，autoStart=false）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dfy-mirror-test-'))

const routes = new Map()

const ctx = {
  effect(fn) {
    try {
      fn()
    } catch {}
    return () => {}
  },
  on() {
    return () => {}
  },
  get() {
    return undefined
  },
  webServer: {
    register(route) {
      routes.set(route.path, route.handler)
      return () => {}
    },
    tapIndex() {
      return () => {}
    },
  },
}

const plugin = await import('../lib/index.js')
plugin.apply(ctx)

function fakeRes() {
  const res = {
    status: 0,
    body: '',
    headers: {},
    writeHead(code, headers) {
      res.status = code
      res.headers = headers || {}
    },
    end(body) {
      res.body = body || ''
    },
  }
  return res
}

const P = '/dsh-dfy-mirror'

test('apply 注册了核心路由，且没有桌面窗的遗留路由', () => {
  assert.equal(typeof plugin.apply, 'function')
  for (const p of ['/status', '/phone', '/config', '/devices', '/deps', '/deps/install', '/start', '/stop', '/key', '/unlock', '/lock', '/topmost', '/log', '/panel.js']) {
    assert.ok(routes.has(P + p), '缺少路由 ' + p)
  }
  for (const p of ['/widget', '/widget/ping', '/widget/close', '/widget/bye']) {
    assert.equal(routes.has(P + p), false, '桌面窗删了，不该再有 ' + p)
  }
})

test('GET /deps 返回 adb / scrcpy / winget 三项', async () => {
  const handler = routes.get(P + '/deps')
  const res = fakeRes()
  await handler({ method: 'GET', headers: { host: '127.0.0.1:1234' }, on() {}, pipe() {} }, res)
  const data = JSON.parse(res.body)
  assert.equal(data.ok, true)
  assert.equal(typeof data.adb.found, 'boolean')
  assert.equal(typeof data.scrcpy.found, 'boolean')
  assert.equal(typeof data.winget, 'boolean')
})

test('GET /status 返回状态机和配置摘要', async () => {
  const handler = routes.get(P + '/status')
  assert.equal(typeof handler, 'function')
  const res = fakeRes()
  await handler({ method: 'GET', headers: { host: '127.0.0.1:1234' }, on() {}, pipe() {} }, res)
  assert.equal(res.status, 200)
  const data = JSON.parse(res.body)
  assert.equal(data.ok, true)
  assert.equal(typeof data.state, 'string')
  assert.equal(typeof data.running, 'boolean')
  assert.equal(typeof data.serial, 'string')
  assert.equal('widgetRunning' in data, false)
})

test('改配置文件后 /status 自动重载（不用重启）', async () => {
  const { writeFileSync } = await import('node:fs')
  const { CONFIG_PATH } = await import('../lib/config.js')
  writeFileSync(CONFIG_PATH, JSON.stringify({ serial: 'reload-test-1' }))
  const handler = routes.get(P + '/status')
  const res = fakeRes()
  await handler({ method: 'GET', headers: { host: '127.0.0.1:1234' }, on() {}, pipe() {} }, res)
  assert.equal(JSON.parse(res.body).serial, 'reload-test-1')
})

test('GET /config 返回配置和默认值', async () => {
  const handler = routes.get(P + '/config')
  const res = fakeRes()
  await handler({ method: 'GET', headers: { host: '127.0.0.1:1234' }, on() {}, pipe() {} }, res)
  assert.equal(res.status, 200)
  const data = JSON.parse(res.body)
  assert.equal(data.ok, true)
  assert.equal(data.config.autoStart, false)
  assert.equal(data.defaults.reconnect, true)
})

test('跨站写操作被 403 拦掉', async () => {
  const handler = routes.get(P + '/key')
  const res = fakeRes()
  await handler(
    {
      method: 'POST',
      headers: { host: '127.0.0.1:1234', origin: 'http://evil.example' },
      on(evt, cb) {
        if (evt === 'end') cb()
      },
      pipe() {},
    },
    res,
  )
  assert.equal(res.status, 403)
})
