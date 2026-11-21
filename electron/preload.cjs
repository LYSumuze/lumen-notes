/** Minimal, read-only bridge exposed to the unchanged web bundle. */
const { contextBridge, ipcRenderer } = require('electron')

// Buffer early IPC so a command / file-open that fires before React mounts
// (e.g. first launch with a .md argument at did-finish-load) is not lost.
const pendingCommands = []
const pendingPaths = []
let commandCb = null
let openPathCb = null

ipcRenderer.on('lumen-command', (_event, id) => {
  if (commandCb) commandCb(id)
  else pendingCommands.push(id)
})
ipcRenderer.on('lumen-open-path', (_event, p) => {
  if (openPathCb) openPathCb(p)
  else pendingPaths.push(p)
})

// Injected by main.cjs through additionalArguments so the renderer can decide
// synchronously (before first paint) whether to open the vault-picker step.
const FIRST_RUN = process.argv.includes('--lumen-first-run=1')
// Separate one-shot request: after an uninstall that KEPT personal data and a
// reinstall, the start page must reappear even though a valid vault config is
// still present. It never changes which vault the shell resolved.
const SHOW_WELCOME = process.argv.includes('--lumen-show-welcome=1')
// 主进程在窗口创建前探测托盘宿主，这里是「图标真的可见」而非仅构造了 Tray。
const HAS_TRAY = process.argv.includes('--lumen-has-tray=1')
// 真实 process.platform，UI 不再靠 navigator.userAgent 猜操作系统。
const OS_PLATFORM = (process.argv.find((a) => a.startsWith('--lumen-platform=')) || '').split('=')[1] || ''

contextBridge.exposeInMainWorld('lumenDesktop', {
  isDesktop: true,
  isFirstRun: FIRST_RUN,
  showWelcomeOnLaunch: SHOW_WELCOME,
  hasTray: HAS_TRAY,
  osPlatform: OS_PLATFORM,
  getVault: () => ipcRenderer.invoke('get-vault'),
  getOrigin: () => ipcRenderer.invoke('get-origin'),
  chooseVault: () => ipcRenderer.invoke('choose-vault'),
  listVaults: () => ipcRenderer.invoke('list-vaults'),
  selectVault: (p) => ipcRenderer.invoke('select-vault', p),
  createVault: () => ipcRenderer.invoke('create-vault'),
  acceptVault: () => ipcRenderer.invoke('accept-vault'),
  revealVault: () => ipcRenderer.invoke('reveal-vault'),
  revealPath: (p) => ipcRenderer.invoke('reveal-path', p),
  onAskClose: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('ask-close', handler)
    return () => ipcRenderer.removeListener('ask-close', handler)
  },
  resolveClose: (action) => ipcRenderer.invoke('window-close-action', action),
  onVaultChanged: (cb) => {
    const handler = (_event, vault) => cb(vault)
    ipcRenderer.on('vault-changed', handler)
    return () => ipcRenderer.removeListener('vault-changed', handler)
  },
  /** Native menu → run an in-page command (commands.ts id). */
  onCommand: (cb) => {
    commandCb = cb
    if (pendingCommands.length) {
      const queued = pendingCommands.splice(0)
      for (const id of queued) cb(id)
    }
    return () => { if (commandCb === cb) commandCb = null }
  },
  /** OS opened a .md (double-click / second instance). */
  onOpenPath: (cb) => {
    openPathCb = cb
    if (pendingPaths.length) {
      const queued = pendingPaths.splice(0)
      for (const p of queued) cb(p)
    }
    return () => { if (openPathCb === cb) openPathCb = null }
  },
})
