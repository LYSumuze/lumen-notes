/**
 * Android App 的设备本地仓库与云仓库。
 *
 * 桌面端不走这个文件：它内嵌的 Node 服务就是本机仓库，REST 等价于本地读写。
 * 手机 App 不能把 .md 或 .lumen-vcs 写到电脑上，所以保存 / 同步 / 收敛 /
 * 选版本全部通过 SAF 的 vaultFs 落在自己选的文件夹里；只有「发布云仓库快照 /
 * 读取对端快照 / 广播收敛结果」这三件事走网络，服务端只是邮局。
 *
 * 版本文件与桌面同格式：{ path, baseHash, local:{versions}, cloud:{versions} }，
 * 文件名用 fnv1a(path)（手机目录自洽即可，不与桌面互相读取）。
 * 收敛判定与 server/index.mjs 的 convergeVault 等价，改一边必须同步改另一边。
 *
 * SAF 实现约定：writeFile 需自动创建父目录；listFiles 需包含点开头的隐藏目录。
 */
import { bridge, type VaultFs } from '../native/platform'
import { fnv1a } from './hash'
import { api } from './sync'
import type { AssetTombstone, PeerAsset } from './sync'
import {
  emptyState, normalizeVcsState, record, SOURCE_CLOUD, SOURCE_LOCAL, VERSION_LIMIT,
  type VersionState, type VersionSource,
  type ConvergeConflict, type ConvergeReport, type ResolveItem,
} from './vcs'
import type { AssetConflict } from '../types'

const VCS_DIR = '.lumen-vcs'
const HISTORY_DIR = '.lumen-history'
const ASSET_DIR = 'img'
const ASSET_TOMB_FILE = `${VCS_DIR}/asset-tombstones.json`
const vcsFile = (p: string) => `${VCS_DIR}/${fnv1a(p)}.json`
const isNote = (p: string) => /\.(md|markdown|txt)$/i.test(p) && !p.startsWith('.') && !p.includes('/.')
const isAsset = (p: string) => p.startsWith(`${ASSET_DIR}/`) && !p.split('/').some((s) => s.startsWith('.'))

/** Only a real Android shell with a granted SAF folder owns a local vault. */
export const hasMobileVault = () => bridge.kind === 'android' && Boolean(bridge.vaultFs)

function nativeFs(): VaultFs {
  const f = bridge.vaultFs
  if (!f) throw new Error('手机仓库未授权，请先在欢迎页选择文件夹')
  return f
}

export interface Tombstone { path: string; at: number; deviceId: string }
export interface CloudDoc {
  path: string; hash: string; content: string; at: number; baseHash: string
}
type StoredVcs = VersionState & { tombstone?: { at: number; deviceId: string; content: string } }

/* ------------------------------------------------------------- version files */

async function readVersions(path: string): Promise<StoredVcs | null> {
  try {
    const raw = JSON.parse(await nativeFs().readFile(vcsFile(path)))
    return normalizeVcsState(raw, path) as StoredVcs
  } catch { return null }
}

async function writeVersions(path: string, state: StoredVcs): Promise<void> {
  await nativeFs().writeFile(vcsFile(path), JSON.stringify(state))
}

/** 供历史面板 / 状态栏读取本设备版本状态，绝不请求电脑服务端。 */
export const readMobileVersions = (path: string) => readVersions(path)

async function versionsOrCreate(path: string, content: string): Promise<StoredVcs> {
  return (await readVersions(path)) || (emptyState(path, content) as StoredVcs)
}

function append(
  state: StoredVcs, source: VersionSource, content: string,
  message: string, reason: string, deviceId?: string,
): StoredVcs {
  const key = source === SOURCE_CLOUD ? 'cloud' : 'local'
  const bucket = state[key]
  return {
    ...state,
    [key]: {
      ...bucket,
      versions: [record(content, source, message, reason), ...(bucket.versions || [])].slice(0, VERSION_LIMIT),
      deviceId: deviceId || bucket.deviceId,
      updatedAt: Date.now(),
    },
  }
}

/** 覆盖或删除前留一份旧内容，删错了还能从 .lumen-history 里找回来。 */
async function snapshot(path: string): Promise<string> {
  const content = await nativeFs().readFile(path).catch(() => null)
  if (content === null) return '' // 新建笔记没有旧内容可留
  await nativeFs().writeFile(`${HISTORY_DIR}/${fnv1a(path)}/${Date.now().toString(36)}.md`, content)
  return content
}

/** Equivalent to server/index.mjs alignCloud(): append a version to each side
 *  ONLY when the content hash actually changed. Appending on every 拉取 would
 *  pollute the shared timeline and make the two devices diverge. */
async function alignCloud(path: string, content: string, selfId: string, fromLocalOnly = false): Promise<StoredVcs> {
  let state = await versionsOrCreate(path, content)
  const h = fnv1a(content)
  if (state.local.versions?.[0]?.hash !== h) {
    state = append(state, SOURCE_LOCAL, content, '已收敛',
      fromLocalOnly ? '从本端拷贝到云仓库' : '两端一致')
  }
  if (state.cloud.versions?.[0]?.hash !== h) {
    state = append(state, SOURCE_CLOUD, content, '已收敛', '两端一致', selfId)
  }
  state = { ...state, baseHash: h }
  delete state.tombstone
  await writeVersions(path, state)
  return state
}

/* ------------------------------------------------------- device-local writes */

/** 本设备云仓库最新内容，供「同步」跳过未修改的笔记。 */
export async function cloudHeadContent(path: string): Promise<string | null> {
  const state = await readVersions(path)
  return state?.cloud.versions[0]?.content ?? null
}

/** 保存 / 同步：写本设备的版本时间线，绝不发往电脑。 */
export async function commitLocal(
  path: string, content: string, source: VersionSource,
  message: string, reason: string, deviceId?: string,
): Promise<VersionState> {
  let state = await versionsOrCreate(path, content)
  const head = (source === SOURCE_CLOUD ? state.cloud : state.local).versions[0]
  if (head && head.content === content) return state
  state = append(state, source, content, message, reason, deviceId)
  await writeVersions(path, state)
  return state
}

export async function writeDoc(path: string, content: string): Promise<void> {
  await snapshot(path)
  await nativeFs().writeFile(path, content)
}

export async function deleteDoc(path: string, deviceId: string): Promise<void> {
  const content = await snapshot(path)
  const state = await versionsOrCreate(path, content)
  await writeVersions(path, {
    ...state,
    tombstone: { at: Date.now(), deviceId, content },
  })
  await nativeFs().removeFile(path)
}

/* -------------------------------------------------------------- attachments */
/*
 * Android's SAF layer must implement VaultFs.readBinary / writeBinary for this
 * section to do anything. Until that native bridge exists, asset sync is a
 * no-op here (the desktop side is fully independent). Hashes MUST match the
 * desktop's SHA-1 over raw bytes, so WebCrypto is used — fnv1a is a STRING
 * hash and cannot be used on binary data.
 */
interface LocalAsset { hash: string; size: number; mtime: number; buf: ArrayBuffer }

async function assetHashOf(buf: ArrayBuffer): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error('当前环境不支持附件校验')
  const digest = await subtle.digest('SHA-1', buf)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
async function localAssets(): Promise<Map<string, LocalAsset>> {
  const f = nativeFs()
  const map = new Map<string, LocalAsset>()
  if (!f.readBinary) return map
  for (const file of await f.listFiles()) {
    if (!isAsset(file.path)) continue
    const buf = await f.readBinary(file.path).catch(() => null)
    if (!buf) continue
    map.set(file.path, {
      hash: await assetHashOf(buf), size: buf.byteLength,
      mtime: Number(file.mtime || 0), buf,
    })
  }
  return map
}
async function readAssetTombs(): Promise<Record<string, AssetTombstone>> {
  try { return JSON.parse(await nativeFs().readFile(ASSET_TOMB_FILE)) || {} }
  catch { return {} }
}
async function writeAssetTombs(map: Record<string, AssetTombstone>): Promise<void> {
  await nativeFs().writeFile(ASSET_TOMB_FILE, JSON.stringify(map))
}
async function clearAssetTomb(rel: string): Promise<void> {
  const map = await readAssetTombs()
  if (!(rel in map)) return
  delete map[rel]
  await writeAssetTombs(map)
}

/** Publish this device's attachment LIST; bytes go to /api/asset/peer in binary. */
async function publishAssets(selfId: string): Promise<{
  assets: PeerAsset[]; assetTombstones: AssetTombstone[]
}> {
  const local = await localAssets()
  const assets: PeerAsset[] = []
  for (const [p, a] of local) {
    try {
      await api.assetPeerUpload(p, a.buf, selfId, a.mtime)
      assets.push({ path: p, hash: a.hash, size: a.size, mtime: a.mtime })
    } catch { /* skip an unreadable attachment */ }
  }
  const tombs = await readAssetTombs()
  return { assets, assetTombstones: Object.values(tombs) }
}

/** Equivalent of server/index.mjs convergeAssets(), using the post office. */
async function convergeAssets(selfId: string) {
  const out = { conflicts: [] as AssetConflict[], copied: 0, deleted: 0, errors: [] as string[] }
  const f = nativeFs()
  if (!f.readBinary || !f.writeBinary) return out
  const { peers } = await api.versionPeers()
  const peer = new Map<string, PeerAsset & { deviceId: string; deviceName: string }>()
  const peerTombs = new Map<string, AssetTombstone & { deviceName: string }>()
  for (const p of peers) {
    if (p.deviceId === selfId || !p.hasAssets) continue
    for (const a of p.assets || []) {
      peer.set(a.path, { ...a, deviceId: p.deviceId, deviceName: p.deviceName })
    }
    for (const t of p.assetTombstones || []) {
      peerTombs.set(t.path, { ...t, deviceName: p.deviceName })
    }
  }
  if (!peer.size && !peerTombs.size) return out
  const local = await localAssets()
  const localTombs = await readAssetTombs()
  const paths = [...new Set([
    ...local.keys(), ...peer.keys(), ...Object.keys(localTombs), ...peerTombs.keys(),
  ])]
  const conflict = (rel: string, L?: LocalAsset, P?: PeerAsset, deviceName = '另一台设备') => {
    out.conflicts.push({
      path: rel, localHash: L?.hash || '', peerHash: P?.hash || '',
      localSize: Number(L?.size || 0), localMtime: Number(L?.mtime || 0),
      peerSize: Number(P?.size || 0), peerMtime: Number(P?.mtime || 0),
      deviceName, at: Date.now(),
    })
  }
  for (const rel of paths) {
    try {
      const L = local.get(rel), P = peer.get(rel)
      const lTomb = localTombs[rel], pTomb = peerTombs.get(rel)
      if (!L && !P) continue
      if (lTomb && P) {
        if (!lTomb.hash || P.hash === lTomb.hash) out.deleted++
        else conflict(rel, undefined, P, peer.get(rel)?.deviceName)
        continue
      }
      if (pTomb && L) {
        if (!pTomb.hash || L.hash === pTomb.hash) {
          await (f.removeBinary || f.removeFile)(rel).catch(() => {})
          localTombs[rel] = pTomb
          await writeAssetTombs(localTombs)
          out.deleted++
        } else conflict(rel, L, undefined, pTomb.deviceName)
        continue
      }
      if (lTomb && !P) continue
      if (pTomb && !L) continue
      if (L && P) {
        if (L.hash === P.hash) continue
        conflict(rel, L, P, peer.get(rel)?.deviceName)
        continue
      }
      if (L && !P) {
        await api.assetPeerUpload(rel, L.buf, selfId, L.mtime)
        out.copied++
        continue
      }
      if (!L && P) {
        let buf: ArrayBuffer
        try { buf = await api.assetPeerDownload(rel, peer.get(rel)?.deviceId || '') }
        catch { buf = await api.assetDownload(rel) }
        await f.writeBinary!(rel, buf)
        await clearAssetTomb(rel)
        out.copied++
      }
    } catch (e: any) {
      out.errors.push(`${rel}：${e?.message || String(e)}`)
    }
  }
  return out
}

/** 本设备云仓库快照：只包含已经「同步」过的笔记 + 删除墓碑。 */
export async function cloudSnapshot(): Promise<{ docs: CloudDoc[]; tombstones: Tombstone[] }> {
  const f = nativeFs()
  const docs: CloudDoc[] = []
  const tombstones: Tombstone[] = []
  for (const file of await f.listFiles()) {
    if (!file.path.startsWith(`${VCS_DIR}/`) || !file.path.endsWith('.json')) continue
    let raw: any
    try { raw = JSON.parse(await f.readFile(file.path)) } catch { continue }
    const p = String(raw?.path || '')
    if (!p) continue
    if (raw.tombstone) {
      tombstones.push({
        path: p, at: Number(raw.tombstone.at || 0),
        deviceId: String(raw.tombstone.deviceId || ''),
      })
      continue
    }
    const state = normalizeVcsState(raw, p)
    const head = state.cloud.versions[0]
    if (!head) continue
    docs.push({
      path: p, hash: fnv1a(head.content), content: head.content,
      at: head.at, baseHash: state.baseHash,
    })
  }
  return { docs, tombstones }
}

/** 连接后发布本设备云仓库；离线时不需要调用。 */
export async function publish(selfId: string, selfName: string): Promise<number> {
  const { docs, tombstones } = await cloudSnapshot()
  // Omit the field entirely when the native binary API is unavailable: an
  // absent list is not the same as "this device deleted every attachment".
  let assetPayload: { assets: PeerAsset[]; assetTombstones: AssetTombstone[] } | null = null
  try { assetPayload = await publishAssets(selfId) } catch { /* native layer not ready */ }
  return (await api.versionPublish({
    deviceId: selfId, deviceName: selfName, docs, tombstones,
    ...(assetPayload || {}),
  })).count
}

/* -------------------------------------------------------------- converge */

interface Entry {
  path: string; exists: boolean; deleted: boolean
  hash: string; content: string; at: number; deviceName?: string
}
export interface MobileConvergeResult {
  report: ConvergeReport
  conflicts: ConvergeConflict[]
  assetConflicts: AssetConflict[]
  peerCount: number
}
interface NotifyEvent { path: string; action: 'write' | 'delete'; content?: string }

async function localInventory(): Promise<Map<string, Entry>> {
  const f = nativeFs()
  const map = new Map<string, Entry>()
  for (const file of await f.listFiles()) {
    if (!isNote(file.path)) continue
    const content = await f.readFile(file.path).catch(() => null)
    if (content === null) continue
    map.set(file.path, {
      path: file.path, exists: true, deleted: false,
      hash: fnv1a(content), content, at: Number(file.mtime || 0),
    })
  }
  const { tombstones } = await cloudSnapshot()
  for (const t of tombstones) {
    if (!map.has(t.path)) {
      map.set(t.path, { path: t.path, exists: false, deleted: true, hash: '', content: '', at: t.at })
    }
  }
  return map
}

async function peerInventory(selfId: string): Promise<{ map: Map<string, Entry>; count: number }> {
  const { peers } = await api.versionPeers()
  const map = new Map<string, Entry>()
  let count = 0
  const put = (e: Entry) => {
    const prev = map.get(e.path)
    if (!prev || e.at >= prev.at) map.set(e.path, e)
  }
  for (const p of peers) {
    if (p.deviceId === selfId) continue
    count++
    for (const d of p.docs || []) {
      put({
        path: d.path, exists: true, deleted: false,
        hash: String(d.hash || fnv1a(String(d.content ?? ''))),
        content: String(d.content ?? ''), at: Number(d.at || 0),
        deviceName: p.deviceName,
      })
    }
    for (const t of p.tombstones || []) {
      put({
        path: t.path, exists: false, deleted: true,
        hash: '', content: '', at: Number(t.at || 0), deviceName: p.deviceName,
      })
    }
  }
  return { map, count }
}

/**
 * 拉取：整仓按内容 hash 收敛，判定与服务端 convergeVault 一致。
 * 相同跳过、单边拷贝、墓碑传播；两端都有但内容不同（含删了又新建同名）
 * 一律不自动，返回给分屏框让用户选版本。所有落盘都写手机自己的 .md。
 */
export async function converge(selfId: string, selfName: string): Promise<MobileConvergeResult> {
  const local = await localInventory()
  const { map: peer, count: peerCount } = await peerInventory(selfId)
  const paths = [...new Set([...local.keys(), ...peer.keys()])]
  const report: ConvergeReport = {
    scanned: paths.length, unchanged: 0, copied: 0, deleted: 0,
    conflicts: 0, errors: [], changedPaths: [],
  }
  const conflicts: ConvergeConflict[] = []
  const events: NotifyEvent[] = []
  const aligns: { path: string; content: string; hash: string; baseHash: string }[] = []
  const peerTombstones: string[] = []

  // 与服务端 convergeVault 等价：没有真实在线设备就绝不收敛。否则本地每篇
  // 笔记都会被当成「对端没有」而白写一条云版本，并误广播一次 converge。
  if (!peerCount) {
    return {
      report: { ...report, scanned: local.size, unchanged: local.size },
      conflicts: [], assetConflicts: [], peerCount: 0,
    }
  }

  for (const rel of paths) {
    const L = local.get(rel), P = peer.get(rel)
    const lExists = !!L?.exists, pExists = !!P?.exists
    const lDeleted = !!L?.deleted, pDeleted = !!P?.deleted
    const lHash = L?.hash || '', pHash = P?.hash || ''
    const lContent = L?.content || '', pContent = P?.content || ''
    const state = await readVersions(rel)
    const base = String(state?.baseHash || '')
    const deviceName = P?.deviceName || '另一台设备'
    const conflict = (kind: ConvergeConflict['kind']) => {
      conflicts.push({
        path: rel, kind, localContent: lContent, peerContent: pContent,
        localHash: lHash, peerHash: pHash, baseHash: base, deviceName,
        localDeleted: lDeleted, peerDeleted: pDeleted, at: Date.now(),
      })
      report.conflicts++
    }
    const align = (content: string, fromLocalOnly = false) => {
      const h = fnv1a(content)
      aligns.push({ path: rel, content, hash: h, baseHash: h })
      return alignCloud(rel, content, selfId, fromLocalOnly)
    }

    try {
      if ((lDeleted && pDeleted) || (!lExists && !lDeleted && pDeleted)
        || (lDeleted && !pExists && !pDeleted) || (!L && !P)) {
        report.unchanged++
        continue
      }
      if (lDeleted && pExists) {
        if (base && pHash === base) {
          peerTombstones.push(rel)
          report.deleted++; report.changedPaths.push(rel)
        } else conflict('delete-vs-create')
        continue
      }
      if (lExists && pDeleted) {
        if (base && lHash === base) {
          await deleteDoc(rel, selfId)
          events.push({ path: rel, action: 'delete' })
          report.deleted++; report.changedPaths.push(rel)
        } else conflict('edit-vs-delete')
        continue
      }
      if (lExists && pExists) {
        if (lHash === pHash) { report.unchanged++; await align(lContent); continue }
        const changedLocal = lHash !== base, changedPeer = pHash !== base
        conflict(changedLocal && changedPeer ? 'both' : changedPeer ? 'peer-only' : 'local-only')
        continue
      }
      if (lExists && !P) {
        await align(lContent, true)
        events.push({ path: rel, action: 'write', content: lContent })
        report.copied++; report.changedPaths.push(rel)
        continue
      }
      if (!L && pExists) {
        await writeDoc(rel, pContent)
        events.push({ path: rel, action: 'write', content: pContent })
        await align(pContent)
        report.copied++; report.changedPaths.push(rel)
        continue
      }
      report.unchanged++
    } catch (e: any) {
      report.errors.push(`${rel}：${e?.message || String(e)}`)
    }
  }

  const assetOut = await convergeAssets(selfId).catch(() => ({
    conflicts: [] as AssetConflict[], copied: 0, deleted: 0, errors: [] as string[],
  }))
  report.assetCopied = assetOut.copied
  report.assetDeleted = assetOut.deleted
  report.errors.push(...assetOut.errors)

  if (events.length || aligns.length || peerTombstones.length || assetOut.copied || assetOut.deleted) {
    await api.versionNotify({
      selfId, selfName, items: events, aligns,
      tombstones: peerTombstones,
    }).catch(() => {})
    await publish(selfId, selfName).catch(() => {})
  }
  return { report, conflicts, assetConflicts: assetOut.conflicts, peerCount }
}

/** 用户在分屏里选定版本：只写手机自己的 .md，然后把结果告诉对端。 */
export async function resolve(
  selfId: string, items: ResolveItem[],
): Promise<{ results: { path: string; ok: boolean; action?: string; error?: string }[] }> {
  const selfName = bridge.label
  const events: NotifyEvent[] = []
  const aligns: { path: string; content: string; hash: string; baseHash: string }[] = []
  const results: { path: string; ok: boolean; action?: string; error?: string }[] = []
  for (const it of items) {
    if (!it.path) continue
    try {
      if (it.choice === 'delete') {
        await deleteDoc(it.path, selfId)
        events.push({ path: it.path, action: 'delete' })
        results.push({ path: it.path, ok: true, action: 'delete' })
        continue
      }
      const content = String(it.content ?? '')
      await writeDoc(it.path, content)
      await alignCloud(it.path, content, selfId, !!it.restore)
      const h = fnv1a(content)
      aligns.push({ path: it.path, content, hash: h, baseHash: h })
      events.push({ path: it.path, action: 'write', content })
      results.push({ path: it.path, ok: true, action: 'write' })
    } catch (e: any) {
      results.push({ path: it.path, ok: false, error: e?.message || String(e) })
    }
  }
  if (events.length) {
    await api.versionNotify({
      selfId, selfName, items: events, aligns,
      tombstones: events.filter((e) => e.action === 'delete').map((e) => e.path),
    }).catch(() => {})
    await publish(selfId, selfName).catch(() => {})
  }
  return { results }
}

/** Attachment conflict choice on a phone: write the local SAF file, then tell
 *  the post office to align the peer snapshot. No .md is touched. */
export async function resolveAssets(
  selfId: string, choices: { path: string; choice: 'local' | 'peer' | 'delete' }[],
): Promise<{ results: { path: string; ok: boolean; error?: string }[] }> {
  const f = nativeFs()
  const results: { path: string; ok: boolean; error?: string }[] = []
  for (const c of choices) {
    try {
      if (c.choice === 'delete') {
        await (f.removeBinary || f.removeFile)(c.path).catch(() => {})
        const tombs = await readAssetTombs()
        tombs[c.path] = { path: c.path, at: Date.now(), hash: '', deviceId: selfId }
        await writeAssetTombs(tombs)
      } else if (c.choice === 'peer') {
        let buf: ArrayBuffer
        try { buf = await api.assetPeerDownload(c.path) }
        catch { buf = await api.assetDownload(c.path) }
        if (!f.writeBinary) throw new Error('手机仓库暂不支持写入附件')
        await f.writeBinary(c.path, buf)
        await clearAssetTomb(c.path)
      } else {
        const buf = f.readBinary ? await f.readBinary(c.path) : null
        if (buf) await api.assetPeerUpload(c.path, buf, selfId, Date.now())
        await clearAssetTomb(c.path)
      }
      results.push({ path: c.path, ok: true })
    } catch (e: any) {
      results.push({ path: c.path, ok: false, error: e?.message || String(e) })
    }
  }
  await api.versionResolve({ selfId, items: [], assets: choices }).catch(() => {})
  await publish(selfId, bridge.label).catch(() => {})
  return { results }
}
