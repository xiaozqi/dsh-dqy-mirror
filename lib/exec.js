// 跑一个外部命令，带超时；永不 reject（调用方只看 code/out/err）。
//
// 宿主和 unlock.js 之前各抄了一份一模一样的实现，改超时策略要改两处，
// 现在只剩这一份。失败一律折成 { code: -1, err }：
//   - 进程起不来（ENOENT）→ code -1
//   - 超时被 kill          → code -1，err='timeout'
import { spawn } from 'node:child_process'

/**
 * @param {string} cmd
 * @param {readonly string[]} args
 * @param {number} [timeoutMs]
 * @returns {Promise<{code: number, out: string, err: string}>}
 */
export function run(cmd, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      resolve(result)
    }

    let proc
    try {
      proc = spawn(cmd, args, { windowsHide: true })
    } catch (e) {
      finish({ code: -1, out, err: String((e && e.message) || e) })
      return
    }

    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        /* 已经退出 */
      }
      finish({ code: -1, out, err: 'timeout' })
    }, timeoutMs)

    proc.stdout.on('data', (d) => (out += d))
    proc.stderr.on('data', (d) => (err += d))
    proc.on('error', (e) => {
      clearTimeout(timer)
      finish({ code: -1, out, err: String((e && e.message) || e) })
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      finish({ code, out, err })
    })
  })
}
