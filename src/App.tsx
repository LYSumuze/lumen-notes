import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, MouseEvent as ReactMouseEvent, ChangeEvent as ReactChangeEvent } from 'react'
import { Editor } from './components/Editor'
import { Preview } from './components/Preview'
import { Icon } from './components/Icons'
import { Sidebar, FileTree, Outline, SearchPanel } from './components/Sidebar'
import { CommandPalette } from './components/CommandPalette'
import type { PaletteItem } from './components/CommandPalette'
import { SyncPanel } from './components/SyncPanel'
import type { SettingsTab, SettingsValues } from './components/SyncPanel'
import { HistoryPanel } from './components/HistoryPanel'
import { Welcome } from './components/Welcome'
import { CloseDialog } from './components/CloseDialog'
import { InputDialog, ConfirmDialog, SaveChoiceDialog, DraftChoiceDialog, DiskChangeDialog, Toast } from './components/Dialogs'
import type { InputRequest, ConfirmRequest, SaveChoiceRequest, SaveChoice, DraftChoiceRequest, DraftChoice, DiskChangeRequest, DiskChoice } from './components/Dialogs'
import { MenuBar } from './components/MenuBar'
import { DesktopToolbar } from './components/DesktopToolbar'
import { buildCommands, matchShortcut, formatShortcut, runWithoutRefocus } from './lib/commands'
import type { CommandContext } from './lib/commands'
import { renderMarkdown } from './lib/markdown'
import { ScrollSync } from './lib/scrollSync'
import { db } from './lib/db'
import type { LocalDoc } from './lib/db'
import { api, connectSync, clientId, getBase, setBase, setSession, normalizeBase } from './lib/sync'
import type { SyncConnection, PresenceInfo } from './lib/sync'
import { bootstrapMirror, mergeTrees, pathsToTree, flattenTree, inScope, fetchUpdates, publishCloud } from './lib/syncEngine'
import { drafts } from './lib/draft'
import { fnv1a } from './lib/hash'
import { fsAccess, downloadFile } from './lib/fsAccess'
import { isDesktopApp, isNativeApp, chooseVault, acceptVault, bridge, isWebBrowser, deviceLabel, isFirstRun, showWelcomeOnLaunch, listVaults, selectVault, createVault, onAskClose, resolveClose, osPlatform, hasSystemTray } from './native/platform'
import { isAndroidNative, androidVaultConfigured, parsePairLink, LumenScan, readAndroidClipboard, setAndroidStatusBarStyle } from './native/androidBridge'
import { MobileShell } from './mobile/MobileShell'
import type { MobileSheet, MobileTab } from './mobile/MobileShell'
import { VIEWPORT_RESIZE_EVENT } from './mobile/useViewportHeight'
import { DEFAULT_TOOLBAR, normalizeToolbar } from './lib/toolbar'
import { undo as cmUndo, redo as cmRedo } from '@codemirror/commands'
import { commitVcs, flushPending, syncToCloud, loadConflicts } from './lib/vcsStore'
import {
  hasMobileVault, writeDoc as writeMobileDoc, deleteDoc as deleteMobileDoc,
} from './lib/mobileVault'
import { SOURCE_LOCAL, VERSION_LIMIT } from './lib/vcs'
import { localVault } from './lib/localVault'
import * as ed from './lib/editing'
import type { AssetConflict, AssetInfo, CommandDef, Device, DocMeta, EditorHandle, SearchHit, SidebarTab, SyncInfo, ThemeName, TreeNode, VaultSort, ViewMode } from './types'

const LS_SETTINGS = 'lumen.settings'
const LS_PATH = 'lumen.lastPath'
const LS_MODE = 'lumen.mode'
const LS_RECENTS = 'lumen.recents'
const LS_WELCOMED = 'lumen.welcomed'
const RECENTS_MAX = 30

/** Recently opened files, most-recent first. Surives reloads in localStorage. */
function loadRecents(): string[] {
  try { return (JSON.parse(localStorage.getItem(LS_RECENTS) || '[]') as string[]).filter(Boolean) }
  catch { return [] }
}
function saveRecents(list: string[]) {
  try { localStorage.setItem(LS_RECENTS, JSON.stringify(list.slice(0, RECENTS_MAX))) } catch { /* ignore */ }
}

const defaultSettings: SettingsValues = {
  theme: 'light', themeMode: 'manual', fontSize: 15, showLineNumbers: true, syncScroll: true,
  scope: 'vault', syncTarget: getBase(),
  toolbarCommands: [...DEFAULT_TOOLBAR],
  treeSort: 'name-asc', vaultSort: 'name-asc',
  closeAction: 'ask',
}

/** Old configs may still carry the removed autoSave flag: drop it explicitly. */
function loadSettings(): SettingsValues {
  try {
    const saved = { ...(JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}') as Record<string, unknown>) }
    delete saved.autoSave
    const next = { ...defaultSettings, ...saved } as SettingsValues
    next.themeMode = next.themeMode === 'system' ? 'system' : 'manual'
    next.theme = next.theme === 'dark' ? 'dark' : 'light'
    next.toolbarCommands = normalizeToolbar(next.toolbarCommands)
    return next
  } catch { return { ...defaultSettings, toolbarCommands: [...DEFAULT_TOOLBAR] } }
}

/** Desktop / native apps write the user's own folder on save, not just IndexedDB. */
const DESKTOP = isDesktopApp()
/** Only the Android Capacitor shell uses the phone UI. Desktop / browser keep
 *  their original render tree, so nothing here can regress the Windows build. */
const MOBILE = isAndroidNative()
/** 每台设备一个稳定且唯一的 id；旧的 'desktop' / 'mobile' 会让两台手机撞车。 */
const DEVICE_ID = clientId

function scopeValue(path: string, scope: SettingsValues['scope']) {
  if (scope === 'file') return path
  if (scope === 'folder') return path.includes('/') ? path.split('/').slice(0, -1).join('/') : ''
  return ''
}

/** Pairing name comes from the platform bridge, not the browser UA. */
function deviceName() { return deviceLabel() }

/**
 * 桌面端：仓库里的 .md 才是权威副本，IndexedDB 只是本设备工作副本。
 * 「同步」前按磁盘清单重建待发布内容；hash 不一致的说明外部改过或收敛刚
 * 拷贝过，就重新读盘并顺手刷新 IDB，避免把旧内容发布成云端最新版。
 */
async function diskDocs(): Promise<{ path: string; content: string }[]> {
  const local = new Map((await db.listDocs()).map((d) => [d.path, d]))
  const { files } = await api.manifest('')
  const out: { path: string; content: string }[] = []
  for (const f of files) {
    const cached = local.get(f.path)
    if (cached && fnv1a(cached.content) === f.hash) {
      out.push({ path: f.path, content: cached.content })
      continue
    }
    const doc = await api.file(f.path).catch(() => null)
    if (!doc) continue
    await db.mirror(doc).catch(() => {})
    out.push({ path: f.path, content: doc.content })
  }
  return out
}

/** Directory under img/ that belongs to a note. Mirrors insertImageFile(). */
const noteAssetDir = (p: string) => {
  const raw = (p || '').split('/').pop()?.replace(/\.(md|markdown|txt)$/i, '') || ''
  return raw.replace(/[\\/:*?"<>|#()\[\]\s]+/g, '_')
    .replace(/_+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || '未命名'
}

/** Decode a URI-encoded path, keeping the original when it is malformed. */
const safeDecodePath = (p: string) => {
  try { return decodeURIComponent(p) } catch { return p }
}

/**
 * Image links in SAVED note content that point at its own img/<note>/ folder.
 * Returns the link text verbatim (a disk path or its URI-encoded form); the
 * asset inventory decides which form is the real file, so a name containing a
 * literal `%20` is never decoded away. Handles inline images with balanced
 * parentheses, reference-style images and raw HTML <img> tags.
 */
const noteImageRefs = (text: string, dir: string): string[] => {
  const src = String(text || '')
  const prefix = `img/${dir}/`
  const out: string[] = []
  const masked = new Uint8Array(src.length)

  // Example links inside fenced code blocks / HTML comments are not pictures.
  // Listing them produced dead tree nodes that always failed to load. The
  // server's orphan reaping still uses the raw whole-vault text (conservative),
  // so this only affects what the tree shows — it never causes a deletion.
  let pos = 0
  let fence = ''
  for (const line of src.split('\n')) {
    const start = pos
    const end = start + line.length
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      masked.fill(1, start, end)
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length
        && !line.slice(m[0].length).trim()) fence = ''
    } else if (m) {
      fence = m[1]
      masked.fill(1, start, end)
    }
    pos = end + 1
  }
  for (const m of src.matchAll(/<!--[\s\S]*?-->/g)) {
    masked.fill(1, m.index || 0, (m.index || 0) + m[0].length)
  }
  const visible = (at: number) => !masked[Math.max(0, Math.min(at, src.length - 1))]

  const add = (raw: string) => {
    const trimmed = String(raw || '').trim()
    // A `<...>` destination may contain spaces; a plain one ends at the title.
    let p = trimmed.replace(/^<|>$/g, '')
    if (!trimmed.startsWith('<')) p = p.split(/\s+/)[0]
    p = p.replace(/^['"]|['"]$/g, '').replace(/^\/+/, '')
    if (p.startsWith(prefix) && !out.includes(p)) out.push(p)
  }

  // Reference definitions: `[id]: img/<note>/foo.png "optional title"`
  const defs = new Map<string, string>()
  const defRe = /^[ \t]{0,3}\[([^\]]+)\]:[ \t]*(\S+)/gm
  let dm: RegExpExecArray | null
  while ((dm = defRe.exec(src))) {
    if (visible(dm.index)) defs.set(dm[1].trim().toLowerCase(), dm[2])
  }

  // Inline `![](...)` with balanced parentheses (file names like a(1).png),
  // and reference-style `![alt][id]` / `![alt][]` / `![alt]`.
  for (let i = 0; i < src.length; i++) {
    if (!visible(i)) continue
    if (src[i] !== '!' || src[i + 1] !== '[' || (i > 0 && src[i - 1] === '\\')) continue
    const close = src.indexOf(']', i + 2)
    if (close < 0) continue
    const after = src[close + 1]
    if (after === '(') {
      let depth = 1
      let j = close + 2
      for (; j < src.length && depth > 0; j++) {
        if (src[j] === '\\') { j++; continue }
        if (src[j] === '(') depth++
        else if (src[j] === ')') depth--
      }
      if (depth === 0) add(src.slice(close + 2, j - 1))
      i = Math.max(i, j - 1)
    } else if (after === '[') {
      const end = src.indexOf(']', close + 2)
      if (end > 0) {
        const id = (src.slice(close + 2, end).trim() || src.slice(i + 2, close).trim()).toLowerCase()
        const def = defs.get(id)
        if (def) add(def)
        i = end
      }
    } else {
      const id = src.slice(i + 2, close).trim().toLowerCase()
      const def = defs.get(id)
      if (def) add(def)
    }
  }

  // Raw HTML images, with quoted or unquoted src.
  const imgRe = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi
  let hm: RegExpExecArray | null
  while ((hm = imgRe.exec(src))) {
    if (visible(hm.index)) add(hm[1] || hm[2] || hm[3] || '')
  }
  return out
}

interface ToastState { id: number; text: string; action?: { label: string; run: () => void }; sticky?: boolean }

export default function App() {
  /* ------------------------------------------------------------- state */
  const [settings, setSettings] = useState<SettingsValues>(loadSettings)
  /** OS dark-mode preference; consulted only while themeMode === 'system'. */
  const [sysDark, setSysDark] = useState(() =>
    typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches
  )
  const effectiveTheme: ThemeName = settings.themeMode === 'system'
    ? (sysDark ? 'dark' : 'light')
    : settings.theme
  const [mode, setMode] = useState<ViewMode>(() => (localStorage.getItem(LS_MODE) as ViewMode) || 'split')
  // On phones the file drawer starts closed so the editor is visible first.
  const [sidebarOpen, setSidebarOpen] = useState(() =>
    typeof window === 'undefined' ? true : window.innerWidth > 860
  )
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('files')
  const [rightOpen, setRightOpen] = useState(true)
  const [splitRatio, setSplitRatio] = useState(50)

  /* Phone shell navigation. Desktop ignores all four values. */
  const [mTab, setMTab] = useState<MobileTab>('notes')
  const [mEditorOpen, setMEditorOpen] = useState(false)
  const [mPane, setMPane] = useState<'edit' | 'read'>('edit')
  const [mSheet, setMSheet] = useState<MobileSheet>(null)

  const [tree, setTree] = useState<TreeNode[]>([])
  const [currentPath, setCurrentPath] = useState('')
  const [content, setContent] = useState('')
  /** Image shown in the preview pane instead of the note (double-click in tree). */
  const [previewAsset, setPreviewAsset] = useState<string | null>(null)
  /** Image refs from the last SAVED copy; drafts must not change the img/ tree. */
  const [savedAssetRefs, setSavedAssetRefs] = useState<string[]>([])
  const [version, setVersion] = useState(1)
  const [dirty, setDirty] = useState(false)
  /** Exact text of the last saved copy; undoing back to it clears "dirty". */
  const savedTextRef = useRef('')
  /** CodeMirror history depth, so undo/redo buttons disable on empty stacks. */
  const [historyDepth, setHistoryDepth] = useState({ undo: 0, redo: 0 })
  const onHistoryChange = useCallback((undo: number, redo: number) => {
    setHistoryDepth((prev) => prev.undo === undo && prev.redo === redo ? prev : { undo, redo })
  }, [])
  const [saveChoiceReq, setSaveChoiceReq] = useState<SaveChoiceRequest | null>(null)
  /** One cold-start dialog for a parked unsaved draft. */
  const [draftChoiceReq, setDraftChoiceReq] = useState<DraftChoiceRequest | null>(null)
  /** External rewrite detected at save time: the user picks disk vs editor. */
  const [diskChangeReq, setDiskChangeReq] = useState<DiskChangeRequest | null>(null)
  const [closeAsk, setCloseAsk] = useState(false)
  const closeActionRef = useRef(settings.closeAction)
  closeActionRef.current = settings.closeAction
  // 点窗口 X：主进程先问我们。先处理未保存的内容；选「取消」时什么都不做，
  // 主进程已 preventDefault()，窗口会保持打开。
  useEffect(() => onAskClose(() => {
  void (async () => {
  // 未保存内容用户选「取消」：必须回报主进程，否则它一直等答复。
  if (!(await latest.current.guardUnsaved())) { void resolveClose('cancel'); return }
  const a = closeActionRef.current
  // 无托盘时「最小化到托盘」降级为退出，绝不把窗口藏起来。
  if (a === 'tray') void resolveClose(hasSystemTray() ? 'tray' : 'quit')
  else if (a === 'quit') void resolveClose('quit')
  else setCloseAsk(true)
  })()
  }), [])
  const [activeLine, setActiveLine] = useState(0)
  const [cursor, setCursor] = useState({ line: 1, col: 1 })

  const [online, setOnline] = useState(false)
  const [wsConnected, setWsConnected] = useState(false)
  const [info, setInfo] = useState<SyncInfo | null>(null)
  const [devices, setDevices] = useState<Device[]>([])
  /** Live LAN peers, broadcast by the server on socket connect/disconnect. */
  const [presence, setPresence] = useState<PresenceInfo>({ peers: [], count: 0 })
  const [vaultName, setVaultName] = useState('仓库')

  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [searching, setSearching] = useState(false)

  const [palette, setPalette] = useState<{ open: boolean; mode: 'commands' | 'files' }>({ open: false, mode: 'commands' })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('sync')
  const [inputReq, setInputReq] = useState<InputRequest | null>(null)
  const [confirmReq, setConfirmReq] = useState<ConfirmRequest | null>(null)
  const [toast, setToast] = useState<ToastState | null>(null)

  const [historyOpen, setHistoryOpen] = useState(false)
  const [localStats, setLocalStats] = useState({ docs: 0, pending: 0, conflicts: 0, history: 0 })
  /**
   * Verifiable counters, never inferred from the health probe:
   *   queued  - offline version records still in the IndexedDB queue
   *   updates - 整仓收敛后等待用户在分屏里选版本的篇数
   */
  const [syncStatus, setSyncStatus] = useState({ queued: 0, updates: 0 })

  // Desktop: firstRun means "no valid vault config yet" (a genuine fresh
  // install). A keep-data uninstall + reinstall is a DIFFERENT case: the
  // config is still valid, so only the start page is requested — welcomed /
  // recents / lastPath / drafts must survive untouched. Only a real first run
  // drops those stale values; resyncVault() then rebuilds IndexedDB once the
  // user confirms a vault.
  const [showWelcome, setShowWelcome] = useState(() => {
    if (!DESKTOP) return !localStorage.getItem(LS_WELCOMED)
    if (isFirstRun()) {
      try {
        localStorage.removeItem(LS_WELCOMED)
        localStorage.removeItem(LS_PATH)
        localStorage.removeItem(LS_RECENTS)
      } catch { /* ignore */ }
      return true
    }
    return showWelcomeOnLaunch()
  })
  // Desktop used to pick the vault with a native dialog BEFORE the window
  // existed, so the Welcome overlay could never appear. The shell now starts
  // with a usable default vault and lets this overlay own the first-run pick.
  // Both a fresh install and a keep-data reinstall start on the vault step,
  // where 「已有仓库，直接开始」 is immediately reachable.
  const [welcomeStage, setWelcomeStage] = useState<'vault' | 'home'>(
    DESKTOP ? (isFirstRun() || showWelcomeOnLaunch() ? 'vault' : 'home') : 'vault',
  )
  const [recents, setRecents] = useState<string[]>(loadRecents)
  const acceptedVaultRef = useRef(false)
  const closeWelcome = useCallback(() => {
    setShowWelcome(false)
    try { localStorage.setItem(LS_WELCOMED, '1') } catch {}
    // Dismissing the picker without choosing a folder still means "use the
    // current vault". Persist it ONLY on a genuine fresh install; on a
    // keep-data reinstall the config is already valid and acceptVault() would
    // broadcast a spurious vault-changed / resync (isFirstRun is fixed for
    // this window's lifetime).
    if (DESKTOP && isFirstRun() && !acceptedVaultRef.current) {
      acceptedVaultRef.current = true
      void acceptVault()
    }
  }, [])

  /* -------------------------------------------------------------- refs */
  /** Frozen at mount: ONLY a genuine fresh install defers boot() until a vault
   *  has been chosen. A keep-data reinstall already has a valid vault, so the
   *  notes load normally behind the start page and are there when it closes. */
  const welcomeGateRef = useRef(DESKTOP && isFirstRun())
  const editorRef = useRef<EditorHandle | null>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const workspaceRef = useRef<HTMLDivElement>(null)
  const connRef = useRef<SyncConnection | null>(null)
  const syncRef = useRef<ScrollSync | null>(null)
  const dirtyRef = useRef(false)
  const onlineRef = useRef(false)
  const treeRef = useRef<TreeNode[]>([])
  const baseHashRef = useRef('')
  const remoteRef = useRef<DocMeta | null>(null)
  const lastEditMode = useRef<ViewMode>('split')
  const inputResolver = useRef<(v: string | null) => void>(() => {})
  const confirmResolver = useRef<(v: boolean) => void>(() => {})
  const saveChoiceResolver = useRef<(v: SaveChoice) => void>(() => {})
  const draftChoiceResolver = useRef<(v: DraftChoice) => void>(() => {})
  const diskChangeResolver = useRef<(v: DiskChoice) => void>(() => {})
  /**
   * A draft just restored by the cold-start dialog IS the unsaved buffer the
   * user chose to keep. The first note open afterwards must not re-ask the
   * leave-guard about the very same text. Only matches while content is
   * unchanged, so a fresh edit still gets the normal protection.
   */
  const skipGuardRef = useRef<{ path: string; content: string } | null>(null)
  const commandsRef = useRef<CommandDef[]>([])
  const latest = useRef<any>({})
  const syncingRef = useRef(false)
  /** One save at a time: a second save while a modal is pending used to
   *  overwrite diskChangeResolver.current and leave the first Promise hanging. */
  const savingRef = useRef(false)
  /** Settles when the in-flight save has finished. A save requested while
   *  another one is pending must WAIT and then re-run against the latest
   *  buffer: a queued save would otherwise be swallowed and
   *  never fire again, leaving the newest edit on disk-never-written. */
  const saveDoneRef = useRef<Promise<void>>(Promise.resolve())
  const lastRemoteNoticeRef = useRef(0)
  const watcherWarnedRef = useRef(false)
  const paletteOpenRef = useRef(false)
  const settingsOpenRef = useRef(false)
  const historyOpenRef = useRef(false)
  historyOpenRef.current = historyOpen
  paletteOpenRef.current = palette.open
  settingsOpenRef.current = settingsOpen

  /** Phone: opening a note from the tree / search / palette enters the
   *  full-screen editor. boot()'s restoreLastDoc uses loadFile() directly, so
   *  a cold start still lands on the notes tab, not inside a note. */
  const mobileOpenDoc = useCallback(async (path: string) => {
    await latest.current.loadFile(path)
    if (MOBILE) { setMPane('edit'); setMEditorOpen(true) }
  }, [])

  if (!syncRef.current) {
    syncRef.current = new ScrollSync(() => editorRef.current, () => previewRef.current)
  }

  const showToast = useCallback((text: string, action?: ToastState['action'], sticky = false) => {
    setToast({ id: Date.now() + Math.random(), text, action, sticky })
  }, [])
  const dismissToast = useCallback(() => setToast(null), [])
  /**
   * A navigation / vault switch invalidates any modal still waiting on a
   * Promise. Resolve them as cancel so those flows unblock instead of leaving
   * two stacked backdrops (or a stale dialog on the newly selected vault).
   * Calling a resolver twice is harmless: an already settled Promise ignores it.
   */
  const clearPendingDialogs = useCallback(() => {
    setDiskChangeReq(null)
    setSaveChoiceReq(null)
    setDraftChoiceReq(null)
    setInputReq(null)
    setConfirmReq(null)
    diskChangeResolver.current('cancel')
    saveChoiceResolver.current('cancel')
    draftChoiceResolver.current('cancel')
    inputResolver.current(null)
    confirmResolver.current(false)
  }, [])

  const refreshLocalStats = useCallback(async () => {
    try { setLocalStats(await db.stats()) } catch { /* storage unavailable */ }
  }, [])

  /**
   * Two verifiable counters: `queued` = offline version records still in the
   * IndexedDB queue, `updates` = whole-vault conflicts waiting for the user to
   * pick a version in the split view. Neither is inferred from a health probe.
   */
  const refreshSyncStatus = useCallback(async () => {
    let updates = 0
    try { updates = (await loadConflicts()).length } catch { /* ignore */ }
    let queued = 0
    try { queued = (await db.vcsQueueList()).length } catch { /* ignore */ }
    setSyncStatus({ queued, updates })
  }, [])

  /** 收敛后把 IDB 工作副本对齐磁盘：拷贝来的读回内容，删掉的移除记录。 */
  const alignLocalReplica = useCallback(async (paths: string[]) => {
    if (hasMobileVault() || !DESKTOP || !onlineRef.current) return
    for (const p of new Set(paths)) {
      const doc = await api.file(p).catch(() => null)
      if (doc) await db.mirror(doc).catch(() => {})
      else await db.deleteDoc(p).catch(() => {})
    }
  }, [])

  // Switching notes or reconnecting changes what "real" means; recompute then.
  // Actions that mutate versions (save / sync / fetch / WS) refresh it
  // explicitly, so typing never triggers a request.
  useEffect(() => { void refreshSyncStatus() }, [currentPath, online, refreshSyncStatus])

  // Renderer-side failures go to the service log so an exported diagnostic
  // report contains both halves of the story. Never surfaces an error to the UI.
  useEffect(() => {
    if (isWebBrowser()) return
    const onError = (e: ErrorEvent) => {
      void api.log('error', 'renderer', e.message || '渲染层异常',
        e.error?.stack || `${e.filename}:${e.lineno}`).catch(() => {})
    }
    const onRejection = (e: PromiseRejectionEvent) => {
      const reason: any = e.reason
      void api.log('error', 'renderer', '未处理的异步异常：' + (reason?.message || String(reason)),
        reason?.stack).catch(() => {})
    }
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [])

  const updateSettings = useCallback((patch: Partial<SettingsValues>) => {
    setSettings((prev) => {
      const merged = { ...patch }
      // Choosing an explicit theme leaves "follow system" mode.
      if (merged.theme && merged.themeMode === undefined) merged.themeMode = 'manual'
      const next = { ...prev, ...merged }
      localStorage.setItem(LS_SETTINGS, JSON.stringify(next))
      return next
    })
  }, [])

  /* ----------------------------------------------------------- prompts */
  const prompt = useCallback((req: InputRequest) => new Promise<string | null>((resolve) => {
    inputResolver.current = resolve
    setInputReq(req)
  }), [])
  const confirm = useCallback((message: string, danger = true) => new Promise<boolean>((resolve) => {
    confirmResolver.current = resolve
    setConfirmReq({ message, danger })
  }), [])
  const askSaveChoice = useCallback((message: string) => new Promise<SaveChoice>((resolve) => {
    saveChoiceResolver.current = resolve
    setSaveChoiceReq({ message })
  }), [])
  const askDraftChoice = useCallback((message: string, savedAt: string) => new Promise<DraftChoice>((resolve) => {
    draftChoiceResolver.current = resolve
    setDraftChoiceReq({ message, savedAt })
  }), [])
  /** The .md changed on disk while the editor held an unsaved buffer. */
  const askDiskChange = useCallback((path: string) => new Promise<DiskChoice>((resolve) => {
    diskChangeResolver.current = resolve
    setDiskChangeReq({ path })
  }), [])

  /* -------------------------------------------------------------- docs */
  const applyTree = useCallback((t: TreeNode[]) => {
    treeRef.current = t
    setTree(t)
  }, [])

  const applyDoc = useCallback((doc: DocMeta | LocalDoc) => {
    dirtyRef.current = false
    setDirty(false)
    remoteRef.current = null
    // baseHash is the content both replicas last agreed on. It must NOT be
    // replaced with the edited text, or the three-way conflict check breaks.
    baseHashRef.current = ('baseHash' in doc && doc.baseHash) ? doc.baseHash : fnv1a(doc.content)
    savedTextRef.current = doc.content
    setContent(doc.content)
    setVersion(doc.version || 1)
    setCurrentPath(doc.path)
    setActiveLine(0)
    // 打开的是已保存副本（在线时先读磁盘），所以用它重建「已保存」的图片引用集。
    setPreviewAsset(null)
    setSavedAssetRefs(noteImageRefs(doc.content, noteAssetDir(doc.path)))
    localStorage.setItem(LS_PATH, doc.path)
  }, [])

  // 附件清单用于给文件树列出图片文件名；显隐只认「已保存内容」里的图片引用。
  // 未保存的草稿不会让 img/ 提前出现，也不会把刚插入但还没保存的图当成已有图片。
  // 声明必须早于 saveNow()：保存成功后要立刻刷新它。
  const [assets, setAssets] = useState<AssetInfo[]>([])
  const refreshAssets = useCallback(async () => {
    try {
      const r = await api.assets()
      setAssets(r.assets || [])
    } catch { /* 附件清单非关键，忽略 */ }
  }, [])
  const imgDir = currentPath ? noteAssetDir(currentPath) : ''
  // 只列已保存笔记引用的图片；磁盘清单补上大小/时间，找不到时用虚拟节点
  // （图片可能已被回收，/raw 会回退到 .lumen-history/assets/ 的备份）。
  const imgAssets = useMemo<AssetInfo[]>(() => {
    if (!savedAssetRefs.length) return []
    const out: AssetInfo[] = []
    for (const raw of savedAssetRefs) {
      // Markdown may store the URI-encoded form; the inventory holds the real
      // disk name. Prefer the exact inventory path so the tree node and /raw
      // always address one and the same file.
      const hit = assets.find((a) => a.path === raw)
        || assets.find((a) => a.path === safeDecodePath(raw))
      const p = hit?.path || raw
      if (out.some((x) => x.path === p)) continue
      out.push(hit || { path: p, hash: '', size: 0, mtime: 0 })
    }
    return out
  }, [savedAssetRefs, assets])
  const showImgFolder = !!imgDir && imgAssets.length > 0

  /** Replace the editor buffer with the externally rewritten disk copy. */
  const adoptDiskContent = useCallback(async (
    docPath: string, content: string, version: number, mtime: number,
  ) => {
    const h = fnv1a(content)
    // applyDoc() clears dirty, remote state, the image preview and rebuilds
    // the saved image-reference set from the new content.
    latest.current.applyDoc({ path: docPath, content, version, mtime })
    baseHashRef.current = h
    remoteRef.current = null
    await db.putDoc({
      path: docPath, content, version, mtime,
      baseHash: h, synced: true, remote: null,
    })
    drafts.clear(docPath)
    void refreshAssets()
    void refreshLocalStats()
    void refreshSyncStatus()
    showToast('已使用磁盘上的新内容，本次修改已放弃')
  }, [refreshAssets, refreshLocalStats, refreshSyncStatus, showToast])

  /** Local-first save: IndexedDB is always written; the server is a best-effort push. */
  const saveNow = useCallback(async (manual = false, overrideText?: string) => {
    if (savingRef.current) {
      const queuedPath = latest.current.currentPath
      await saveDoneRef.current.catch(() => {})
      // Only re-run for the SAME note. Switching notes parks the buffer as a
      // draft; writing it after the switch would land in the wrong document.
      if (latest.current.currentPath !== queuedPath || !dirtyRef.current || !latest.current.currentPath) return
      await latest.current.saveNow(manual, overrideText)
      return
    }
    const s = latest.current
    if (!dirtyRef.current || !s.currentPath) return
    savingRef.current = true
    let release = () => {}
    saveDoneRef.current = new Promise<void>((resolve) => { release = resolve })
    const retry = {
      label: '重试',
      run: () => { dismissToast(); void latest.current.saveNow(true) },
    }
    try {
      // A draft restored by the cold-start dialog may not have reached React
      // state yet; the caller passes its exact text so we never save stale
      // content from the previous render.
      const path = s.currentPath
      const text = overrideText ?? s.content
      /**
       * The vault .md is the only authoritative copy. An external editor (or a
       * peer's write) may have changed it since this note was opened. The WS
       * notice mirrors the new bytes into IndexedDB, which also refreshes
       * baseHash — so the server's 409 check would NOT fire and a plain save
       * would silently overwrite the new content. Compare with our own baseline
       * (baseHashRef, never touched by db.mirror) before writing anything.
       */
      let forceWrite = false
      if (DESKTOP && onlineRef.current) {
        let disk: DocMeta
        try { disk = await api.file(path) }
        catch {
          // Cannot verify what is on disk. Do NOT write: the server's 409
          // guard is unreliable because db.mirror() may already have refreshed
          // IDB's baseHash to the disk content. Keep the buffer dirty so the
          // retry hint and the parked draft can still recover it.
          try { drafts.put(path, text) } catch { /* ignore */ }
          showToast('无法确认磁盘上的笔记内容，保存已取消；修改仍是未保存草稿', retry, true)
          return
        }
        if (fnv1a(disk.content) !== baseHashRef.current && disk.content !== text) {
          const choice = await askDiskChange(path)
          if (choice === 'cancel') return
          if (choice === 'disk') {
            await adoptDiskContent(path, disk.content, disk.version, disk.mtime)
            return
          }
          forceWrite = true
        }
      }
      try {
        const prev = await db.getDoc(path)
        const baseHash = prev?.baseHash ?? baseHashRef.current
        const nextVersion = (prev?.version || s.version || 0) + 1
        const local: LocalDoc = {
          path, content: text, version: nextVersion, mtime: Date.now(),
          baseHash, synced: false, remote: null,
        }
        const saveReason = manual ? '手动保存' : '保存'
        await db.saveLocal(local, saveReason, 'local', VERSION_LIMIT)
        // 手机 App 的权威副本在自己 SAF 目录里，保存不能只写 IndexedDB。
        if (hasMobileVault()) await writeMobileDoc(path, text).catch(() => {})
        // dirty / drafts / savedAssetRefs are cleared ONLY after the
        // authoritative .md has been written. Clearing them here used to
        // discard the buffer silently when api.save failed, because the next
        // loadFile mirrors the stale disk copy over IndexedDB.
        // Every save appends one version to this device's LOCAL timeline,
        // offline or online. Best effort — it must never block the actual save.
        void commitVcs({
          path, source: SOURCE_LOCAL, content: text,
          reason: saveReason,
          message: saveReason,
        }, onlineRef.current).catch(() => {})
        // Best-effort mirror into the folder the user picked on this device.
        void fsAccess.mirrorDoc(path, text)
        await refreshLocalStats()
        void refreshSyncStatus()

        /**
         * db.saveLocal() already put the unsaved text into IndexedDB. If the
         * .md write fails (or a conflict is cancelled), roll the working copy
         * back to the authoritative disk bytes while keeping the ORIGINAL
         * baseHash and the parked draft. Otherwise a restart — which boots
         * before `online` is established and therefore reads IDB, not the
         * disk — would present an unsaved buffer as "saved".
         */
        const rollbackToDisk = async (remote: LocalDoc['remote'] = null) => {
          if (!DESKTOP || !onlineRef.current) return
          const disk = await api.file(path).catch(() => null)
          if (!disk) return
          const before = await db.getDoc(path).catch(() => null)
          await db.putDoc({
            path, content: disk.content, version: disk.version, mtime: disk.mtime,
            baseHash: before?.baseHash ?? baseHashRef.current,
            synced: true, remote,
          }).catch(() => {})
        }

        /** Mark the buffer saved against the authoritative copy. */
        const markSaved = (version: number) => {
          savedTextRef.current = text
          setSavedAssetRefs(noteImageRefs(text, noteAssetDir(path)))
          if (latest.current.currentPath === path && latest.current.content === text) {
            drafts.clear(path)
            setVersion(version)
            dirtyRef.current = false
            setDirty(false)
          }
        }
        // 保存 = 把 .md 写回桌面仓库（权威副本）。它永远不是跨端同步，更不能
        // 广播去覆盖对端；手机 App 只写自己 SAF 目录，绝不碰电脑磁盘。
        if (!DESKTOP || !onlineRef.current) { markSaved(nextVersion); return }

        try {
          const res = await api.save(path, text, nextVersion, baseHash, forceWrite)
          // 保存时服务端会回收本篇不再引用的图片，并删掉空的 img/<笔记名>/。
          // 立刻刷新清单，文件树里的 img 才能在「没图了」时随即隐藏。
          void refreshAssets()
          const syncedHash = fnv1a(text)
          baseHashRef.current = syncedHash
          await db.putDoc({ ...local, version: res.version, mtime: res.mtime, baseHash: syncedHash, synced: true })
          markSaved(res.version)
        } catch (e: any) {
          if (e.status === 409 && e.data?.server) {
            // Same decision as the pre-save check, for the race where the disk
            // changed between our read and the PUT.
            const srv = e.data.server
            remoteRef.current = srv
            await db.putDoc({
              ...local,
              remote: { content: srv.content, version: srv.version, mtime: srv.mtime },
            })
            const choice = await askDiskChange(path)
            if (choice === 'disk') {
              await adoptDiskContent(path, srv.content, srv.version, srv.mtime)
            } else if (choice === 'mine') {
              try {
                const forced = await api.save(path, text, nextVersion, baseHash, true)
                const syncedHash = fnv1a(text)
                baseHashRef.current = syncedHash
                remoteRef.current = null
                await db.putDoc({
                  ...local, version: forced.version, mtime: forced.mtime,
                  baseHash: syncedHash, synced: true, remote: null,
                })
                markSaved(forced.version)
                void refreshAssets()
                showToast('已用编辑器里的修改覆盖磁盘内容')
              } catch (err: any) {
                try { drafts.put(path, text) } catch { /* ignore */ }
                await rollbackToDisk()
                showToast('覆盖失败，修改仍保留为未保存草稿：' + (err?.message || '未知错误'), retry, true)
              }
            } else {
              // Nothing was written to disk: the buffer was never marked
              // saved, so it stays dirty. savedAssetRefs was not updated
              // either, so the img tree still reflects the SAVED content.
              // Keep the remote marker so 拉取 can still open the split view.
              await rollbackToDisk({ content: srv.content, version: srv.version, mtime: srv.mtime })
              showToast('两边都改过这篇笔记，请点「拉取」在分屏里选一个版本', {
                label: '拉取', run: () => void latest.current.fetchNow(),
              })
            }
          } else {
            // The .md write failed. Keep dirty + the parked draft so switching
            // notes (which mirrors disk into IDB) cannot destroy the edit.
            try { drafts.put(path, text) } catch { /* ignore */ }
            await rollbackToDisk()
            showToast(DESKTOP
              ? `写入笔记文件夹失败，修改仍保留为未保存草稿：${e.message || '未知错误'}`
              : `推送电脑失败，修改仍保留为未保存草稿：${e.message || '未知错误'}`, retry, true)
          }
        }
        await refreshLocalStats()
      } catch (e: any) {
        showToast('本地保存失败：' + (e.message || '未知错误'))
      }
    } finally {
      savingRef.current = false
      release()
    }
  }, [showToast, dismissToast, refreshLocalStats, refreshSyncStatus, refreshAssets, askDiskChange, adoptDiskContent])

  /**
   * Classic "save / don't save / cancel" guard before any action that would
   * leave or overwrite the current buffer. Discarding rolls the editor back
   * to the last saved copy, so what is on screen always matches the disk.
   */
  const guardUnsaved = useCallback(async (): Promise<boolean> => {
    const s = latest.current
    if (!dirtyRef.current || !s.currentPath) return true
    // The cold-start dialog already asked about this exact buffer. Do not ask
    // a second time when the user immediately opens the recovered note.
    const skip = skipGuardRef.current
    if (skip) {
      skipGuardRef.current = null
      if (s.currentPath === skip.path && s.content === skip.content) return true
    }
    const choice = await askSaveChoice(`「${String(s.currentPath).split('/').pop()}」有未保存的修改，要保存吗？`)
    if (choice === 'cancel') return false
    // A failed disk write leaves dirty=true; never navigate away (or close the
    // window) while the user's edit is still only in memory.
    if (choice === 'save') { await s.saveNow(true); return !dirtyRef.current }
    // Discarding must roll back to the DISK copy, not IndexedDB: after a
    // failed disk write IDB can hold the unsaved text while the .md does not.
    if (DESKTOP && onlineRef.current) {
      const disk = await api.file(s.currentPath).catch(() => null)
      if (disk) await db.mirror(disk).catch(() => {})
    }
    const saved = await db.getDoc(s.currentPath)
    if (saved) s.applyDoc(saved)
    else { dirtyRef.current = false; setDirty(false) }
    drafts.clear(s.currentPath)
    return true
  }, [askSaveChoice])

  /** Record an opened file at the front of the recents list (dedup, capped). */
  const pushRecent = useCallback((path: string) => {
    if (!path) return
    setRecents((prev) => {
      const next = [path, ...prev.filter((p) => p !== path)].slice(0, RECENTS_MAX)
      saveRecents(next)
      return next
    })
  }, [])

  /** Drop a path from the recents list only (no disk / vault deletion). */
  const removeRecent = useCallback((path: string) => {
    setRecents((prev) => {
      const next = prev.filter((p) => p !== path)
      saveRecents(next)
      return next
    })
  }, [])

  /**
   * 桌面在线时先读磁盘（权威副本）并刷新 IDB 工作副本，再打开它。
   * 否则「拉取把对端内容写进本机 .md」或外部编辑过 .md 之后，切回这篇
   * 笔记仍会显示旧内容，甚至把旧内容再发布到云仓库。
   */
  const loadFile = useCallback(async (path: string, skipSave = false, skipDraftRestore = false) => {
    clearPendingDialogs()
    if (!skipSave && !(await latest.current.guardUnsaved())) return
    try {
      let doc: LocalDoc | undefined
      if (DESKTOP && onlineRef.current) {
        const disk = await api.file(path).catch(() => null)
        if (disk) { await db.mirror(disk); doc = await db.getDoc(path) }
      }
      if (!doc) doc = await db.getDoc(path)
      if (!doc && hasMobileVault()) {
        // Note exists in the SAF folder but not in the working copy yet.
        const raw = await localVault.readDoc(path)
        if (raw !== null) {
          await db.mirror({ path, content: raw, version: 1, mtime: Date.now() })
          doc = await db.getDoc(path)
        }
      } else if (!doc && onlineRef.current && !DESKTOP) {
        await db.mirror(await api.file(path))
        doc = await db.getDoc(path)
      }
      if (doc) {
        applyDoc(doc)
        // A failed disk write keeps the buffer dirty. db.mirror() above may
        // have overwritten IDB with the stale disk copy, so restore the parked
        // draft instead of silently losing the user's edit on a note switch.
        const parked = skipDraftRestore ? null : drafts.get(path)
        if (parked && parked.content !== doc.content) {
          setContent(parked.content)
          dirtyRef.current = true
          setDirty(true)
          // It is back in the editor now; drop the parachute copy so boot()
          // does not offer the same draft a second time.
          drafts.clear(path)
        }
        pushRecent(path)
      } else showToast('本地副本中找不到这篇笔记')
    } catch (e: any) { showToast('打开失败：' + (e.message || '未知错误')) }
    if (latest.current.settings.scope !== 'vault') latest.current.refreshTree()
  }, [applyDoc, showToast, pushRecent, clearPendingDialogs])

  const onContentChange = useCallback((v: string) => {
    setContent(v)
    // Undo / redo can land exactly back on the saved text. A normal editor
    // then drops the "modified" marker instead of leaving it stuck on.
    const clean = v === savedTextRef.current
    dirtyRef.current = !clean
    setDirty(!clean)
  }, [])

  /** Union of the computer vault and this device's local replica. */
  const refreshTree = useCallback(async () => {
    const s = latest.current
    const scope = scopeValue(s.currentPath, s.settings.scope)
    if (hasMobileVault()) {
      // The phone's file tree comes from its own SAF folder, never from the
      // desktop REST tree (that would show the other device's notes).
      const fs = bridge.vaultFs
      const files = fs ? await fs.listFiles().catch(() => []) : []
      const paths = files
        .map((f) => f.path)
        .filter((p) => /\.(md|markdown|txt)$/i.test(p) && !p.startsWith('.') && !p.includes('/.'))
        .filter((p) => inScope(p, scope))
      setVaultName((await bridge.getVault().catch(() => '')) || '手机仓库')
      applyTree(pathsToTree(paths))
      return
    }
    let remoteTree: TreeNode[] = []
    if (onlineRef.current) {
      try {
        const r = await api.tree(scope)
        remoteTree = r.tree
        setVaultName(r.vault || '仓库')
      } catch (e: any) {
        if (e.status === 401) { if (!MOBILE) showToast('配对已失效，请在电脑上重新打开同步面板扫码') }
        else showToast('读取电脑文件列表失败：' + (e.message || ''))
      }
    } else setVaultName('本地笔记')
    const localPaths = (await db.listDocs()).filter((d) => inScope(d.path, scope)).map((d) => d.path)
    applyTree(mergeTrees(remoteTree, pathsToTree(localPaths)))
  }, [showToast, applyTree])

  const refreshInfo = useCallback(async () => {
    if (!onlineRef.current) return
    try {
      const i = await api.info()
      setInfo(i); setDevices(i.devices || [])
    } catch (e: any) {
      if (e.status === 401) { if (!MOBILE) showToast('此设备尚未配对，请扫描电脑端二维码') }
    }
  }, [showToast])

  const restoreLastDoc = useCallback(async () => {
    const last = localStorage.getItem(LS_PATH) || ''
    const files = flattenTree(treeRef.current)
    const target = files.find((f) => f.path === last) || files[0]
    // On boot, leave the parked draft for boot()'s explicit "restore / discard"
    // prompt instead of silently loading it. Only an in-app note switch
    // auto-restores it (to survive a failed disk write + db.mirror).
    if (target) { await latest.current.loadFile(target.path, true, true); return }
    // Empty vault: show the empty state. Never fabricate a note in IndexedDB
    // or on disk — the authoritative copy is always a real .md in the vault.
    dirtyRef.current = false
    setDirty(false)
    baseHashRef.current = ''
    savedTextRef.current = ''
    remoteRef.current = null
    setContent('')
    setVersion(0)
    setCurrentPath('')
    setActiveLine(0)
    // An empty vault has no notes and no attachments: drop the previous
    // vault's image preview and asset list too, or it keeps pointing at a
    // /raw path that no longer exists in the newly selected folder.
    setPreviewAsset(null)
    setSavedAssetRefs([])
    setAssets([])
    try { localStorage.removeItem(LS_PATH) } catch { /* ignore */ }
  }, [])

  /* -------------------------------------------------------- files CRUD */
  const newFile = useCallback(async (dir = '', phone = false) => {
    const name = await prompt({ title: '新建笔记', placeholder: '笔记名称', confirmText: '创建' })
    if (!name) return
    if (!(await latest.current.guardUnsaved())) return
    const path = (dir ? `${dir}/` : '') + (/\.(md|markdown|txt)$/i.test(name) ? name : `${name}.md`)
    try {
      const body = `# ${name.replace(/\.(md|markdown|txt)$/i, '')}\n\n`
      await db.saveLocal({
        path, content: body, version: 1, mtime: Date.now(),
        baseHash: '', synced: false, remote: null,
      }, '新建笔记')
      void fsAccess.mirrorDoc(path, body)
      // 仓库里的 .md 才是权威副本：新建必须落盘，不能只写 IndexedDB 副本。
      if (DESKTOP) {
        try {
          await api.create(path, body)
          const created = await db.getDoc(path)
          if (created) await db.putDoc({ ...created, baseHash: fnv1a(body), synced: true })
        } catch { /* 同名已存在或服务暂不可达 */ }
      } else if (hasMobileVault()) {
        await writeMobileDoc(path, body).catch(() => {})
      }
      await refreshLocalStats()
      await latest.current.refreshTree()
      // guardUnsaved() already handled the old buffer; don't ask twice.
      await latest.current.loadFile(path, true)
      setSidebarOpen(true); setSidebarTab('files')
      if (MOBILE && phone) { setMPane('edit'); setMEditorOpen(true) }
    } catch (e: any) { showToast('创建失败：' + e.message) }
  }, [prompt, showToast, refreshLocalStats])

  const newFolder = useCallback(async (dir = '') => {
    const name = await prompt({ title: '新建文件夹', placeholder: '文件夹名称', confirmText: '创建' })
    if (!name) return
    const path = (dir ? `${dir}/` : '') + name
    try {
      if (DESKTOP) await api.mkdir(path)
      // 手机 / 网页副本的目录由笔记路径自动生成，不需要额外建文件夹。
      await latest.current.refreshTree()
    } catch (e: any) { showToast('创建失败：' + e.message) }
  }, [prompt, showToast])

  const renameNode = useCallback(async (node: TreeNode) => {
    const name = await prompt({ title: '重命名', value: node.name, confirmText: '保存' })
    if (!name || name === node.name) return
    const parts = node.path.split('/')
    parts[parts.length - 1] = name
    const next = parts.join('/')
    try {
      const before = await db.listDocs()
      for (const d of before) {
        if (d.path === node.path || d.path.startsWith(node.path + '/')) {
          const p = next + d.path.slice(node.path.length)
          await db.putDoc({ ...d, path: p, synced: false })
          await db.deleteDoc(d.path)
        }
      }
      if (hasMobileVault() && bridge.vaultFs) {
        // SAF has no rename: copy every affected note to its new path, then
        // remove the old document. Empty folders are implicit on the phone.
        for (const d of before) {
          if (d.path !== node.path && !d.path.startsWith(node.path + '/')) continue
          const p = next + d.path.slice(node.path.length)
          try {
            const content = await bridge.vaultFs.readFile(d.path)
            await bridge.vaultFs.writeFile(p, content)
            await bridge.vaultFs.removeFile(d.path)
          } catch { /* the note may exist only in the working copy */ }
        }
      } else if (DESKTOP) {
        try { await api.rename(node.path, next) } catch { /* 磁盘上没有该路径 */ }
      }
      if (latest.current.currentPath.startsWith(node.path)) {
        setCurrentPath(next + latest.current.currentPath.slice(node.path.length))
      }
      await refreshLocalStats()
      await latest.current.refreshTree()
    } catch (e: any) { showToast('重命名失败：' + e.message) }
  }, [prompt, showToast, refreshLocalStats])

  /**
   * 文件树删除 = 真删仓库里的 .md + 写墓碑，对端点「拉取」后同步删除。
   * 桌面走本机内嵌服务（DELETE /api/file 递归删除、逐篇留 .lumen-history
   * 快照并 markDeleted）；手机 App 逐篇写自己的 SAF 目录。欢迎页的
   * 「从最近列表移除」是另一条独立入口，仍然是纯记录操作。
   */
  const deleteNode = useCallback(async (node: TreeNode) => {
    const inRange = (p: string) => !!p && (p === node.path || p.startsWith(node.path + '/'))
    // 只有删除范围包含当前打开的笔记时才需要保护未保存草稿；删别的文件不该打断编辑。
    if (inRange(String(latest.current.currentPath || '')) && !(await latest.current.guardUnsaved())) return
    const targets = flattenTree(treeRef.current).filter((f) => inRange(f.path)).map((f) => f.path)
    // 空文件夹在手机端没有实体目录（目录由笔记路径隐含），不要删一个不存在的路径。
    if (!targets.length && node.type !== 'folder') targets.push(node.path)
    const label = node.type === 'folder'
      ? `文件夹「${node.name}」及其下全部内容（${targets.length} 篇笔记）`
      : `笔记「${node.path}」`
    const ok = await confirm(
      `确定删除${label}吗？这会真正删除仓库里的 .md 文件，并写入删除记录；另一台设备点「拉取」后也会删除同一篇。删除前会留一份 .lumen-history 快照，可从那里恢复。`,
      true,
    )
    if (!ok) return
    try {
      let removed = false
      if (hasMobileVault()) {
        for (const p of targets) await deleteMobileDoc(p, DEVICE_ID)
        removed = true
      } else {
        try { await api.remove(node.path); removed = true }
        catch {
          // 磁盘上可能已被收敛删除。DELETE 对不存在的路径是幂等的（仍写墓碑），
          // 这里逐篇补一次，确保删除记录能传播到对端。
          for (const p of targets) {
            try { await api.remove(p); removed = true } catch { /* 已不存在 */ }
          }
        }
      }
      // 无论远端结果如何，本设备的工作副本/记录都要清干净；以前这些清理
      // 全在 api.remove 之后，一次失败就会留下 IDB、草稿和最近文件残留。
      for (const p of [node.path, ...targets]) { removeRecent(p); drafts.clear(p) }
      for (const d of await db.listDocs()) {
        if (inRange(d.path)) await db.deleteDoc(d.path)
      }
      await refreshLocalStats()
      await latest.current.refreshTree()
      const files = flattenTree(treeRef.current)
      if (inRange(String(latest.current.currentPath || ''))) {
        if (files.length) await latest.current.loadFile(files[0].path, true)
        else applyDoc({ path: '', content: '', version: 1, mtime: Date.now() })
      }
      showToast(removed
        ? `已删除${label}，并写入删除记录；对端点「拉取」后会同步删除`
        : `已从本设备移除${label}（仓库里已无此文件）`)
    } catch (e: any) { showToast('删除失败：' + (e?.message || '未知错误')) }
  }, [confirm, removeRecent, applyDoc, showToast, refreshLocalStats])

  const openWiki = useCallback(async (target: string) => {
    const files = flattenTree(latest.current.tree)
    const found = files.find((f) =>
      f.path === target || f.path === `${target}.md` || f.name.replace(/\.(md|markdown|txt)$/i, '') === target
    )
    if (found) await latest.current.loadFile(found.path)
    else showToast(`未找到笔记「${target}」`)
  }, [showToast])

  /* ------------------------------------------------------------- sync */
  const connect = useCallback(() => {
    connRef.current?.close()
    connRef.current = connectSync({
      onStatus: (v) => {
        setWsConnected(v)
        // A dead socket cannot carry trustworthy peer information.
        if (!v) setPresence({ peers: [], count: 0 })
      },
      onPresence: (p) => setPresence(p),
      onFile: (msg) => {
        if (msg.origin === clientId) return
        // 实时广播只作提示。任何内容差异都必须走「拉取」→ 分屏选版本，
        // 不会自动覆盖本设备的 .md 或编辑器。
        // 但磁盘内容确实变了，IDB 工作副本要跟上（当前笔记有未保存草稿时
        // 先保留旧基线，让下一次保存能撞出 409 而不是静默覆盖对端修改）。
        if (msg.path && typeof msg.content === 'string'
          && !(dirtyRef.current && msg.path === latest.current.currentPath)) {
          void db.mirror({
            path: msg.path, content: msg.content,
            version: msg.version || 1, mtime: msg.mtime || Date.now(),
          }).catch(() => {})
        }
        const t = Date.now()
        if (t - lastRemoteNoticeRef.current > 20_000) {
          lastRemoteNoticeRef.current = t
          showToast('仓库有文件更新，点「拉取」查看差异并选版本', {
            label: '拉取', run: () => void latest.current.fetchNow(),
          })
        }
      },
      /** 对端「同步」只是发布它的云仓库，不授权覆盖本设备任何内容。 */
      onPush: (msg) => {
        if (msg.from === clientId) return // our own push echo
        showToast(`「${String(msg.path || '').split('/').pop()}」已发布到云仓库，点「拉取」查看差异`, {
          label: '拉取', run: () => void latest.current.fetchNow(),
        })
      },
      onTree: () => latest.current.refreshTree(),
      onDevices: (list: Device[]) => setDevices(list),
      onVcs: () => void latest.current.refreshSyncStatus(),
      /** 对端完成收敛：本设备把自己的本地仓库工作副本与收敛结果对齐。 */
      onConverge: (msg) => {
        if (msg.clientId === clientId) return // our own resolve echo
        ;(async () => {
          for (const it of msg.items || []) {
            if (it.action === 'delete') {
              if (hasMobileVault()) await deleteMobileDoc(it.path, DEVICE_ID).catch(() => {})
              else {
                // /versions/resolve 已经删过 .md；只有文件还在时才补删，
                // 避免重复写墓碑与历史快照。
                const disk = await api.file(it.path).catch(() => null)
                if (disk) await api.remove(it.path).catch(() => {})
              }
              await db.deleteDoc(it.path).catch(() => {})
              continue
            }
            // /versions/resolve：服务端已写好 .md，本端只刷新，绝不重复写盘。
            // /versions/notify（手机端收敛）：服务端没写盘，本端要用对端传来的
            // 内容写回自己的 .md——这一步以前被磁盘旧内容覆盖掉了。
            const disk = hasMobileVault() ? null : await api.file(it.path).catch(() => null)
            const content = String(it.content ?? disk?.content ?? '')
            let version = disk?.version || 1
            let mtime = disk?.mtime || Date.now()
            if (hasMobileVault()) await writeMobileDoc(it.path, content).catch(() => {})
            else if (!disk || disk.content !== content) {
              // silent: 这是收敛结果的回写，不是新的用户编辑，不能广播成
              // 「仓库有文件更新」让对端刚收敛完又去点拉取。
              const saved = await api.save(it.path, content, 0, '', true, true).catch(() => null)
              if (saved) { version = saved.version; mtime = saved.mtime }
            }
            await db.mirror({ path: it.path, content, version, mtime }).catch(() => {})
            if (it.path === latest.current.currentPath && !dirtyRef.current) {
              latest.current.applyDoc({
                path: it.path, content, version: 1,
                mtime: Date.now(), baseHash: fnv1a(content),
                synced: true, remote: null,
              } as LocalDoc)
            }
          }
          await latest.current.refreshTree()
          await refreshLocalStats()
          void latest.current.refreshSyncStatus()
          showToast(`已收到对端的版本收敛结果（${(msg.items || []).length} 篇）`)
        })().catch(() => {})
      },
      onVault: (msg) => {
        void latest.current.refreshInfo()
        void latest.current.refreshTree()
        showToast(`电脑仓库已切换到「${msg.name}」`)
      },
      // Phone already shows the disconnected state in its banner / connect
      // page; a toast on every reconnect adds nothing.
      onUnpaired: () => { if (!MOBILE) showToast('配对已失效，请重新扫码绑定') },
      onWatcherDegraded: (message) => {
        // 监视降级只提示一次，避免 inotify 反复报错刷屏。
        if (watcherWarnedRef.current) return
        watcherWarnedRef.current = true
        showToast(message || '文件监视已降级，外部改动不会自动同步')
      },
      onCursor: (msg) => {
        if (msg.from === clientId || msg.path !== latest.current.currentPath) return
        showToast('其它设备跳转到了第 ' + (Number(msg.line) + 1) + ' 行', {
          label: '跟随',
          run: () => latest.current.jumpToLine(Number(msg.line)),
        })
      },
    })
    connRef.current?.subscribe(scopeValue(latest.current.currentPath, latest.current.settings.scope))
  }, [showToast, refreshLocalStats])

  const boot = useCallback(async () => {
    // A phone with no granted SAF tree cannot read a single .md. Keep the
    // welcome picker in front until the user chooses a folder; onSelectVault
    // then re-runs boot() to establish the WS link and load the notes.
    if (isAndroidNative() && !(await androidVaultConfigured())) {
      setWelcomeStage('vault')
      setShowWelcome(true)
      return
    }
    const ok = await api.health()
    onlineRef.current = ok
    setOnline(ok)
    // Fresh install: the vault has not been chosen yet. Do not read or write
    // a single note; resyncVault() rebuilds everything once a folder is set.
    if (welcomeGateRef.current) {
      if (ok) latest.current.connect()
      else setInfo(null)
      return
    }
    if (ok) {
      const flushed = await flushPending().catch(() => 0)
      if (flushed) showToast(`已把 ${flushed} 条离线版本写入本地仓库`)
      // 启动只做一次只读镜像，绝不自动推拉或合并。任何差异都留给用户点
      // 「拉取」后在分屏里选版本。
      const n = await bootstrapMirror()
      if (n) showToast(`已把电脑仓库的 ${n} 篇笔记复制到本设备（不会回推）`)
      await latest.current.refreshInfo()
      latest.current.connect()
    } else {
      setInfo(null)
      // Offline phone: mirror the SAF notes into IndexedDB anyway, otherwise
      // the editor would have nothing to open without the desktop service.
      if (hasMobileVault()) await bootstrapMirror().catch(() => 0)
    }
    await latest.current.refreshTree()
    void refreshAssets()
    await latest.current.restoreLastDoc()
    await refreshLocalStats()
    // Crash / refresh parachute: ONE dialog for the unsaved text parked before
    // unload. It used to be a "restore / discard" confirm, and then the very
    // same buffer triggered the leave-guard as soon as a note was opened.
    const bootPath = localStorage.getItem(LS_PATH) || ''
    const draft = drafts.get(bootPath)
    const savedDoc = bootPath ? await db.getDoc(bootPath) : null
    if (draft && (!savedDoc || draft.content !== savedDoc.content)) {
      const when = new Date(draft.savedAt).toLocaleString()
      const choice = await askDraftChoice(
        `「${bootPath.split('/').pop()}」有上次未保存的内容`, when)
      if (choice === 'discard') {
        drafts.clear(bootPath)
      } else if (choice === 'edit' || choice === 'save') {
        // Keep the parachute copy until a successful save. loadFile() also
        // restores it when the note is opened, so the edit cannot be lost.
        setContent(draft.content)
        latest.current.content = draft.content
        dirtyRef.current = true
        setDirty(true)
        if (choice === 'save') {
          await latest.current.saveNow(true, draft.content)
        } else {
          skipGuardRef.current = { path: bootPath, content: draft.content }
          showToast('已恢复未保存的内容')
        }
      }
      // 'cancel': leave the draft parked for the next launch.
    }
  }, [showToast, refreshLocalStats, askDraftChoice])

  const reconnect = useCallback(async (raw: string) => {
    let target: string
    try { target = normalizeBase(raw) }
    catch (e: any) { showToast(e.message || '地址格式不正确'); return }
    setBase(target)
    updateSettings({ syncTarget: target })
    connRef.current?.close()
    await latest.current.boot()
    showToast('已重新连接：' + getBase())
  }, [updateSettings, showToast])

  const pairWithCode = useCallback(async (code: string) => {
    if (!code) return
    try {
      const r = await api.pair(code, deviceName())
      setSession(r.session)
      connRef.current?.close()
      await latest.current.boot()
      showToast('配对成功，已连接电脑仓库')
    } catch (e: any) { showToast('配对失败：' + (e.message || '请检查配对码与服务地址')) }
  }, [showToast])

  /** Phone: a scanned QR or a pasted desktop link points the transport at the
   *  PC and (when present) exchanges the pairing token for a session. */
  const connectFromLink = useCallback(async (raw: string) => {
    try {
      const { base, token } = parsePairLink(raw)
      setBase(base)
      updateSettings({ syncTarget: base })
      if (token) {
        const r = await api.pair(token, deviceName())
        setSession(r.session)
      }
      connRef.current?.close()
      await latest.current.boot()
      showToast('已连接：' + base)
    } catch (e: any) { showToast(e?.message || '连接失败') }
  }, [updateSettings, showToast])

  const unpair = useCallback(async (id: string) => {
    try { await api.unpair(id); setDevices((d) => d.filter((x) => x.id !== id)); showToast('已解除绑定') }
    catch (e: any) { showToast('操作失败：' + e.message) }
  }, [showToast])

  /* ------------------------------------------- 同步 / 拉取 */
  /**
   * 发布：把调用方给定的文档写进本设备自己的云仓库，并把云仓库清单登记给
   * 对端（publishCloud 不拉回任何内容）。不做收敛、不碰对端 .md。
   * getDocs 决定范围：单篇 = [当前笔记]，全仓 = diskDocs()；在 guardUnsaved
   * 之后再取值，保证「先保存再发布」拿到的是保存后的磁盘内容。
   */
  const publishDocs = useCallback(async (
    getDocs: () => Promise<{ path: string; content: string }[]>,
    label: string,
  ) => {
    if (syncingRef.current) { showToast('正在同步中，请稍候'); return }
    // Immediate feedback: the native button tooltip has a system delay and the
    // unsaved guard can open a dialog, so tell the user right away.
    showToast(onlineRef.current ? `正在${label}…` : '离线：正在登记到本设备云仓库…')
    if (!(await latest.current.guardUnsaved())) return
    syncingRef.current = true
    try {
      // 桌面在线时以磁盘 .md 为准；IDB 只是工作副本，可能还停在拉取/外部
      // 编辑之前的内容，直接拿它发布会把旧内容写成云端最新版。
      const docs = await getDocs()
      if (!docs.length) { showToast('没有可同步的笔记'); return }
      const report = await syncToCloud({ docs, online: onlineRef.current, isDesktop: DESKTOP })
      // 把本设备云仓库清单登记给对端，以便之后能拉到；不拉回任何内容。
      if (onlineRef.current) await publishCloud(DEVICE_ID, deviceLabel()).catch(() => 0)
      // Report first; the counter / asset refreshes are bookkeeping and must
      // not hold the result hostage (they made the toast appear seconds late).
      showToast(report.failed
        ? `${label}完成，但有 ${report.failed} 篇失败`
        : `${label}完成：发布 ${report.uploaded} 篇到本设备云仓库${onlineRef.current ? '' : '（离线登记，连接后补推）'}`)
      await refreshLocalStats()
      void refreshAssets()
      void refreshSyncStatus()
    } catch (e: any) {
      showToast('同步失败：' + (e.message || '未知错误'))
    } finally { syncingRef.current = false }
  }, [showToast, refreshLocalStats, refreshSyncStatus])

  /** 同步当前笔记：只把打开的这一篇发布到本设备云仓库。 */
  const syncCurrent = useCallback(async () => {
    const rel = String(latest.current.currentPath || '')
    if (!rel) { showToast('请先打开一篇笔记'); return }
    await publishDocs(async () => {
      if (DESKTOP && onlineRef.current) {
        const doc = await api.file(rel).catch(() => null)
        return doc ? [{ path: rel, content: doc.content }] : []
      }
      return (await localVault.listDocs()).filter((d) => d.path === rel)
        .map((d) => ({ path: d.path, content: d.content }))
    }, '同步当前笔记')
  }, [publishDocs, showToast])

  /** 全仓同步：把本地仓库全部笔记发布到本设备云仓库。 */
  const syncVaultNow = useCallback(async () => {
    await publishDocs(async () =>
      DESKTOP && onlineRef.current ? await diskDocs() : await localVault.listDocs(),
    '全仓同步')
  }, [publishDocs])

  /* ------------------------------------------- explicit cloud fetch */
  /**
   * 拉取 = 整仓双向收敛。先保护未保存草稿，再由服务端按内容 hash 跳过相同、
   * 拷贝单边、传播删除墓碑；两端内容不同的笔记全部进「待处理」列表，只有
   * 用户在分屏里选定版本后才写回 .md。
   */
  const fetchNow = useCallback(async () => {
    if (syncingRef.current) { showToast('正在拉取中，请稍候'); return }
    if (!(await latest.current.guardUnsaved())) return
    syncingRef.current = true
    try {
      showToast('正在拉取并收敛云仓库…')
      const report = await fetchUpdates({
        selfId: DEVICE_ID,
        selfName: deviceLabel(),
      })
      // 收敛改写/删除过的 .md 必须同步刷进 IDB 工作副本，否则下一次「同步」
      // 会把旧内容发布成云端最新版，切走再切回也还是旧内容。
      await alignLocalReplica(report.changedPaths)
      await latest.current.refreshTree()
      void refreshAssets()
      await refreshLocalStats()
      // 收敛可能改写或删除了当前打开的 .md；没有未保存草稿就重新载入。
      const cur = String(latest.current.currentPath || '')
      if (cur && !dirtyRef.current) {
        const doc = await api.file(cur).catch(() => null)
        if (doc) {
          await db.mirror(doc).catch(() => {})
          applyDoc({ ...doc, baseHash: fnv1a(doc.content), synced: true, remote: null } as LocalDoc)
        } else if (report.changedPaths.includes(cur)) {
          showToast('当前笔记已在两端删除，请从文件树选择其它笔记')
        }
      }
      void refreshSyncStatus()
      const assetCount = report.assetConflicts.length
      if (report.updated > 0 || assetCount > 0) setHistoryOpen(true)
      const assetNote = (report.assetCopied || report.assetDeleted || assetCount)
        ? `；附件拷贝 ${report.assetCopied} 项、删除 ${report.assetDeleted} 项${assetCount ? `、${assetCount} 项待选择` : ''}`
        : ''
      const text = report.failed
        ? `拉取完成，但有 ${report.failed} 篇失败`
        : !report.peerCount
          ? '未连接设备，没有可拉取的云仓库'
          : report.updated
            ? `拉取完成：跳过 ${report.unchanged} 篇、拷贝 ${report.copied} 篇、删除 ${report.deleted} 篇，${report.updated} 篇待选版本`
            : `拉取完成：两端云仓库已一致（跳过 ${report.unchanged} 篇、拷贝 ${report.copied} 篇、删除 ${report.deleted} 篇）`
      showToast(text + assetNote)
    } catch (e: any) {
      showToast(e.message || '拉取失败')
    } finally { syncingRef.current = false }
  }, [showToast, refreshLocalStats, refreshSyncStatus, applyDoc, alignLocalReplica])

  /** Paste / drop / 「插入图片…」: copy into img/<note>/ and write a root-relative link. */
  const insertImageFile = useCallback(async (file: File) => {
    if (!file) return
    const ext = (file.name.match(/\.[a-z0-9]+$/i)?.[0] || '.png').toLowerCase()
    // A space or bracket inside `(...)` makes Markdown treat the whole image
    // as plain text, so the stored name must be URL/Markdown safe.
    const base = (file.name.replace(/\.[a-z0-9]+$/i, '').replace(/^\.+/, '')
      .replace(/[\\/:*?"<>|#()\[\]\s]+/g, '_').replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '').slice(0, 60) || '图片')
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    // 与文件树判定共用同一套笔记名清洗，避免含空格/括号的笔记名对不上目录。
    const noteBase = noteAssetDir(latest.current?.currentPath || '')
    const rel = `img/${noteBase}/${base}-${stamp}-${Math.random().toString(36).slice(2, 6)}${ext}`
    try {
      const info = await api.assetUpload(rel, file)
      // A leading slash means "vault root" in this renderer, so the link works
      // no matter which folder the current note lives in. Newlines keep the
      // image its own block instead of gluing it to surrounding text.
      editorRef.current?.insertText(`\n![${base}](/${info.path})\n`)
      await refreshTree()
      void refreshAssets()
      showToast(`已插入图片：${info.path}`)
    } catch (e: any) {
      showToast('插入图片失败：' + (e?.message || '未知错误'))
    }
  }, [refreshTree, showToast])

  // 菜单「插入 ▸ 图片」复用同一套落盘逻辑：选图 → 存 img/<笔记名>/ → 插入链接。
  const imageInputRef = useRef<HTMLInputElement>(null)
  const insertImage = useCallback(() => { imageInputRef.current?.click() }, [])
  const onImagePicked = useCallback((e: ReactChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) void insertImageFile(file)
    e.target.value = ''
  }, [insertImageFile])

  const openHistory = useCallback(() => setHistoryOpen(true), [])

  /**
   * 服务端已经写好 .md（resolveVersions），这里只把编辑器与本地工作副本
   * 对齐，绝不重复写盘——写回只有一条路径。
   */
  const applyConverged = useCallback(async (content: string, path: string) => {
    // 服务端已写好 .md；先按磁盘结果刷新 IDB 工作副本（即使编辑器是脏的也
    // 要刷），这里绝不重复写盘——写回只有 /versions/resolve 一条路径。
    const doc = await api.file(path).catch(() => null)
    if (doc) await db.mirror({ path, content: doc.content, version: doc.version, mtime: doc.mtime }).catch(() => {})
    else await db.deleteDoc(path).catch(() => {})
    await latest.current.refreshTree()
    await refreshLocalStats()
    void refreshSyncStatus()
    if (path !== latest.current.currentPath || dirtyRef.current) return
    if (!doc) {
      if (!content) showToast('这篇笔记已在两端删除')
      return
    }
    applyDoc({
      path, content: doc.content, version: doc.version, mtime: doc.mtime,
      baseHash: fnv1a(doc.content), synced: true, remote: null,
    } as LocalDoc)
  }, [applyDoc, refreshLocalStats, refreshSyncStatus, showToast])

  /* -------------------------------------------------------- navigation */
  const jumpToLine = useCallback((line: number) => {
    setActiveLine(line)
    editorRef.current?.scrollToLine(line + 1, true)
    if (latest.current.mode !== 'source') {
      window.requestAnimationFrame(() => syncRef.current?.jumpFromEditor(line))
    }
  }, [])

  const onEditorClick = useCallback((line: number) => {
    setActiveLine(line)
    if (latest.current.mode !== 'source') syncRef.current?.jumpFromEditor(line)
    connRef.current?.cursor(latest.current.currentPath, line)
  }, [])

  const onPreviewJump = useCallback((line: number) => {
    setActiveLine(line)
    syncRef.current?.jumpFromPreview(line)
  }, [])

  const onTaskToggle = useCallback((line: number) => {
    const view = editorRef.current?.view
    if (!view) return
    if (!ed.flipTaskAtLine(view, line)) showToast('这一行不是任务项')
  }, [showToast])

  const setViewMode = useCallback((m: ViewMode) => {
    setMode(m)
    if (m !== 'reading') lastEditMode.current = m
    localStorage.setItem(LS_MODE, m)
  }, [])

  /* ------------------------------------------------------------ effects */
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!mq?.addEventListener) return
    const onChange = (e: MediaQueryListEvent) => setSysDark(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    document.documentElement.dataset.theme = effectiveTheme
    const meta = document.querySelector('meta[name="theme-color"]')
    if (meta) meta.setAttribute('content', effectiveTheme === 'dark' ? '#1e1e1e' : '#ffffff')
    if (MOBILE) void setAndroidStatusBarStyle(effectiveTheme === 'dark')
  }, [effectiveTheme])

  useEffect(() => {
    ;(async () => {
      const params = new URLSearchParams(location.search)
      const pairToken = params.get('pair')
      if (pairToken) {
        try {
          const r = await api.pair(pairToken, deviceName())
          setSession(r.session)
          showToast('已绑定到局域网仓库')
        } catch (e: any) { showToast(e.message || '配对失败') }
        history.replaceState({}, '', location.pathname)
      }
      await boot()
    })()
    return () => connRef.current?.close()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Android hardware back, in priority order: dialog → image preview →
  // bottom sheet → editor → notes tab → leave the app.
  useEffect(() => {
    if (!MOBILE) return
    let off: (() => void) | undefined
    void import('@capacitor/app').then(({ App }) => {
      void App.addListener('backButton', ({ canGoBack }) => {
        const L = latest.current
        // Dispatch on document, not window. Dialogs / menus listen on document
        // (some in the capture phase); an event targeted at window never
        // reaches them, which used to leave dialogs stuck open on back.
        if (document.querySelector('.modal-backdrop, .menu-mobile, .sidebar-scrim')) {
          document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape', bubbles: true, cancelable: true,
          }))
          return
        }
        // The image preview has no Escape handler of its own.
        if (document.querySelector('.asset-preview')) { setPreviewAsset(null); return }
        if (L.mSheet) { setMSheet(null); return }
        if (L.mEditorOpen) {
          if (!L.dirty) { setMEditorOpen(false); return }
          void confirm('当前笔记还没保存，仍要返回吗？').then((yes) => {
            if (yes) setMEditorOpen(false)
          })
          return
        }
        if (L.mTab !== 'notes') { setMTab('notes'); return }
        if (canGoBack) window.history.back()
        else void App.exitApp()
      }).then((h) => { off = () => { void h.remove() } })
    })
    return () => { off?.() }
  }, [confirm])

  // CodeMirror is mounted inside a display:none pane while the notes tab is
  // visible. Re-measure once it becomes visible, otherwise the first tap can
  // land on a zero-height editor on some WebViews.
  useEffect(() => {
    if (!MOBILE || !mEditorOpen) return
    const t = window.setTimeout(() => {
      try { editorRef.current?.view?.requestMeasure?.() } catch { /* view not ready */ }
    }, 80)
    return () => clearTimeout(t)
  }, [mEditorOpen, mPane])

  // Edits stay in memory until an explicit save. When the soft keyboard
  // changes the visual viewport, keep the caret above the toolbar.
  useEffect(() => {
    if (!MOBILE) return
    let t: number | undefined
    const onResize = (e: Event) => {
      window.clearTimeout(t)
      // The viewport hook fires continuously during the IME animation and
      // one final `settled` event once geometry stops changing. Re-centre the
      // caret immediately on that last frame instead of waiting for debounce.
      if ((e as CustomEvent).detail?.settled) {
        editorRef.current?.ensureCursorVisible()
        return
      }
      t = window.setTimeout(() => editorRef.current?.ensureCursorVisible(), 120)
    }
    window.addEventListener(VIEWPORT_RESIZE_EVENT, onResize)
    return () => {
      window.clearTimeout(t)
      window.removeEventListener(VIEWPORT_RESIZE_EVENT, onResize)
    }
  }, [])

  // Park unsaved text outside the note store. A parachute, not a save: no .md
  // file, no history entry, no folder mirror, no cross-device traffic.
  useEffect(() => {
    if (!dirtyRef.current || !currentPath) return
    const t = window.setTimeout(() => {
      if (dirtyRef.current) drafts.put(latest.current.currentPath, content)
    }, 400)
    return () => clearTimeout(t)
  }, [content, currentPath])

  useEffect(() => {
    const park = () => {
      if (!dirtyRef.current) return
      try { drafts.put(latest.current.currentPath, latest.current.content) } catch { /* ignore */ }
    }
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return
      park()
      // Browsers only allow their native "leave site?" wording here; the
      // three-button choice is used for in-app navigation instead.
      e.preventDefault()
      e.returnValue = ''
    }
    // Mobile browsers rarely fire beforeunload; hiding the tab is the signal.
    const onVisibility = () => { if (document.visibilityState === 'hidden') park() }
    window.addEventListener('beforeunload', onBeforeUnload)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  useEffect(() => {
    if (!online) return
    const scope = scopeValue(currentPath, settings.scope)
    connRef.current?.subscribe(scope)
    latest.current.refreshTree()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.scope, currentPath, online])

  const deferred = useDeferredValue(content)
  const rendered = useMemo(() => renderMarkdown(deferred, currentPath), [deferred, currentPath])

  useEffect(() => {
    const id = window.requestAnimationFrame(() => syncRef.current?.refresh())
    return () => cancelAnimationFrame(id)
  }, [rendered.html, mode, settings.fontSize])

  useEffect(() => {
    // An image preview has no [data-line] anchors; scrolling it must never
    // drag the editor to an unrelated line.
    syncRef.current?.setEnabled(settings.syncScroll && mode === 'split' && !previewAsset)
    const t = window.setTimeout(() => {
      editorRef.current?.view?.requestMeasure()
      syncRef.current?.refresh()
    }, 60)
    return () => clearTimeout(t)
  }, [mode, settings.syncScroll, sidebarOpen, rightOpen, splitRatio, previewAsset])

  // Search across the vault (debounced).
  useEffect(() => {
    const q = query.trim()
    if (!q) { setHits([]); setSearching(false); return }
    setSearching(true)
    const t = window.setTimeout(async () => {
      const files = flattenTree(latest.current.tree).slice(0, 80)
      const out: SearchHit[] = []
      const lower = q.toLowerCase()
      for (const f of files) {
        try {
          let text = (await db.getDoc(f.path))?.content || ''
          if (!text && onlineRef.current) text = (await api.file(f.path).catch(() => ({ content: '' }))).content
          text.split('\n').forEach((line, i) => {
            if (line.toLowerCase().includes(lower)) out.push({ path: f.path, line: i, text: line })
          })
        } catch { /* skip unreadable file */ }
      }
      setHits(out); setSearching(false)
    }, 320)
    return () => clearTimeout(t)
  }, [query, tree])

  /* ---------------------------------------------------------- commands */
  const setSidebar = useCallback((tab: SidebarTab) => { setSidebarTab(tab); setSidebarOpen(true) }, [])
  const openSync = useCallback(() => { setSettingsTab('sync'); setSettingsOpen(true); latest.current.refreshInfo() }, [])
  const openSettings = useCallback(() => { setSettingsTab('storage'); setSettingsOpen(true); void latest.current.refreshInfo() }, [])
  const openToolbarSettings = useCallback(() => { setSettingsTab('toolbar'); setSettingsOpen(true) }, [])
  /**
   * 切仓后 IDB 只是上一仓库的工作副本：全部清掉（含离线队列、版本缓存、
   * 历史缓存、待处理冲突、草稿、最近文件），再按新仓库的 .md 只读重建。
   * 否则旧仓库的「待处理 N 篇」会在新仓库里凭空创建旧路径的 .md。
   */
  const resyncVault = useCallback(async () => {
    clearPendingDialogs()
    setPreviewAsset(null)
    setSavedAssetRefs([])
    await db.clearVaultCache().catch(() => {})
    drafts.clearAll()
    try { localStorage.removeItem(LS_RECENTS); localStorage.removeItem(LS_PATH) } catch { /* ignore */ }
    setRecents([])
    await bootstrapMirror().catch(() => 0)
    await latest.current.refreshInfo()
    await latest.current.refreshTree()
    // The attachment inventory belongs to the vault, just like the tree and
    // IndexedDB mirror. Without this, switching back to a non-empty vault
    // leaves the img/ subtree showing raw Markdown links instead of real
    // file names (and loses size/mtime for sorting).
    await refreshAssets()
    await refreshLocalStats()
    await refreshSyncStatus()
    await latest.current.restoreLastDoc()
  }, [refreshAssets, refreshLocalStats, refreshSyncStatus, clearPendingDialogs])
  /** Desktop: native folder picker. Web: open the vault page, which shows the
   * current path and explains why a browser cannot change it. */
  const openStorage = useCallback(() => {
    if (!DESKTOP) { setSettingsTab('storage'); setSettingsOpen(true); void latest.current.refreshInfo(); return }
    void chooseVault().then(async (v) => {
      if (!v) return
      await resyncVault()
      showToast('笔记文件夹已切换为「' + v.split(/[\\/]/).pop() + '」')
    }).catch((e: any) => showToast('切换文件夹失败：' + (e?.message || '未知错误')))
  }, [showToast, resyncVault])

  // The Electron native menu can switch the folder without going through the
  // React UI. Keep the tree in sync when that happens.
  useEffect(() => {
    if (!DESKTOP) return
    return bridge.onVaultChanged(() => { void resyncVault() })
  }, [resyncVault])

  /* ------------------------------------------- phone-only actions */
  const mobileScan = useCallback(async () => {
    try {
      const r = await LumenScan.scanQr()
      if (r && r.text) await connectFromLink(r.text)
    } catch (e: any) { showToast('扫码失败：' + (e?.message || '未知错误')) }
  }, [connectFromLink, showToast])

  const mobilePaste = useCallback(async () => {
    try { return (await readAndroidClipboard()).trim() }
    catch {
      try { return (await navigator.clipboard.readText()).trim() }
      catch { return '' }
    }
  }, [])

  const mobileManual = useCallback(async (rawBase: string, code: string) => {
    try {
      const target = normalizeBase(rawBase)
      setBase(target)
      updateSettings({ syncTarget: target })
      if (code) {
        const r = await api.pair(code, deviceName())
        setSession(r.session)
      }
      connRef.current?.close()
      await latest.current.boot()
      showToast('已连接：' + target)
    } catch (e: any) { showToast(e?.message || '连接失败') }
  }, [updateSettings, showToast])

  const mobileChooseVault = useCallback(async () => {
    try {
      const v = await chooseVault()
      if (!v) return
      await resyncVault()
      showToast('笔记文件夹已切换为「' + v.split(/[\\/]/).pop() + '」')
    } catch (e: any) { showToast('选择文件夹失败：' + (e?.message || '未知错误')) }
  }, [resyncVault, showToast])

  const mobileExportLog = useCallback(async () => {
    try {
      const r = await api.report()
      showToast('诊断报告已在电脑端生成：' + r.path)
    } catch (e: any) { showToast('导出日志失败：' + (e?.message || '未知错误')) }
  }, [showToast])

  const mobileUndo = useCallback(() => {
    const view = editorRef.current?.view
    if (view) cmUndo(view)
  }, [])
  const mobileRedo = useCallback(() => {
    const view = editorRef.current?.view
    if (view) cmRedo(view)
  }, [])
  /** Toolbar taps must keep the caret inside the editor, not a <button>. */
  const pinEditorFocus = useCallback(() => {
    editorRef.current?.focus()
  }, [])

  const saveAs = useCallback(() => {
    const { currentPath: p, content: text } = latest.current
    if (!p) { showToast('请先打开一篇笔记'); return }
    const name = String(p).split('/').pop() || '未命名.md'
    void fsAccess.saveAs(name, String(text || '')).then((r) => {
      if (r !== 'cancel') showToast(r === 'picker' ? '已另存到你选择的位置' : '已导出 .md 到下载目录')
    })
  }, [showToast])

  const downloadMd = useCallback(() => {
    const { currentPath: p, content: text } = latest.current
    if (!p) { showToast('请先打开一篇笔记'); return }
    downloadFile(String(p).split('/').pop() || '未命名.md', String(text || ''))
    showToast('已导出 .md 到下载目录')
  }, [showToast])

  const currentNode = useCallback((): TreeNode | null => {
    const p = latest.current.currentPath
    return p ? { path: p, name: String(p).split('/').pop() || p, type: 'file' } : null
  }, [])

  const renameCurrent = useCallback(() => {
    const n = currentNode()
    if (n) void latest.current.renameNode(n)
    else showToast('请先打开一篇笔记')
  }, [currentNode, showToast])

  const deleteCurrent = useCallback(() => {
    const n = currentNode()
    if (n) void latest.current.deleteNode(n)
    else showToast('请先打开一篇笔记')
  }, [currentNode, showToast])

  const openShortcuts = useCallback(() => { setSettingsTab('shortcuts'); setSettingsOpen(true) }, [])
  const openAbout = useCallback(() => { setSettingsTab('about'); setSettingsOpen(true) }, [])

  const ctx: CommandContext = {
    editor: () => editorRef.current,
    setMode: setViewMode,
    toggleEditRead: () => setViewMode(latest.current.mode === 'reading' ? lastEditMode.current : 'reading'),
    openPalette: () => setPalette({ open: true, mode: 'commands' }),
    quickSwitch: () => setPalette({ open: true, mode: 'files' }),
    openSearch: () => setSidebar('search'),
    openFiles: () => setSidebar('files'),
    openOutline: () => setSidebar('outline'),
    openSync,
    openSettings,
    openHistory,
    openStorage,
    downloadMd,
    renameCurrent,
    deleteCurrent,
    openShortcuts,
    openAbout,
    saveAs,
    fetchNow: () => void fetchNow(),
    syncCurrent: () => void syncCurrent(),
    syncVaultNow: () => void syncVaultNow(),
    openWelcome: () => { setShowWelcome(true); setWelcomeStage(isFirstRun() ? 'vault' : 'home') },
    save: () => latest.current.saveNow(true),
    newFile: () => latest.current.newFile(),
    newFolder: () => latest.current.newFolder(),
    toggleTheme: () => updateSettings({ themeMode: 'manual', theme: latest.current.effectiveTheme === 'dark' ? 'light' : 'dark' }),
    zoom: (d) => updateSettings({ fontSize: Math.min(26, Math.max(11, latest.current.settings.fontSize + d)) }),
    toggleSidebar: () => setSidebarOpen((v) => !v),
    toggleRight: () => setRightOpen((v) => !v),
    toggleSyncScroll: () => {
      updateSettings({ syncScroll: !latest.current.settings.syncScroll })
      showToast(!latest.current.settings.syncScroll ? '已开启双向滚动同步' : '已关闭双向滚动同步')
    },
    insertDate: () => {
      const view = editorRef.current?.view
      if (view) ed.insertBlock(view, new Date().toISOString().slice(0, 10))
    },
    insertImage,
  }
  const commands = useMemo(() => buildCommands(ctx), [/* ctx is rebuilt per render; commands stay stable via ref */])
  commandsRef.current = commands

  // Run a command by id — driven by the native desktop menu / tray (see electron/main.cjs).
  const runCommandById = useCallback((id: string) => {
    const cmd = commandsRef.current.find((c) => c.id === id)
    if (cmd) { try { cmd.run() } catch (e) { console.error('[command]', id, e) } }
  }, [])

  /** A phone toolbar tap must not re-focus the editor (that pops the IME). */
  const mobileToolbarCommand = useCallback((id: string) => {
    runWithoutRefocus(() => runCommandById(id))
  }, [runCommandById])

  // Open a .md whose absolute path arrived from the OS (double-click / second instance).
  const openOsPath = useCallback(async (absPath: string) => {
    try {
      const vault = await bridge.getVault()
      const rel = vault && absPath.startsWith(vault)
        ? absPath.slice(vault.length).replace(/^[\\/]/, '')
        : ''
      const norm = rel.replace(/\\/g, '/')
      if (norm) await latest.current.loadFile(norm)
      else showToast('该文件不在当前笔记文件夹内：' + absPath)
    } catch { showToast('无法打开文件：' + absPath) }
  }, [showToast])

  // Bridge native desktop menu + OS file-open into the app.
  useEffect(() => {
    if (bridge.kind !== 'desktop') return
    const offCmd = bridge.onCommand?.(runCommandById)
    const offPath = bridge.onOpenPath?.(openOsPath)
    return () => { offCmd && offCmd(); offPath && offPath() }
  }, [runCommandById, openOsPath])

  // Global shortcuts work in every pane, not only inside CodeMirror.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (paletteOpenRef.current || settingsOpenRef.current || historyOpenRef.current || inputReq || confirmReq || saveChoiceReq || draftChoiceReq) {
        if (e.key === 'Escape' && (inputReq || confirmReq || saveChoiceReq || draftChoiceReq)) return
        return
      }
      const target = e.target as HTMLElement
      const inCm = !!target.closest?.('.cm-editor')
      const inField = !inCm && !!target.closest?.('input, textarea, select, [contenteditable="true"]')
      if (inField) return
      for (const cmd of commandsRef.current) {
        if (!cmd.shortcut || !matchShortcut(e, cmd.shortcut)) continue
        if (!inCm && (cmd.id === 'edit.indent' || cmd.id === 'edit.outdent')) continue
        e.preventDefault()
        e.stopPropagation()
        cmd.run()
        return
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [inputReq, confirmReq, saveChoiceReq, draftChoiceReq])

  /* -------------------------------------------------------------- misc */
  const paletteItems: PaletteItem[] = useMemo(() => {
    if (palette.mode === 'files') {
      return flattenTree(tree).map((f) => ({
        id: f.path, title: f.name.replace(/\.(md|markdown|txt)$/i, ''), subtitle: f.path,
        group: '笔记', icon: 'file', run: () => latest.current.loadFile(f.path),
      }))
    }
    const icons: Record<string, string> = {
      视图: 'split', 格式: 'bold', 编辑: 'edit', 文件: 'file', 导航: 'search', 应用: 'settings',
    }
    return commands.map((c) => ({
      id: c.id, title: c.name, group: c.group, shortcut: c.shortcut,
      icon: icons[c.group] || 'dot', run: c.run,
    }))
  }, [palette.mode, commands, tree])

  const fileActions = useMemo(() => ({
    onOpen: (p: string) => latest.current.loadFile(p),
    onNewFile: (d?: string) => latest.current.newFile(d),
    onNewFolder: (d?: string) => latest.current.newFolder(d),
    onRename: (n: TreeNode) => latest.current.renameNode(n),
    onDelete: (n: TreeNode) => latest.current.deleteNode(n),
    onPreviewAsset: (p: string) => {
      setPreviewAsset(p)
      // 纯源码模式下右侧预览被隐藏，双击图片时切回分屏才看得到。
      if (latest.current.mode === 'source') setViewMode('split')
    },
  }), [])

  /** Phone tree: single tap opens / previews, ⋯ always visible, and the ⋯
   *  routes to the bottom action sheet instead of a hover context menu. */
  const mobileFileActions = useMemo(() => ({
    ...fileActions,
    mobile: true,
    onOpen: (p: string) => void mobileOpenDoc(p),
    onNewFile: (d?: string) => void latest.current.newFile(d, true),
    onPreviewAsset: (p: string) => {
      setPreviewAsset(p)
      setMPane('read')
      setMEditorOpen(true)
    },
    onNodeMenu: (n: TreeNode) => setMSheet({ kind: 'node', node: n }),
  }), [fileActions, mobileOpenDoc])

  const startResize = (e: ReactMouseEvent) => {
    e.preventDefault()
    const rect = workspaceRef.current?.getBoundingClientRect()
    if (!rect) return
    const move = (ev: MouseEvent) => {
      const pct = ((ev.clientX - rect.left) / rect.width) * 100
      setSplitRatio(Math.min(78, Math.max(22, pct)))
    }
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up) }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const stats = useMemo(() => ed.wordStats(content), [content])
  const scopeLabel = settings.scope === 'vault' ? '整个仓库' : settings.scope === 'folder'
    ? (scopeValue(currentPath, 'folder') || '根目录（全部）') : (currentPath || '未打开文件')
  const cssVars = {
    '--editor-size': `${settings.fontSize}px`,
    '--preview-size': `${settings.fontSize + 1}px`,
  } as CSSProperties

  /**
   * Status bar LAN line: report whether a device is actually attached, not
   * whether the local Node service answers /health. `online` only means the
   * service is reachable; `presence` is the server's live socket census.
   */
  const lanState = (() => {
    if (!online) return {
      icon: 'wifiOff' as const, label: 'LAN 服务未启动',
      title: '本机同步服务不可访问；笔记仍可离线编辑',
    }
    if (!wsConnected) return {
      icon: 'wifiOff' as const, label: 'LAN 未连接',
      title: '实时通道未连接，暂时无法确认其它设备是否接入',
    }
    if (presence.count > 0) return {
      icon: 'wifi' as const, label: `LAN 已连接 ${presence.count} 台`,
      title: '已接入：' + presence.peers.map((p) => p.name + (p.ip ? `（${p.ip}）` : '')).join('、'),
    }
    return {
      icon: 'wifiOff' as const, label: 'LAN 未连接设备',
      title: '本机服务在线，但还没有其它设备接入局域网',
    }
  })()

  latest.current = {
    content, version, currentPath, dirty, settings, effectiveTheme, mode, tree, online,
    saveNow, guardUnsaved, loadFile, applyDoc, refreshTree, refreshInfo, refreshSyncStatus, restoreLastDoc, connect, boot,
    newFile, newFolder, renameNode, deleteNode, openWiki, jumpToLine,
    editorRef, setSidebar, openSync, openSettings, openHistory,
    syncCurrent, syncVaultNow, fetchNow,
    mTab, mEditorOpen, mPane, mSheet,
  }

  /* ------------------------------------------------ shared render slots
     Editor / Preview are single-instance components: both shells reuse the
     same JSX so CodeMirror is never remounted when the platform branch
     differs. Dialogs are shared for the same reason (their Promises must
     always stay mounted, including during boot). */
  const editorPane = (
    <Editor
      value={content} docKey={currentPath}
      onChange={onContentChange}
      onHistoryChange={onHistoryChange}
      onCursor={(line, col) => { setCursor({ line, col }); setActiveLine(line - 1) }}
      onScroll={() => { if (mode === 'split' && settings.syncScroll && !previewAsset) syncRef.current?.onEditorScroll() }}
      onClickJump={onEditorClick}
      onHandle={(h) => { editorRef.current = h }}
      fontSize={settings.fontSize}
      showLineNumbers={settings.showLineNumbers}
      onInsertImage={(file) => void insertImageFile(file)}
    />
  )
  const previewPane = (
    <Preview
      html={rendered.html} containerRef={previewRef}
      asset={previewAsset} onCloseAsset={() => setPreviewAsset(null)}
      onScroll={() => { if (mode === 'split' && settings.syncScroll && !previewAsset) syncRef.current?.onPreviewScroll() }}
      onTaskToggle={onTaskToggle} onWiki={openWiki} onJump={onPreviewJump}
    />
  )
  const mobileFileTree = (
    <FileTree
      tree={tree} currentPath={currentPath} vault={vaultName}
      showImgFolder={showImgFolder}
      imgDir={imgDir} imgAssets={imgAssets} activeAsset={previewAsset}
      scopeLabel={settings.scope !== 'vault' ? scopeLabel : undefined}
      sort={settings.treeSort} onSort={(v) => updateSettings({ treeSort: v })}
      actions={mobileFileActions}
    />
  )
  const mobileSearch = (
    <SearchPanel
      query={query} onQuery={setQuery} hits={hits} searching={searching}
      onOpen={(p, line) => { void mobileOpenDoc(p).then(() => window.setTimeout(() => jumpToLine(line), 90)) }}
    />
  )
  const overlays = (
    <>
      <CommandPalette
        open={palette.open}
        title={palette.mode === 'commands' ? '输入命令…' : '输入文件名快速切换…'}
        items={paletteItems}
        hideShortcuts={MOBILE}
        onClose={() => setPalette((p) => ({ ...p, open: false }))}
      />

      <SyncPanel
        open={settingsOpen} onClose={() => setSettingsOpen(false)}
        tab={settingsTab} onTab={setSettingsTab}
        online={online} wsConnected={wsConnected} info={info} devices={devices}
        settings={settings} onSettings={updateSettings}
        onReconnect={reconnect} onPair={pairWithCode} onPairLink={(raw) => void connectFromLink(raw)}
        onRefresh={() => { boot(); refreshInfo() }} onUnpair={unpair}
        commands={commands} scopeLabel={scopeLabel}
        stats={localStats}
        onOpenHistory={() => { setSettingsOpen(false); setHistoryOpen(true) }}
        onSyncCurrent={() => { setSettingsOpen(false); void syncCurrent() }}
        onSyncVault={() => { setSettingsOpen(false); void syncVaultNow() }}
        onFetch={() => { setSettingsOpen(false); void fetchNow() }}
        isDesktop={DESKTOP}
        currentPath={currentPath} currentContent={content} onToast={showToast}
        onVaultChanged={() => { void refreshInfo(); void refreshTree(); void refreshLocalStats() }}
        onChangeVault={openStorage}
      />

      <HistoryPanel
        open={historyOpen} onClose={() => setHistoryOpen(false)}
        path={currentPath} online={online} currentContent={content}
        isDesktop={DESKTOP} onApply={applyConverged} onGuard={guardUnsaved}
      />

      <InputDialog request={inputReq} onResolve={(v) => { setInputReq(null); inputResolver.current(v) }} />
      <ConfirmDialog request={confirmReq} onResolve={(v) => { setConfirmReq(null); confirmResolver.current(v) }} />
      <SaveChoiceDialog request={saveChoiceReq} onResolve={(v) => { setSaveChoiceReq(null); saveChoiceResolver.current(v) }} />
      <DraftChoiceDialog request={draftChoiceReq} onResolve={(v) => { setDraftChoiceReq(null); draftChoiceResolver.current(v) }} />
      <DiskChangeDialog request={diskChangeReq} onResolve={(v) => { setDiskChangeReq(null); diskChangeResolver.current(v) }} />
      <Toast toast={toast} onDismiss={dismissToast} />

      <input ref={imageInputRef} type="file" accept="image/*" hidden onChange={onImagePicked} />
      <CloseDialog
        open={closeAsk}
        hasTray={DESKTOP && hasSystemTray()}
        onResolve={(a) => { setCloseAsk(false); void resolveClose(a) }}
        onCancel={() => { setCloseAsk(false); void resolveClose('cancel') }}
      />
    </>
  )

  /* ------------------------------------------------------------- view */
  // There is no browser product. The static bundle is only a rendering layer
  // for the desktop / phone shells, which own a real local vault folder.
  if (isWebBrowser()) {
    return (
      <div className="app web-block" data-theme={effectiveTheme}>
        <div className="web-block-card">
          <Icon name="file" size={30} />
          <h1>请使用桌面应用或手机 App</h1>
          <p>笔记保存在你自己的本地仓库目录里，浏览器没有读写这个目录的权限，也不参与设备间同步。</p>
          <p>在电脑上运行 <code>npm run electron</code> 打开桌面版；手机 App 将在下一阶段提供。</p>
        </div>
      </div>
    )
  }

  // Fresh install: render ONLY the first-run screen. The editor, file tree and
  // all panels stay unmounted, so no stale note can show through a blurred
  // backdrop and no vault content is loaded before a folder is chosen.
  if (showWelcome) {
    return (
      <div className="app" data-theme={effectiveTheme}>
        <Welcome
          initialStage={welcomeStage}
          native={isNativeApp()}
          online={online}
          vaultName={vaultName}
          recents={recents}
          onSelectVault={async () => {
            if (isNativeApp()) {
              try {
                const v = await chooseVault()
                if (!v) return false
                // chooseVault() already persisted the config and broadcast
                // vault-changed; no second acceptVault() broadcast is needed.
                acceptedVaultRef.current = true
                if (isAndroidNative()) await latest.current.boot()
                await refreshInfo(); await refreshTree(); await refreshLocalStats()
                showToast('笔记文件夹已切换为「' + v.split(/[\\/]/).pop() + '」')
                return true
              } catch (e: any) {
                showToast('选择文件夹失败：' + (e?.message || '未知错误'))
                return false
              }
            }
            setSettingsOpen(true); setSettingsTab('sync'); refreshInfo()
            return true
          }}
          onListVaults={listVaults}
          vaultSort={settings.vaultSort}
          onVaultSort={(v) => updateSettings({ vaultSort: v })}
          onSelectVaultPath={async (p) => {
            try {
              const v = await selectVault(p)
              if (!v) return false
              acceptedVaultRef.current = true
              await refreshInfo(); await refreshTree(); await refreshLocalStats()
              showToast('笔记文件夹已切换为「' + v.split(/[\\/]/).pop() + '」')
              return true
            } catch (e: any) {
              showToast('切换仓库失败：' + (e?.message || '未知错误'))
              return false
            }
          }}
          onCreateVault={async () => {
            try {
              const v = await createVault()
              if (!v) return false
              acceptedVaultRef.current = true
              await refreshInfo(); await refreshTree(); await refreshLocalStats()
              showToast('已新建并切换到「' + v.split(/[\\/]/).pop() + '」')
              return true
            } catch (e: any) {
              showToast('新建仓库失败：' + (e?.message || '未知错误'))
              return false
            }
          }}
          onConnect={() => { setSettingsOpen(true); setSettingsTab('sync'); refreshInfo() }}
          onOpenFolder={() => { closeWelcome(); setSidebarOpen(true); setSidebarTab('files') }}
          onOpenFile={() => { closeWelcome(); setPalette({ open: true, mode: 'files' }) }}
          onNewFile={() => { closeWelcome(); void latest.current.newFile() }}
          onOpenRecent={(p) => { closeWelcome(); void loadFile(p) }}
          onRemoveRecent={(p) => removeRecent(p)}
          onClose={closeWelcome}
        />
        {/* After a keep-data reinstall boot() runs behind the start page, so
            pending dialogs (draft recovery / close confirmation) must still be
            rendered or their Promises would hang forever. */}
        <InputDialog request={inputReq} onResolve={(v) => { setInputReq(null); inputResolver.current(v) }} />
        <ConfirmDialog request={confirmReq} onResolve={(v) => { setConfirmReq(null); confirmResolver.current(v) }} />
        <SaveChoiceDialog request={saveChoiceReq} onResolve={(v) => { setSaveChoiceReq(null); saveChoiceResolver.current(v) }} />
        <DraftChoiceDialog request={draftChoiceReq} onResolve={(v) => { setDraftChoiceReq(null); draftChoiceResolver.current(v) }} />
        <DiskChangeDialog request={diskChangeReq} onResolve={(v) => { setDiskChangeReq(null); diskChangeResolver.current(v) }} />
        <Toast toast={toast} onDismiss={dismissToast} />
        <CloseDialog
          open={closeAsk}
          hasTray={DESKTOP && hasSystemTray()}
          onResolve={(a) => { setCloseAsk(false); void resolveClose(a) }}
          onCancel={() => { setCloseAsk(false); void resolveClose('cancel') }}
        />
      </div>
    )
  }

  /* Phone shell: a separate render tree. Desktop chrome (menu / ribbon /
     statusbar) is never mounted here, so no hover or Alt-mnemonic affordance
     leaks onto a touch screen. Shared overlays stay mounted below. */
  if (MOBILE) {
    const connected = online && wsConnected
    return (
      <div className="app mobile-app" data-theme={effectiveTheme}>
        <MobileShell
          tab={mTab} editorOpen={mEditorOpen} pane={mPane} sheet={mSheet}
          setTab={setMTab} setPane={setMPane} setSheet={setMSheet}
          title={currentPath ? (currentPath.split('/').pop() || '').replace(/\.(md|markdown|txt)$/i, '') : ''}
          dirty={dirty} currentPath={currentPath}
          onSave={() => void saveNow(true)}
          onSync={() => void syncCurrent()} onFetch={() => void fetchNow()}
          onBack={() => {
            if (!dirty) { setMEditorOpen(false); return }
            void confirm('当前笔记还没保存，仍要返回吗？').then((yes) => {
              if (yes) setMEditorOpen(false)
            })
          }}
          fileTree={mobileFileTree} searchPanel={mobileSearch}
          editorPane={editorPane} previewPane={previewPane} cssVars={cssVars}
          actions={mobileFileActions}
          toolbar={settings.toolbarCommands}
          onCommand={mobileToolbarCommand} onUndo={mobileUndo} onRedo={mobileRedo}
          canUndo={historyDepth.undo > 0} canRedo={historyDepth.redo > 0}
          onInsertImage={insertImage}
          onOpenPalette={() => setPalette({ open: true, mode: 'commands' })}
          onOpenSettings={openSettings} onOpenHistory={openHistory}
          onOpenToolbarSettings={openToolbarSettings}
          onPinFocus={pinEditorFocus}
          lanLabel={lanState.label} connected={connected}
          updates={syncStatus.updates} queued={syncStatus.queued}
          connect={{
            connected, online, wsConnected,
            base: settings.syncTarget || getBase(),
            devices, updates: syncStatus.updates, queued: syncStatus.queued,
            onScan: () => void mobileScan(),
            onConnectLink: (raw) => void connectFromLink(raw),
            onPaste: mobilePaste,
            onManual: (b, c) => void mobileManual(b, c),
            onSyncCurrent: () => void syncCurrent(),
            onSyncVault: () => void syncVaultNow(),
            onFetch: () => void fetchNow(),
            onOpenHistory: openHistory,
            onToast: showToast,
          }}
          settings={{
            vaultName, theme: effectiveTheme, themeMode: settings.themeMode,
            fontSize: settings.fontSize,
            showLineNumbers: settings.showLineNumbers,
            onThemeMode: (mode) => updateSettings(mode === 'system'
              ? { themeMode: 'system' }
              : { themeMode: 'manual', theme: mode }),
            onToggleTheme: () => updateSettings({ themeMode: 'manual', theme: effectiveTheme === 'dark' ? 'light' : 'dark' }),
            onFontSize: (d) => updateSettings({ fontSize: Math.min(26, Math.max(11, settings.fontSize + d)) }),
            onLineNumbers: () => updateSettings({ showLineNumbers: !settings.showLineNumbers }),
            onChooseVault: () => void mobileChooseVault(),
            onOpenHistory: openHistory,
            onExportLog: () => void mobileExportLog(),
            onOpenAbout: openAbout,
          }}
        />
        {overlays}
      </div>
    )
  }

  return (
    <div className="app" data-theme={effectiveTheme}>
      <MenuBar commands={commands} />

      <header className="titlebar">
        <div className="tb-left">
          <button className="icon-btn" title="切换侧边栏 (Ctrl+Alt+B)" onClick={() => setSidebarOpen((v) => !v)}>
            <Icon name="panelLeft" size={17} />
          </button>
          <div className="doc-title" title={currentPath}>
            <Icon name="file" size={14} />
            <span>{currentPath ? currentPath.split('/').pop()?.replace(/\.(md|markdown|txt)$/i, '') : 'Lumen Notes'}</span>
            {dirty && <i className="dirty-dot" title="未保存" />}
            {dirty && <span className="unsaved-tag">未保存</span>}
          </div>
        </div>

        <div className="tb-right">
          <button
            className={`sync-top-btn${syncStatus.queued ? ' has-flag' : ''}`}
            onClick={() => void syncCurrent()}
            data-tip={`同步当前笔记到本设备云仓库 (${formatShortcut('Mod+Alt+S')})`}
          >
            <Icon name="sync" size={14} /><span>同步</span>
            {syncStatus.queued > 0 && <i className="btn-dot" />}
          </button>
          <button
            className={`sync-top-btn${syncStatus.updates ? ' has-flag' : ''}`}
            onClick={() => void fetchNow()}
            data-tip={`拉取：整仓收敛，两端云仓库对齐 (${formatShortcut('Mod+Alt+P')})`}
          >
            <Icon name="fetch" size={14} /><span>拉取</span>
            {syncStatus.updates > 0 && <i className="btn-dot" />}
          </button>
          <button
            className={`save-btn ${dirty ? 'pending' : ''}`}
            disabled={!dirty} onClick={() => void saveNow(true)}
            data-tip={`保存当前笔记到本地仓库 (${formatShortcut('Mod+S')})`}
          >
            保存
          </button>
        </div>
      </header>

      <DesktopToolbar
        toolbar={settings.toolbarCommands}
        onCommand={runCommandById} onUndo={mobileUndo} onRedo={mobileRedo}
        canUndo={historyDepth.undo > 0} canRedo={historyDepth.redo > 0}
        onInsertImage={insertImage}
        onMore={() => setPalette({ open: true, mode: 'commands' })}
        onCustomize={openToolbarSettings}
      />

      <div className="body">
        <nav className="ribbon desktop-flex">
          <button className={mode === 'source' ? 'active' : ''} title="仅源码" onClick={() => setViewMode('source')}><Icon name="edit" size={18} /></button>
          <button className={mode === 'split' ? 'active' : ''} title="分屏：源码 + 阅读" onClick={() => setViewMode('split')}><Icon name="split" size={18} /></button>
          <button className={mode === 'reading' ? 'active' : ''} title="仅阅读" onClick={() => setViewMode('reading')}><Icon name="book" size={18} /></button>
          <div className="ribbon-sep" />
          <button title="新建笔记" onClick={() => newFile()}><Icon name="plus" size={18} /></button>
          <div className="ribbon-sep" />
          <button title={`命令面板 (${formatShortcut('Mod+P')})`} onClick={() => setPalette({ open: true, mode: 'commands' })}><Icon name="command" size={18} /></button>
          <button className={syncStatus.queued ? 'has-flag' : ''} data-tip={`同步当前笔记到本设备云仓库 (${formatShortcut('Mod+Alt+S')})`} onClick={() => void syncCurrent()}><Icon name="sync" size={18} />{syncStatus.queued > 0 && <i className="btn-dot" />}</button>
          <button data-tip="全仓同步：把本地仓库全部笔记发布到本设备云仓库" onClick={() => void syncVaultNow()}><Icon name="vault" size={18} /></button>
          <button className={syncStatus.updates ? 'has-flag' : ''} data-tip={`拉取云仓库更新 (${formatShortcut('Mod+Alt+P')})`} onClick={() => void fetchNow()}><Icon name="fetch" size={18} />{syncStatus.updates > 0 && <i className="btn-dot" />}</button>
          <button title="历史版本" onClick={openHistory}><Icon name="history" size={18} />{syncStatus.updates > 0 && <i className="btn-dot" />}</button>
          <button title="局域网同步与扫码" onClick={openSync}><Icon name="qr" size={18} /></button>
          <button title="偏好设置" onClick={openSettings}><Icon name="settings" size={18} /></button>
          <button title="切换主题" onClick={() => updateSettings({ themeMode: 'manual', theme: effectiveTheme === 'dark' ? 'light' : 'dark' })}>
            <Icon name={effectiveTheme === 'dark' ? 'sun' : 'moon'} size={18} />
          </button>
          <button title="右侧大纲栏" onClick={() => setRightOpen((v) => !v)}><Icon name="panelRight" size={18} /></button>
          <div className="ribbon-spacer" />
        </nav>

        {sidebarOpen && (
          <>
            <div className="sidebar-scrim" onClick={() => setSidebarOpen(false)} />
            <Sidebar tab={sidebarTab} onTab={setSidebarTab}>
              {sidebarTab === 'files' && (
                <FileTree
                  tree={tree} currentPath={currentPath} vault={vaultName}
                  showImgFolder={showImgFolder}
                  imgDir={imgDir} imgAssets={imgAssets} activeAsset={previewAsset}
                  scopeLabel={settings.scope !== 'vault' ? scopeLabel : undefined}
                  sort={settings.treeSort} onSort={(v) => updateSettings({ treeSort: v })}
                  actions={fileActions}
                />
              )}
              {sidebarTab === 'outline' && <Outline headings={rendered.headings} activeLine={activeLine} onJump={jumpToLine} />}
              {sidebarTab === 'search' && (
                <SearchPanel
                  query={query} onQuery={setQuery} hits={hits} searching={searching}
                  onOpen={(p, line) => { loadFile(p).then(() => window.setTimeout(() => jumpToLine(line), 90)) }}
                />
              )}
            </Sidebar>
          </>
        )}

        <main className={`workspace mode-${mode}`} ref={workspaceRef} style={cssVars}>
          {!currentPath && (
            <div className="workspace-empty">
              <Icon name="file" size={30} />
              <h2>这个仓库还没有笔记</h2>
              <p>新建笔记后，内容将以 .md 文件保存在仓库中。</p>
              <button className="workspace-empty-btn" onClick={() => void newFile()}>新建笔记</button>
            </div>
          )}
          <div
            className={`pane source-pane ${mode === 'reading' ? 'pane-hidden' : ''}`}
            style={mode === 'split' ? { flexBasis: `${splitRatio}%` } : undefined}
          >
            {editorPane}
          </div>

          <div className="resizer" onMouseDown={startResize} title="拖动调整分屏比例"><span /></div>

          <div className={`pane preview-pane ${mode === 'source' ? 'pane-hidden' : ''}`}>
            {previewPane}
          </div>
        </main>

        {rightOpen && (
          <aside className="rightbar desktop-flex">
            <Outline headings={rendered.headings} activeLine={activeLine} onJump={jumpToLine} />
          </aside>
        )}
      </div>

      <footer className="statusbar">
        <div className="sb-left">
          <span><Icon name="file" size={12} /> {currentPath || '未打开'}</span>
          <span>{stats.words} 词 · {stats.chars} 字符</span>
        </div>
        <div className="sb-right">
          <span>Ln {cursor.line}, Col {cursor.col}</span>
          <span>{mode === 'split' ? '分屏预览' : mode === 'source' ? '源码模式' : '阅读模式'}</span>
          <span className={dirty ? 'unsaved' : ''}>{dirty ? '● 未保存' : '已保存'}</span>
          <span className="sb-service" title={lanState.title}>
            <Icon name={lanState.icon} size={12} />{lanState.label}
          </span>
          {syncStatus.queued > 0 && (
            <span className="sb-flag" title="离线登记的版本，连接后自动补推">待补推 {syncStatus.queued} 条</span>
          )}
          {syncStatus.updates > 0 && (
            <button className="sb-flag link" onClick={openHistory} title="拉取后有笔记需要选版本，点此打开历史版本">
              待处理 {syncStatus.updates} 篇
            </button>
          )}
          <span className="desktop-only">{settings.fontSize}px</span>
        </div>
      </footer>

      <nav className="mobile-bar">
        <button onClick={() => setSidebar('files')}><Icon name="files" size={19} /><span>文件</span></button>
        <button onClick={() => setSidebar('outline')}><Icon name="outline" size={19} /><span>大纲</span></button>
        <button className={mode === 'source' ? 'active' : ''} onClick={() => setViewMode('source')}><Icon name="edit" size={19} /><span>源码</span></button>
        <button className={mode === 'split' ? 'active' : ''} onClick={() => setViewMode('split')}><Icon name="split" size={19} /><span>分屏</span></button>
        <button className={mode === 'reading' ? 'active' : ''} onClick={() => setViewMode('reading')}><Icon name="book" size={19} /><span>阅读</span></button>
        <button onClick={() => void syncCurrent()}><Icon name="sync" size={19} /><span>同步</span></button>
      </nav>

      {overlays}

      {/* First-run screen is rendered by the early return above. */}
    </div>
  )
}
