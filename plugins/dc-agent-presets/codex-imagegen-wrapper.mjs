#!/usr/bin/env node
// dsh-generate-image 的 codex adapter 固定會加 `-s <sandbox>`；Codex 只要看到
// `--sandbox` 就會忽略 permission profile。這個 wrapper 在 exec 前把它拿掉，
// 改成 `-c default_permissions=...`，只為了擋掉 /mnt 的讀取。
//
// 真正的 codex 路徑由 dc-draw-image 用 `--dc-real-codex` 傳進來；wrapper 會把
// 這個自訂參數拿掉，再把 codex 的 stdout/stderr 原樣接回 adapter 的 pipe。
import { spawn } from 'node:child_process'

const args = process.argv.slice(2)
const realIdx = args.indexOf('--dc-real-codex')
if (realIdx < 0 || !args[realIdx + 1]) {
  console.error('[codex-imagegen-wrapper] 缺少 --dc-real-codex')
  process.exit(127)
}
const real = args[realIdx + 1]
args.splice(realIdx, 2)

const sandboxIdx = args.indexOf('-s')
if (sandboxIdx >= 0) args.splice(sandboxIdx, 2)

// `-c` 的 dotted path 不會拆掉 key 的引號：`filesystem."/mnt"` 會讓 Codex 看到
// 帶引號的路徑而拒絕啟動。這裡的 key 沒有 `.`，直接寫就不需要引號。
const profile = [
  'default_permissions="dc-imagegen"',
  'permissions.dc-imagegen.filesystem.:root=read',
  'permissions.dc-imagegen.filesystem./mnt=deny',
]
const jsonIdx = args.indexOf('--json')
const at = jsonIdx >= 0 ? jsonIdx : args.length
args.splice(at, 0, ...profile.flatMap((entry) => ['-c', entry]))

// 用 execve 讓 wrapper 的 PID 直接變成 codex：adapter 逾時／取消時殺到的就是
// 真正的 codex，不會留下背景程序繼續燒額度。舊版 Node 或 Windows 才退回 spawn。
if (typeof process.execve === 'function') {
  try {
    process.execve(real, [real, ...args], process.env)
  } catch (error) {
    if (process.platform !== 'win32') {
      console.error(`[codex-imagegen-wrapper] execve 失敗：${error?.message ?? error}`)
      process.exit(127)
    }
  }
}

const child = spawn(process.execPath, [real, ...args], {
  stdio: ['ignore', 'inherit', 'inherit'],
  env: process.env,
})
child.on('error', (error) => {
  console.error(`[codex-imagegen-wrapper] 無法啟動 codex：${error?.message ?? error}`)
  process.exit(127)
})
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
