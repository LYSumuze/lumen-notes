/**
 * Real-folder storage on THIS device (File System Access API).
 *
 * Desktop Chrome / Edge on a secure origin (https or localhost) can bind any
 * folder once; from then on every note is mirrored into it as a real `.md`
 * file that any plain-text tool can open. Mobile browsers and plain-http LAN
 * origins do not expose the picker: callers get a clear capability flag and a
 * download fallback instead of a silent no-op.
 *
 * The mirror is write-only on purpose: deleting a note never deletes a real
 * file in the user's folder. Overwrites happen only for paths that belong to
 * the note vault, so unrelated files in that folder are left untouched.
 */
import { db } from './db'

const HANDLE_KEY = 'folderHandle'
const NAME_KEY = 'folderName'
const NOTE_RE = /\.(md|markdown|txt)$/i

type DirHandle = any
type FileHandle = any

export interface FolderState {
  supported: boolean
  secure: boolean
  bound: boolean
  name: string
  permission: 'granted' | 'prompt' | 'denied' | 'unsupported'
  handle?: DirHandle
}

let cached: { handle: DirHandle; name: string } | null = null

function picker(name: 'showDirectoryPicker' | 'showSaveFilePicker'): ((opts?: any) => Promise<any>) | null {
  if (typeof window === 'undefined') return null
  const fn = (window as any)[name]
  return typeof fn === 'function' ? fn.bind(window) : null
}

function isSecure() {
  try { return typeof window !== 'undefined' && window.isSecureContext === true }
  catch { return false }
}

export function downloadFile(name: string, content: string) {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 4000)
}

function safeParts(rel: string): string[] {
  return String(rel).replace(/\\/g, '/').split('/').filter((p) => p && p !== '.' && p !== '..')
}

async function writePath(root: DirHandle, rel: string, content: string) {
  const parts = safeParts(rel)
  if (!parts.length) throw new Error('无效的笔记路径')
  let dir = root
  for (const seg of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(seg, { create: true })
  const fh: FileHandle = await dir.getFileHandle(parts[parts.length - 1], { create: true })
  const writer = await fh.createWritable()
  await writer.write(content)
  await writer.close()
}

export const fsAccess = {
  supported(): boolean { return !!picker('showDirectoryPicker') && isSecure() },
  saveFilePickerSupported(): boolean { return !!picker('showSaveFilePicker') && isSecure() },
  secure(): boolean { return isSecure() },

  async state(): Promise<FolderState> {
    const supported = this.supported()
    const secure = isSecure()
    if (!supported) return { supported: false, secure, bound: false, name: '', permission: 'unsupported' }
    if (!cached) {
      try {
        const handle = await db.getSetting<DirHandle | null>(HANDLE_KEY, null)
        const name = await db.getSetting<string>(NAME_KEY, '')
        if (handle) cached = { handle, name }
      } catch { /* IndexedDB may not support storing handles */ }
    }
    if (!cached?.handle) return { supported, secure, bound: false, name: '', permission: 'prompt' }
    let permission: FolderState['permission'] = 'prompt'
    try { permission = await cached.handle.queryPermission({ mode: 'readwrite' }) || 'prompt' }
    catch { permission = 'prompt' }
    return { supported, secure, bound: true, name: cached.name || cached.handle.name || '笔记', permission, handle: cached.handle }
  },

  /** Must be called from a user gesture (browser requirement). */
  async pick(): Promise<string> {
    const choose = picker('showDirectoryPicker')
    if (!choose) throw new Error('当前环境不支持选择文件夹，请改用「导出 .md」')
    if (!isSecure()) throw new Error('文件夹选择需要安全环境，请用 http://localhost:18740 或 https 打开本页')
    const handle: DirHandle = await choose({ mode: 'readwrite', id: 'lumen-vault' })
    const name = handle.name || '笔记'
    cached = { handle, name }
    try {
      await db.setSetting(HANDLE_KEY, handle)
      await db.setSetting(NAME_KEY, name)
    } catch { /* still usable for this session */ }
    return name
  },

  /** Re-authorise a persisted handle; also requires a user gesture. */
  async requestPermission(): Promise<boolean> {
    const st = await this.state()
    if (!st.bound || !st.handle) return false
    try { return (await st.handle.requestPermission({ mode: 'readwrite' })) === 'granted' }
    catch { return false }
  },

  async clear() {
    cached = null
    try {
      await db.setSetting(HANDLE_KEY, null)
      await db.setSetting(NAME_KEY, '')
    } catch { /* noop */ }
  },

  /** Fire-and-forget mirror after a local save. Never throws, never prompts. */
  async mirrorDoc(path: string, content: string): Promise<boolean> {
    try {
      const st = await this.state()
      if (!st.bound || st.permission !== 'granted' || !st.handle) return false
      await writePath(st.handle, path, content)
      return true
    } catch { return false }
  },

  async mirrorAll(docs?: { path: string; content: string }[]) {
    const st = await this.state()
    if (!st.bound || !st.handle) throw new Error('还没有选择本设备的保存文件夹')
    if (st.permission !== 'granted') throw new Error('需要重新授权文件夹访问权限')
    const list = docs || (await db.listDocs()).map((d) => ({ path: d.path, content: d.content }))
    let ok = 0
    let failed = 0
    const errors: string[] = []
    for (const d of list) {
      try { await writePath(st.handle, d.path, d.content); ok++ }
      catch (e: any) { failed++; errors.push(`${d.path}: ${e.message || '写入失败'}`) }
    }
    return { ok, failed, errors }
  },

  /** Read every markdown file in the bound folder (for importing into the vault). */
  async importAll(): Promise<{ path: string; content: string }[]> {
    const st = await this.state()
    if (!st.bound || st.permission !== 'granted' || !st.handle) return []
    const out: { path: string; content: string }[] = []
    const walk = async (dir: DirHandle, prefix: string) => {
      for await (const handle of dir.values()) {
        const name: string = handle.name || ''
        if (!name || name.startsWith('.')) continue
        if (handle.kind === 'directory') await walk(handle, prefix ? `${prefix}/${name}` : name)
        else if (NOTE_RE.test(name)) {
          const file = await handle.getFile()
          out.push({ path: prefix ? `${prefix}/${name}` : name, content: await file.text() })
        }
      }
    }
    await walk(st.handle, '')
    return out
  },

  /** Choose where a single note goes; falls back to a normal download. */
  async saveAs(suggestedName: string, content: string): Promise<'picker' | 'download' | 'cancel'> {
    const choose = picker('showSaveFilePicker')
    if (choose && isSecure()) {
      try {
        const fh: FileHandle = await choose({
          suggestedName,
          types: [{
            description: 'Markdown 笔记',
            accept: { 'text/markdown': ['.md', '.markdown'], 'text/plain': ['.txt'] },
          }],
        })
        const writer = await fh.createWritable()
        await writer.write(content)
        await writer.close()
        return 'picker'
      } catch (e: any) {
        if (e?.name === 'AbortError') return 'cancel'
        // Permission / filesystem error: degrade to a download.
      }
    }
    downloadFile(suggestedName, content)
    return 'download'
  },
}
