// 配置模块：只做「读文件 → 校验 → 补默认值」这一件事，不碰进程、不碰网络。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
export const CONFIG_PATH = join(HOME, 'phone-mirror.json')

export const DEFAULTS = {
  serial: '', // adb 序列号；网络设备就是 ip:port
  adb: '', // 空 = 自动找
  scrcpy: '', // 空 = 自动找
  autoStart: false,
  alwaysOnTop: true, // 手机窗口一直浮在最上面
  windowWidth: 460, // 窗口内容宽度（物理像素）
  turnScreenOff: true, // 投屏时关掉手机屏幕，省电
  graceMs: 1200, // scrcpy 活过这么久才算「启动成功」
  widget: true, // 打开页面时自动拉起「桌面控制窗」（全局置顶的那个小窗口）
  reconnect: true, // 意外掉线（网络抖动、手机休眠）自动重连
}

const STRING_KEYS = new Set(['serial', 'adb', 'scrcpy'])
const BOOL_KEYS = new Set(['autoStart', 'alwaysOnTop', 'turnScreenOff', 'widget', 'reconnect'])
const INT_KEYS = new Set(['windowWidth', 'graceMs'])

/** 把任意输入收敛成一份合法配置；未知字段直接丢掉。 */
export function sanitize(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const cfg = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS)) {
    if (!(key in raw)) continue
    const value = raw[key]
    if (STRING_KEYS.has(key)) {
      cfg[key] = String(value ?? '').trim()
    } else if (BOOL_KEYS.has(key)) {
      cfg[key] = !!value
    } else if (INT_KEYS.has(key)) {
      const n = Number(value)
      if (Number.isFinite(n) && n > 0) cfg[key] = Math.round(n)
    }
  }
  if (cfg.windowWidth < 120) cfg.windowWidth = DEFAULTS.windowWidth
  if (cfg.windowWidth > 2000) cfg.windowWidth = 2000
  if (cfg.graceMs < 200) cfg.graceMs = DEFAULTS.graceMs
  return cfg
}

export function loadConfig() {
  try {
    return sanitize(JSON.parse(readFileSync(CONFIG_PATH, 'utf8')))
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveConfig(cfg) {
  try {
    mkdirSync(HOME, { recursive: true })
    writeFileSync(CONFIG_PATH, JSON.stringify(sanitize(cfg), null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}
