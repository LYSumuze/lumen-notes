/**
 * One entry point for 本地仓库 / 云仓库 version operations, online or offline.
 *
 * 保存 → local timeline. 同步 → this device's own cloud repo. Both are plain
 * version records in the vault, so they work with no connection at all. While
 * offline the records go into an IndexedDB queue and are overlaid onto the
 * cached state immediately; on reconnect the queue is flushed in order.
 * 拉取 = whole-vault converge. The server skips identical notes, copies
 * one-sided ones, propagates deletion tombstones, and returns a conflict list
 * for anything where both sides differ. The history panel handles those one by
 * one; resolveVersions() is the ONLY path that writes a .md back.
 */
import { api, clientId } from './sync'
import { db } from './db'
import {
  hasMobileVault, commitLocal as writeMobileVersion,
  cloudHeadContent, resolve as resolveMobile, readMobileVersions,
  resolveAssets as resolveMobileAssets,
} from './mobileVault'
import {
  ASSET_CONFLICTS_KEY, CONFLICTS_KEY, emptyState, makeVersionId, normalizeVcsState,
  SOURCE_CLOUD, SOURCE_LOCAL,
  type ConvergeConflict, type ResolveItem,
  type VersionState, type VersionRecord, type VersionSource,
} from './vcs'
import type { AssetConflict } from '../types'

export interface QueuedVersion {
  id: string
  path: string
  source: VersionSource
  content: string
  message: string
  reason: string
  at: number
  deviceId?: string
}

export interface LoadedVcs {
  state: VersionState
  pending: number
  remote: boolean
}

/** Show queued versions in the right repo before the server has them. */
function overlay(state: VersionState, queued: QueuedVersion[]): VersionState {
  if (!queued.length) return state
  let next = state
  for (const q of [...queued].sort((a, b) => a.at - b.at)) {
    const bucket = q.source === SOURCE_CLOUD ? next.cloud : next.local
    if (bucket.versions.some((v) => v.id === q.id)) continue
    const version: VersionRecord = {
      id: q.id, at: q.at, hash: '', content: q.content,
      message: q.message, reason: q.reason, source: q.source,
    }
    next = {
      ...next,
      [q.source]: {
        versions: [version, ...bucket.versions],
        deviceId: q.deviceId || bucket.deviceId,
        updatedAt: q.at,
      },
    }
  }
  return next
}

/** Push queued versions in order; stop at the first failure to keep order. */
export async function flushPending(): Promise<number> {
  const all = (await db.vcsQueueList()) as QueuedVersion[]
  let done = 0
  for (const q of all) {
    try {
      if (q.source === SOURCE_CLOUD) {
        await api.versionSync({ path: q.path, content: q.content, deviceId: q.deviceId })
      } else {
        await api.versionCommit({
          path: q.path, content: q.content, message: q.message, reason: q.reason,
        })
      }
      await db.vcsQueueRemove([q.id])
      done++
    } catch { break }
  }
  return done
}

export async function loadVcs(path: string, online: boolean, fallbackContent: string): Promise<LoadedVcs> {
  if (hasMobileVault()) {
    const local = await readMobileVersions(path)
    const s = normalizeVcsState(local || emptyState(path, fallbackContent), path)
    return { state: s, pending: 0, remote: false }
  }
  let remote = false
  let state: VersionState | undefined
  const cached = await db.vcsCacheGet(path)
  if (online) {
    try {
      await flushPending()
      const fresh = normalizeVcsState(await api.versions(path), path)
      // The peer snapshot lives only in this device's cache — never overwrite it.
      state = { ...fresh, peer: (cached as VersionState | undefined)?.peer || fresh.peer || null }
      await db.vcsCachePut(path, state)
      remote = true
    } catch { /* connection dropped between checks */ }
  }
  if (!state) state = normalizeVcsState(cached || emptyState(path, fallbackContent), path)
  const queued = (await db.vcsQueueList(path)) as QueuedVersion[]
  return { state: overlay(state, queued), pending: queued.length, remote }
}

export async function commitVcs(input: {
  path: string
  source: VersionSource
  content: string
  message?: string
  reason?: string
  deviceId?: string
}, online: boolean): Promise<void> {
  const item: QueuedVersion = {
    id: makeVersionId(), path: input.path, source: input.source,
    content: input.content,
    message: input.message || (input.source === SOURCE_CLOUD ? '同步' : '保存'),
    reason: input.reason || (input.source === SOURCE_CLOUD ? '同步到云仓库' : '保存'),
    deviceId: input.deviceId,
    at: Date.now(),
  }
  // 手机 App 直接写自己 SAF 目录里的版本文件：保存/同步不需要电脑在线，
  // 也不用「离线登记、连接后补推」那条为纯网页端准备的队列。
  if (hasMobileVault()) {
    await writeMobileVersion(item.path, item.content, item.source, item.message, item.reason, item.deviceId)
    return
  }
  await db.vcsQueuePut(item)
  if (online) await flushPending().catch(() => {})
}

/**
 * 同步 = publish the current local note into THIS device's cloud repo.
 * Notes already published with the same content are skipped.
 */
export interface CloudSyncReport {
  scanned: number
  unchanged: number
  uploaded: number
  failed: number
  errors: string[]
}

export async function syncToCloud(input: {
  docs: { path: string; content: string }[]
  online: boolean
  isDesktop: boolean
}): Promise<CloudSyncReport> {
  const report: CloudSyncReport = {
    scanned: input.docs.length, unchanged: 0, uploaded: 0, failed: 0, errors: [],
  }
  const deviceId = clientId
  for (const d of input.docs) {
    try {
      if (hasMobileVault()) {
        if ((await cloudHeadContent(d.path)) === d.content) { report.unchanged++; continue }
        await writeMobileVersion(d.path, d.content, SOURCE_CLOUD, '同步', '同步到云仓库', deviceId)
        report.uploaded++
        continue
      }
      const cached = await db.vcsCacheGet(d.path)
      const state = normalizeVcsState(cached || emptyState(d.path, d.content), d.path)
      const head = state.cloud.versions[0]
      if (head && (head.content === d.content)) { report.unchanged++; continue }
      await commitVcs({
        path: d.path, source: SOURCE_CLOUD, content: d.content,
        message: '同步', reason: '同步到云仓库', deviceId,
      }, input.online)
      report.uploaded++
    } catch (e: any) {
      report.failed++
      report.errors.push(`${d.path}：${String(e?.message || e)}`)
    }
  }
  return report
}

/* ------------------------------- whole-vault pending conflicts (待处理 N 篇) */

export async function loadConflicts(): Promise<ConvergeConflict[]> {
  try { return (await db.getSetting<ConvergeConflict[]>(CONFLICTS_KEY, [])) || [] }
  catch { return [] }
}

export async function saveConflicts(list: ConvergeConflict[]): Promise<void> {
  await db.setSetting(CONFLICTS_KEY, list)
}

export async function dropConflict(path: string): Promise<ConvergeConflict[]> {
  const list = (await loadConflicts()).filter((c) => c.path !== path)
  await saveConflicts(list)
  return list
}

/* ----------------------- attachment conflicts (simple choice card) ----------------------- */

export async function loadAssetConflicts(): Promise<AssetConflict[]> {
  try { return (await db.getSetting<AssetConflict[]>(ASSET_CONFLICTS_KEY, [])) || [] }
  catch { return [] }
}
export async function saveAssetConflicts(list: AssetConflict[]): Promise<void> {
  await db.setSetting(ASSET_CONFLICTS_KEY, list)
}

/** The only write-back path for an attachment conflict. */
export async function resolveAssetVersions(input: {
  selfId: string
  assets: { path: string; choice: 'local' | 'peer' | 'delete' }[]
}): Promise<{ results: { path: string; ok: boolean; error?: string }[] }> {
  if (hasMobileVault()) {
    const res = await resolveMobileAssets(input.selfId, input.assets)
    const ok = new Set(res.results.filter((r) => r.ok).map((r) => r.path))
    if (ok.size) await saveAssetConflicts((await loadAssetConflicts()).filter((c) => !ok.has(c.path)))
    return res
  }
  const res = await api.versionResolve({ selfId: input.selfId, items: [], assets: input.assets })
  const results = (res.assetResults || []).map((r) => ({ path: r.path, ok: r.ok, error: r.error }))
  const ok = new Set(results.filter((r) => r.ok).map((r) => r.path))
  if (ok.size) await saveAssetConflicts((await loadAssetConflicts()).filter((c) => !ok.has(c.path)))
  return { results }
}

/**
 * 唯一写回路径：用户在分屏里选定版本（或恢复某个历史版本）后调用。
 * 服务端写 .md（覆盖前留 .lumen-history 快照）→ 两端各记一条「已收敛」
 * 版本 → 推进 baseHash → 对齐对端云仓库 → WS 广播给对端自行 apply。
 */
export async function resolveVersions(input: {
  selfId: string
  items: ResolveItem[]
}): Promise<{ applied: boolean; failed: string[] }> {
  const res = hasMobileVault()
    ? await resolveMobile(input.selfId, input.items)
    : await api.versionResolve({ selfId: input.selfId, items: input.items })
  const failed = (res.results || [])
    .filter((r) => !r.ok)
    .map((r) => `${r.path}：${r.error || '写入失败'}`)
  for (const r of (res.results || []).filter((r) => r.ok)) {
    await dropConflict(r.path)
    // The old peer snapshot is stale now; never leave a phantom status hint.
    const cached = (await db.vcsCacheGet(r.path)) as VersionState | undefined
    if (cached) await db.vcsCachePut(r.path, { ...cached, peer: null })
  }
  return { applied: failed.length === 0, failed }
}
