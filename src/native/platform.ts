/**
 * Platform bridge contract.
 *
 * The product is a desktop app (Electron) and a phone app (Capacitor/Android).
 * There is no browser product: a plain browser session shows an "use the app"
 * screen instead of the editor. The browser is only the rendering engine that
 * both native shells load — the same static dist/ bundle, no Node APIs.
 *
 * Every device owns a LOCAL VAULT: a folder the user picks once on first run.
 * Saving writes the real .md in that folder. The desktop shell does this via
 * its embedded Node service; Android will implement `vaultFs` with SAF
 * (ACTION_OPEN_DOCUMENT_TREE + takePersistableUriPermission). iOS, when the
 * day comes, uses UIDocumentPickerViewController + security-scoped bookmark.
 *
 * The CLOUD VAULT is a separate concept: it lives in the desktop vault and
 * only exists so two devices can exchange edits over the LAN. Neither the
 * local nor the cloud vault depends on any external server.
 */
import { isAndroidNative, androidBridge as makeAndroidBridge } from './androidBridge'

export type PlatformKind = 'web' | 'desktop' | 'android' | 'ios'

/** Optional native filesystem operations for a device-local vault folder. */
export interface VaultFs {
  listFiles: () => Promise<{ path: string; size?: number; mtime?: number }[]>
  readFile: (path: string) => Promise<string>
  writeFile: (path: string, content: string) => Promise<void>
  removeFile: (path: string) => Promise<void>
  /** Binary attachments in img/; Android's SAF layer must implement these. */
  readBinary?: (path: string) => Promise<ArrayBuffer>
  writeBinary?: (path: string, data: ArrayBuffer) => Promise<void>
  removeBinary?: (path: string) => Promise<void>
}

/** A folder the user has used as a notes vault. */
export interface VaultEntry {
  path: string
  name: string
  /** 0 = inherited from the config, never explicitly opened from the list. */
  lastUsedAt: number
}

export interface NativeFileBridge {
  kind: PlatformKind
  label: string
  /** true = Ctrl+S writes the .md in the folder the user picked. */
  localAuthority: boolean
  /** Absolute path (desktop) or a displayable URI (mobile). */
  getVault: () => Promise<string>
  /** Native folder picker; null when the user cancels. */
  chooseVault: () => Promise<string | null>
  /** Desktop only: folders the user has used, read from userData. */
  listVaults?: () => Promise<VaultEntry[]>
  /** Desktop only: switch to one of those folders. */
  selectVault?: (path: string) => Promise<string | null>
  /** Desktop only: pick/新建 a folder and switch to it; null when cancelled. */
  createVault?: () => Promise<string | null>
  /** Desktop only: accept the vault the shell already resolved, persisting it
   *  as configured so the first-run overlay does not reappear next launch. */
  acceptVault?: () => Promise<unknown>
  /** Subscribe to runtime vault switches fired by the native menu/plugin. */
  onVaultChanged: (cb: (vault: string) => void) => () => void
  /** Open the folder in the OS file manager, when the platform supports it. */
  revealVault?: () => Promise<unknown>
  /** Desktop only: reveal an exported diagnostic report in the file manager. */
  revealPath?: (p: string) => Promise<unknown>
  /** Fresh install with no configured vault yet: Welcome starts on the picker step. */
  isFirstRun?: boolean
  /** Uninstall + keep personal data + reinstall: reopen the start page while
   *  keeping the existing vault, recents, drafts and last opened note. */
  showWelcomeOnLaunch?: boolean
  /** Native vault filesystem; absent on desktop (the local Node service owns it). */
  vaultFs?: VaultFs
  /** Subscribe to native-menu command dispatch (desktop only). */
  onCommand?: (cb: (id: string) => void) => () => void
  /** Subscribe to OS file-open events (.md from double-click), desktop only. */
  onOpenPath?: (cb: (path: string) => void) => () => void
  /** 主进程在用户点关闭时询问渲染层如何处理（桌面端）。 */
  onAskClose?: (cb: () => void) => () => void
  /** 告诉主进程关闭意图：tray=最小化到托盘，quit=退出，cancel=撤销关闭。 */
  resolveClose?: (action: 'tray' | 'quit' | 'cancel') => Promise<unknown>
  /** 真实 process.platform（桌面端）；UI 不再从 userAgent 猜操作系统。 */
  osPlatform?: string
  /** 托盘图标是否真的可见（不是仅构造了 Tray 对象）。 */
  hasTray?: boolean
}

interface DesktopBridge {
  isDesktop: true
  isFirstRun: boolean
  showWelcomeOnLaunch?: boolean
  getVault: () => Promise<string>
  getOrigin: () => Promise<string>
  chooseVault: () => Promise<string | null>
  listVaults: () => Promise<VaultEntry[]>
  selectVault: (p: string) => Promise<string | null>
  createVault: () => Promise<string | null>
  acceptVault: () => Promise<unknown>
  revealVault: () => Promise<unknown>
  revealPath: (p: string) => Promise<unknown>
  onVaultChanged: (cb: (vault: string) => void) => () => void
  onCommand?: (cb: (id: string) => void) => () => void
  onOpenPath?: (cb: (path: string) => void) => () => void
  onAskClose?: (cb: () => void) => () => void
  resolveClose?: (action: 'tray' | 'quit' | 'cancel') => Promise<unknown>
  osPlatform?: string
  hasTray?: boolean
}

/** Injected by the Android Capacitor plugin (stage 2). */
interface AndroidBridge {
  isAndroid: true
  getVault: () => Promise<string>
  chooseVault: () => Promise<string | null>
  onVaultChanged: (cb: (vault: string) => void) => () => void
  vaultFs?: VaultFs
}

declare global {
  interface Window {
    lumenDesktop?: DesktopBridge
    lumenAndroid?: AndroidBridge
  }
}

const webBridge: NativeFileBridge = {
  kind: 'web',
  label: '浏览器',
  localAuthority: false,
  getVault: async () => '',
  chooseVault: async () => null,
  onVaultChanged: () => () => {},
}

function detect(): NativeFileBridge {
  if (typeof window === 'undefined') return webBridge
  const a = window.lumenAndroid
  if (a?.isAndroid) {
    return {
      kind: 'android', label: '手机', localAuthority: true,
      getVault: () => a.getVault(),
      chooseVault: () => a.chooseVault(),
      onVaultChanged: (cb) => a.onVaultChanged(cb),
      vaultFs: a.vaultFs,
    }
  }
  // Capacitor shell: the two local plugins implement the same contract.
  if (isAndroidNative()) return makeAndroidBridge()
  const d = window.lumenDesktop
  if (!d?.isDesktop) return webBridge
  return {
    kind: 'desktop',
    label: '电脑',
    localAuthority: true,
    isFirstRun: d.isFirstRun,
    showWelcomeOnLaunch: d.showWelcomeOnLaunch,
    getVault: () => d.getVault(),
    chooseVault: () => d.chooseVault(),
    listVaults: () => d.listVaults(),
    selectVault: (p) => d.selectVault(p),
    createVault: () => d.createVault(),
    acceptVault: () => d.acceptVault(),
    onVaultChanged: (cb) => d.onVaultChanged(cb),
    revealVault: () => d.revealVault(),
    revealPath: (p) => d.revealPath?.(p) ?? Promise.resolve(),
    onCommand: d.onCommand,
    onOpenPath: d.onOpenPath,
    onAskClose: d.onAskClose,
    resolveClose: (a) => d.resolveClose?.(a) ?? Promise.resolve(),
    osPlatform: d.osPlatform,
    hasTray: d.hasTray,
  }
}

export const bridge = detect()
export const isDesktopApp = () => bridge.kind === 'desktop'
export const isNativeApp = () => bridge.localAuthority
export const isWebBrowser = () => bridge.kind === 'web'
export const chooseVault = () => bridge.chooseVault()
/** Desktop only: the vault list shown by 「已有仓库，直接开始」. */
export const listVaults = async (): Promise<VaultEntry[]> => {
  try { return (await bridge.listVaults?.()) || [] } catch { return [] }
}
export const selectVault = (p: string) => bridge.selectVault?.(p) ?? Promise.resolve(null)
export const createVault = () => bridge.createVault?.() ?? Promise.resolve(null)
/** Desktop only: confirm the vault the shell already resolved (Welcome skipped). */
export const acceptVault = () => bridge.acceptVault?.()
/** 主进程在用户点关闭时询问渲染层；返回取消监听的函数。 */
export const onAskClose = (cb: () => void) => bridge.onAskClose?.(cb) ?? (() => {})
/** 告诉主进程关闭意图。 */
export const resolveClose = (action: 'tray' | 'quit' | 'cancel') => bridge.resolveClose?.(action) ?? Promise.resolve()
/** 真实操作系统标识；非桌面端返回空串。 */
export const osPlatform = () => bridge.osPlatform || ''
/** 托盘图标是否真的可见；非桌面端一律 false。 */
export const hasSystemTray = () => (isDesktopApp() && bridge.hasTray) || false
/** Fresh install: the Welcome overlay should open on its vault-picker step. */
export const isFirstRun = () => bridge.isFirstRun ?? false
/** Keep-data reinstall: show the start page without resetting any user data. */
export const showWelcomeOnLaunch = () => bridge.showWelcomeOnLaunch ?? false
/** Stationary device label used for pairing and cloud chain names. */
export const deviceLabel = () => bridge.label
/** Desktop only: highlight a file in the OS file manager. */
export const revealPath = (p: string) =>
  typeof window === 'undefined' ? Promise.resolve() : (window.lumenDesktop?.revealPath?.(p) ?? Promise.resolve())
