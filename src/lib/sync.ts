/**
 * Transport layer. The web bundle never touches Node APIs: it only talks
 * REST + WebSocket over a configurable origin. That same bundle can later be
 * dropped into Electron / Capacitor, where the origin simply points at a
 * remote Lumen sync service instead of the local one.
 */
import type { AssetConflict, AssetInfo, BrowseResult, Device, DocMeta, SetStorageResult, StorageInfo, SyncInfo, TreeNode } from '../types'
import type { ConvergeConflict, ConvergeReport, ResolveItem, VersionState } from './vcs'

/** One published binary attachment (bytes travel over /api/asset, not JSON). */
export interface PeerAsset {
  path: string
  hash: string
  size: number
  mtime: number
  at?: number
}
export interface AssetTombstone { path: string; at: number; hash: string; deviceId: string }

/** Another device's cloud repo copy, published over REST while connected. */
export interface PeerCloud {
  deviceId: string
  deviceName: string
  at: number
  docs: { path: string; hash: string; content: string; at: number; baseHash: string }[]
  tombstones?: { path: string; at: number; deviceId: string }[]
  /** Absent on older clients: never treat that as "deleted every attachment". */
  hasAssets?: boolean
  assets?: PeerAsset[]
  assetTombstones?: AssetTombstone[]
}

const LS_BASE = 'lumen.base'
const LS_SESSION = 'lumen.session'
const LS_CLIENT = 'lumen.client'

// Guard browser globals so this module can also be imported by Node-side
// tooling / Electron main processes without a DOM shim.
const storage = {
  get(k: string): string | null {
    try { return typeof localStorage !== 'undefined' ? localStorage.getItem(k) : null }
    catch { return null }
  },
  set(k: string, v: string) {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(k, v) } catch { /* noop */ }
  },
  remove(k: string) {
    try { if (typeof localStorage !== 'undefined') localStorage.removeItem(k) } catch { /* noop */ }
  },
}

function defaultBase() {
  try { return location.origin && location.origin !== 'null' ? location.origin : 'http://localhost:18740' }
  catch { return 'http://localhost:18740' }
}

let base = storage.get(LS_BASE) || defaultBase()
let session = storage.get(LS_SESSION) || ''
export const clientId = (() => {
  let v = storage.get(LS_CLIENT)
  if (!v) { v = Math.random().toString(36).slice(2, 10); storage.set(LS_CLIENT, v) }
  return v
})()

export const getBase = () => base
/** Accept `192.168.1.10:2333`, `http://…`, `https://…` and return a clean origin. */
export function normalizeBase(v: string): string {
  const raw = String(v || '').trim()
  if (!raw) throw new Error('请输入服务器地址')
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`
  let u: URL
  try { u = new URL(withScheme) } catch { throw new Error('地址格式不正确，例如 192.168.1.10:2333') }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('只支持 http / https 地址')
  if (!u.hostname) throw new Error('地址缺少主机名')
  return u.origin
}
export function setBase(v: string) {
  base = v.replace(/\/+$/, '') || defaultBase()
  storage.set(LS_BASE, base)
}
export const getSession = () => session
export function setSession(v: string) {
  session = v
  if (v) storage.set(LS_SESSION, v)
  else storage.remove(LS_SESSION)
}

function url(p: string) {
  return `${base}/${p.replace(/^\/+/, '')}`
}
/** Per-process credential for the shell served by THIS sync service. Fetched
 *  at runtime (never cached by the service worker, never put in localStorage),
 *  so it rotates whenever the service restarts. Paired LAN devices use their
 *  session instead; a foreign web page can obtain neither. */
let shellToken = ''
async function primeShellToken() {
  if (shellToken) return
  try {
    const res = await fetch(url('api/shell-token'), { headers: headers() })
    if (res.ok) {
      const d = await res.json().catch(() => ({}))
      shellToken = String(d?.token || '')
    }
  } catch { /* offline or remote shell: retry on the next socket attempt */ }
}
function wsUrl() {
  const u = new URL(base)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  u.pathname = '/ws'
  // The socket's own device id lets the server tell a live peer from a stale
  // /api/versions/publish entry (a device that went offline must not converge).
  const params = new URLSearchParams()
  params.set('clientId', clientId)
  if (session) params.set('session', session)
  if (shellToken) params.set('shell', shellToken)
  u.search = params.toString()
  return u.toString()
}
function headers(extra: Record<string, string> = {}) {
  return { 'Content-Type': 'application/json', 'X-Lumen-Session': session, 'X-Lumen-Client': clientId, ...extra }
}

async function request<T>(p: string, init: RequestInit = {}, timeout = 6000): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    const res = await fetch(url(p), { ...init, headers: headers(init.headers as any || {}), signal: ctrl.signal })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw Object.assign(new Error((data as any).error || `HTTP ${res.status}`), { status: res.status, data })
    return data as T
  } finally { clearTimeout(timer) }
}

/** Raw binary transport. Callers MUST set Content-Type to octet-stream so the
 *  server's express.raw() middleware picks the body up instead of express.json. */
async function rawFetch(p: string, init: RequestInit = {}, timeout = 60000): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeout)
  try {
    const res = await fetch(url(p), { ...init, headers: headers(init.headers as any || {}), signal: ctrl.signal })
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      throw Object.assign(new Error((data as any).error || `HTTP ${res.status}`), { status: res.status })
    }
    return res
  } finally { clearTimeout(timer) }
}
const binaryHeaders = { 'Content-Type': 'application/octet-stream' }
const toBuffer = async (data: Blob | ArrayBuffer) =>
  data instanceof ArrayBuffer ? data : await data.arrayBuffer()

export const api = {
  async health(): Promise<boolean> {
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 1800)
      const res = await fetch(url('health'), { signal: ctrl.signal, cache: 'no-store' })
      clearTimeout(t)
      return res.ok
    } catch { return false }
  },
  info: () => request<SyncInfo>('api/info'),
  /** Fire-and-forget renderer log; callers must swallow failures. */
  log: (level: 'info' | 'warn' | 'error', tag: string, message: string, extra?: string) =>
    request<{ ok: boolean }>('api/logs', {
      method: 'POST', body: JSON.stringify({ level, tag, message, extra }),
    }),
  /** Build a diagnostic report on disk; returns its primary path and fallback copy. */
  report: () => request<{ path: string; copy: string | null; degraded: boolean; name: string }>(
    'api/report', { method: 'POST', body: '{}' }, 20000,
  ),
  pair: (token: string, name: string) =>
    request<{ session: string; device: Device; pairToken: string }>('api/pair', {
      method: 'POST', body: JSON.stringify({ token, name }),
    }),
  devices: () => request<{ devices: Device[] }>('api/devices'),
  unpair: (id: string) => request<{ ok: boolean }>(`api/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  tree: (scope = '') => request<{ tree: TreeNode[]; vault: string }>(`api/tree?scope=${encodeURIComponent(scope)}`),
  /** Cheap content-fingerprint inventory; a fetch only transfers differing files. */
  manifest: (scope = '') => request<{ files: { path: string; hash: string; size: number; mtime: number }[]; vault: string }>(`api/manifest?scope=${encodeURIComponent(scope)}`),
  file: (path: string) => request<DocMeta>(`api/file?path=${encodeURIComponent(path)}`),
  /**
   * `silent` is used when converging a peer's result: the .md still has to be
   * written, but broadcasting it as a fresh user edit would make the other
   * device show a misleading "仓库有文件更新，点拉取" hint right after 拉取.
   */
  save: (path: string, content: string, version: number, baseHash: string, force = false, silent = false) =>
    request<DocMeta>(`api/file?path=${encodeURIComponent(path)}`, {
      method: 'PUT', body: JSON.stringify({ content, version, baseHash, force, silent }),
    }),
  /** Explicit single-file sync: push the currently open note to the other side. */
  push: (path: string, content: string, baseHash: string, force = true) =>
    request<DocMeta & { pushed?: boolean; peers?: number }>('api/push', {
      method: 'POST', body: JSON.stringify({ path, content, baseHash, force }),
    }),
  history: (path: string) =>
    request<{ versions: any[] }>(`api/history?path=${encodeURIComponent(path)}`),
  historyContent: (id: string) =>
    request<any>(`api/history/content?id=${encodeURIComponent(id)}`),
  restoreHistory: (id: string) =>
    request<DocMeta>('api/history/restore', { method: 'POST', body: JSON.stringify({ id }) }),
  deleteHistory: (id: string) =>
    request<{ ok: boolean }>(`api/history?id=${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /* ------------------------------------- 本地仓库 / 本设备云仓库的版本 */
  versions: (path: string) =>
    request<VersionState>(`api/versions?path=${encodeURIComponent(path)}`),
  versionCommit: (body: {
    path: string; content: string; message?: string; reason?: string
  }) => request<{ state: VersionState; skipped: boolean }>('api/versions/commit', {
    method: 'POST', body: JSON.stringify(body),
  }),
  versionSync: (body: { path: string; content: string; deviceId?: string }) =>
    request<{ state: VersionState; skipped: boolean }>('api/versions/sync', {
      method: 'POST', body: JSON.stringify(body),
    }),
  /** 连接成功后，把本设备云仓库发布给对端。 */
  versionPublish: (body: {
    deviceId: string; deviceName: string
    docs: { path: string; hash: string; content: string; at: number; baseHash: string }[]
    tombstones?: { path: string; at: number; deviceId: string }[]
    assets?: PeerAsset[]
    assetTombstones?: AssetTombstone[]
  }) => request<{ ok: boolean; count: number }>('api/versions/publish', {
    method: 'POST', body: JSON.stringify(body),
  }),
  versionPeers: () => request<{ peers: PeerCloud[] }>('api/versions/peers'),
  versionTombstones: () =>
    request<{ tombstones: { path: string; at: number; deviceId: string }[] }>('api/versions/tombstones'),
  /** 拉取：整仓收敛扫描，自动处理无争议项，返回需要选版本的差异。 */
  versionConverge: (selfId: string) =>
    request<{
      report: ConvergeReport; conflicts: ConvergeConflict[]
      assetConflicts: AssetConflict[]; peerCount: number
    }>('api/versions/converge', { method: 'POST', body: JSON.stringify({ selfId }) }, 30000),
  /** 用户在分屏里选定版本：写回 .md、推进基线、广播给对端。 */
  versionResolve: (body: {
    selfId: string; items: ResolveItem[]
    assets?: { path: string; choice: 'local' | 'peer' | 'delete' }[]
  }) => request<{
    results: { path: string; ok: boolean; action?: string; error?: string }[]
    assetResults?: { path: string; ok: boolean; action?: string; error?: string }[]
  }>('api/versions/resolve', { method: 'POST', body: JSON.stringify(body) }),
  /**
   * 手机 App 在自己设备上完成收敛后，只把「结果」交给邮局：对齐对端云仓库
   * 快照 + 广播让对端自己 apply。服务端绝不替任何设备写 .md。
   */
  versionNotify: (body: {
    selfId: string; selfName: string
    items: { path: string; action: 'write' | 'delete'; content?: string }[]
    aligns?: { path: string; content: string; hash: string; baseHash: string }[]
    tombstones?: string[]
  }) => request<{ ok: boolean }>('api/versions/notify', {
    method: 'POST', body: JSON.stringify(body),
  }),
  create: (path: string, content = '') =>
    request<{ path: string }>('api/file', { method: 'POST', body: JSON.stringify({ path, content }) }),
  mkdir: (path: string) => request<{ ok: boolean }>('api/folder', { method: 'POST', body: JSON.stringify({ path }) }),
  rename: (path: string, newPath: string) =>
    request<{ ok: boolean; path: string }>('api/file', { method: 'PATCH', body: JSON.stringify({ path, newPath }) }),
  remove: (path: string) => request<{ ok: boolean }>(`api/file?path=${encodeURIComponent(path)}`, { method: 'DELETE' }),
  storage: () => request<StorageInfo>('api/storage'),
  browse: (p = '') => request<BrowseResult>(`api/storage/browse?path=${encodeURIComponent(p)}`),
  setStorage: (p: string, migrate: boolean) =>
    request<SetStorageResult>('api/storage', { method: 'POST', body: JSON.stringify({ path: p, migrate }) }),
  asset: (p: string) => assetUrl(p),

  /* ------------------------------------------------- 附件 / binary transport */
  /** Inventory of img/ in this vault, plus deletion markers to publish. */
  assets: () => request<{ assets: AssetInfo[]; tombstones: AssetTombstone[] }>('api/assets', {}, 30000),
  assetDownload: async (p: string): Promise<ArrayBuffer> => {
    const res = await rawFetch(`api/asset?path=${encodeURIComponent(p)}`, { headers: binaryHeaders })
    return res.arrayBuffer()
  },
  /** Pull bytes another device published (used when converging on a phone). */
  assetPeerDownload: async (p: string, deviceId = ''): Promise<ArrayBuffer> => {
    const q = `api/asset/peer?path=${encodeURIComponent(p)}&deviceId=${encodeURIComponent(deviceId)}`
    const res = await rawFetch(q, { headers: binaryHeaders })
    return res.arrayBuffer()
  },
  /** Insert an image into img/ and return its final vault-relative path. */
  assetUpload: async (p: string, data: Blob | ArrayBuffer) => {
    const res = await rawFetch(`api/asset?path=${encodeURIComponent(p)}`, {
      method: 'PUT', body: await toBuffer(data), headers: binaryHeaders,
    })
    return res.json() as Promise<AssetInfo>
  },
  /** Publish bytes for this device's cloud snapshot (post office, memory only). */
  assetPeerUpload: async (p: string, data: Blob | ArrayBuffer, deviceId: string, mtime = 0) => {
    const q = `api/asset/peer?path=${encodeURIComponent(p)}&deviceId=${encodeURIComponent(deviceId)}&mtime=${mtime}`
    const res = await rawFetch(q, { method: 'PUT', body: await toBuffer(data), headers: binaryHeaders })
    return res.json() as Promise<{ ok: boolean; path: string; hash: string; size: number }>
  },
  assetRemove: (p: string) =>
    request<{ ok: boolean; alreadyGone?: boolean }>(`api/asset?path=${encodeURIComponent(p)}`, { method: 'DELETE' }),
}

/**
 * Markdown-it already percent-encodes a link target (中文 → %E4%B8%AD...).
 * Decode once before re-encoding, otherwise /raw receives %25E4... and 404s.
 */
function normalizeAssetPath(p: string) {
  const raw = String(p || '')
  try { return decodeURIComponent(raw) } catch { return raw }
}

/**
 * URL for a path that is already the real on-disk vault path. Encodes exactly
 * once: decoding here would corrupt file names that literally contain `%xx`.
 * /raw is authenticated for non-loopback peers; an <img> cannot send headers,
 * so a paired session travels in the query instead (sessionFrom reads it).
 */
export const assetDiskUrl = (p: string) =>
  `${base}/raw?path=${encodeURIComponent(p)}${session ? `&session=${encodeURIComponent(session)}` : ''}`

/** Absolute URL for vault attachments, valid even when the shell points at a remote server. */
export const assetUrl = (p: string) => assetDiskUrl(normalizeAssetPath(p))

/** A device currently attached to the LAN sync service (not a pairing record). */
export interface PeerInfo { id: string; name: string; ip: string }
export interface PresenceInfo { peers: PeerInfo[]; count: number }

export interface SyncHandlers {
  onStatus?: (online: boolean) => void
  onFile?: (msg: { path: string; content: string; version: number; mtime: number; origin?: string }) => void
  /** Explicit push from the other device; accepted even in manual sync mode. */
  onPush?: (msg: { path: string; content: string; version: number; mtime: number; from?: string; reason?: string }) => void
  onTree?: () => void
  onDevices?: (devices: Device[]) => void
  /** Live LAN peers changed (connect / disconnect), sourced from the server. */
  onPresence?: (info: PresenceInfo) => void
  /** A commit was added to a cloud chain (by us or by the other device). */
  onVcs?: (msg: { path: string }) => void
  /** 对端完成了版本收敛：写入本设备本地仓库并刷新界面。 */
  onConverge?: (msg: {
    origin: string; clientId: string; at: number
    items: { path: string; action: 'write' | 'delete'; content?: string }[]
  }) => void
  onVault?: (msg: { vault: string; name: string; previous: string }) => void
  onCursor?: (msg: any) => void
  onUnpaired?: () => void
  // 服务端文件监视降级（如 inotify 满）：外部改动不再自动同步。
  onWatcherDegraded?: (message: string) => void
}

export function connectSync(handlers: SyncHandlers) {
  let ws: WebSocket | null = null
  let closed = false
  let retry: number | undefined
  let scope = ''
  /** A removed session is permanent until the user pairs again. The server
   *  sends `unpaired` on every reconnect, so notify only once per connection. */
  let unpairedNotified = false

  const open = () => {
    if (closed) return
    try { ws = new WebSocket(wsUrl()) } catch { schedule(); return }
    ws.onopen = () => {
      handlers.onStatus?.(true)
      if (scope) send({ type: 'subscribe', scope })
    }
    const presence = (msg: any): PresenceInfo => {
      const peers: PeerInfo[] = Array.isArray(msg?.peers) ? msg.peers : []
      return { peers, count: Number(msg?.count) || peers.length }
    }
    ws.onmessage = (ev) => {
      let msg: any
      try { msg = JSON.parse(ev.data) } catch { return }
      switch (msg.type) {
        case 'file': handlers.onFile?.(msg); break
        case 'pushFile': handlers.onPush?.(msg); break
        case 'tree': handlers.onTree?.(); break
        case 'devices': handlers.onDevices?.(msg.devices || []); break
        case 'presence': handlers.onPresence?.(presence(msg)); break
        case 'vcs': handlers.onVcs?.(msg); break
        case 'converge': handlers.onConverge?.(msg); break
        case 'vault': handlers.onVault?.(msg); break
        case 'cursor': case 'focus': handlers.onCursor?.(msg); break
        case 'watcher-degraded': handlers.onWatcherDegraded?.(String(msg.message || '')); break
        case 'unpaired':
          if (!unpairedNotified) { unpairedNotified = true; handlers.onUnpaired?.() }
          break
        case 'hello':
          handlers.onDevices?.(msg.devices || [])
          if (msg.presence) handlers.onPresence?.(presence(msg.presence))
          break
      }
    }
    ws.onclose = (ev) => { handlers.onStatus?.(false); schedule(ev?.code === 4001) }
    ws.onerror = () => { try { ws?.close() } catch { /* noop */ } }
  }
  const schedule = (unpaired = false) => {
    if (closed || retry) return
    // A deleted session cannot heal itself; retry slowly so we do not spin
    // a reconnect every 2.2s (and re-signal the same state) until re-pairing.
    retry = window.setTimeout(() => { retry = undefined; attempt() }, unpaired ? 10000 : 2200)
  }
  const send = (obj: any) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj))
  }
  /** The shell token must be in hand BEFORE the socket is created: the
   *  upgrade request carries it and a credential-less loopback socket is
   *  refused. Failures fall through to open() so retries still run. */
  const attempt = () => {
    if (closed) return
    void primeShellToken().then(() => { if (!closed) open() })
  }
  attempt()
  return {
    subscribe(next: string) { scope = next; send({ type: 'subscribe', scope: next }) },
    cursor(path: string, line: number) { send({ type: 'cursor', path, line, from: clientId }) },
    send,
    refresh() { unpairedNotified = false; try { ws?.close() } catch { /* noop */ } },
    close() { closed = true; if (retry) clearTimeout(retry); try { ws?.close() } catch { /* noop */ } },
  }
}
export type SyncConnection = ReturnType<typeof connectSync>
