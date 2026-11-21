/**
 * Unsaved-text parking area for explicit-save mode.
 *
 * Edits live in memory until the user presses Ctrl+S / 保存. This store is a
 * crash / refresh / background-tab parachute ONLY: drafts are never written as
 * .md files, never added to the history store, never mirrored to a bound
 * folder and never sent to another device. Saving or explicitly discarding a
 * change clears the draft for that path.
 */
const KEY = 'lumen.drafts.v1'

export interface Draft {
  path: string
  content: string
  savedAt: number
}

type DraftMap = Record<string, Draft>

function read(): DraftMap {
  try {
    const raw = localStorage.getItem(KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' ? parsed as DraftMap : {}
  } catch { return {} }
}

function write(map: DraftMap) {
  // Quota / private mode failures are non-fatal: memory editing still works.
  try { localStorage.setItem(KEY, JSON.stringify(map)) } catch { /* ignore */ }
}

export const drafts = {
  get(path: string): Draft | null {
    if (!path) return null
    const d = read()[path]
    return d && typeof d.content === 'string' ? d : null
  },
  put(path: string, content: string) {
    if (!path) return
    const map = read()
    map[path] = { path, content, savedAt: Date.now() }
    write(map)
  },
  clear(path: string) {
    if (!path) return
    const map = read()
    if (!(path in map)) return
    delete map[path]
    write(map)
  },
  /** Switching vaults invalidates every parked draft of the old vault. */
  clearAll() { write({}) },
}
