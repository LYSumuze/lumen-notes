/**
 * 本地仓库 (local vault) — one per device, always offline-capable.
 *
 * This is the single place the UI asks "what does MY vault contain?". The
 * desktop shell answers from its IndexedDB working copy while the embedded
 * Node service writes the real .md into the chosen folder; a future Android
 * shell answers straight from its SAF-backed folder via `bridge.vaultFs`.
 * Neither path knows anything about the other device.
 *
 * The 云仓库 (cloud vault) is deliberately NOT here. It lives in the desktop
 * vault's version chains and is only read/written by 同步 / 拉取.
 */
import { bridge, type PlatformKind, type VaultFs } from '../native/platform'
import { db } from './db'

export interface LocalVaultFile {
  path: string
  content: string
}

export interface LocalVault {
  kind: PlatformKind
  label: string
  /** true when saving writes the .md in the user's own folder. */
  localAuthority: boolean
  /** Absolute path (desktop) or a content-tree URI (Android). */
  getVault: () => Promise<string>
  chooseVault: () => Promise<string | null>
  /** All notes in this device's vault. */
  listDocs: () => Promise<LocalVaultFile[]>
  readDoc: (path: string) => Promise<string | null>
  /** Native folder filesystem, present on mobile shells only. */
  vaultFs?: VaultFs
  hasNativeFs: () => boolean
}

export const localVault: LocalVault = {
  kind: bridge.kind,
  label: bridge.label,
  localAuthority: bridge.localAuthority,
  getVault: () => bridge.getVault(),
  chooseVault: () => bridge.chooseVault(),
  vaultFs: bridge.vaultFs,
  hasNativeFs: () => Boolean(bridge.vaultFs),

  async listDocs() {
    if (bridge.vaultFs) {
      const fs = bridge.vaultFs
      const files = await fs.listFiles()
      const out: LocalVaultFile[] = []
      for (const f of files) {
        try { out.push({ path: f.path, content: await fs.readFile(f.path) }) }
        catch { /* unreadable file in the user's folder */ }
      }
      return out
    }
    const docs = await db.listDocs()
    return docs.map((d) => ({ path: d.path, content: d.content }))
  },

  async readDoc(path: string) {
    if (bridge.vaultFs) {
      try { return await bridge.vaultFs.readFile(path) } catch { return null }
    }
    return (await db.getDoc(path))?.content ?? null
  },
}
