// 宿主侧的冒烟测试：用一个假的 ctx 把 apply() 跑起来，再调几个路由，
// 确认「注册成功 / 状态返回 / 写操作三重闸（POST + 同源 + token）」没坏。
// 不启动 scrcpy（配置用临时目录里的默认值，autoStart=false），也不触碰 adb。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dqy-mirror-test-'))

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

const P = '/dsh-dqy-mirror'

/** 走一遍插件的包装层：同源检查 / 方法检查 / token 检查都在里面。 */
async function call(path, { method = 'GET', headers = {}, body } = {}) {
  const handler = routes.get(P + path)
  assert.ok(handler, '没有注册路由 ' + path)
  const res = fakeRes()
  const req = {
    method,
    headers: { host: '127.0.0.1:1234', ...headers },
    on(evt, cb) {
      if (evt === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body)))
      if (evt === 'end') cb()
    },
    pipe() {},
  }
  await handler(req, res)
  return res
}

const panel = await call('/panel.js')
const tokenMatch = /var TOKEN = '([0-9a-f]{32})'/.exec(panel.body)
const TOKEN = tokenMatch ? tokenMatch[1] : ''
const AUTH = { 'x-dpm-token': TOKEN }

test('apply 注册了核心路由，且没有桌面窗的遗留路由', () => {
  assert.equal(typeof plugin.apply, 'function')
  for (const p of ['/status', '/phone', '/config', '/devices', '/deps', '/deps/install', '/start', '/stop', '/key', '/unlock', '/lock', '/topmost', '/log', '/panel.js', '/wireless', '/disconnect', '/reset', '/diagnostics']) {
    assert.ok(routes.has(P + p), '缺少路由 ' + p)
  }
  for (const p of ['/widget', '/widget/ping', '/widget/close', '/widget/bye']) {
    assert.equal(routes.has(P + p), false, '桌面窗删了，不该再有 ' + p)
  }
})

test('/panel.js 注入的 token 是随机值', () => {
  assert.ok(TOKEN, 'panel.js 里应该把占位符换成了 token')
  assert.equal(panel.body.includes('__DPM_TOKEN__'), false)
  assert.match(panel.body, /x-dpm-token/)
})

test('GET /deps 返回 adb / scrcpy / winget 三项', async () => {
  const res = await call('/deps')
  const data = JSON.parse(res.body)
  assert.equal(data.ok, true)
  assert.equal(typeof data.adb.found, 'boolean')
  assert.equal(typeof data.scrcpy.found, 'boolean')
  assert.equal(typeof data.winget, 'boolean')
  assert.equal(typeof data.adb.version, 'string')
  assert.match(data.plugin, /^\d+\.\d+\.\d+/)
})

test('GET /status 返回状态机和配置摘要', async () => {
  const res = await call('/status')
  assert.equal(res.status, 200)
  const data = JSON.parse(res.body)
  assert.equal(data.ok, true)
  assert.equal(typeof data.state, 'string')
  assert.equal(typeof data.running, 'boolean')
  assert.equal(typeof data.serial, 'string')
  assert.equal('widgetRunning' in data, false)
})

test('改配置文件后 /status 自动重载（不用重启）', async () => {
  const { CONFIG_PATH } = await import('../lib/config.js')
  writeFileSync(CONFIG_PATH, JSON.stringify({ serial: 'reload-test-1' }))
  const res = await call('/status')
  assert.equal(JSON.parse(res.body).serial, 'reload-test-1')
})

test('GET /config 返回配置和默认值', async () => {
  const res = await call('/config')
  assert.equal(res.status, 200)
  const data = JSON.parse(res.body)
  assert.equal(data.ok, true)
  assert.equal(data.config.autoStart, false)
  assert.equal(data.defaults.reconnect, true)
  assert.equal(data.defaults.audio, false)
})

test('跨站写操作被 403 拦掉', async () => {
  const res = await call('/key', {
    method: 'POST',
    headers: { origin: 'http://evil.example', ...AUTH },
    body: { code: 4 },
  })
  assert.equal(res.status, 403)
})

test('改状态的接口拒绝 GET（堵掉 <img src=.../unlock>）', async () => {
  for (const p of ['/start', '/stop', '/unlock', '/lock', '/key', '/topmost', '/wireless', '/disconnect', '/reset']) {
    const res = await call(p)
    assert.equal(res.status, 405, p + ' 只应该接受 POST')
  }
})

test('POST 没有 token 一律 403', async () => {
  for (const p of ['/start', '/unlock', '/lock', '/topmost']) {
    const res = await call(p, { method: 'POST', body: {} })
    assert.equal(res.status, 403, p + ' 缺 token 必须拒绝')
  }
})

test('POST 带 token 才进业务逻辑（/topmost 参数错 → 400 而不是 403）', async () => {
  const res = await call('/topmost', { method: 'POST', headers: AUTH, body: {} })
  assert.equal(res.status, 400)
})

test('PIN 不会出现在 GET /config 的响应里', async () => {
  const save = await call('/config', { method: 'POST', headers: AUTH, body: { pin: '123456' } })
  assert.equal(save.status, 200)
  assert.equal(JSON.parse(save.body).config.pin, '••••••')

  const read = await call('/config')
  assert.equal(JSON.parse(read.body).config.pin, '••••••')

  // 磁盘上仍然是真 PIN，否则解锁就没法用
  const { CONFIG_PATH } = await import('../lib/config.js')
  assert.equal(JSON.parse(readFileSync(CONFIG_PATH, 'utf8')).pin, '123456')
})

test('改 serial 不会把已有的 PIN 冲掉', async () => {
  await call('/config', { method: 'POST', headers: AUTH, body: { serial: '10.0.0.2:5555' } })
  const { CONFIG_PATH } = await import('../lib/config.js')
  const disk = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  assert.equal(disk.serial, '10.0.0.2:5555')
  assert.equal(disk.pin, '123456')
})

test('GET /diagnostics 带版本号，但不会泄露 PIN', async () => {
  const res = await call('/diagnostics')
  assert.equal(res.status, 200)
  const d = JSON.parse(res.body)
  assert.equal(d.ok, true)
  assert.match(d.text, /插件版本/)
  assert.match(d.text, /PIN: 已设置/)
  assert.equal(d.text.includes('123456'), false)
})

test('POST /reset 恢复默认，但保留连接的手机', async () => {
  const res = await call('/reset', { method: 'POST', headers: AUTH, body: {} })
  assert.equal(res.status, 200)
  const data = JSON.parse(res.body)
  assert.equal(data.config.pin, '')
  assert.equal(data.config.serial, '10.0.0.2:5555')
  assert.equal(data.config.windowWidth, 460)
  assert.equal(data.config.audio, false)
})
