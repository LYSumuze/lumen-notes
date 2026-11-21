/**
 * Android (Capacitor) implementation of the platform bridge.
 *
 * The renderer contract lives in ./platform.ts and was written for a
 * `window.lumenAndroid` object. On a real device we fulfil it with two local
 * Capacitor plugins instead of a JS-injected global, so both shells keep the
 * exact same business logic (src/lib/mobileVault.ts, syncEngine.ts, vcsStore.ts).
 *
 * Nothing here runs on desktop: Capacitor.isNativePlatform() is false in
 * Electron and in a plain browser, so the desktop bridge is untouched.
 */
import { Capacitor, registerPlugin } from '@capacitor/core'
import type { NativeFileBridge, VaultFs } from './platform'

interface LumenVaultPlugin {
  getVault(): Promise<{ vault: string; configured: boolean }>
  chooseVault(): Promise<{ vault: string; configured: boolean } | void>
  listFiles(): Promise<{ files: { path: string; size: number; mtime: number }[] }>
  readFile(o: { path: string }): Promise<{ content: string }>
  writeFile(o: { path: string; content: string }): Promise<void>
  removeFile(o: { path: string }): Promise<void>
  readBinary(o: { path: string }): Promise<{ base64: string }>
  writeBinary(o: { path: string; base64: string }): Promise<void>
  removeBinary(o: { path: string }): Promise<void>
  readClipboard(): Promise<{ text: string }>
  setStatusBarStyle(o: { dark: boolean }): Promise<void>
}
export interface LumenScanPlugin {
  scanQr(): Promise<{ text: string } | void>
}

export const LumenVault = registerPlugin<LumenVaultPlugin>('LumenVault')
export const LumenScan = registerPlugin<LumenScanPlugin>('LumenScan')

export const isAndroidNative = () =>
  Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android'

/** WebView clipboard permissions are unreliable; the native plugin reads it. */
export const readAndroidClipboard = async (): Promise<string> => {
  const { text } = await LumenVault.readClipboard()
  return typeof text === 'string' ? text : ''
}

/** Match the system status-bar colours / icon contrast to the app theme. */
export const setAndroidStatusBarStyle = async (dark: boolean): Promise<void> => {
  if (!isAndroidNative()) return
  try { await LumenVault.setStatusBarStyle({ dark }) } catch { /* older shell */ }
}

/** SAF tree not picked yet (or its persistable grant was revoked). */
export const androidVaultConfigured = async (): Promise<boolean> => {
  try { return Boolean((await LumenVault.getVault()).configured) }
  catch { return false }
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.length; i += 8192) {
    s += String.fromCharCode(...Array.from(bytes.subarray(i, i + 8192)))
  }
  return btoa(s)
}

function fromBase64(b64: string): ArrayBuffer {
  const bin = atob(b64 || '')
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out.buffer
}

const androidVaultFs: VaultFs = {
  listFiles: async () => {
    const { files } = await LumenVault.listFiles()
    return (files || []).map((f) => ({
      path: f.path, size: Number(f.size || 0), mtime: Number(f.mtime || 0),
    }))
  },
  readFile: async (path) => (await LumenVault.readFile({ path })).content,
  writeFile: async (path, content) => { await LumenVault.writeFile({ path, content }) },
  removeFile: async (path) => { await LumenVault.removeFile({ path }) },
  readBinary: async (path) => fromBase64((await LumenVault.readBinary({ path })).base64),
  writeBinary: async (path, data) => { await LumenVault.writeBinary({ path, base64: toBase64(data) }) },
  removeBinary: async (path) => { await LumenVault.removeBinary({ path }) },
}

const vaultListeners = new Set<(vault: string) => void>()

export function androidBridge(): NativeFileBridge {
  return {
    kind: 'android',
    label: '手机',
    localAuthority: true,
    getVault: async () => (await LumenVault.getVault()).vault,
    chooseVault: async () => {
      const r = await LumenVault.chooseVault()
      const vault = r && r.vault ? r.vault : null
      if (vault) for (const cb of [...vaultListeners]) cb(vault)
      return vault
    },
    onVaultChanged: (cb) => {
      vaultListeners.add(cb)
      return () => { vaultListeners.delete(cb) }
    },
    vaultFs: androidVaultFs,
  }
}

/** Parse the desktop QR / copied link: http://192.168.1.10:18740/?pair=TOKEN */
export function parsePairLink(raw: string): { base: string; token: string } {
  const text = String(raw || '').trim()
  if (!text) throw new Error('请粘贴配对链接')
  let u: URL
  try { u = new URL(text) } catch { throw new Error('链接格式不正确') }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('只支持 http / https 链接')
  if (!u.hostname) throw new Error('链接缺少主机地址')
  return { base: u.origin, token: u.searchParams.get('pair') || '' }
}
