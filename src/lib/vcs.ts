/**
 * Version records for Lumen Notes — pure algorithms, no DOM / Node APIs.
 *
 * Model: every device owns two repositories for the same note.
 *   - 本地仓库 (local): a linear timeline of versions, one per save.
 *   - 云仓库 (cloud): this device's own published versions. "同步" pushes the
 *     current local content here; it stays on THIS device, no chain, no fork.
 * When two devices connect, each publishes its cloud content to the other.
 * "拉取" compares the two against a shared baseHash and shows ONE diff box.
 * The user picks a version; that choice becomes the new shared baseHash.
 *
 * No chains, no heads, no "side by side" coexistence. `baseHash` is the only
 * piece of state that must survive: it is what tells "one side changed" from
 * "both sides changed".
 */
import { fnv1a, normalizeEol } from './hash'

/** 每篇笔记的版本上限（固定，不可调）：面板显示最近 15 条，磁盘两端各留 15 条。 */
export const VERSION_LIMIT = 15

export interface VersionRecord {
  id: string
  at: number
  hash: string
  content: string
  message: string
  reason: string
  source: 'local' | 'cloud'
  /** Tombstone record: this note was deleted on both devices. */
  deleted?: boolean
}

export interface VersionBucket {
  versions: VersionRecord[]   // newest first
  deviceId?: string
  updatedAt: number
}

/** Latest cloud content published by the other device, cached after 拉取. */
export interface PeerSnapshot {
  deviceId: string
  deviceName: string
  content: string
  hash: string
  at: number
  baseHash: string
}

export interface VersionState {
  path: string
  /** Content hash both devices agreed on after the last update. */
  baseHash: string
  local: VersionBucket
  cloud: VersionBucket
  /** Not persisted on the server: only the local cache holds peer data. */
  peer?: PeerSnapshot | null
}

/** Compat names so the IndexedDB layer does not need a schema bump. */
export type VcsState = VersionState

export const SOURCE_LOCAL = 'local' as const
export const SOURCE_CLOUD = 'cloud' as const
export type VersionSource = typeof SOURCE_LOCAL | typeof SOURCE_CLOUD

export const makeVersionId = () =>
  `v${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`

export function record(content: string, source: VersionSource, message: string, reason: string, at = Date.now()): VersionRecord {
  return { id: makeVersionId(), at, hash: fnv1a(content), content, message, reason, source }
}

export const latest = (bucket?: VersionBucket): VersionRecord | undefined => bucket?.versions?.[0]
export const latestContent = (bucket?: VersionBucket): string => latest(bucket)?.content ?? ''

/** A brand new note: one local version, an EMPTY cloud repo (no phantom "1 个版本"). */
export function emptyState(path: string, content: string, at = Date.now()): VersionState {
  return {
    path,
    baseHash: fnv1a(content),
    local: { versions: [record(content, SOURCE_LOCAL, '初始版本', '初始化', at)], updatedAt: at },
    cloud: { versions: [], updatedAt: 0 },
  }
}

/**
 * Convert the old three-chain files / cached states into the new shape.
 * Only the newest real commit survives as one local version; the two cloud
 * chains were pre-created shells pointing at the same root, so they are
 * deliberately dropped — that is the phantom "云链 1 个版本" bug.
 */
export function normalizeVcsState(raw: any, path: string): VersionState {
  if (raw && raw.local && raw.cloud && Array.isArray(raw.local.versions)) {
    return {
      path: raw.path || path,
      baseHash: String(raw.baseHash || ''),
      local: { ...raw.local, versions: raw.local.versions || [] },
      cloud: { ...raw.cloud, versions: raw.cloud.versions || [] },
      peer: raw.peer || null,
    }
  }
  if (raw && Array.isArray(raw.commits) && Array.isArray(raw.chains)) {
    const commits = raw.commits as any[]
    const newest = commits.reduce((a: any, b: any) => (Number(b?.at || 0) > Number(a?.at || 0) ? b : a), commits[0])
    const content = String(newest?.content ?? '')
    const at = Number(newest?.at || Date.now())
    return {
      path,
      baseHash: fnv1a(content),
      local: {
        versions: [{ id: String(newest?.id || makeVersionId()), at, hash: fnv1a(content), content,
          message: String(newest?.message || '初始版本'), reason: String(newest?.reason || '初始化'), source: SOURCE_LOCAL }],
        updatedAt: at,
      },
      cloud: { versions: [], updatedAt: 0 },
      peer: null,
    }
  }
  return emptyState(path, '')
}

export function appendVersion(state: VersionState, source: VersionSource, input: {
  content: string; message?: string; reason?: string; deviceId?: string; at?: number
}): { state: VersionState; version: VersionRecord } {
  const at = input.at ?? Date.now()
  const version = record(input.content, source, input.message || (source === SOURCE_CLOUD ? '同步' : '保存'), input.reason || '保存', at)
  const bucket = source === SOURCE_CLOUD ? state.cloud : state.local
  const next: VersionBucket = {
    versions: [version, ...(bucket?.versions || [])].slice(0, VERSION_LIMIT),
    deviceId: input.deviceId || bucket?.deviceId,
    updatedAt: at,
  }
  return {
    state: { ...state, [source]: next },
    version,
  }
}

/* ------------------------------------------------------------------ diff */

export type DiffKind = 'equal' | 'add' | 'del'

export interface DiffRow {
  kind: DiffKind
  text: string
  aLine?: number
  bLine?: number
}

/**
 * Compare by visible content, not by the bytes used for line endings.
 * A CRLF snapshot against an LF snapshot differs on EVERY line after
 * split('\n'), so a one-line edit would otherwise look like a full rewrite.
 * Stored version content is never rewritten — this is comparison-only.
 * Uses the SAME normalizer as content hashing, so "same text" means one thing.
 */
/** Line-based LCS diff. `add` exists only in b, `del` only in a. */
export function diffLines(a: string, b: string): DiffRow[] {
  const al = normalizeEol(a).split('\n')
  const bl = normalizeEol(b).split('\n')
  const n = al.length, m = bl.length
  if (n * m > 4_000_000) return coarseDiff(al, bl)
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = al[i] === bl[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: DiffRow[] = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (al[i] === bl[j]) {
      out.push({ kind: 'equal', text: al[i], aLine: i + 1, bLine: j + 1 }); i++; j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: 'del', text: al[i], aLine: i + 1 }); i++
    } else {
      out.push({ kind: 'add', text: bl[j], bLine: j + 1 }); j++
    }
  }
  while (i < n) { out.push({ kind: 'del', text: al[i], aLine: i + 1 }); i++ }
  while (j < m) { out.push({ kind: 'add', text: bl[j], bLine: j + 1 }); j++ }
  return out
}

function coarseDiff(al: string[], bl: string[]): DiffRow[] {
  const out: DiffRow[] = []
  const n = Math.max(al.length, bl.length)
  for (let i = 0; i < n; i++) {
    if (i < al.length && i < bl.length) {
      if (al[i] === bl[i]) out.push({ kind: 'equal', text: al[i], aLine: i + 1, bLine: i + 1 })
      else {
        out.push({ kind: 'del', text: al[i], aLine: i + 1 })
        out.push({ kind: 'add', text: bl[i], bLine: i + 1 })
      }
    } else if (i < al.length) out.push({ kind: 'del', text: al[i], aLine: i + 1 })
    else out.push({ kind: 'add', text: bl[i], bLine: i + 1 })
  }
  return out
}

/* ------------------------------------------------- side-by-side comparison */
/** One cell in a two-column diff. `empty` lines keep both columns aligned. */
export interface SideLine {
  text: string
  line?: number
  changed: boolean
  empty: boolean
}
export interface SideBySide {
  left: SideLine[]
  right: SideLine[]
  changes: number
}

/**
 * Build two aligned columns from the LCS diff. Consecutive del/add blocks are
 * paired row by row so an edited line shows the old text on the left and the
 * new text on the right, instead of two unrelated half-screens. Both cells of
 * a changed row carry `changed: true` — the UI paints them red on both sides.
 */
export function sideBySide(a: string, b: string): SideBySide {
  const rows = diffLines(a, b)
  const left: SideLine[] = []
  const right: SideLine[] = []
  const blank = (changed: boolean): SideLine => ({ text: '', changed, empty: true })
  const cell = (text: string, line: number | undefined, changed: boolean): SideLine => ({
    text, line, changed, empty: false,
  })
  let i = 0
  let changes = 0
  while (i < rows.length) {
    if (rows[i].kind === 'equal') {
      const r = rows[i]
      left.push(cell(r.text, r.aLine, false))
      right.push(cell(r.text, r.bLine, false))
      i++
      continue
    }
    // Collect a whole change block so deletions and insertions can be paired.
    const dels: DiffRow[] = []
    const adds: DiffRow[] = []
    while (i < rows.length && rows[i].kind !== 'equal') {
      (rows[i].kind === 'del' ? dels : adds).push(rows[i])
      i++
    }
    const n = Math.max(dels.length, adds.length)
    for (let k = 0; k < n; k++) {
      const d = dels[k], x = adds[k]
      left.push(d ? cell(d.text, d.aLine, true) : blank(true))
      right.push(x ? cell(x.text, x.bLine, true) : blank(true))
      changes++
    }
  }
  return { left, right, changes }
}

/* ------------------------------------------------------------ one timeline */
export interface TimelineEntry extends VersionRecord {
  /** local + cloud records from the same converge step, shown as one row. */
  merged?: boolean
}

/**
 * "一条时间线": the local save history and this device's cloud publish history
 * are the same immutable stream. A converge step writes one record into each
 * bucket with the same content; those two are folded into a single row marked
 * 「两端一致」 so the timeline stays readable.
 */
export function timeline(state: VersionState): TimelineEntry[] {
  const all: TimelineEntry[] = [
    ...(state.local?.versions || []).map((v) => ({ ...v, source: SOURCE_LOCAL as VersionSource })),
    ...(state.cloud?.versions || []).map((v) => ({ ...v, source: SOURCE_CLOUD as VersionSource })),
  ].sort((a, b) => b.at - a.at)
  const out: TimelineEntry[] = []
  for (const v of all) {
    const prev = out[out.length - 1]
    if (prev && !prev.merged && prev.source !== v.source
      && prev.hash === v.hash && Math.abs(prev.at - v.at) < 2000) {
      out[out.length - 1] = { ...prev, merged: true, reason: '两端一致', message: '已收敛' }
      continue
    }
    out.push(v)
  }
  return out.slice(0, VERSION_LIMIT)
}

/* ------------------------------------------------------- converge protocol */
/** IndexedDB key holding the whole-vault pending conflict list. */
export const CONFLICTS_KEY = 'lumen.converge.conflicts'
/** Attachments have their own simple choice card, never the note diff view. */
export const ASSET_CONFLICTS_KEY = 'lumen.converge.asset.conflicts'

export type ConvergeKind =
  | 'local-only' | 'peer-only' | 'both'
  | 'delete-vs-create' | 'edit-vs-delete'

/** A note that needs the user to pick a version in the side-by-side box. */
export interface ConvergeConflict {
  path: string
  kind: ConvergeKind
  localContent: string
  peerContent: string
  localHash: string
  peerHash: string
  baseHash: string
  deviceName: string
  localDeleted: boolean
  peerDeleted: boolean
  at: number
}

export interface ConvergeReport {
  scanned: number
  unchanged: number
  copied: number
  deleted: number
  conflicts: number
  errors: string[]
  changedPaths: string[]
  /** Attachment converge counters (kept separate from note counts). */
  assetCopied?: number
  assetDeleted?: number
}

export interface ResolveItem {
  path: string
  /** local | peer → write that content; delete → tombstone on both devices. */
  choice: 'local' | 'peer' | 'delete'
  content?: string
  /** Restoring an arbitrary timeline version bypasses the conflict content. */
  restore?: boolean
}

export function conflictTitle(kind: ConvergeKind): string {
  switch (kind) {
    case 'both': return '两端都改了这篇笔记'
    case 'local-only': return '本端改了这篇笔记'
    case 'peer-only': return '对端改了这篇笔记'
    case 'delete-vs-create': return '一端删除、另一端又新建了同名笔记'
    case 'edit-vs-delete': return '一端删除、另一端还有未同步的修改'
  }
}
