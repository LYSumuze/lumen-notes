/**
 * Local-first storage. Every device keeps a full working copy of the vault in
 * IndexedDB, so editing works with no server at all. Each doc carries sync
 * metadata (baseHash / synced / remote) that the sync engine uses to decide
 * whether a change can be pushed safely or needs a manual direction choice.
 */
import { fnv1a } from './hash'
import type { VcsState } from './vcs'

const DB_NAME = 'lumen-notes'
const VERSION = 3
// IDB 的 history 缓存只作本机兜底：未显式传 limit 的调用默认留 5 条。
// 版本时间线由 vcs.ts 的 VERSION_LIMIT=15 控制，两处互不影响；
// 保留次数已固定，不再有可调设置。
const MAX_HISTORY_PER_FILE = 5
/* Auto-save was removed: every explicit save gets its own history entry. */

export interface LocalDoc {
  path: string
  content: string
  version: number
  mtime: number
  /** Content hash at the moment this doc last agreed with the server. */
  baseHash: string
  /** false = the local copy still has changes the server does not have. */
  synced: boolean
  /** Set when a real three-way conflict was detected; holds the server copy. */
  remote?: { content: string; version: number; mtime: number } | null
}

export interface HistoryEntry {
  id: string
  path: string
  content: string
  mtime: number
  version: number
  source: 'local' | 'server'
  reason: string
  chars: number
}

let dbPromise: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION)
    req.onupgradeneeded = (ev) => {
      const db = req.result
      let docs: IDBObjectStore
      if (!db.objectStoreNames.contains('docs')) {
        docs = db.createObjectStore('docs', { keyPath: 'path' })
      } else {
        docs = req.transaction!.objectStore('docs')
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' })
      }
      if (!db.objectStoreNames.contains('history')) {
        const h = db.createObjectStore('history', { keyPath: 'id' })
        h.createIndex('byPath', 'path', { unique: false })
        h.createIndex('byTime', 'mtime', { unique: false })
      }
      // v3: offline version-chain commits waiting to be pushed, plus a cache
      // of the last server state so the panel still works with no connection.
      if (!db.objectStoreNames.contains('vcsQueue')) {
        const q = db.createObjectStore('vcsQueue', { keyPath: 'id' })
        q.createIndex('byPath', 'path', { unique: false })
      }
      if (!db.objectStoreNames.contains('vcsCache')) {
        db.createObjectStore('vcsCache', { keyPath: 'path' })
      }
      // v1 -> v2: old docs had no sync metadata.
      if ((ev as IDBVersionChangeEvent).oldVersion < 2 && db.objectStoreNames.contains('docs')) {
        const cursor = docs.openCursor()
        cursor.onsuccess = () => {
          const row = cursor.result
          if (!row) return
          const d = row.value as any
          if (d.baseHash === undefined) {
            d.baseHash = fnv1a(String(d.content || ''))
            d.synced = false
            d.remote = null
            row.update(d)
          }
          row.continue()
        }
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('数据库升级被其它标签页占用，请关闭其它 Lumen Notes 页面后刷新'))
  })
  return dbPromise
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode)
        const req = fn(t.objectStore(store))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
  )
}

const makeId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`

export const db = {
  listDocs: () => tx<LocalDoc[]>('docs', 'readonly', (s) => s.getAll() as IDBRequest<LocalDoc[]>),
  getDoc: (path: string) => tx<LocalDoc | undefined>('docs', 'readonly', (s) => s.get(path) as IDBRequest<LocalDoc | undefined>),
  putDoc: (doc: LocalDoc) => tx<IDBValidKey>('docs', 'readwrite', (s) => s.put(doc)),
  deleteDoc: (path: string) => tx<undefined>('docs', 'readwrite', (s) => s.delete(path) as unknown as IDBRequest<undefined>),
  clearDocs: () => tx<undefined>('docs', 'readwrite', (s) => s.clear() as unknown as IDBRequest<undefined>),
  /**
   * 切换仓库时把本设备的全部工作副本/缓存清干净。IDB 只是上一仓库的镜像，
   * 留着 vcsQueue / vcsCache / history / 待处理冲突会把旧仓库的路径带进新仓库。
   */
  async clearVaultCache(): Promise<void> {
    const stores = ['docs', 'vcsQueue', 'vcsCache', 'history', 'settings']
    const idb = await open()
    await new Promise<void>((resolve, reject) => {
      const t = idb.transaction(stores, 'readwrite')
      stores.forEach((name) => t.objectStore(name).clear())
      t.oncomplete = () => resolve()
      t.onerror = () => reject(t.error)
    })
  },

  getSetting: <T>(key: string, fallback: T): Promise<T> =>
    tx<any>('settings', 'readonly', (s) => s.get(key)).then((r) => (r ? (r.value as T) : fallback)).catch(() => fallback),
  setSetting: (key: string, value: unknown) => tx<IDBValidKey>('settings', 'readwrite', (s) => s.put({ key, value })),

  /** Offline version queue + last known local/cloud state. */
  vcsQueuePut: (item: {
    id: string; path: string; source: 'local' | 'cloud'; content: string;
    message: string; reason: string; at: number; deviceId?: string
  }) => tx<IDBValidKey>('vcsQueue', 'readwrite', (s) => s.put(item)),
  vcsQueueList: (path?: string) =>
    tx<any[]>('vcsQueue', 'readonly', (s) => s.getAll() as IDBRequest<any[]>)
      .then((rows) => (path ? rows.filter((r) => r.path === path) : rows).sort((a, b) => a.at - b.at)),
  vcsQueueRemove: (ids: string[]) =>
    open().then((idb) => new Promise<void>((resolve, reject) => {
      const t = idb.transaction('vcsQueue', 'readwrite')
      const s = t.objectStore('vcsQueue')
      ids.forEach((id) => s.delete(id))
      t.oncomplete = () => resolve()
      t.onerror = () => reject(t.error)
    })),
  vcsCacheGet: (path: string) =>
    tx<any>('vcsCache', 'readonly', (s) => s.get(path) as IDBRequest<any>).then((r) => r?.state as VcsState | undefined),
  vcsCachePut: (path: string, state: VcsState) =>
    tx<IDBValidKey>('vcsCache', 'readwrite', (s) => s.put({ path, state })),

  /** All versions for one file, newest first. */
  listHistory(path: string): Promise<HistoryEntry[]> {
    return open().then(
      (idb) =>
        new Promise<HistoryEntry[]>((resolve, reject) => {
          const t = idb.transaction('history', 'readonly')
          const idx = t.objectStore('history').index('byPath')
          const req = idx.getAll(IDBKeyRange.only(path))
          req.onsuccess = () => resolve((req.result as HistoryEntry[]).sort((a, b) => b.mtime - a.mtime))
          req.onerror = () => reject(req.error)
        })
    )
  },
  allHistory(): Promise<HistoryEntry[]> {
    return tx<HistoryEntry[]>('history', 'readonly', (s) => s.getAll() as IDBRequest<HistoryEntry[]>)
  },
  putHistory(entry: HistoryEntry) {
    return tx<IDBValidKey>('history', 'readwrite', (s) => s.put(entry))
  },
  deleteHistory(id: string) {
    return tx<undefined>('history', 'readwrite', (s) => s.delete(id) as unknown as IDBRequest<undefined>)
  },

  /** Record one snapshot. Every explicit save gets its own version. */
  async addHistory(input: Omit<HistoryEntry, 'id' | 'chars'> & { id?: string }, limit = MAX_HISTORY_PER_FILE): Promise<HistoryEntry> {
    const list = await db.listHistory(input.path)
    const entry: HistoryEntry = {
      ...input,
      id: input.id || makeId(),
      chars: input.content.length,
    }
    await db.putHistory(entry)
    if (list.length + 1 > limit) {
      const excess = list.slice(limit - 1)
      for (const e of excess) await db.deleteHistory(e.id)
    }
    return entry
  },

  /** Snapshot whatever is on disk right now, before an overwrite. */
  async snapshot(path: string, reason: string, source: HistoryEntry['source'] = 'local') {
    const doc = await db.getDoc(path)
    if (!doc) return
    await db.addHistory({
      path, content: doc.content, mtime: Date.now(), version: doc.version,
      source, reason,
    })
  },

  /** Write a doc and record its previous state as a history version. */
  async saveLocal(doc: LocalDoc, reason = '手动保存', source: HistoryEntry['source'] = 'local', limit = MAX_HISTORY_PER_FILE) {
    const prev = await db.getDoc(doc.path)
    if (prev && prev.content !== doc.content) {
      await db.addHistory({
        path: doc.path, content: prev.content, mtime: Date.now(), version: prev.version,
        source, reason,
      }, limit)
    } else if (!prev) {
      await db.addHistory({
        path: doc.path, content: doc.content, mtime: Date.now(), version: doc.version,
        source, reason: '新建笔记',
      }, limit)
    }
    await db.putDoc(doc)
  },

  /** Mirror a server copy locally without creating a history entry. */
  async mirror(doc: { path: string; content: string; version: number; mtime: number }) {
    await db.putDoc({
      ...doc,
      baseHash: fnv1a(doc.content),
      synced: true,
      remote: null,
    })
  },

  stats: async () => {
    const [docs, history] = await Promise.all([db.listDocs(), db.allHistory()])
    return {
      docs: docs.length,
      pending: docs.filter((d) => !d.synced).length,
      conflicts: docs.filter((d) => !!d.remote).length,
      history: history.length,
    }
  },
}
