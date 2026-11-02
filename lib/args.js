// 纯函数：拼 scrcpy 参数、解析 adb 输出。没有 IO，方便单测。

export const WINDOW_TITLE = '手机投屏'

/**
 * 新架构只用一个引擎：scrcpy 自己的窗口。
 * 所以这里也不需要任何「私货」参数——没有代理端口、没有 adb 包装器、没有无边框技巧。
 */
export function buildScrcpyArgs(cfg, title = WINDOW_TITLE) {
  const args = ['--no-audio', '--window-title', title]
  if (cfg.serial) args.push('--serial', String(cfg.serial))
  if (Number(cfg.windowWidth) > 0) args.push('--window-width', String(Math.round(cfg.windowWidth)))
  if (cfg.alwaysOnTop) args.push('--always-on-top')
  // 坑：--stay-awake 会把 --turn-screen-off 顶掉（插电时强制亮屏），别加。
  if (cfg.turnScreenOff) args.push('--turn-screen-off')
  return args
}

/** `adb devices -l` 的输出 → [{ serial, state, model }] */
export function parseDevices(text) {
  const out = []
  for (const line of String(text || '').split(/\r?\n/).slice(1)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const m = /^(\S+)\s+(\S+)(?:\s+.*?\bmodel:(\S+))?/.exec(trimmed)
    if (!m) continue
    out.push({ serial: m[1], state: m[2], model: m[3] || '' })
  }
  return out
}

/** `wm size` 的输出 → { width, height } */
export function parseWmSize(text) {
  const m = /(\d+)\s*x\s*(\d+)/.exec(String(text || ''))
  return m ? { width: Number(m[1]), height: Number(m[2]) } : null
}

/** 退出码人话化，面板上直接显示 */
export function describeExit(code) {
  if (code === 0) return '投屏窗口已关闭'
  if (code === 1) return 'scrcpy 启动失败（看日志）'
  if (code === 2) return 'scrcpy 参数或设备有问题'
  if (code === 3221225620) return 'scrcpy 崩溃了（0xC0000005，通常是端口/驱动冲突）'
  return 'scrcpy 退出（代码 ' + code + '）'
}
