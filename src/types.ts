export type ViewMode = 'split' | 'source' | 'reading'
export type SidebarTab = 'files' | 'outline' | 'search'
export type SyncScope = 'vault' | 'folder' | 'file'
export type ThemeName = 'dark' | 'light'
/** Phone only: follow the OS dark setting, or use the explicit `theme` value. */
export type ThemeMode = 'manual' | 'system'
/** Display-only ordering of the sidebar file tree; persisted with the settings. */
export type TreeSort =
  | 'name-asc' | 'name-desc'
  | 'mtime-desc' | 'mtime-asc'
  | 'size-desc' | 'size-asc'
/** Ordering of the first-run vault list; persisted as lumen.settings.vaultSort. */
export type VaultSort = 'name-asc' | 'name-desc' | 'used-desc' | 'used-asc'

/** One binary file inside the vault's img/ directory. */
export interface AssetInfo {
  path: string
  hash: string
  size: number
  mtime: number
}

/** Two devices changed the same attachment: the user must pick a side. */
export interface AssetConflict {
  path: string
  localHash: string
  peerHash: string
  localSize: number
  localMtime: number
  peerSize: number
  peerMtime: number
  deviceName: string
  at: number
}

export interface TreeNode {
  name: string
  path: string
  /** 'asset' is a display-only node for an image under img/; it is never a note. */
  type: 'file' | 'folder' | 'asset'
  children?: TreeNode[]
  /** Server-side file metadata, used by the transfer list (local replicas have no size). */
  size?: number
  mtime?: number
}

export interface Heading {
  level: number
  text: string
  line: number
  id: string
}

export interface Device {
  id: string
  name: string
  ip: string
  ua: string
  pairedAt: number
  lastSeen: number
}

export interface SyncInfo {
  port: number
  urls: string[]
  primaryUrl: string
  pairToken: string
  pairRequired: boolean
  vault: string
  devices: Device[]
  distReady: boolean
  hiddenFolder?: string
  desktop?: boolean
}

export interface StorageInfo {
  vault: string
  vaultName: string
  defaultVault: string
  home: string
  configFile: string
  canChange: boolean
  restrictedRoots: string[]
}

export interface BrowseResult {
  path: string
  parent: string | null
  root: string
  dirs: { name: string; path: string }[]
  drives: { name: string; path: string }[]
  selectable: boolean
  notes: number
}

export interface SetStorageResult {
  vault: string
  vaultName: string
  changed: boolean
  migrated: number
}

export interface DocMeta {
  path: string
  content: string
  version: number
  mtime: number
  unchanged?: boolean
}

export interface HistoryEntry {
  id: string
  path: string
  content: string
  version: number
  mtime: number
  reason: string
  source: 'local' | 'server'
  origin?: string
  chars: number
  /** Set only for list responses that omit the body. */
  hasContent?: boolean
}

export interface SearchHit {
  path: string
  line: number
  text: string
}

export interface CommandDef {
  id: string
  name: string
  group: string
  shortcut?: string
  icon?: string
  run: () => void
}

export interface EditorHandle {
  view: any
  scroller: HTMLElement | null
  getTopLine: () => number
  scrollToLine: (line: number, setCursor?: boolean) => void
  getCursorLine: () => number
  /** Insert text at the cursor (used by 「插入图片…」 after the file is stored). */
  insertText: (text: string) => void
  /** Keep the caret visible when the soft keyboard shrinks the visual viewport. */
  ensureCursorVisible: () => void
  /** Pin focus back onto the editor (toolbar tap must not drop the caret). */
  focus: () => void
}
