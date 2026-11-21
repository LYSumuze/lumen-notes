/**
 * Robust Electron launcher.
 *
 * Some terminal environments export ELECTRON_RUN_AS_NODE=1, which makes
 * `electron .` run the main process as plain Node — `require('electron')`
 * then returns only the binary path and `app` is undefined. We strip that
 * variable for the child so the real GUI always starts. The forked sync
 * service re-adds the flag itself
 * (see main.cjs startServer), so nothing else is affected.
 */
const { spawn } = require('node:child_process')
const path = require('node:path')

const electronBinary = require('electron') // under plain Node this is the exe path
const appRoot = path.resolve(__dirname, '..')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

// Chromium switches must come BEFORE the app path, otherwise Electron treats
// them as application argv and silently ignores them.
const args = []
// Optional: enables CDP for smoke tests / UI inspection. Off by default.
if (process.env.LUMEN_DEBUG_PORT) {
  args.push(`--remote-debugging-port=${process.env.LUMEN_DEBUG_PORT}`)
  console.log(`[launch] CDP enabled on ${process.env.LUMEN_DEBUG_PORT}`)
}
args.push(appRoot)

const child = spawn(electronBinary, args, { stdio: 'inherit', env })
child.on('exit', (code) => process.exit(code == null ? 0 : code))
child.on('error', (err) => {
  console.error('[launch] 无法启动 Electron：', err && err.message)
  process.exit(1)
})
