/**
 * Tree helpers + the two whole-vault operations that are still in use:
 *   publishCloud() - publish THIS device's cloud repo snapshot to the post office
 *   fetchUpdates() - whole-vault converge; conflicts go to the history panel
 *
 * The old direction sync / auto merge / combined-history code was removed with
 * the point-to-point 同步 dialog. Nothing here may write a .md on its own: the
 * only write-back path is /api/versions/resolve (or the mobile equivalent).
 */
import { api } from './sync'
import { bridge } from '../native/platform'
import type { AssetTombstone, PeerAsset } from './sync'
import { db } from './db'
import { fnv1a } from './hash'
import { ASSET_CONFLICTS_KEY, CONFLICTS_KEY, normalizeVcsState, type ConvergeConflict } from './vcs'
import {
  hasMobileVault, publish as publishMobileCloud, converge as convergeMobile,
} from './mobileVault'
import type { AssetConflict, TreeNode, TreeSort } from '../types'

export function flattenTree(tree: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = []
  const walk = (list: TreeNode[]) => list.forEach((n) => {
    if (n.type === 'file') out.push(n)
    else if (n.children) walk(n.children)
  })
  walk(tree)
  return out
}

const sortNodes = (a: TreeNode, b: TreeNode) =>
  a.type === b.type ? a.name.localeCompare(b.name, 'zh-CN') : a.type === 'folder' ? -1 : 1

/**
 * Display-only ordering for the sidebar. Never reorders anything on disk and
 * never changes paths: folders stay on top, and every directory is sorted
 * independently. Local offline replicas carry no size/mtime, so in the numeric
 * modes they fall back to name order and sit after entries with real metadata
 * instead of pretending to be files from 1970.
 */
export function sortTree(nodes: TreeNode[], mode: TreeSort): TreeNode[] {
  const byName = (a: TreeNode, b: TreeNode) => a.name.localeCompare(b.name, 'zh-CN')
  const key: 'mtime' | 'size' = mode.startsWith('mtime') ? 'mtime' : 'size'
  const desc = mode.endsWith('-desc')
  const compare = (a: TreeNode, b: TreeNode) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1
    if (mode === 'name-asc') return byName(a, b)
    if (mode === 'name-desc') return -byName(a, b)
    const av = a[key]
    const bv = b[key]
    const aHas = typeof av === 'number'
    const bHas = typeof bv === 'number'
    if (!aHas || !bHas) {
      if (aHas !== bHas) return aHas ? -1 : 1
      return byName(a, b)
    }
    const delta = desc ? (bv as number) - (av as number) : (av as number) - (bv as number)
    return delta || byName(a, b)
  }
  return nodes
    .map((n) => (n.children ? { ...n, children: sortTree(n.children, mode) } : { ...n }))
    .sort(compare)
}

export function pathsToTree(paths: string[]): TreeNode[] {
  const root: TreeNode[] = []
  for (const path of paths) {
    const parts = path.split('/')
    let list = root
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts.slice(0, i + 1).join('/')
      let folder = list.find((n) => n.type === 'folder' && n.path === p)
      if (!folder) { folder = { name: parts[i], path: p, type: 'folder', children: [] }; list.push(folder) }
      list = folder.children!
    }
    if (!list.some((n) => n.type === 'file' && n.path === path)) {
      list.push({ name: parts[parts.length - 1], path, type: 'file' })
    }
  }
  const sort = (nodes: TreeNode[]) => {
    nodes.sort(sortNodes)
    nodes.forEach((n) => n.children && sort(n.children))
  }
  sort(root)
  return root
}

/** Union of the server tree and the local replica (offline-created notes stay visible). */
export function mergeTrees(a: TreeNode[], b: TreeNode[]): TreeNode[] {
  const map = new Map<string, TreeNode>()
  const add = (list: TreeNode[]) => list.forEach((n) => {
    const prev = map.get(n.path)
    if (!prev) {
      map.set(n.path, { ...n, children: n.children ? [...n.children] : undefined })
    } else if (prev.type === 'folder' && n.type === 'folder') {
      prev.children = mergeTrees(prev.children || [], n.children || [])
    }
  })
  add(a)
  add(b)
  return [...map.values()].sort(sortNodes)
}

export function inScope(path: string, scope: string): boolean {
  const s = String(scope || '').replace(/^\/+/, '')
  if (!s) return true
  if (/\.(md|markdown|txt)$/i.test(s)) return path === s
  return path === s || path.startsWith(s + '/')
}

export interface RunOptions {
  /** This device's id, used to ignore its own published cloud copy. */
  selfId?: string
  selfName?: string
}

/**
 * 一次性只读镜像：全新设备第一次连上时把仓库里的 .md 复制进本地工作副本。
 * 绝不回推，也绝不覆盖已有的本地笔记。
 */
export async function bootstrapMirror(): Promise<number> {
  if (hasMobileVault()) {
    // A phone mirrors its OWN SAF notes into IndexedDB. It must never silently
    // copy the desktop vault: copying notes across is 拉取 / converge's job.
    const fs = bridge.vaultFs
    if (!fs) return 0
    const existing = new Set((await db.listDocs()).map((d) => d.path))
    let n = 0
    const files = await fs.listFiles().catch(() => [] as { path: string; mtime?: number }[])
    for (const f of files) {
      const p = f.path
      if (!/\.(md|markdown|txt)$/i.test(p) || p.startsWith('.') || p.includes('/.')) continue
      if (existing.has(p)) continue
      try {
        const content = await fs.readFile(p)
        await db.mirror({ path: p, content, version: 1, mtime: Number(f.mtime || Date.now()) })
        n++
      } catch { /* unreadable note in the user's folder */ }
    }
    return n
  }
  if ((await db.listDocs()).length) return 0
  if (!(await api.health())) return 0
  let files: TreeNode[] = []
  try { files = flattenTree((await api.tree('')).tree) } catch { return 0 }
  let n = 0
  for (const f of files) {
    try { await db.mirror(await api.file(f.path)); n++ } catch { /* unreadable file */ }
  }
  return n
}

/**
 * 把本设备云仓库发布出去（双向交换的一半）。云端内容 + 删除墓碑一起发。
 * 即使两个清单都为空也要登记设备，否则收敛无法判断有没有对端在线。
 */
export async function publishCloud(selfId: string, selfName: string): Promise<number> {
  // 手机 App 必须发布自己 SAF 目录里的云仓库，不能读电脑服务端的 manifest。
  if (hasMobileVault()) return publishMobileCloud(selfId, selfName)
  const { files } = await api.manifest('')
  const docs: { path: string; hash: string; content: string; at: number; baseHash: string }[] = []
  for (const f of files) {
    try {
      const state = normalizeVcsState(await api.versions(f.path), f.path)
      const head = state.cloud.versions[0]
      if (!head) continue
      docs.push({
        path: f.path, hash: fnv1a(head.content), content: head.content,
        at: head.at, baseHash: state.baseHash,
      })
    } catch { /* skip a note that cannot be read right now */ }
  }
  let tombstones: { path: string; at: number; deviceId: string }[] = []
  try { tombstones = (await api.versionTombstones()).tombstones || [] } catch { /* offline */ }
  // Attachments ride alongside the note snapshot as a LIST only. The bytes are
  // uploaded separately in binary, so a large image never lands in JSON.
  // If the endpoint is unavailable (older service) omit the field entirely:
  // an absent list is not the same as "this device has no attachments".
  let assetPayload: { assets: PeerAsset[]; assetTombstones: AssetTombstone[] } | null = null
  try {
    const inv = await api.assets()
    const assets: PeerAsset[] = []
    for (const a of inv.assets) {
      try {
        const buf = await api.assetDownload(a.path)
        await api.assetPeerUpload(a.path, buf, selfId, a.mtime)
        assets.push({ path: a.path, hash: a.hash, size: a.size, mtime: a.mtime })
      } catch { /* unreadable / too large: skip instead of failing the whole sync */ }
    }
    assetPayload = { assets, assetTombstones: inv.tombstones || [] }
  } catch { /* older service without attachment support */ }
  return (await api.versionPublish({
    deviceId: selfId, deviceName: selfName, docs, tombstones,
    ...(assetPayload || {}),
  })).count
}

/**
 * 拉取 = 整仓双向收敛。服务端按内容 hash 逐篇处理：相同的跳过、单边有的
 * 直接拷贝、一端删了且另一端没改的用墓碑传播；凡两端内容不同（含「删了又
 * 新建同名」）一律不自动，返回给分屏框让用户选版本。
 * 冲突清单存进 IndexedDB，历史面板的「待处理 N 篇」逐篇切换处理。
 */
export interface FetchReport {
  scanned: number
  unchanged: number
  copied: number
  deleted: number
  /** Number of notes waiting for the user to pick a version. */
  updated: number
  failed: number
  errors: string[]
  changedPaths: string[]
  peerCount: number
  /** Binary attachments that need a simple "keep local / use peer" choice. */
  assetConflicts: AssetConflict[]
  assetCopied: number
  assetDeleted: number
}

export async function fetchUpdates(opts: RunOptions = {}): Promise<FetchReport> {
  if (!(await api.health())) {
    throw new Error('未连接，拉取失败：请确认电脑端已启动，且两台设备在同一 Wi-Fi')
  }
  const selfId = opts.selfId || ''
  if (selfId) await publishCloud(selfId, opts.selfName || selfId).catch(() => 0)

  // 手机 App：收敛与落盘全在自己设备上，服务端只当邮局。
  if (hasMobileVault()) {
    const out = await convergeMobile(selfId, opts.selfName || selfId)
    await db.setSetting(CONFLICTS_KEY, out.conflicts)
    await db.setSetting(ASSET_CONFLICTS_KEY, out.assetConflicts || [])
    const r = out.report
    return {
      scanned: r.scanned, unchanged: r.unchanged, copied: r.copied, deleted: r.deleted,
      updated: out.conflicts.length, failed: r.errors.length, errors: r.errors,
      changedPaths: r.changedPaths, peerCount: out.peerCount,
      assetConflicts: out.assetConflicts || [],
      assetCopied: Number(r.assetCopied || 0), assetDeleted: Number(r.assetDeleted || 0),
    }
  }

  const res = await api.versionConverge(selfId)
  const conflicts: ConvergeConflict[] = res.conflicts || []
  const assetConflicts: AssetConflict[] = res.assetConflicts || []
  await db.setSetting(CONFLICTS_KEY, conflicts)
  await db.setSetting(ASSET_CONFLICTS_KEY, assetConflicts)
  const r = res.report
  return {
    scanned: r.scanned, unchanged: r.unchanged, copied: r.copied, deleted: r.deleted,
    updated: conflicts.length, failed: r.errors?.length || 0, errors: r.errors || [],
    changedPaths: r.changedPaths || [], peerCount: res.peerCount,
    assetConflicts, assetCopied: Number((r as any).assetCopied || 0),
    assetDeleted: Number((r as any).assetDeleted || 0),
  }
}
