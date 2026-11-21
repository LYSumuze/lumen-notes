/**
 * Lumen Notes · LAN sync + static host
 *
 * One small Node process serves:
 *   1. the built web app (dist/)            -> browsers, Electron, Capacitor WebView
 *   2. a REST API over a vault folder       -> folder / single-file sync
 *   3. a WebSocket channel                 -> live multi-device propagation
 *   4. a pairing-token flow                -> phone scans QR in the desktop UI
 *
 * No database, no cloud. Notes live as plain .md files in the configured
 * vault (a folder under app userData until the user picks one).
 */
import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import express from 'express'
import chokidar from 'chokidar'
import { WebSocketServer, WebSocket } from 'ws'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
// The desktop shell passes writable, real paths. Standalone `npm start` keeps
// the original source-tree behaviour for development.
const DIST = process.env.LUMEN_DIST ? path.resolve(process.env.LUMEN_DIST) : path.join(ROOT, 'dist')
const CONFIG_FILE = process.env.LUMEN_CONFIG_FILE
  ? path.resolve(process.env.LUMEN_CONFIG_FILE)
  : path.join(ROOT, '.lumen-config.json')
const DEFAULT_VAULT = process.env.LUMEN_DEFAULT_VAULT
  ? path.resolve(process.env.LUMEN_DEFAULT_VAULT)
  : path.join(__dirname, 'vault')

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {} }
  catch { return {} }
}
function writeConfig(patch) {
  const next = { ...readConfig(), ...patch }
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8')
  return next
}

// The vault is user-selectable at runtime. The chosen path is persisted in
// .lumen-config.json so it survives restarts; LUMEN_VAULT still wins when set.
const savedVault = readConfig().vault
let VAULT = process.env.LUMEN_VAULT
  ? path.resolve(process.env.LUMEN_VAULT)
  : savedVault
    ? path.resolve(ROOT, String(savedVault))
    : DEFAULT_VAULT

const IS_WINDOWS = process.platform === 'win32'
/** 大小写敏感文件系统可以同时存在 Note.md 和 note.md。 */
const CASE_SENSITIVE_FS = process.platform === 'linux'
/** chokidar 无法监视整个仓库时非空；通过 /health、WS 和报告告知前端。 */
let watcherDegraded = ''

const PORT = Number(process.env.LUMEN_PORT || 18740)
const HOST = process.env.LUMEN_HOST || '0.0.0.0'
const PAIR_TOKEN = crypto.randomBytes(12).toString('hex')
const PAIR_MODE = process.env.LUMEN_PAIR !== '0'
// Optional whitelist: LUMEN_STORAGE_ROOTS="D:\Notes;E:\Docs" (path.delimiter).
// Empty = any non-system folder is allowed, which is what most users want.
const STORAGE_ROOTS = String(process.env.LUMEN_STORAGE_ROOTS || '')
  .split(path.delimiter).filter(Boolean).map((p) => path.resolve(p))
// Changing the vault from a paired phone is opt-in (it widens what a LAN
// device can read on the host machine).
const REMOTE_STORAGE = process.env.LUMEN_REMOTE_STORAGE === '1'
// History travels WITH the vault: a dot-prefixed folder inside the folder the
// user picked as their notes location. On Windows we additionally set the real
// hidden attribute (something a browser can never do); macOS / Linux already
// hide dot folders. Both the file tree and chokidar skip dot paths.
const HISTORY_FOLDER = '.lumen-history'
const LEGACY_HISTORY_DIR = path.join(ROOT, '.lumen-history')
/** 版本条数与覆盖前快照数固定为 15，不再提供可调设置。 */
const VERSION_LIMIT = 15
const historyRoot = () => path.join(VAULT, HISTORY_FOLDER)
function historyLimit() {
  // 固定值，忽略 .lumen-config.json 里遗留的旧可调设置。
  return VERSION_LIMIT
}
/** Create the hidden history folder inside the currently selected vault. */
async function ensureHistoryDir() {
  const dir = historyRoot()
  await fsp.mkdir(dir, { recursive: true })
  if (process.platform === 'win32') {
    await new Promise((resolve) => execFile('attrib', ['+h', dir], () => resolve()))
  }
  return dir
}

await fsp.mkdir(VAULT, { recursive: true })
await fsp.mkdir(path.join(VAULT, 'img'), { recursive: true })
await ensureHistoryDir()

/* -------------------------------------------------------------- diagnostics */

// A small rolling log lives in userData so an exported report can explain a
// failure from an earlier launch. The in-memory ring covers the current run.
// Neither ever stores note contents, pairing tokens or device IP addresses.
const LOG_DIR = process.env.LUMEN_LOG_DIR
  ? path.resolve(process.env.LUMEN_LOG_DIR)
  : path.join(ROOT, '.lumen-logs')
const INSTALL_DIR = process.env.LUMEN_INSTALL_DIR
  ? path.resolve(process.env.LUMEN_INSTALL_DIR)
  : ROOT
const REPORT_DIR = path.join(path.dirname(LOG_DIR), 'reports')
const RING_LIMIT = 500
const KEEP_DAYS = 7
const logRing = []
let logFile = ''
let lastLogDay = ''

const pad2 = (n) => String(n).padStart(2, '0')
const localDay = (d = new Date()) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
const stamp = (at) => {
  const d = new Date(at)
  return `${localDay(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

function pruneLogs() {
  try {
    const cutoff = localDay(new Date(Date.now() - KEEP_DAYS * 86400000))
    for (const name of fs.readdirSync(LOG_DIR)) {
      const m = /^lumen-(\d{4}-\d{2}-\d{2})\.log$/.exec(name)
      if (m && m[1] < cutoff) fs.unlinkSync(path.join(LOG_DIR, name))
    }
  } catch { /* nothing to prune yet */ }
}
pruneLogs()

function log(level, tag, message, extra) {
  const entry = {
    at: Date.now(),
    level: ['info', 'warn', 'error'].includes(level) ? level : 'info',
    tag: String(tag || 'app').slice(0, 40),
    message: String(message || '').slice(0, 500),
    extra: extra == null ? '' : String(extra).slice(0, 4000),
  }
  logRing.push(entry)
  if (logRing.length > RING_LIMIT) logRing.shift()
  try {
    const day = localDay(new Date(entry.at))
    if (day !== lastLogDay) {
      fs.mkdirSync(LOG_DIR, { recursive: true })
      logFile = path.join(LOG_DIR, `lumen-${day}.log`)
      lastLogDay = day
      pruneLogs()
    }
    const flat = entry.extra.replace(/\s+/g, ' ')
    fs.appendFileSync(logFile,
      `${stamp(entry.at)} [${entry.level.toUpperCase()}] [${entry.tag}] ${entry.message}${flat ? ' | ' + flat : ''}\n`, 'utf8')
  } catch { /* diagnostics must never break the service */ }
  if (entry.level === 'error') console.error(`[${entry.tag}] ${entry.message}`, entry.extra || '')
  else if (entry.level === 'warn') console.warn(`[${entry.tag}] ${entry.message}`)
}

function appVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '未知' }
  catch { return '未知' }
}

/** Rolling log files from previous launches, newest lines last. */
function readRecentLogFiles(maxLines = 400) {
  try {
    const names = fs.readdirSync(LOG_DIR)
      .filter((n) => /^lumen-\d{4}-\d{2}-\d{2}\.log$/.test(n)).sort()
    const lines = []
    for (const name of names) {
      lines.push(...fs.readFileSync(path.join(LOG_DIR, name), 'utf8').split('\n').filter(Boolean))
    }
    return lines.slice(-maxLines)
  } catch { return [] }
}

/** The exported report: environment + paths + state + recent logs. No note body. */
async function buildReport() {
  let files = 0, folders = 0, bytes = 0
  try {
    const count = (nodes) => {
      for (const n of nodes) {
        if (n.type === 'file') { files++; bytes += n.size || 0 }
        else { folders++; count(n.children || []) }
      }
    }
    count(await walk(VAULT))
  } catch (e) { log('warn', 'report', '统计仓库失败：' + e.message) }

  const cfg = readConfig()
  const configRows = Object.entries(cfg)
    .filter(([k]) => !/token|secret|password|pair|code/i.test(k))
    .map(([k, v]) => `- \`${k}\`: ${String(typeof v === 'object' ? JSON.stringify(v) : v).slice(0, 300)}`)
  const deviceRows = [...devices.values()].map((d) => `- ${d.name}`)
  const recent = logRing.slice(-200).map((e) =>
    `${stamp(e.at)} [${e.level.toUpperCase()}] [${e.tag}] ${e.message}`)
  const problems = logRing.filter((e) => e.level !== 'info').slice(-50).map((e) =>
    `${stamp(e.at)} [${e.level.toUpperCase()}] [${e.tag}] ${e.message}${e.extra ? '\n' + e.extra : ''}`)
  const historyLines = readRecentLogFiles()

  return [
    '# Lumen Notes 诊断报告',
    '',
    '> 本报告不含笔记正文、配对码与设备 IP 地址。',
    '',
    '## 概览',
    '',
    `- 导出时间：${stamp(Date.now())}`,
    `- 应用版本：v${appVersion()}`,
    `- 运行时：Node ${process.version}${process.versions.electron ? ' / Electron ' + process.versions.electron : ''}`,
    `- 系统：${process.platform} ${process.arch} · ${os.release()}`,
    `- 已运行时长：${Math.round(process.uptime())} 秒`,
    '',
    '## 路径',
    '',
    `- 安装目录：${INSTALL_DIR}`,
    `- 应用代码：${ROOT}`,
    `- 前端产物：${DIST}`,
    `- 配置文件：${CONFIG_FILE}`,
    `- 默认仓库：${DEFAULT_VAULT}`,
    `- 当前仓库：${VAULT}`,
    `- 历史目录：${historyRoot()}`,
    `- 日志目录：${LOG_DIR}`,
    `- 报告副本：${REPORT_DIR}`,
    '',
    '## 服务状态',
    '',
    `- 监听：${HOST}:${PORT}`,
    `- 前端产物：${fs.existsSync(path.join(DIST, 'index.html')) ? '已就绪' : '未构建'}`,
    `- WebSocket 连接数：${wss.clients.size}`,
    `- 已配对设备数：${devices.size}`,
    `- 配对模式：${PAIR_MODE ? '需配对码' : '关闭'}`,
    `- 文件监视：${watcherDegraded || '正常'}`,
    `- 版本记录数：${versions.size}`,
    `- 历史版本上限：${historyLimit()}`,
    '',
    '## 仓库统计',
    '',
    `- 笔记文件：${files} 篇`,
    `- 文件夹：${folders} 个`,
    `- 文件总大小：${(bytes / 1024).toFixed(1)} KB`,
    '',
    '## 已配对设备',
    '',
    ...(deviceRows.length ? deviceRows : ['- 无']),
    '',
    '## 配置摘要',
    '',
    ...(configRows.length ? configRows : ['- 无']),
    '',
    '## 最近日志（本次运行，最多 200 条）',
    '',
    '```text',
    ...(recent.length ? recent : ['（无）']),
    '```',
    '',
    '## 历史日志（用户数据滚动文件，保留最近 7 天，末尾 400 行）',
    '',
    '```text',
    ...(historyLines.length ? historyLines : ['（无）']),
    '```',
    '',
    '## 最近警告与错误（最多 50 条）',
    '',
    '```text',
    ...(problems.length ? problems : ['（无）']),
    '```',
    '',
  ].join('\n')
}

/* ------------------------------------------------------------------ utils */

const hash = (s) => crypto.createHash('sha1').update(s).digest('hex')

// MUST stay byte-for-byte identical to src/lib/hash.ts (three-way merge check).
// Line endings are normalized before hashing so a CRLF note and an LF note
// with the same words share one fingerprint. Stored content is never rewritten.
function normalizeEol(input) {
  return String(input ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
}
function fnv1a(input) {
  const s = normalizeEol(input)
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < s.length; i++) {
    h1 ^= s.charCodeAt(i)
    h1 = Math.imul(h1, 0x01000193) >>> 0
    h2 ^= s.charCodeAt(i)
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')
}
// baseHash values written before EOL normalization are still in the client's
// IndexedDB. Accept them so the first save after an upgrade is not reported
// as "another device changed this file". New values use fnv1a() only.
function fnv1aLegacy(input) {
  const s = String(input ?? '')
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < s.length; i++) {
    h1 ^= s.charCodeAt(i)
    h1 = Math.imul(h1, 0x01000193) >>> 0
    h2 ^= s.charCodeAt(i)
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')
}
const now = () => Date.now()

/* --------------------------------------------------------- version history */

// The key depends ONLY on the relative path: the hidden history folder now
// travels with the notes, so copying / moving the vault must not orphan it.
const historyKey = (rel) =>
  crypto.createHash('sha1').update(String(rel)).digest('hex').slice(0, 16)
// Intermediate builds keyed by the vault's absolute path (and kept the folder
// outside the vault). Keep those versions readable for a smooth upgrade.
const legacyHistoryKey = (rel, vault = VAULT) =>
  crypto.createHash('sha1').update(`${vault}|${String(rel)}`).digest('hex').slice(0, 16)
const historyDirFor = async (rel) => {
  const dir = path.join(historyRoot(), historyKey(rel))
  await fsp.mkdir(dir, { recursive: true })
  return dir
}
const HISTORY_ID = /^[a-f0-9]{16}\/[0-9a-z-]+\.json$/

function historyFile(id) {
  const clean = String(id || '')
  if (!HISTORY_ID.test(clean)) throw Object.assign(new Error('无效的版本号'), { status: 400 })
  const abs = path.resolve(historyRoot(), clean)
  if (!abs.startsWith(historyRoot() + path.sep)) throw Object.assign(new Error('非法路径'), { status: 400 })
  if (fs.existsSync(abs)) return abs
  // Versions recorded by older builds lived next to the project, not in the vault.
  const legacy = path.resolve(LEGACY_HISTORY_DIR, clean)
  if (fs.existsSync(legacy) && legacy.startsWith(LEGACY_HISTORY_DIR + path.sep)) return legacy
  return abs
}

async function recordHistory(rel, content, version, reason, origin = '') {
  const dir = await historyDirFor(rel)
  const id = `${historyKey(rel)}/${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}.json`
  const entry = {
    id,
    path: rel,
    content: String(content ?? ''),
    version: Number(version) || 1,
    mtime: now(),
    reason: String(reason || '保存前'),
    origin: String(origin || ''),
    source: 'server',
    chars: String(content ?? '').length,
  }
  await fsp.writeFile(path.join(dir, path.basename(id)), JSON.stringify(entry), 'utf8')
  // Keep only the last N versions (user setting, 1..10, default 5).
  const limit = historyLimit()
  const files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.json')).sort()
  if (files.length > limit) {
    for (const f of files.slice(0, files.length - limit)) {
      await fsp.unlink(path.join(dir, f)).catch(() => {})
    }
  }
  return entry
}

async function listHistory(rel) {
  const keys = [historyKey(rel), legacyHistoryKey(rel)]
  const roots = [historyRoot(), LEGACY_HISTORY_DIR]
  const out = []
  const seen = new Set()
  for (const root of roots) {
    for (const key of keys) {
      let files
      try { files = (await fsp.readdir(path.join(root, key))).filter((f) => f.endsWith('.json')) }
      catch { continue }
      for (const f of files) {
        try {
          const entry = JSON.parse(await fsp.readFile(path.join(root, key, f), 'utf8'))
          if (seen.has(f + '|' + entry.mtime)) continue
          seen.add(f + '|' + entry.mtime)
          const { content, ...meta } = entry
          out.push(meta)
        } catch { /* skip corrupt entry */ }
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, historyLimit())
}

/* -------------------------------------------------- selectable vault path */

// 旧列表把 Windows 与 Unix 目录混在一起，且对任意层级同名段一律拒绝：
// Linux 上 ~/dev/notes、~/usr/projects 会被误杀。改成「仅各处都不安全的名字」
// + 「按绝对路径前缀判断系统目录」，不再按路径中任意子串匹配。
const FORBIDDEN_SEGMENTS = new Set([
  '.ssh', '.git', '.lumen-history', 'node_modules',
  '$recycle.bin', 'system volume information', 'system32', 'syswow64',
  'appdata', 'programdata',
])
const POSIX_SYSTEM_ROOTS = [
  '/etc', '/usr', '/bin', '/sbin', '/var', '/proc', '/dev', '/sys',
  '/run', '/boot', '/lib', '/lib64', '/opt', '/snap',
  '/system', '/library', '/private', '/applications',
]
const WINDOWS_SYSTEM_NAMES = new Set(['windows', 'program files', 'program files (x86)'])
function isSystemLocation(abs) {
  if (IS_WINDOWS) {
    // 只看盘符后的第一段，D:\Users\me\windows 仍是合法用户目录。
    const segs = abs.toLowerCase().split(path.sep).filter(Boolean)
    return segs.length >= 2 && WINDOWS_SYSTEM_NAMES.has(segs[1])
  }
  const lower = abs.toLowerCase()
  return POSIX_SYSTEM_ROOTS.some((r) => lower === r || lower.startsWith(r + '/'))
}

/** Reject disk roots and OS/program folders, and honour an optional whitelist. */
function assertStoragePath(target) {
  const abs = path.resolve(String(target || ''))
  if (!abs || path.parse(abs).root === abs) {
    throw Object.assign(new Error('不能把磁盘根目录作为保存位置，请选一个具体文件夹'), { status: 400 })
  }
  const segments = abs.split(path.sep).filter(Boolean).map((s) => s.toLowerCase())
  if (segments.some((s) => FORBIDDEN_SEGMENTS.has(s))) {
    throw Object.assign(new Error('该目录属于内部或敏感目录，不能作为笔记仓库'), { status: 400 })
  }
  if (isSystemLocation(abs)) {
    throw Object.assign(new Error('该目录属于系统或程序目录，不能作为笔记仓库'), { status: 400 })
  }
  if (STORAGE_ROOTS.length && !STORAGE_ROOTS.some((r) => abs === r || abs.startsWith(r + path.sep))) {
    throw Object.assign(new Error(`保存位置必须在允许的目录内：${STORAGE_ROOTS.join(' / ')}`), { status: 400 })
  }
  return abs
}

/** The folder picker may walk UP towards a legitimate vault, but must never
 *  enumerate OS/program directories (or anything outside LUMEN_STORAGE_ROOTS).
 *  assertStoragePath() rejects disk ROOTS, which the picker legitimately needs
 *  to list drives, so browsing uses this slightly wider rule instead. */
function assertBrowsable(target) {
  const abs = path.resolve(String(target || ''))
  const segments = abs.split(path.sep).filter(Boolean).map((s) => s.toLowerCase())
  if (segments.some((s) => FORBIDDEN_SEGMENTS.has(s)) || isSystemLocation(abs)) {
    throw Object.assign(new Error('该目录不能浏览，请选择一个笔记文件夹'), { status: 400 })
  }
  if (STORAGE_ROOTS.length) {
    const root = path.parse(abs).root
    const onPathToRoot = STORAGE_ROOTS.some((r) => {
      const rr = path.resolve(r)
      return abs === rr || abs.startsWith(rr + path.sep) || rr.startsWith(abs + path.sep)
    })
    if (abs !== root && !onPathToRoot) {
      throw Object.assign(new Error('只能浏览允许的笔记目录'), { status: 400 })
    }
  }
  return abs
}

/** Linux 文件名可以合法包含反斜杠和冒号：只在 Windows 上做分隔符/盘符归一化。
 *  旧代码无条件把 a\b.md 改成 a/b.md，导致这类笔记在 Linux 上永远打不开。 */
function normalizeRelInput(rel) {
  let raw = String(rel || '')
  if (IS_WINDOWS) raw = raw.replace(/\\/g, '/').replace(/^[a-zA-Z]:/, '')
  if (/^file:\/\//i.test(raw)) raw = raw.replace(/^file:\/\//i, '')
  return raw.replace(/^\/+/, '')
}
/** 大小写敏感文件系统可同时存在 Note.md 与 note.md：
 *  跨设备同步时另一台会当成同一篇，创建/重命名前要拦住。 */
function caseClashError(abs) {
  if (!CASE_SENSITIVE_FS) return null
  try {
    const dir = path.dirname(abs)
    const base = path.basename(abs)
    const lower = base.toLowerCase()
    const hit = fs.readdirSync(dir).find((n) => n !== base && n.toLowerCase() === lower)
    if (hit) return Object.assign(new Error(
      `仓库里已有仅大小写不同的「${hit}」。Linux 区分大小写，跨设备同步会当成另一篇笔记；请先重命名其中一份。`), { status: 409 })
  } catch { /* 目录尚不存在：无冲突 */ }
  return null
}

function safeResolve(rel) {
const stripped = normalizeRelInput(rel)
  // An empty path used to resolve to the vault root, which made DELETE /api/file
  // recursively wipe the whole repository. Never allow the root as a note path.
  if (!stripped) {
    throw Object.assign(new Error('路径不能为空或指向仓库根目录'), { status: 400 })
  }
  // Dot folders are internal (history lives in .lumen-history) and are already
  // excluded from the tree. Never let the API read or overwrite them as notes.
  if (stripped.split('/').some((s) => s.startsWith('.'))) {
    throw Object.assign(new Error('隐藏目录不能作为笔记读写'), { status: 400 })
  }
  const abs = path.resolve(VAULT, stripped)
  if (abs === VAULT || !abs.startsWith(VAULT + path.sep)) {
    throw Object.assign(new Error('非法路径'), { status: 400 })
  }
  return abs
}
const relOf = (abs) => path.relative(VAULT, abs).split(path.sep).join('/')
const isLoopback = (ip) =>
  ip === '::1' || ip === '127.0.0.1' || ip.startsWith('::ffff:127.0.0.1')

function lanIps() {
  const out = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address)
    }
  }
  return out
}

/* --------------------------------------------------------------- versions */

const versions = new Map() // rel -> { version, hash, mtime }

async function current(rel) {
  const abs = safeResolve(rel)
  const content = await fsp.readFile(abs, 'utf8')
  const h = hash(content)
  let meta = versions.get(rel)
  if (!meta || meta.hash !== h) {
    const version = meta ? meta.version + 1 : 1
    meta = { version, hash: h, mtime: (await fsp.stat(abs)).mtimeMs }
    versions.set(rel, meta)
  }
  return { path: rel, content, ...meta }
}

/* ------------------------------------------------------------- file tree */

const IGNORE = /^(node_modules|\.git|\.trash|\.DS_Store)$/

async function walk(dir, depth = 0) {
  if (depth > 12) return []
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const nodes = []
  for (const e of entries) {
    if (IGNORE.test(e.name) || e.name.startsWith('.')) continue
    const abs = path.join(dir, e.name)
    const rel = relOf(abs)
    if (e.isDirectory()) {
      const children = await walk(abs, depth + 1)
      let ownMtime = 0
      try { ownMtime = Math.round((await fsp.stat(abs)).mtimeMs) } catch { /* vanished */ }
      // Folders need the same metadata as files so the sidebar can sort by
      // modification time or size without treating every folder as empty.
      nodes.push({
        name: e.name, path: rel, type: 'folder', children,
        size: children.reduce((sum, k) => sum + (k.size || 0), 0),
        mtime: children.reduce((latest, k) => Math.max(latest, k.mtime || 0), ownMtime),
      })
    } else if (e.isFile() && /\.(md|markdown|txt)$/i.test(e.name)) {
      let size = 0
      let mtime = 0
      try { const st = await fsp.stat(abs); size = st.size; mtime = Math.round(st.mtimeMs) } catch { /* vanished */ }
      nodes.push({ name: e.name, path: rel, type: 'file', size, mtime })
    }
  }
  nodes.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name, 'zh-CN') : a.type === 'folder' ? -1 : 1
  )
  return nodes
}

function filterTree(nodes, scope) {
  if (!scope) return nodes
  const s = String(scope).replace(/^\/+/, '')
  if (/\.(md|markdown|txt)$/i.test(s)) {
    const find = (list) => {
      for (const n of list) {
        if (n.path === s && n.type === 'file') return n
        if (n.children) { const r = find(n.children); if (r) return r }
      }
      return null
    }
    const hit = find(nodes)
    return hit ? [hit] : []
  }
  const findFolder = (list) => {
    for (const n of list) {
      if (n.path === s && n.type === 'folder') return n
      if (n.children) { const r = findFolder(n.children); if (r) return r }
    }
    return null
  }
  const hit = findFolder(nodes)
  return hit ? hit.children : []
}

/* ------------------------------------------------------------ attachments */
/*
 * img/ is a plain folder in the vault root. It stays visible in the file
 * tree, but walk() only lists notes, so images never become note entries.
 * Binary files travel over their own raw endpoints — never base64 inside the
 * JSON publish payload (that breaks encoding and hits the 20mb JSON limit).
 * The sync service's vault is the authoritative attachment store: every device
 * publishes its own snapshot here and previews always go through /raw.
 */
const ASSET_ROOT = 'img'
const MAX_ASSET_BYTES = 32 * 1024 * 1024
const ASSET_TOMBSTONE_FILE = '.lumen-vcs/asset-tombstones.json'
/** Only raster/vector IMAGE attachments may be stored. An .html/.js upload
 *  opened through /raw would otherwise execute in the app's own origin. */
const ASSET_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.avif': 'image/avif', '.svg': 'image/svg+xml',
}
function assertAssetExt(rel) {
  const ext = path.extname(String(rel || '')).toLowerCase()
  if (!ASSET_TYPES[ext]) {
    throw Object.assign(new Error('附件只支持常见图片格式'), { status: 400 })
  }
  return ext
}
/** Every byte served for an attachment is sandboxed. `nosniff` stops MIME
 *  guessing, and the CSP sandbox stops a top-level SVG/HTML response from
 *  running script even though it shares the app's origin. */
function guardAttachmentResponse(res, rel) {
  const ext = path.extname(String(rel || '')).toLowerCase()
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'")
  if (ASSET_TYPES[ext]) res.type(ASSET_TYPES[ext])
  else {
    res.type('application/octet-stream')
    res.setHeader('Content-Disposition', 'attachment')
  }
  return ext
}
const assetTombstonePath = () => path.join(VAULT, ASSET_TOMBSTONE_FILE)
/** deviceId -> Map<rel, {hash,size,mtime,at,buf}> : published bytes, memory only.
 *  deviceId comes from the request, so hard caps are mandatory: without them
 *  a caller could mint endless ids and OOM the whole sync service. */
const peerAssets = new Map()
const PEER_ASSET_MAX_DEVICES = 24
const PEER_ASSET_MAX_PER_DEVICE = 64 * 1024 * 1024
const PEER_ASSET_MAX_TOTAL_BYTES = 96 * 1024 * 1024

function assetSafeResolve(rel) {
const stripped = normalizeRelInput(rel)
  const parts = stripped.split('/').filter(Boolean)
  if (parts.length < 2 || parts[0] !== ASSET_ROOT
    || parts.some((s) => s === '..' || s === '.' || s.startsWith('.'))) {
    throw Object.assign(new Error('图片路径必须位于仓库的 img/ 目录内'), { status: 400 })
  }
  const abs = path.resolve(VAULT, parts.join('/'))
  if (!abs.startsWith(path.join(VAULT, ASSET_ROOT) + path.sep)) {
    throw Object.assign(new Error('非法附件路径'), { status: 400 })
  }
  return abs
}
const assetRelOf = (abs) => path.relative(VAULT, abs).split(path.sep).join('/')

/**
 * The note APIs must never write into the attachment tree. On Windows the
 * filesystem folds IMG / "img " / "img." onto the same folder as img/, so a
 * case-sensitive check on the raw query is bypassable: DELETE /api/file would
 * fsp.rm() every picture with no .lumen-history backup and no tombstone.
 * Compare the first segment of the RESOLVED path (so "a/../img/x" is caught
 * too), ignoring case and trailing dots/spaces. A note named img.md is fine.
 */
function isAssetScope(rel) {
const first = normalizeRelInput(rel).split('/')[0]
  return first.replace(/[.\s]+$/g, '').toLowerCase() === ASSET_ROOT.toLowerCase()
}
function assertNotePath(abs) {
  if (isAssetScope(relOf(abs))) {
    throw Object.assign(new Error('附件由笔记管理，不能直接操作 img 目录'), { status: 400 })
  }
}
/** Same guard for version / converge / notify payloads, which name a RELATIVE
 *  path rather than an absolute one. Without it /api/versions/resolve could
 *  delete an attachment with no .lumen-history backup and no asset tombstone. */
function assertNoteRel(rel) {
  assertNotePath(safeResolve(rel))
  return rel
}
/** SHA-1 over raw bytes; fnv1a() is a STRING hash and must never be used here. */
const assetHash = (buf) => crypto.createHash('sha1').update(buf).digest('hex')

async function scanAssets() {
  const out = []
  const visit = async (dir) => {
    let entries
    try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const abs = path.join(dir, e.name)
      if (e.isDirectory()) { await visit(abs); continue }
      if (!e.isFile()) continue
      let st
      try { st = await fsp.stat(abs) } catch { continue }
      if (st.size > MAX_ASSET_BYTES) continue
      const buf = await fsp.readFile(abs).catch(() => null)
      if (!buf) continue
      out.push({ path: assetRelOf(abs), hash: assetHash(buf), size: st.size, mtime: Math.round(st.mtimeMs) })
    }
  }
  await visit(path.join(VAULT, ASSET_ROOT))
  return out
}

async function readAssetTombstones() {
  try {
    const raw = JSON.parse(await fsp.readFile(assetTombstonePath(), 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch { return {} }
}
async function writeAssetTombstones(map) {
  await fsp.mkdir(path.dirname(assetTombstonePath()), { recursive: true })
  await fsp.writeFile(assetTombstonePath(), JSON.stringify(map, null, 2), 'utf8')
}
async function markAssetDeleted(rel, hash, deviceId) {
  const map = await readAssetTombstones()
  map[rel] = { at: now(), hash: String(hash || ''), deviceId: String(deviceId || '') }
  await writeAssetTombstones(map)
}
async function clearAssetTombstone(rel) {
  const map = await readAssetTombstones()
  if (!(rel in map)) return
  delete map[rel]
  await writeAssetTombstones(map)
}

/* ------------------------------------------ orphan attachment retirement */
/*
 * Deleting an image LINK used to leave its file behind forever: img/<note>/
 * kept the bytes, /api/assets still listed them, and the file tree kept
 * showing img/ as an "empty folder" (walk() lists notes only). Retiring now
 * moves the bytes into the vault's hidden history folder and writes a
 * tombstone, so the published cloud inventory drops the picture while old
 * version snapshots still render it through /raw's fallback lookup.
 */
const ASSET_BACKUP_DIR = 'assets'
const assetBackupRoot = () => path.join(historyRoot(), ASSET_BACKUP_DIR)

/** Must match App.tsx insertImageFile() exactly, or the folder never matches. */
function noteAssetDir(rel) {
  const raw = String(rel || '').split('/').pop().replace(/\.(md|markdown|txt)$/i, '') || '未命名'
  return (raw || '未命名')
    .replace(/[\\/:*?"<>|#()\[\]\s]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60) || '未命名'
}

/** Resolve img/... inside the hidden backup folder, never outside it. */
function assetBackupOf(rel) {
const stripped = normalizeRelInput(rel)
  const parts = stripped.split('/').filter(Boolean)
  if (parts[0] !== ASSET_ROOT || parts.some((s) => s === '..' || s === '.' || s.startsWith('.'))) return null
  const abs = path.resolve(assetBackupRoot(), parts.join('/'))
  return abs.startsWith(assetBackupRoot() + path.sep) ? abs : null
}

/** Remove now-empty img/<note>/ folders, but always keep the img/ root. */
async function pruneEmptyAssetDirs(dir) {
  const root = path.join(VAULT, ASSET_ROOT)
  let cur = dir
  while (cur.startsWith(root + path.sep)) {
    const entries = await fsp.readdir(cur).catch(() => null)
    if (!entries || entries.length) break
    await fsp.rmdir(cur).catch(() => {})
    cur = path.dirname(cur)
  }
}

/**
 * Move one attachment out of img/, remember its hash as a tombstone, and
 * prune the folder. Shared by manual deletion, orphan reaping and converge,
 * so every deletion path behaves identically.
 */
async function retireAsset(rel, origin = '') {
  const abs = assetSafeResolve(rel)
  const buf = await fsp.readFile(abs).catch(() => null)
  const hash = buf ? assetHash(buf) : ''
  if (buf) {
    const backup = assetBackupOf(rel)
    if (!backup) throw Object.assign(new Error('非法附件路径'), { status: 400 })
    await fsp.mkdir(path.dirname(backup), { recursive: true })
    await fsp.rm(backup, { force: true }).catch(() => {})
    try {
      await fsp.rename(abs, backup)
    } catch (e) {
      if (e.code === 'ENOENT') return { hash: '', alreadyGone: true }
      // Different volume or a locked backup target: copy, then drop original.
      await fsp.copyFile(abs, backup)
      await fsp.unlink(abs).catch(() => {})
    }
  }
  await markAssetDeleted(rel, hash, origin)
  await pruneEmptyAssetDirs(path.dirname(abs))
  log('info', 'asset', `回收图片 ${rel}${buf ? '（已备份）' : ''}`)
  return { hash, alreadyGone: !buf }
}

/**
 * After a note is written, retire files in its own img/<note>/ folder that no
 * longer appear in ANY note on disk (plain, URI-encoded or decoded form).
 * The whole-vault haystack is deliberate: another note may legitimately link
 * the same picture. Only the saved note's own folder is ever touched.
 */
async function reapOrphanAssets(rel, content, origin = '') {
  const dirName = noteAssetDir(rel)
  const dir = path.join(VAULT, ASSET_ROOT, dirName)
  let entries
  try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return [] }
  const files = entries.filter((e) => e.isFile() && !e.name.startsWith('.'))
  if (!files.length) return []
  const chunks = [String(content ?? '')]
  // The on-disk copy of this note is stale until writeFile finishes, so the
  // freshly saved content above is authoritative for it.
  for (const n of walkFiles(await walk(VAULT))) {
    if (n.path === rel) continue
    chunks.push(await fsp.readFile(safeResolve(n.path), 'utf8').catch(() => ''))
  }
  const haystack = chunks.join('\n').toLowerCase()
  const removed = []
  for (const e of files) {
    const r = assetRelOf(path.join(dir, e.name))
    let decoded = r
    try { decoded = decodeURIComponent(r) } catch { /* keep raw */ }
    const forms = [r, encodeURI(r), decoded]
    if (forms.some((v) => haystack.includes(v.toLowerCase()))) continue
    await retireAsset(r, origin)
    removed.push(r)
  }
  if (removed.length) broadcast({ type: 'tree' })
  return removed
}

const peerAssetBytesOf = (map) => {
  let n = 0
  for (const e of map.values()) n += e.buf?.length || 0
  return n
}
/** Drop the least-recently-published device until the id count is bounded. */
function capPeerDeviceCount(keepId) {
  while (peerAssets.size > PEER_ASSET_MAX_DEVICES) {
    let victim = null, newest = Infinity
    for (const [id, map] of peerAssets) {
      if (id === keepId) continue
      let last = 0
      for (const e of map.values()) last = Math.max(last, e.at || 0)
      if (last < newest) { newest = last; victim = id }
    }
    if (victim === null) break
    peerAssets.delete(victim)
  }
}
/** LRU-ish eviction so the total in-memory attachment cache stays bounded. */
function trimPeerAssets(keepId, keepRel) {
  capPeerDeviceCount(keepId)
  const own = peerAssets.get(keepId)
  if (own) {
    while (peerAssetBytesOf(own) > PEER_ASSET_MAX_PER_DEVICE && own.size > 1) {
      let key = null, at = Infinity
      for (const [rel, e] of own) {
        if (rel === keepRel) continue
        if (e.at < at) { at = e.at; key = rel }
      }
      if (key === null) break
      own.delete(key)
    }
  }
  for (;;) {
    let total = 0, victimId = null, victimRel = null, oldest = Infinity
    for (const [id, map] of peerAssets) {
      for (const [rel, e] of map) {
        total += e.buf?.length || 0
        if (id === keepId && rel === keepRel) continue
        if (e.at < oldest) { oldest = e.at; victimId = id; victimRel = rel }
      }
    }
    if (total <= PEER_ASSET_MAX_TOTAL_BYTES || victimId === null) break
    const map = peerAssets.get(victimId)
    map?.delete(victimRel)
    if (map && !map.size) peerAssets.delete(victimId)
  }
}
function putPeerAsset(deviceId, rel, buf, meta = {}) {
  const id = String(deviceId || '')
  if (!id) return
  if (!peerAssets.has(id)) peerAssets.set(id, new Map())
  peerAssets.get(id).set(rel, {
    hash: assetHash(buf), size: buf.length,
    mtime: Number(meta.mtime || now()), at: now(), buf,
  })
  trimPeerAssets(id, rel)
}
function peerAssetBytes(deviceId, rel) {
  return peerAssets.get(deviceId)?.get(rel)?.buf || null
}

/* ------------------------------------------------------------ auth / pair */

const sessions = new Map() // session -> device
const devices = new Map() // deviceId -> device
/** Per-process credential for the shell this server itself serves. It is
 *  handed out over loopback to a same-origin page only; LAN clients must pair.
 *  Rotates on every restart, so it is never persisted in localStorage. */
const SHELL_TOKEN = crypto.randomBytes(18).toString('hex')

function requestIp(req) {
  // Trust the socket only. A client-supplied X-Forwarded-For must never be
  // able to turn an unpaired LAN request into a loopback (pairing-free) one.
  return req.socket?.remoteAddress || ''
}

function sessionFrom(req) {
  return String(req.headers['x-lumen-session'] || req.query.session || '')
}

function isAuthorized(req) {
  const ip = requestIp(req)
  if (!isLoopback(ip)) return PAIR_MODE === false || sessions.has(sessionFrom(req))
  if (PAIR_MODE === false) return true
  // Loopback alone is no longer proof of being the app's own shell: any page
  // in the browser on this machine can reach 127.0.0.1. A request carrying a
  // foreign Origin must present a paired session (CSRF / cross-site reads).
  const origin = String(req.headers.origin || '')
  if (origin && !sameOrigin(origin, req)) return sessions.has(sessionFrom(req))
  return true
}

/** Only serve the hosts this process actually owns. A foreign domain pointed
 *  at 127.0.0.1 (DNS rebinding) must not inherit loopback's pairing bypass. */
function requestHostOk(req) {
  const host = String(req.headers.host || '').split(':')[0].replace(/^\[|\]$/g, '')
  return host === 'localhost' || isLoopback(host) || lanIps().includes(host)
}

/* 'null' is deliberately NOT here. A sandboxed iframe or a file:// page used
 * to get ACAO: null echoed back, which — combined with loopback's pairing
 * bypass — let any page on this machine read note bodies and write to /api. */
const CORS_ORIGINS = new Set([
  'http://localhost', 'https://localhost',
  'capacitor://localhost', 'ionic://localhost', 'app://localhost',
])
function sameOrigin(origin, req) {
  try { return new URL(origin).host === String(req.headers.host || '') }
  catch { return false }
}
function corsAllowed(origin, req) {
  if (!origin) return true // native shell / curl / same-origin request
  if (CORS_ORIGINS.has(origin)) return true
  try {
    const u = new URL(origin)
    if (['capacitor:', 'ionic:', 'app:'].includes(u.protocol)) return u.hostname === 'localhost'
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    if (u.host === String(req.headers.host || '')) return true
    // Vite dev / preview server while developing the renderer.
    return (isLoopback(u.hostname) || u.hostname === 'localhost')
      && ['5173', '4173'].includes(u.port)
  } catch { return false }
}

/* --------------------------------------------------------------- express */

const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '20mb' }))
app.use((req, res, next) => {
  if (!requestHostOk(req)) return res.status(403).json({ error: 'invalid host' })
  const origin = String(req.headers.origin || '')
  const allowed = corsAllowed(origin, req)
  if (origin && !allowed) return res.status(403).json({ error: 'origin not allowed' })
  if (origin && allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Lumen-Session, X-Lumen-Client')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  // Record failed requests and the few write actions that matter for diagnosis.
  // Only the path is logged (no query strings, so note names stay out of it).
  res.on('finish', () => {
    if (res.statusCode >= 400) log('warn', 'http', `${req.method} ${req.path} -> ${res.statusCode}`)
    else if (req.method !== 'GET' && /^\/api\/(file|versions|storage|push|publish|prefs)/.test(req.path)) {
      log('info', 'http', `${req.method} ${req.path} -> ${res.statusCode}`)
    }
  })
  next()
})

app.get('/health', (_req, res) =>
  res.json({ ok: true, name: 'lumen-sync', version: 1, paired: true, pid: process.pid,
    watcherDegraded: watcherDegraded || null }))

// Public: the pairing handshake itself must be reachable before a session exists.
app.post('/api/pair', (req, res) => {
  const { token, name } = req.body || {}
  if (PAIR_MODE && token !== PAIR_TOKEN) {
    return res.status(403).json({ error: '配对码无效或已过期，请在电脑上重新打开同步面板刷新二维码' })
  }
  const id = crypto.randomUUID()
  const session = crypto.randomBytes(18).toString('hex')
  const device = {
    id,
    name: String(name || '未命名设备').slice(0, 40),
    ip: requestIp(req),
    ua: String(req.headers['user-agent'] || '').slice(0, 160),
    pairedAt: now(),
    lastSeen: now(),
  }
  devices.set(id, device)
  sessions.set(session, { id, device })
  broadcast({ type: 'devices', devices: deviceList() })
  log('info', 'pair', '设备已配对：' + device.name)
  res.json({ session, device, pairToken: PAIR_TOKEN })
})

app.get('/api/info', (req, res) => {
  // Only paired devices may enumerate LAN addresses / the current pairing token.
  if (!isAuthorized(req)) return res.status(401).json({ error: 'unpaired' })
  const ips = lanIps()
  const urls = ips.map((ip) => `http://${ip}:${PORT}`)
  res.json({
    port: PORT,
    urls,
    primaryUrl: urls[0] || `http://127.0.0.1:${PORT}`,
    pairToken: PAIR_TOKEN,
    pairRequired: PAIR_MODE,
    vault: VAULT,
    devices: deviceList(),
    distReady: fs.existsSync(path.join(DIST, 'index.html')),
    historyLimit: historyLimit(),
    hiddenFolder: HISTORY_FOLDER,
    desktop: process.env.LUMEN_DESKTOP === '1',
  })
})

app.get('/api/devices', (req, res) => {
  if (!isAuthorized(req)) return res.status(401).json({ error: 'unpaired' })
  res.json({ devices: deviceList() })
})

app.delete('/api/devices/:id', (req, res) => {
  if (!isAuthorized(req)) return res.status(401).json({ error: 'unpaired' })
  devices.delete(req.params.id)
  for (const [s, v] of sessions) if (v.id === req.params.id) sessions.delete(s)
  broadcast({ type: 'devices', devices: deviceList() })
  res.json({ ok: true })
})

app.use('/api', (req, res, next) => {
  if (!isAuthorized(req)) return res.status(401).json({ error: 'unpaired', pairTokenNeeded: true })
  next()
})

/** Local shell credential for its own WebSocket. A foreign page cannot read
 *  this JSON (CORS), and a LAN client is refused outright — it still has to
 *  pair. Never cached: the service worker excludes /api/*. */
app.get('/api/shell-token', (req, res) => {
  if (!isLoopback(requestIp(req))) return res.status(403).json({ error: '仅限本机外壳' })
  const origin = String(req.headers.origin || '')
  if (origin && !sameOrigin(origin, req)) return res.status(403).json({ error: '仅限本机外壳' })
  res.setHeader('Cache-Control', 'no-store')
  res.json({ token: SHELL_TOKEN })
})

function deviceList() {
  return [...devices.values()].sort((a, b) => a.pairedAt - b.pairedAt)
}

app.get('/api/tree', async (req, res) => {
  try {
    const tree = filterTree(await walk(VAULT), req.query.scope || '')
    res.json({ tree, vault: path.basename(VAULT) })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

/**
 * Content-fingerprint inventory of the whole vault. A fetch compares this
 * against the device's own copy and only transfers files whose hash differs,
 * so unchanged / already-present notes are never sent again.
 * Fingerprints use the exact same fnv1a as src/lib/hash.ts.
 */
const manifestCache = new Map()
const walkFiles = (nodes, out = []) => {
  for (const n of nodes) {
    if (n.type === 'file') out.push(n)
    else if (n.children) walkFiles(n.children, out)
  }
  return out
}

app.get('/api/manifest', async (req, res) => {
  try {
    const scope = String(req.query.scope || '')
    const files = walkFiles(filterTree(await walk(VAULT), scope))
    const items = []
    for (const f of files) {
      let st
      try { st = await fsp.stat(safeResolve(f.path)) } catch { continue }
      const size = st.size
      const mtime = Math.round(st.mtimeMs)
      const cached = manifestCache.get(f.path)
      let hash
      if (cached && cached.size === size && cached.mtime === mtime) {
        hash = cached.hash
      } else {
        const content = await fsp.readFile(safeResolve(f.path), 'utf8')
        hash = fnv1a(content)
        manifestCache.set(f.path, { size, mtime, hash })
      }
      items.push({ path: f.path, hash, size, mtime })
    }
    res.json({ files: items, vault: path.basename(VAULT) })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

/* ---------------------- binary attachment transport (never JSON) ---------------------- */
const rawAssetBody = express.raw({
  type: ['application/octet-stream', 'image/*', 'application/pdf', 'application/zip'],
  limit: '40mb',
})

/** Inventory of this vault's img/ plus the deletion markers to publish. */
app.get('/api/assets', async (_req, res) => {
  try {
    const graves = await readAssetTombstones()
    res.json({
      assets: await scanAssets(),
      tombstones: Object.entries(graves).map(([path, t]) => ({
        path, at: Number(t?.at || 0), hash: String(t?.hash || ''),
        deviceId: String(t?.deviceId || ''),
      })),
    })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

/** Read a local attachment as raw bytes (editor insert / peer download). */
app.get('/api/asset', async (req, res) => {
  try {
    const abs = assetSafeResolve(String(req.query.path || ''))
    const buf = await fsp.readFile(abs)
    guardAttachmentResponse(res, abs)
    res.send(buf)
  } catch (e) {
    res.status(e.code === 'ENOENT' ? 404 : (e.status || 400)).json({ error: e.message })
  }
})

/** Read bytes published by another device, without touching this vault. */
app.get('/api/asset/peer', (req, res) => {
  const rel = String(req.query.path || '')
  const deviceId = String(req.query.deviceId || '')
  let entry = null
  if (deviceId) entry = peerAssets.get(deviceId)?.get(rel) || null
  else {
    for (const [id, map] of peerAssets.entries()) {
      if (id === String(req.query.selfId || '')) continue
      const e = map.get(rel)
      if (e && (!entry || e.at > entry.at)) entry = e
    }
  }
  if (!entry) return res.sendStatus(404)
  guardAttachmentResponse(res, rel)
  res.send(entry.buf)
})

/** Editor insert (or convergent copy): write bytes into this vault's img/. */
app.put('/api/asset', rawAssetBody, async (req, res) => {
  try {
    const abs = assetSafeResolve(String(req.query.path || ''))
    assertAssetExt(abs)
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
    if (!buf.length) return res.status(400).json({ error: '附件内容为空' })
    if (buf.length > MAX_ASSET_BYTES) return res.status(413).json({ error: '单个附件不能超过 32 MB' })
    await fsp.mkdir(path.dirname(abs), { recursive: true })
    await fsp.writeFile(abs, buf)
    const rel = assetRelOf(abs)
    await clearAssetTombstone(rel)
    log('info', 'asset', `写入图片 ${rel}（${buf.length} B）`)
    res.json({ path: rel, hash: assetHash(buf), size: buf.length, mtime: Date.now() })
  } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
})

/** Publish this device's attachment bytes to the post office (memory only). */
app.put('/api/asset/peer', rawAssetBody, (req, res) => {
  try {
    const rel = assetRelOf(assetSafeResolve(String(req.query.path || '')))
    assertAssetExt(rel)
    const deviceId = String(req.query.deviceId || vcsOrigin(req) || '')
    if (!deviceId) return res.status(400).json({ error: '缺少设备标识' })
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
    if (!buf.length) return res.status(400).json({ error: '附件内容为空' })
    if (buf.length > MAX_ASSET_BYTES) return res.status(413).json({ error: '单个附件不能超过 32 MB' })
    putPeerAsset(deviceId, rel, buf, { mtime: Number(req.query.mtime || 0) })
    res.json({ ok: true, path: rel, hash: assetHash(buf), size: buf.length })
  } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
})

/** Deleting an attachment writes a tombstone so it does not come back. */
app.delete('/api/asset', async (req, res) => {
  try {
    const abs = assetSafeResolve(String(req.query.path || ''))
    const out = await retireAsset(assetRelOf(abs), vcsOrigin(req))
    if (!out.alreadyGone) broadcast({ type: 'tree' })
    res.json({ ok: true, alreadyGone: out.alreadyGone })
  } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
})

app.get('/api/file', async (req, res) => {
  try {
    const rel = String(req.query.path || '')
    res.json(await current(rel))
  } catch (e) { res.status(e.code === 'ENOENT' ? 404 : 400).json({ error: e.message }) }
})

/**
 * Shared write path for both a normal save and an explicit single-file push.
 * The three-way check uses content hashes (never version numbers, which reset
 * on restart). `force` is only ever set by an explicit "this device wins"
 * action, and every overwrite leaves a snapshot in .lumen-history first.
 */
async function commitFile(rel, body, opts = {}) {
  const abs = safeResolve(rel)
  assertNotePath(abs)
  const cur = await current(rel).catch(() => null)
  const content = String(body?.content ?? '')
  const baseHash = String(body?.baseHash || '')
  const force = body?.force === true || body?.force === '1' || opts.force === true
  if (cur) {
    const diskHash = fnv1a(cur.content)
    const incomingHash = fnv1a(content)
    // Old baseHash values are pre-normalization fingerprints; treat them as a
    // match for the unchanged disk content instead of raising a false conflict.
    const diskUnchangedFromBase = baseHash === diskHash || baseHash === fnv1aLegacy(cur.content)
    const changed = baseHash ? !diskUnchangedFromBase && diskHash !== incomingHash : true
    if (changed && !force) return { conflict: cur }
    if (diskHash === incomingHash) {
      // Reaping on an unchanged save too: it is idempotent and clears img/
      // leftovers written by older builds that never retired orphaned images.
      await reapOrphanAssets(rel, content, opts.origin || '').catch(() => [])
      return { doc: { ...cur, unchanged: true }, skipped: true }
    }
    await recordHistory(rel, cur.content, cur.version,
      opts.reason || (force ? '同步覆盖前' : '保存前'), opts.origin || '')
  }
  const h = hash(content)
  await fsp.mkdir(path.dirname(abs), { recursive: true })
  await fsp.writeFile(abs, content, 'utf8')
  // Save is authoritative: retire pictures this note no longer links, back
  // them up for old version snapshots, and publish tombstones for the cloud.
  if (cur) await reapOrphanAssets(rel, content, opts.origin || '').catch(() => [])
  const version = (cur?.version || 0) + 1
  const meta = { version, hash: h, mtime: now() }
  versions.set(rel, meta)
  return { doc: { path: rel, content, ...meta }, skipped: false }
}

app.put('/api/file', async (req, res) => {
  try {
    const rel = String(req.query.path || '')
    const origin = String(req.headers['x-lumen-client'] || '')
    const out = await commitFile(rel, req.body, { origin })
    if (out.conflict) return res.status(409).json({ conflict: true, server: out.conflict, error: '文件已在其他设备更新' })
    // A converge write-back is not a fresh user edit — don't broadcast it as
    // one, or the peer shows a bogus "仓库有文件更新" hint right after 拉取.
    if (!out.skipped && req.body?.silent !== true) broadcast({ type: 'file', ...out.doc, origin })
    res.json(out.doc)
  } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
})

/**
 * Explicit single-file sync: "whichever device presses 同步 pushes the file it
 * has open to the other side". No direction picker, no queue, no scope.
 * The server writes the vault copy (so the desktop .md is really updated) and
 * broadcasts a `pushFile` event that peers accept even in manual mode.
 */
app.post('/api/push', async (req, res) => {
  try {
    const rel = String(req.body?.path || '')
    if (!rel) return res.status(400).json({ error: '没有指定要同步的文件' })
    const origin = String(req.headers['x-lumen-client'] || '')
    // An explicit button press is authoritative (force). Autosync reuses this
    // endpoint with force:false so the normal three-way conflict check applies.
    const force = req.body?.force !== false
    const out = await commitFile(rel, req.body, { force, reason: '同步覆盖前', origin })
    if (out.conflict) return res.status(409).json({ conflict: true, server: out.conflict, error: '文件已在其他设备更新' })
    // Only pushFile is broadcast: it is unscoped (a subscribed client must not
    // miss an explicit sync) and peers accept it even in manual mode. Sending
    // `file` too would double-apply and show a misleading "there are updates"
    // hint for an action the user just explicitly performed.
    broadcast({ type: 'pushFile', ...out.doc, from: origin, at: now(), reason: '单文件同步' })
    res.json({ ...out.doc, pushed: true, peers: wss.clients.size })
  } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
})

/* ---------------------------------------------------------- user prefs */

app.get('/api/prefs', (_req, res) => res.json({
  historyLimit: historyLimit(),
  historyDir: historyRoot(),
  hiddenFolder: HISTORY_FOLDER,
  maxHistoryLimit: VERSION_LIMIT,
}))

// 保留次数已固定为 15，不再允许任何客户端改写配置。
app.post('/api/prefs', (_req, res) => res.status(400).json({
  error: '历史版本保留次数已固定为 15，不可调整',
  historyLimit: VERSION_LIMIT,
}))

app.post('/api/file', async (req, res) => {
  try {
    let rel = normalizeRelInput(req.body?.path || '未命名.md')
    if (!/\.(md|markdown|txt)$/i.test(rel)) rel += '.md'
    const abs = safeResolve(rel)
    assertNotePath(abs)
    if (fs.existsSync(abs)) return res.status(409).json({ error: '同名文件已存在' })
    const clash = caseClashError(abs)
    if (clash) return res.status(409).json({ error: clash.message })
    const created = String(req.body?.content ?? '')
    await fsp.mkdir(path.dirname(abs), { recursive: true })
    await fsp.writeFile(abs, created, 'utf8')
    await recordHistory(rel, created, 1, '新建笔记', String(req.headers['x-lumen-client'] || ''))
    versions.set(rel, { version: 1, hash: hash(created), mtime: now() })
    broadcast({ type: 'tree' })
    res.json({ path: rel })
  } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
})

app.post('/api/folder', async (req, res) => {
  try {
    const abs = safeResolve(String(req.body?.path || ''))
    assertNotePath(abs)
    await fsp.mkdir(abs, { recursive: true })
    broadcast({ type: 'tree' })
    res.json({ ok: true })
  } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
})

app.patch('/api/file', async (req, res) => {
  try {
    const from = safeResolve(String(req.body?.path || ''))
    const to = safeResolve(String(req.body?.newPath || ''))
    assertNotePath(from)
    assertNotePath(to)
    if (path.resolve(from) !== path.resolve(to)) {
      const clash = caseClashError(to)
      if (clash) return res.status(409).json({ error: clash.message })
    }
    await fsp.mkdir(path.dirname(to), { recursive: true })
    await fsp.rename(from, to)
    versions.delete(relOf(from))
    broadcast({ type: 'tree' })
    res.json({ ok: true, path: relOf(to) })
  } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
})

app.delete('/api/file', async (req, res) => {
  try {
    const abs = safeResolve(String(req.query.path || ''))
    // Guard BEFORE the ENOENT branch: a case/whitespace variant of img/ that
    // does not exist must not write a tombstone for a bogus path either.
    assertNotePath(abs)
    const origin = String(req.headers['x-lumen-client'] || '')
    let st = null
    try { st = await fsp.stat(abs) }
    catch (e) { if (e.code !== 'ENOENT') throw e }
    // 磁盘上已经没有这个路径（例如收敛时已被对端删掉）不算失败：删除是幂等的，
    // 仍然要写墓碑让删除传播，前端也才能继续清理自己的工作副本。
    if (!st) {
      const prior = await peekVersions(relOf(abs))
      if (!prior.tombstone) await markDeleted(relOf(abs), origin).catch(() => {})
      versions.delete(relOf(abs))
      manifestCache.delete(relOf(abs))
      broadcast({ type: 'tree' })
      return res.json({ ok: true, alreadyGone: true })
    }
    const deletedPaths = []
    if (st.isDirectory()) {
      const snapshot = async (dir) => {
        for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name)
          if (e.isDirectory()) await snapshot(p)
          else if (/\.(md|markdown|txt)$/i.test(e.name)) {
            deletedPaths.push(relOf(p))
            await recordHistory(relOf(p), await fsp.readFile(p, 'utf8').catch(() => ''), 0, '删除前', origin)
          }
        }
      }
      await snapshot(abs)
      await fsp.rm(abs, { recursive: true, force: true })
    } else {
      deletedPaths.push(relOf(abs))
      await recordHistory(relOf(abs), await fsp.readFile(abs, 'utf8').catch(() => ''), 0, '删除前', origin)
      await fsp.unlink(abs)
    }
    versions.delete(relOf(abs))
    // Tombstones make the deletion converge on the other device instead of the
    // note being copied back on the next 拉取.
    for (const rel of deletedPaths) await markDeleted(rel, origin).catch(() => {})
    broadcast({ type: 'tree' })
    res.json({ ok: true })
  } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
})

/* ------------------------------------------------------- storage location */

function canChangeStorage(req) {
  return isLoopback(requestIp(req)) || REMOTE_STORAGE
}

function windowsDrives() {
  if (process.platform !== 'win32') return []
  const out = []
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZAB') {
    const p = `${letter}:\\`
    try { if (fs.existsSync(p)) out.push({ name: `${letter}: 盘`, path: p }) } catch { /* ignore */ }
  }
  return out
}

app.get('/api/storage', (req, res) => {
  res.json({
    vault: VAULT,
    vaultName: path.basename(VAULT),
    defaultVault: DEFAULT_VAULT,
    home: os.homedir(),
    configFile: CONFIG_FILE,
    canChange: canChangeStorage(req),
    restrictedRoots: STORAGE_ROOTS,
  })
})

/** Read-only listing for the folder picker: directory names only, no content. */
app.get('/api/storage/browse', async (req, res) => {
  try {
    const requested = String(req.query.path || '')
    const target = requested ? path.resolve(requested) : path.resolve(os.homedir())
    // An authorised peer must not be able to enumerate C:\Windows etc. just
    // by naming a path. Check the target BEFORE reading it, and check every
    // directory we hand back so the picker cannot climb into a forbidden tree.
    try { assertBrowsable(target) }
    catch (e) { return res.status(e.status || 400).json({ error: e.message }) }
    let entries
    try { entries = await fsp.readdir(target, { withFileTypes: true }) }
    catch (e) { return res.status(400).json({ error: `无法读取目录：${e.message}` }) }
    const dirs = []
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || FORBIDDEN_SEGMENTS.has(e.name.toLowerCase())) continue
      const child = path.join(target, e.name)
      try { assertBrowsable(child) } catch { continue }
      dirs.push({ name: e.name, path: child })
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
    let selectable = true
    try { assertStoragePath(target) } catch { selectable = false }
    res.json({
      path: target,
      parent: path.dirname(target) === target ? null : path.dirname(target),
      root: path.parse(target).root,
      dirs,
      drives: windowsDrives(),
      selectable,
      notes: entries.filter((e) => e.isFile() && /\.(md|markdown|txt)$/i.test(e.name)).length,
    })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

/** Copy markdown files into the new vault without overwriting anything there. */
async function migrateVault(from, to) {
  let count = 0
  async function copyDir(src) {
    const list = await fsp.readdir(src, { withFileTypes: true }).catch(() => [])
    for (const e of list) {
      if (e.name.startsWith('.')) continue
      const s = path.join(src, e.name)
      const d = path.join(to, path.relative(from, s))
      if (e.isDirectory()) await copyDir(s)
      else if (e.isFile() && /\.(md|markdown|txt)$/i.test(e.name)) {
        if (fs.existsSync(d)) continue
        await fsp.mkdir(path.dirname(d), { recursive: true })
        await fsp.copyFile(s, d)
        count++
      }
    }
  }
  await copyDir(from)
  return count
}

app.post('/api/storage', async (req, res) => {
  try {
    if (!canChangeStorage(req)) {
      return res.status(403).json({
        error: '出于安全考虑，保存位置只能在电脑上修改。若确实需要手机端修改，请设置 LUMEN_REMOTE_STORAGE=1 后重启服务。',
      })
    }
    const target = String(req.body?.path || '').trim()
    if (!target) return res.status(400).json({ error: '请填写保存位置' })
    const abs = assertStoragePath(target)
    if (abs === VAULT) return res.json({ vault: VAULT, changed: false, migrated: 0 })
    await fsp.mkdir(abs, { recursive: true })
    // Resolve symlinks before re-checking the whitelist.
    const real = await fsp.realpath(abs).catch(() => abs)
    if (STORAGE_ROOTS.length && !STORAGE_ROOTS.some((r) => real === r || real.startsWith(r + path.sep))) {
      throw Object.assign(new Error('该目录指向了允许范围之外'), { status: 400 })
    }
    const probe = path.join(abs, `.lumen-write-${process.pid}`)
    await fsp.writeFile(probe, 'ok', 'utf8')
    await fsp.unlink(probe).catch(() => {})

    const migrated = req.body?.migrate ? await migrateVault(VAULT, abs) : 0
    const previous = VAULT
    VAULT = abs
    versions.clear()
    manifestCache.clear()
    if (typeof peerCloud !== 'undefined') peerCloud.clear()
    writeConfig({ vault: abs, updatedAt: now() })
    // The hidden history and version-chain folders belong to the new vault too.
    await ensureHistoryDir()
    await ensureVcsDir()
    await fsp.mkdir(path.join(VAULT, 'img'), { recursive: true })
    await restartWatcher()
    broadcast({ type: 'vault', vault: VAULT, name: path.basename(VAULT), previous })
    broadcast({ type: 'tree' })
    const msg = `vault: ${previous} -> ${VAULT} (migrated ${migrated} notes)`
    console.log(`[storage] ${msg}`)
    log('info', 'storage', '仓库已切换：' + msg)
    res.json({ vault: VAULT, vaultName: path.basename(VAULT), changed: true, migrated })
  } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
})

/* ------------------------------------------------------- version history API */

app.get('/api/history', async (req, res) => {
  try {
    const rel = String(req.query.path || '')
    res.json({ versions: await listHistory(rel) })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

app.get('/api/history/content', async (req, res) => {
  try {
    const entry = JSON.parse(await fsp.readFile(historyFile(req.query.id), 'utf8'))
    res.json(entry)
  } catch (e) { res.status(e.status || 404).json({ error: e.message }) }
})

app.post('/api/history/restore', async (req, res) => {
  try {
    const entry = JSON.parse(await fsp.readFile(historyFile(req.body?.id), 'utf8'))
    const rel = entry.path
    const abs = safeResolve(rel)
    const cur = await current(rel).catch(() => null)
    if (cur && cur.content !== entry.content) {
      await recordHistory(rel, cur.content, cur.version, '恢复前', String(req.headers['x-lumen-client'] || ''))
    }
    await fsp.mkdir(path.dirname(abs), { recursive: true })
    await fsp.writeFile(abs, entry.content, 'utf8')
    const version = (cur?.version || 0) + 1
    const meta = { version, hash: hash(entry.content), mtime: now() }
    versions.set(rel, meta)
    const payload = { path: rel, content: entry.content, ...meta }
    broadcast({ type: 'file', ...payload, origin: String(req.headers['x-lumen-client'] || '') })
    res.json(payload)
  } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
})

app.delete('/api/history', async (req, res) => {
  try {
    await fsp.unlink(historyFile(req.query.id))
    res.json({ ok: true })
  } catch (e) { res.status(e.status || 404).json({ error: e.message }) }
})

/* ------------------------------------- versions: 本地仓库 + 本设备云仓库 */

// One JSON file per note, stored INSIDE the vault so versions travel with the
// notes. Shape: { path, baseHash, local:{versions:[]}, cloud:{versions:[]} }.
// There are no chains and no forks: `local` is this device's save timeline and
// `cloud` is this device's own published copy. Peer devices publish their
// cloud copy over REST while connected; 拉取 compares, the user picks a
// version, and that content becomes the new shared baseHash.
const VCS_FOLDER = '.lumen-vcs'
const vcsRoot = () => path.join(VAULT, VCS_FOLDER)
const vcsFileFor = (rel) =>
  path.join(vcsRoot(), `${crypto.createHash('sha1').update(String(rel)).digest('hex')}.json`)
const versionId = () => `v${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`

async function ensureVcsDir() {
  const dir = vcsRoot()
  await fsp.mkdir(dir, { recursive: true })
  if (process.platform === 'win32') {
    await new Promise((resolve) => execFile('attrib', ['+h', dir], () => resolve()))
  }
  return dir
}
await ensureVcsDir()

const makeRecord = (content, source, message, reason, at = now()) => ({
  id: versionId(), at, hash: fnv1a(String(content ?? '')),
  content: String(content ?? ''), message: String(message || '保存'),
  reason: String(reason || '保存'), source,
})

const emptyVersions = (rel, content, at = now()) => ({
  path: rel,
  baseHash: fnv1a(String(content ?? '')),
  local: { versions: [makeRecord(content, 'local', '初始版本', '初始化', at)], updatedAt: at },
  cloud: { versions: [], updatedAt: 0 },
})

/**
 * Old files had three chains all pointing at ONE root commit. Keeping them
 * made the UI claim "云·电脑链 1 个版本 / 云·手机链 1 个版本" even though no
 * sync ever happened. Migrate to a single local version and an EMPTY cloud.
 */
function migrateVersions(raw, rel) {
  const commits = Array.isArray(raw?.commits) ? raw.commits : []
  const newest = commits.reduce(
    (a, b) => (Number(b?.at || 0) > Number(a?.at || 0) ? b : a), commits[0] || {},
  )
  const content = String(newest?.content ?? '')
  const at = Number(newest?.at || now())
  return {
    path: rel,
    baseHash: fnv1a(content),
    local: {
      versions: [{
        id: String(newest?.id || versionId()), at, hash: fnv1a(content), content,
        message: String(newest?.message || '初始版本'),
        reason: String(newest?.reason || '初始化'), source: 'local',
      }],
      updatedAt: at,
    },
    cloud: { versions: [], updatedAt: 0 },
  }
}

async function readVersions(rel, content = '') {
  try {
    const raw = JSON.parse(await fsp.readFile(vcsFileFor(rel), 'utf8'))
    if (raw && raw.local && raw.cloud && Array.isArray(raw.local.versions)) return raw
    if (raw && Array.isArray(raw.commits)) {
      const next = migrateVersions(raw, rel)
      await writeVersions(rel, next)
      return next
    }
  } catch { /* not created yet */ }
  const next = emptyVersions(rel, content)
  await writeVersions(rel, next)
  return next
}

async function writeVersions(rel, state) {
  await ensureVcsDir()
  await fsp.writeFile(vcsFileFor(rel), JSON.stringify(state), 'utf8')
  return state
}

function appendVersion(state, source, content, message, reason, deviceId) {
  const rec = makeRecord(content, source, message, reason)
  const bucket = source === 'cloud' ? state.cloud : state.local
  const nextBucket = {
    versions: [rec, ...(bucket?.versions || [])].slice(0, VERSION_LIMIT),
    deviceId: deviceId || bucket?.deviceId,
    updatedAt: rec.at,
  }
  return { state: { ...state, [source]: nextBucket }, record: rec }
}

/** Cloud copies published by OTHER devices while connected. In-memory only:
 *  a device republishes on connect, so nothing stale survives a restart. */
const peerCloud = new Map()
const vcsOrigin = (req) => String(req.headers['x-lumen-client'] || '')
const vcsChanged = (req, rel) =>
  broadcast({ type: 'vcs', path: rel, origin: vcsOrigin(req), at: now() })

app.get('/api/versions', async (req, res) => {
  try {
    const rel = String(req.query.path || '')
    // Reading a version is a READ. It must never create/rewrite a .lumen-vcs
    // file, and an img/ path must never be interpreted as a note (binary bytes
    // used to be stuffed into the version JSON as utf8 text).
    assertNoteRel(rel)
    const cur = await current(rel).catch(() => null)
    let state = await peekVersions(rel)
    // A note that has never been saved has no version file. Synthesise its
    // initial version IN MEMORY so the history panel still shows the disk
    // content — without the write side effect readVersions() used to have.
    if (cur && !state.tombstone && !state.local?.versions?.length) {
      state = emptyVersions(rel, cur.content)
    }
    res.json({
      path: rel, baseHash: state.baseHash || '',
      local: state.local, cloud: state.cloud,
      ...(state.tombstone ? { tombstone: state.tombstone } : {}),
    })
  } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
})

/** 保存 → 本地仓库时间线。Same content twice is not recorded again. */
app.post('/api/versions/commit', async (req, res) => {
  try {
    const rel = String(req.body?.path || '')
    if (!rel) return res.status(400).json({ error: '没有指定笔记' })
    const content = String(req.body?.content ?? '')
    let state = await readVersions(rel, content)
    const head = state.local.versions?.[0]
    if (head && head.hash === fnv1a(content)) return res.json({ state, skipped: true })
    state = appendVersion(state, 'local', content,
      req.body?.message || '保存', req.body?.reason || '保存').state
    await writeVersions(rel, state)
    vcsChanged(req, rel)
    res.json({ state, skipped: false })
  } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
})

/** 同步 = 把当前内容发布到本设备自己的云仓库。离线时前端排队补推。 */
app.post('/api/versions/sync', async (req, res) => {
  try {
    const rel = String(req.body?.path || '')
    if (!rel) return res.status(400).json({ error: '没有指定笔记' })
    const content = String(req.body?.content ?? '')
    let state = await readVersions(rel, content)
    const head = state.cloud.versions?.[0]
    if (head && head.hash === fnv1a(content)) return res.json({ state, skipped: true })
    state = appendVersion(state, 'cloud', content, '同步', '同步到云仓库',
      String(req.body?.deviceId || '')).state
    await writeVersions(rel, state)
    vcsChanged(req, rel)
    res.json({ state, skipped: false })
  } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
})

/** 连接成功后，对端把自己的云仓库发布过来；只进内存，绝不写本地 .md。
 *  tombstones 让「一端删了笔记」不会被另一端当新文件拷回来。即便两清单
 *  都为空也要登记设备，否则收敛无法判断有没有对端在线。 */
app.post('/api/versions/publish', async (req, res) => {
  try {
    // Only this machine (loopback) or an already paired device may publish a
    // cloud snapshot; an arbitrary LAN client must not register a phantom peer.
    if (!isLoopback(requestIp(req)) && !sessions.has(sessionFrom(req))) {
      return res.status(401).json({ error: 'unpaired' })
    }
    const deviceId = String(req.body?.deviceId || '')
    if (!deviceId) return res.status(400).json({ error: '缺少设备标识' })
    const docs = Array.isArray(req.body?.docs) ? req.body.docs : []
    const tombstones = Array.isArray(req.body?.tombstones) ? req.body.tombstones : []
    // An old client omits `assets` entirely. That must NOT be read as "the
    // peer deleted every attachment", so only converge peers that sent it.
    const sentAssets = Array.isArray(req.body?.assets)
    const assets = sentAssets ? req.body.assets : []
    const assetGraves = Array.isArray(req.body?.assetTombstones) ? req.body.assetTombstones : []
    const map = new Map()
    for (const d of docs) {
      const p = String(d?.path || '')
      if (!p) continue
      // A published cloud snapshot is untrusted input: img/ paths are handled
      // by the attachment protocol, never by the note version chain.
      try { assertNoteRel(p) } catch { continue }
      map.set(p, {
        hash: String(d.hash || fnv1a(String(d.content ?? ''))),
        content: String(d.content ?? ''),
        at: Number(d.at || now()),
        baseHash: String(d.baseHash || ''),
      })
    }
    const graves = new Map()
    for (const t of tombstones) {
      const p = String(t?.path || '')
      if (!p) continue
      try { assertNoteRel(p) } catch { continue }
      graves.set(p, { at: Number(t.at || now()), deviceId: String(t.deviceId || deviceId) })
    }
    const assetMap = new Map()
    for (const a of assets) {
      const p = String(a?.path || '')
      if (!p) continue
      assetMap.set(p, {
        hash: String(a.hash || ''), size: Number(a.size || 0),
        mtime: Number(a.mtime || 0), at: now(),
      })
    }
    const assetTombs = new Map()
    for (const t of assetGraves) {
      const p = String(t?.path || '')
      if (!p) continue
      assetTombs.set(p, {
        at: Number(t.at || now()), hash: String(t.hash || ''),
        deviceId: String(t.deviceId || deviceId),
      })
    }
    // Drop bytes for attachments the peer no longer lists; otherwise a stale
    // in-memory copy would look like "the peer still has this file" forever.
    if (sentAssets) {
      const held = peerAssets.get(deviceId) || new Map()
      for (const key of [...held.keys()]) if (!assetMap.has(key)) held.delete(key)
      peerAssets.set(deviceId, held)
      capPeerDeviceCount(deviceId)
    }
    peerCloud.set(deviceId, {
      deviceId, deviceName: String(req.body?.deviceName || deviceId),
      at: now(), docs: map, tombstones: graves,
      hasAssets: sentAssets, assets: assetMap, assetTombstones: assetTombs,
    })
    res.json({ ok: true, count: map.size + graves.size + assetMap.size + assetTombs.size })
  } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
})

app.get('/api/versions/peers', (req, res) => {
  // The desktop renderer's socket is loopback, so include it here: phones need
  // to read the desktop's own cloud snapshot, but never a phantom device.
  const online = onlinePeerIds(true)
  const peers = [...peerCloud.values()].filter((p) => online.has(p.deviceId)).map((p) => ({
    deviceId: p.deviceId, deviceName: p.deviceName, at: p.at,
    docs: [...p.docs.entries()].map(([path, d]) => ({ path, ...d })),
    tombstones: [...(p.tombstones || new Map()).entries()].map(([path, t]) => ({ path, ...t })),
    hasAssets: !!p.hasAssets,
    assets: [...(p.assets || new Map()).entries()].map(([path, a]) => ({ path, ...a })),
    assetTombstones: [...(p.assetTombstones || new Map()).entries()].map(([path, t]) => ({ path, ...t })),
  }))
  res.json({ peers })
})

async function localTombstones() {
  const out = []
  let names = []
  try { names = await fsp.readdir(vcsRoot()) } catch { return out }
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    let raw
    try { raw = JSON.parse(await fsp.readFile(path.join(vcsRoot(), name), 'utf8')) } catch { continue }
    const rel = String(raw?.path || '')
    if (!rel || !raw?.tombstone || fs.existsSync(safeResolve(rel))) continue
    out.push({
      path: rel, at: Number(raw.tombstone.at || 0),
      deviceId: String(raw.tombstone.deviceId || ''),
    })
  }
  return out
}

/** This device's own deletion markers, sent along with its cloud publish. */
app.get('/api/versions/tombstones', async (_req, res) => {
  try { res.json({ tombstones: await localTombstones() }) }
  catch (e) { res.status(500).json({ error: e.message }) }
})

/* ------------------------------------------------------------------------- *
 * 整仓收敛 (拉取)
 *
 * 一端 = 本设备的真实 .md + 本设备 .lumen-vcs 里的删除墓碑；
 * 对端 = 连接后 publish 过来的云仓库副本（内存 Map）。
 * 逐篇按内容 hash 判定，绝不用文件名当判据：
 *   两端 hash 相同       → 跳过（顺手对齐双方云仓库最新内容）
 *   只有一端有           → 直接拷贝，另一端新建 .md
 *   一端删 / 另一端没改  → 墓碑传播，两端都删（删前留 .lumen-history 快照）
 *   一端删 / 另一端改了  → 弹框（含「删了又新建同名」）
 *   两端都有但 hash 不同 → 一律弹框，不自动快进
 * 收敛后本设备 .md、本设备云仓库、对端云仓库副本、baseHash 全部一致。
 * ------------------------------------------------------------------------- */

/** Called by DELETE /api/file: a user deletion must travel to the other device. */
async function markDeleted(rel, origin) {
  let state = await readVersions(rel, '')
  state = appendVersion(state, 'local', '', '已删除', '本端删除').state
  state.local.versions[0].deleted = true
  state = { ...state, tombstone: { at: now(), deviceId: origin, content: '' } }
  await writeVersions(rel, state)
  manifestCache.delete(rel)
}

/** Read a version file WITHOUT creating a phantom file for notes we do not own. */
async function peekVersions(rel) {
  try {
    const raw = JSON.parse(await fsp.readFile(vcsFileFor(rel), 'utf8'))
    if (raw && raw.local && raw.cloud && Array.isArray(raw.local.versions)) return raw
    if (raw && Array.isArray(raw.commits)) return migrateVersions(raw, rel)
  } catch { /* not created yet */ }
  return { path: rel, baseHash: '', local: { versions: [] }, cloud: { versions: [] } }
}

async function localInventory() {
  const map = new Map()
  for (const f of walkFiles(await walk(VAULT))) {
    const content = await fsp.readFile(safeResolve(f.path), 'utf8').catch(() => null)
    if (content === null) continue
    map.set(f.path, { exists: true, content, hash: fnv1a(content), at: 0 })
  }
  // manifest only lists EXISTING files, so deleted notes must come from tombstones.
  let names = []
  try { names = await fsp.readdir(vcsRoot()) } catch { /* no version dir yet */ }
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    if (map.has(name)) continue
    let raw
    try { raw = JSON.parse(await fsp.readFile(path.join(vcsRoot(), name), 'utf8')) } catch { continue }
    const rel = String(raw?.path || '')
    if (!rel || !raw?.tombstone || map.has(rel)) continue
    if (fs.existsSync(safeResolve(rel))) continue // recreated under the same name
    map.set(rel, {
      exists: false, deleted: true, content: '', hash: '',
      at: Number(raw.tombstone.at || 0),
    })
  }
  return map
}

function peerInventory(selfId, online = null) {
  const map = new Map()
  for (const p of peerCloud.values()) {
    if (p.deviceId === selfId) continue
    // A published snapshot is authoritative only while that device is still
    // connected. Otherwise an offline device looks like "the file is missing"
    // and converge would copy local notes into a phantom peer.
    if (online && !online.has(p.deviceId)) continue
    for (const [rel, d] of p.docs || []) {
      const prev = map.get(rel)
      if (!prev || Number(d.at || 0) >= Number(prev.at || 0)) {
        map.set(rel, {
          exists: true, content: String(d.content ?? ''),
          hash: String(d.hash || fnv1a(String(d.content ?? ''))),
          baseHash: String(d.baseHash || ''), at: Number(d.at || 0),
          deviceName: p.deviceName, deviceId: p.deviceId,
        })
      }
    }
    for (const [rel, t] of p.tombstones || []) {
      const prev = map.get(rel)
      if (!prev || Number(t.at || 0) >= Number(prev.at || 0)) {
        map.set(rel, {
          exists: false, deleted: true, content: '', hash: '',
          at: Number(t.at || 0), deviceName: p.deviceName, deviceId: p.deviceId,
        })
      }
    }
  }
  return map
}

function setPeerDoc(selfId, rel, content, h, baseHash) {
  for (const p of peerCloud.values()) {
    if (p.deviceId === selfId) continue
    p.docs.set(rel, { hash: h, content, at: now(), baseHash })
    ;(p.tombstones || new Map()).delete(rel)
    p.at = now()
  }
}

function setPeerTombstone(selfId, rel) {
  for (const p of peerCloud.values()) {
    if (p.deviceId === selfId) continue
    p.docs.delete(rel)
    if (!p.tombstones) p.tombstones = new Map()
    p.tombstones.set(rel, { at: now(), deviceId: p.deviceId })
    p.at = now()
  }
}

/** Make local .md, local timeline, this device's cloud and the peer copy agree. */
async function alignCloud(rel, content, selfId, fromLocalOnly = false) {
  const h = fnv1a(content)
  let state = await readVersions(rel, content)
  if (state.local.versions?.[0]?.hash !== h) {
    state = appendVersion(state, 'local', content, '已收敛',
      fromLocalOnly ? '从本端拷贝到云仓库' : '两端一致').state
  }
  if (state.cloud.versions?.[0]?.hash !== h) {
    state = appendVersion(state, 'cloud', content, '已收敛', '两端一致', selfId).state
  }
  state = { ...state, baseHash: h, tombstone: null }
  await writeVersions(rel, state)
  setPeerDoc(selfId, rel, content, h, h)
  return state
}

/** Destructive: snapshot into .lumen-history, remove .md, write a tombstone. */
async function deleteForConverge(rel, selfId) {
  // Last line of defence: every converge/resolve path that removes a file
  // must be a NOTE. Attachments are retired by retireAsset() with a backup.
  assertNoteRel(rel)
  const cur = await current(rel).catch(() => null)
  if (cur) {
    await recordHistory(rel, cur.content, cur.version, '收敛删除前', selfId)
    await fsp.unlink(safeResolve(rel)).catch(() => {})
    versions.delete(rel)
  }
  let state = await readVersions(rel, '')
  state = appendVersion(state, 'local', '', '已删除', '两端一致删除').state
  state.local.versions[0].deleted = true
  state = appendVersion(state, 'cloud', '', '已删除', '两端一致删除', selfId).state
  state.cloud.versions[0].deleted = true
  state = {
    ...state, baseHash: '',
    tombstone: { at: now(), deviceId: selfId, content: cur?.content ?? '' },
  }
  await writeVersions(rel, state)
  setPeerTombstone(selfId, rel)
  manifestCache.delete(rel)
  return state
}

/**
 * Attachments converge by CONTENT HASH, with the same rules as notes:
 * identical → skip; one side only → copy; both changed → ask the user;
 * deletion → tombstone propagation. Bytes never come from the JSON payload.
 * Only peers that actually published an `assets` list take part, so an older
 * device can never make this one delete all of its attachments.
 */
async function convergeAssets(selfId, online) {
  const out = { scanned: 0, unchanged: 0, copied: 0, deleted: 0, conflicts: [], errors: [] }
  const peers = [...peerCloud.values()].filter(
    (p) => p.deviceId !== selfId && online.has(p.deviceId) && p.hasAssets,
  )
  if (!peers.length) return out

  const local = new Map((await scanAssets()).map((a) => [a.path, a]))
  const localGraves = await readAssetTombstones()
  const peer = new Map()
  const peerGraves = new Map()
  for (const p of peers) {
    for (const [rel, a] of p.assets || []) {
      const prev = peer.get(rel)
      if (!prev || Number(a.at || 0) >= Number(prev.at || 0)) {
        peer.set(rel, { ...a, deviceName: p.deviceName, deviceId: p.deviceId })
      }
    }
    for (const [rel, t] of p.assetTombstones || []) {
      const prev = peerGraves.get(rel)
      if (!prev || Number(t.at || 0) >= Number(prev.at || 0)) {
        peerGraves.set(rel, { ...t, deviceName: p.deviceName, deviceId: p.deviceId })
      }
    }
  }
  const paths = [...new Set([
    ...local.keys(), ...peer.keys(), ...Object.keys(localGraves), ...peerGraves.keys(),
  ])]
  out.scanned = paths.length

  const conflict = (rel, L, P, deviceName) => {
    out.conflicts.push({
      path: rel,
      localHash: L?.hash || '', peerHash: P?.hash || '',
      localSize: Number(L?.size || 0), localMtime: Number(L?.mtime || 0),
      peerSize: Number(P?.size || 0), peerMtime: Number(P?.mtime || 0),
      deviceName: String(deviceName || '另一台设备'), at: now(),
    })
  }

  for (const rel of paths) {
    try {
      const L = local.get(rel), P = peer.get(rel)
      const lGrave = localGraves[rel], pGrave = peerGraves.get(rel)
      if (!L && !P) { out.unchanged++; continue }

      // Tombstone propagation only when the surviving side is the SAME file.
      if (lGrave && P) {
        if (!lGrave.hash || P.hash === lGrave.hash) {
          for (const p of peers) {
            peerAssets.get(p.deviceId)?.delete(rel)
            p.assets?.delete(rel)
          }
          out.deleted++
        } else conflict(rel, null, P, P.deviceName)
        continue
      }
      if (pGrave && L) {
        if (!pGrave.hash || L.hash === pGrave.hash) {
          // Peer deleted it: retire our copy the same way a local deletion
          // would, so the folder disappears and old snapshots keep the bytes.
          await retireAsset(rel, String(pGrave.deviceId || ''))
          out.deleted++
        } else conflict(rel, L, null, pGrave.deviceName)
        continue
      }
      if (lGrave && !P) { out.unchanged++; continue }
      if (pGrave && !L) { out.unchanged++; continue }

      if (L && P) {
        if (L.hash === P.hash) { out.unchanged++; continue }
        conflict(rel, L, P, P.deviceName)
        continue
      }
      if (L && !P) {
        // Make our copy available to the peer: its next converge / preview can
        // fetch the bytes from /api/asset (or /api/asset/peer).
        const buf = await fsp.readFile(assetSafeResolve(rel)).catch(() => null)
        if (!buf) { out.errors.push(`${rel}：读取本地附件失败`); continue }
        for (const p of peers) {
          putPeerAsset(p.deviceId, rel, buf, { mtime: L.mtime })
          p.assets?.set(rel, { hash: L.hash, size: L.size, mtime: L.mtime, at: now() })
        }
        out.copied++
        continue
      }
      if (!L && P) {
        const buf = peerAssetBytes(P.deviceId, rel)
        if (!buf) { out.errors.push(`${rel}：对端附件内容不可用`); continue }
        const abs = assetSafeResolve(rel)
        await fsp.mkdir(path.dirname(abs), { recursive: true })
        await fsp.writeFile(abs, buf)
        await clearAssetTombstone(rel)
        out.copied++
        continue
      }
      out.unchanged++
    } catch (e) {
      out.errors.push(`${rel}：${e.message}`)
    }
  }
  return out
}

async function convergeVault(selfId) {
  const online = onlinePeerIds()
  const local = await localInventory()
  const peer = peerInventory(selfId, online)
  const paths = [...new Set([...local.keys(), ...peer.keys()])]
  const report = {
    scanned: paths.length, unchanged: 0, copied: 0, deleted: 0,
    conflicts: 0, errors: [], changedPaths: [],
  }
  const conflicts = []
  // 没有真实在线设备就绝不收敛：否则本地每篇笔记都会被当成「对端没有」
  // 而白写一遍云版本。拉取的前提就是两台设备已连接。
  if (!online.size) {
    return {
      report: { ...report, scanned: local.size, unchanged: local.size },
      conflicts: [], peerCount: 0, assetConflicts: [],
    }
  }
  for (const rel of paths) {
    const L = local.get(rel)
    const P = peer.get(rel)
    const lExists = !!L?.exists, pExists = !!P?.exists
    const lDeleted = !!L?.deleted, pDeleted = !!P?.deleted
    const lHash = L?.hash || '', pHash = P?.hash || ''
    const lContent = L?.content || '', pContent = P?.content || ''
    const state = await peekVersions(rel)
    const base = String(state.baseHash || '')
    const deviceName = P?.deviceName || '另一台设备'
    const conflict = (kind) => {
      conflicts.push({
        path: rel, kind, localContent: lContent, peerContent: pContent,
        localHash: lHash, peerHash: pHash, baseHash: base, deviceName,
        localDeleted: lDeleted, peerDeleted: pDeleted, at: now(),
      })
      report.conflicts++
    }

    try {
      // Both gone (or never present on the other side): nothing to do.
      if ((lDeleted && pDeleted) || (!lExists && !lDeleted && pDeleted)
        || (lDeleted && !pExists && !pDeleted) || (!L && !P)) {
        report.unchanged++
        continue
      }

      // Tombstone propagation, but only when the surviving side is the OLD
      // unchanged copy. A recreated / edited same-name note is a real conflict.
      if (lDeleted && pExists) {
        if (base && pHash === base) {
          setPeerTombstone(selfId, rel)
          report.deleted++; report.changedPaths.push(rel)
        } else conflict('delete-vs-create')
        continue
      }
      if (lExists && pDeleted) {
        if (base && lHash === base) {
          await deleteForConverge(rel, selfId)
          report.deleted++; report.changedPaths.push(rel)
        } else conflict('edit-vs-delete')
        continue
      }

      if (lExists && pExists) {
        if (lHash === pHash) {
          report.unchanged++
          await alignCloud(rel, lContent, selfId)
          continue
        }
        const changedLocal = lHash !== base
        const changedPeer = pHash !== base
        conflict(changedLocal && changedPeer ? 'both' : changedPeer ? 'peer-only' : 'local-only')
        continue
      }

      // Only one side owns it → copy. Hashing above means an identical file is
      // never copied twice.
      if (lExists && !P) {
        await alignCloud(rel, lContent, selfId, true)
        report.copied++; report.changedPaths.push(rel)
        continue
      }
      if (!L && pExists) {
        await commitFile(rel, { content: pContent, force: true },
          { force: true, reason: '收敛新建前', origin: selfId })
        await alignCloud(rel, pContent, selfId)
        report.copied++; report.changedPaths.push(rel)
        continue
      }
      report.unchanged++
    } catch (e) {
      report.errors.push(`${rel}：${e.message}`)
    }
  }
  const assetReport = await convergeAssets(selfId, online)
  report.assetCopied = assetReport.copied
  report.assetDeleted = assetReport.deleted
  report.assetUnchanged = assetReport.unchanged
  report.errors.push(...assetReport.errors)
  if (report.changedPaths.length || assetReport.copied || assetReport.deleted) {
    manifestCache.clear()
    broadcast({ type: 'tree' })
  }
  return {
    report, conflicts,
    assetConflicts: assetReport.conflicts,
    peerCount: [...peerCloud.values()].filter((p) => p.deviceId !== selfId && online.has(p.deviceId)).length,
  }
}

/** 拉取：整仓扫描 + 自动处理无争议项，返回需要用户裁决的差异列表。 */
app.post('/api/versions/converge', async (req, res) => {
  try {
    const selfId = String(req.body?.selfId || '')
    const out = await convergeVault(selfId)
    res.json(out)
  } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
})

/** 用户在分屏里选定版本：写 .md、记两端版本、推进基线、广播给对端 apply。 */
app.post('/api/versions/resolve', async (req, res) => {
  try {
    const selfId = String(req.body?.selfId || '')
    const originClient = vcsOrigin(req)
    const items = Array.isArray(req.body?.items) ? req.body.items : []
    const assetItems = Array.isArray(req.body?.assets) ? req.body.assets : []
    const results = []
    const assetResults = []
    const events = []
    for (const it of items) {
      const rel = String(it?.path || '')
      if (!rel) continue
      try {
        assertNoteRel(rel)
        if (String(it?.choice || '') === 'delete') {
          await deleteForConverge(rel, selfId)
          events.push({ path: rel, action: 'delete' })
          results.push({ path: rel, ok: true, action: 'delete' })
          continue
        }
        const content = String(it?.content ?? '')
        await commitFile(rel, { content, force: true }, {
          force: true, reason: it?.restore ? '恢复版本前' : '选用版本前', origin: originClient,
        })
        await alignCloud(rel, content, selfId, !!it?.restore)
        events.push({ path: rel, action: 'write', content })
        results.push({ path: rel, ok: true, action: 'write' })
      } catch (e) {
        results.push({ path: rel, ok: false, error: e.message })
      }
    }
    // Attachment conflicts are chosen on a simple card, not in the note diff.
    for (const it of assetItems) {
      const rel = String(it?.path || '')
      const choice = String(it?.choice || 'local')
      if (!rel) continue
      try {
        const abs = assetSafeResolve(rel)
        if (choice === 'delete') {
          await retireAsset(rel, originClient)
          for (const [id, map] of peerAssets.entries()) if (id !== selfId) map.delete(rel)
          for (const p of peerCloud.values()) if (p.deviceId !== selfId) p.assets?.delete(rel)
          assetResults.push({ path: rel, ok: true, action: 'delete' })
          continue
        }
        if (choice === 'peer') {
          let buf = null
          for (const [id, map] of peerAssets.entries()) {
            if (id === selfId) continue
            const e = map.get(rel)
            if (e) { buf = e.buf; break }
          }
          if (!buf) throw new Error('对端附件内容不可用')
          await fsp.mkdir(path.dirname(abs), { recursive: true })
          await fsp.writeFile(abs, buf)
          await clearAssetTombstone(rel)
          assetResults.push({ path: rel, ok: true, action: 'peer' })
          continue
        }
        // Keep this device's copy and make it available to the other side.
        const buf = await fsp.readFile(abs)
        for (const p of peerCloud.values()) {
          if (p.deviceId === selfId) continue
          putPeerAsset(p.deviceId, rel, buf, { mtime: Date.now() })
          p.assets?.set(rel, { hash: assetHash(buf), size: buf.length, mtime: Date.now(), at: now() })
        }
        assetResults.push({ path: rel, ok: true, action: 'local' })
      } catch (e) {
        assetResults.push({ path: rel, ok: false, error: e.message })
      }
    }
    manifestCache.clear()
    broadcast({ type: 'tree' })
    // An attachment-only decision has no note events; broadcasting an empty
    // converge would make the other device show a misleading "0 篇收敛" toast.
    if (events.length) {
      broadcast({
        type: 'converge', origin: selfId, clientId: originClient,
        items: events, at: now(),
      })
    }
    res.json({ results, assetResults })
  } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
})

/**
 * 邮局端点：手机 App 在自己设备上收敛完后，把「结果」交给服务端。
 * 只对齐对端云仓库快照 + 广播让对端自己 apply，绝不写任何设备的 .md。
 * 桌面端仍走 /api/versions/converge 与 /resolve（它的服务端就是本机仓库）。
 */
app.post('/api/versions/notify', async (req, res) => {
  try {
    const selfId = String(req.body?.selfId || '')
    const aligns = Array.isArray(req.body?.aligns) ? req.body.aligns : []
    const tombs = Array.isArray(req.body?.tombstones) ? req.body.tombstones : []
    // A peer's post-office payload is untrusted input. Never let an img/ path
    // into the note version chain: it would be treated as a deleted note on
    // the other device (and replayed as a file write on the next converge).
    const isNote = (rel) => {
      try { assertNoteRel(String(rel || '')); return true } catch { return false }
    }
    const items = (Array.isArray(req.body?.items) ? req.body.items : [])
      .filter((it) => isNote(it?.path))
    for (const a of aligns) {
      const rel = String(a?.path || '')
      if (!rel || !isNote(rel)) continue
      const content = String(a?.content ?? '')
      const h = String(a?.hash || fnv1a(content))
      setPeerDoc(selfId, rel, content, h, String(a?.baseHash || h))
    }
    for (const rel of tombs) {
      if (rel && isNote(rel)) setPeerTombstone(selfId, String(rel))
    }
    if (items.length) {
      broadcast({
        type: 'converge', origin: selfId, clientId: vcsOrigin(req),
        items, at: now(),
      })
    }
    res.json({ ok: true })
  } catch (e) { res.status(e.status || 500).json({ error: e.message }) }
})

/* --------------------------------------------------------- diagnostics API */

// Both endpoints sit behind the session guard: a report contains local paths
// and must never be reachable from an unpaired LAN client. They still need a
// write budget — otherwise any authorised client can fill the disk by looping.
const writeBudget = new Map()
function overBudget(key, limit, windowMs) {
  const t = Date.now()
  let b = writeBudget.get(key)
  if (!b || t - b.start >= windowMs) {
    b = { start: t, count: 0 }
    writeBudget.set(key, b)
  }
  b.count++
  if (writeBudget.size > 256) {
    for (const [k, v] of writeBudget) if (t - v.start >= windowMs) writeBudget.delete(k)
  }
  return b.count > limit
}
app.post('/api/logs', (req, res) => {
  if (overBudget('logs:' + requestIp(req), 120, 60_000)) {
    return res.status(429).json({ error: '日志写入过于频繁' })
  }
  const { level, tag, message, extra } = req.body || {}
  if (!message || typeof message !== 'string') return res.status(400).json({ error: 'missing message' })
  log(['warn', 'error'].includes(level) ? level : 'info',
    String(tag || 'renderer').slice(0, 64), String(message).slice(0, 4096),
    typeof extra === 'string' ? extra.slice(0, 4096) : extra)
  res.json({ ok: true })
})

app.post('/api/report', async (req, res) => {
  if (overBudget('report:' + requestIp(req), 3, 600_000)) {
    return res.status(429).json({ error: '诊断报告导出过于频繁' })
  }
  try {
    const body = await buildReport()
    const d = new Date()
    // One file per hour, same name overwrites: repeated exports can no longer
    // accumulate thousands of timestamped reports on disk.
    const name = `LumenNotes-诊断报告-${localDay(d)}-${pad2(d.getHours())}.md`
    const saved = []
    const degraded = false
      // 用户数据目录一定可写：作为主输出；安装目录仅作可选副本。
      // Linux 上 /opt/<app> 通常只读，旧版以安装目录为主输出会稳定降级。
      try {
      fs.mkdirSync(REPORT_DIR, { recursive: true })
      const primary = path.join(REPORT_DIR, name)
      fs.writeFileSync(primary, body, 'utf8')
      saved.push(primary)
      } catch (e) {
      log('warn', 'report', '用户数据目录不可写：' + e.message)
      }
      try {
      fs.mkdirSync(INSTALL_DIR, { recursive: true })
      const copy = path.join(INSTALL_DIR, name)
      fs.writeFileSync(copy, body, 'utf8')
      saved.push(copy)
      } catch (e) { log('warn', 'report', '安装目录副本写入失败：' + e.message) }
      if (!saved.length) return res.status(500).json({ error: '报告写入失败：用户数据目录与安装目录均不可写' })
      log('info', 'report', '诊断报告已导出：' + saved.join(' / '))
    res.json({ path: saved[0], copy: saved[1] || null, degraded, name })
  } catch (e) {
    log('error', 'report', '生成诊断报告失败：' + e.message, e.stack)
    res.status(500).json({ error: e.message })
  }
})

// Unknown API paths must not fall through to the SPA HTML fallback.
app.use('/api', (_req, res) => res.status(404).json({ error: 'unknown api' }))

// Relative images / attachments referenced from markdown. A retired picture
// is gone from img/ but kept in the hidden history folder, so older version
// snapshots (and their image links) still render instead of showing a 404.
app.get('/raw', (req, res) => {
  // /raw sits outside the /api auth middleware. Without this check an unpaired
  // device on the LAN could read any non-hidden vault file (including .md note
  // bodies) just by naming its path. <img> cannot send headers, so the
  // renderer appends the session to the query; sessionFrom already reads it.
  if (!isAuthorized(req)) return res.status(401).json({ error: 'unpaired', pairTokenNeeded: true })
  try {
    const rel = String(req.query.path || '')
    guardAttachmentResponse(res, rel)
    const abs = safeResolve(rel)
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      const backup = assetBackupOf(rel)
      if (!backup || !fs.existsSync(backup) || !fs.statSync(backup).isFile()) return res.sendStatus(404)
      return res.sendFile(backup)
    }
    res.sendFile(abs)
  } catch { res.sendStatus(400) }
})

if (fs.existsSync(DIST)) {
  app.use(express.static(DIST, { index: false, maxAge: 0 }))
  app.get('*', (_req, res) => res.sendFile(path.join(DIST, 'index.html')))
} else {
  app.get('*', (_req, res) =>
    res
      .status(200)
      .type('html')
      .send(`<meta charset="utf-8"><body style="font:15px/1.7 system-ui;background:#1e1e1e;color:#dcddde;padding:48px;max-width:680px;margin:auto">
      <h1>Lumen Notes</h1><p>同步服务已运行，但还没有构建前端产物。</p>
      <p>开发模式请访问 <a style="color:#a88bfa" href="http://localhost:5173">http://localhost:5173</a><br>
      或先执行 <code>npm run build</code> 再重新 <code>npm start</code>。</p></body>`)
  )
}

app.use((err, _req, res, _next) => {
  console.error('[error]', err)
  log('error', 'http', err.message || 'server error', err.stack)
  res.status(500).json({ error: err.message || 'server error' })
})

const server = http.createServer(app)
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[fatal] 端口 ${PORT} 已被占用：请关闭旧的 Lumen Notes 服务，或改用 LUMEN_PORT`)
    log('error', 'boot', `端口 ${PORT} 已被占用`, e.stack)
  } else {
    console.error('[fatal] 同步服务启动失败：', e)
    log('error', 'boot', '同步服务启动失败：' + e.message, e.stack)
  }
  process.exit(1)
})

/* ------------------------------------------------------------ websockets */

/**
 * Upgrade-time gate. HTTP middleware never sees a WebSocket handshake, so
 * without this a foreign web page could open ws://127.0.0.1:PORT/ws and keep
 * receiving note bodies. Browsers ALWAYS send an Origin on a WebSocket; the
 * Host check additionally stops DNS rebinding. A loopback socket must carry
 * the shell credential (or a paired session) — being local is not enough.
 */
function wsAllowed(req) {
  if (!requestHostOk(req)) return false
  const origin = String(req.headers.origin || '')
  if (origin === 'null') return false
  if (origin && !corsAllowed(origin, req)) return false
  if (PAIR_MODE !== false && isLoopback(req.socket.remoteAddress || '')) {
    const q = new URL(req.url, 'http://x').searchParams
    const shell = q.get('shell') || ''
    if (shell !== SHELL_TOKEN && !sessions.has(q.get('session') || '')) return false
  }
  return true
}
const wss = new WebSocketServer({
  server, path: '/ws',
  verifyClient: (info, done) => {
    if (wsAllowed(info.req)) done(true)
    else done(false, 403, 'forbidden')
  },
})
wss.on('error', (e) => log('error', 'ws', 'WebSocket 服务异常：' + e.message, e.stack))

function broadcast(msg, except) {
  const raw = JSON.stringify(msg)
  for (const ws of wss.clients) {
    if (ws.readyState !== WebSocket.OPEN || ws === except) continue
    // Even a socket that is about to be closed as 'unpaired' must never see
    // a broadcast: file/pushFile/converge messages carry full note bodies.
    if (ws.allowed !== true) continue
    if (msg.type === 'file' && ws.scope) {
      const s = String(ws.scope)
      const inScope = /\.(md|markdown|txt)$/i.test(s) ? msg.path === s : msg.path.startsWith(s + '/')
      if (!inScope) continue
    }
    ws.send(raw)
  }
}

/**
 * Real LAN peers = authorised sockets whose remote address is NOT loopback.
 * The desktop renderer itself connects over 127.0.0.1 and must never be
 * counted as a second device. One device can hold several sockets (tabs),
 * so dedupe by paired device id, falling back to the remote IP.
 */
function peerPresence(except) {
  const seen = new Map()
  for (const ws of wss.clients) {
    if (ws === except || ws.readyState !== WebSocket.OPEN) continue
    if (ws.allowed !== true || ws.isLocal) continue
    const key = ws.clientId || ws.deviceId || ws.ip || 'unknown'
    if (!seen.has(key)) {
      seen.set(key, { id: key, name: ws.deviceName || ws.ip || '未知设备', ip: String(ws.ip || '') })
    }
  }
  const peers = [...seen.values()]
  return { peers, count: peers.length }
}

function broadcastPresence(except) {
  broadcast({ type: 'presence', ...peerPresence(except) }, except)
}

/** Device ids that currently hold an authorised, non-loopback socket. A cloud
 *  snapshot left behind by an offline device must never drive convergence. */
function onlinePeerIds(includeLocal = false) {
  const ids = new Set()
  for (const ws of wss.clients) {
    if (ws.readyState !== WebSocket.OPEN || ws.allowed !== true) continue
    if (ws.isLocal && !includeLocal) continue
    if (ws.clientId) ids.add(ws.clientId)
    if (ws.deviceId) ids.add(ws.deviceId)
  }
  return ids
}

wss.on('connection', (ws, req) => {
  // The socket is the only trustworthy source of the remote address.
  const ip = req.socket.remoteAddress || ''
  const q = new URL(req.url, 'http://x').searchParams
  const session = q.get('session') || ''
  const paired = sessions.get(session)
  ws.ip = ip
  ws.isLocal = isLoopback(ip)
  ws.clientId = q.get('clientId') || ''
  ws.deviceId = paired?.device?.id || ''
  ws.deviceName = paired?.device?.name || ''
  ws.allowed = isLoopback(ip) || !PAIR_MODE || sessions.has(session)
  ws.scope = ''
  if (!ws.allowed) {
    ws.send(JSON.stringify({ type: 'unpaired' }))
    return ws.close(4001, 'unpaired')
  }
  ws.send(JSON.stringify({ type: 'hello', devices: deviceList(), presence: peerPresence(), time: now() }))
  broadcastPresence()
  ws.on('close', () => broadcastPresence(ws))

  ws.on('message', (buf) => {
    let msg
    try { msg = JSON.parse(String(buf)) } catch { return }
    if (msg.type === 'subscribe') { ws.scope = String(msg.scope || ''); return }
    if (msg.type === 'unpair') return
    if (msg.type === 'cursor' || msg.type === 'focus') {
      // Cross-device "jump to the same place" hint. Purely informational.
      broadcast({ ...msg, from: String(msg.from || ''), at: now() }, ws)
    }
  })
})

/* ---------------------------------------------------------- file watcher */

let watcher = null
let watcherReady = false

async function externalFile(rel) {
  try {
    const abs = safeResolve(rel)
    const content = await fsp.readFile(abs, 'utf8')
    const h = hash(content)
    const meta = versions.get(rel)
    if (meta && meta.hash === h) return // our own write, already broadcast
    const version = (meta?.version || 0) + 1
    const next = { version, hash: h, mtime: now() }
    versions.set(rel, next)
    if (watcherReady) broadcast({ type: 'file', path: rel, content, ...next, origin: 'disk' })
  } catch { /* deleted while reading */ }
}

function startWatcher() {
  watcherReady = false
  const w = chokidar.watch(VAULT, {
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 220, pollInterval: 40 },
    ignored: (p) => /(^|[/\\])\./.test(p) || /node_modules/.test(p),
  })
  w.on('change', (abs) => { if (/\.(md|markdown|txt)$/i.test(abs)) externalFile(relOf(abs)) })
    .on('add', (abs) => { if (/\.(md|markdown|txt)$/i.test(abs)) { externalFile(relOf(abs)); if (watcherReady) broadcast({ type: 'tree' }) } })
    .on('unlink', (abs) => { versions.delete(relOf(abs)); if (watcherReady) broadcast({ type: 'tree' }) })
    .on('addDir', () => { if (watcherReady) broadcast({ type: 'tree' }) })
    .on('unlinkDir', () => { if (watcherReady) broadcast({ type: 'tree' }) })
  .on('ready', () => {
    watcherReady = true
    if (watcherDegraded) { watcherDegraded = ''; log('info', 'watcher', '文件监视已恢复') }
  })
  .on('error', (e) => {
    const inotifyFull = e && (e.code === 'ENOSPC' || /inotify|watch/i.test(e.message || ''))
    const msg = inotifyFull
      ? '文件监视失败：inotify 监视数量超限，外部改动不会自动同步。可提高 fs.inotify.max_user_watches 后重启应用'
      : '文件监视异常：' + (e && e.message)
    watcherDegraded = msg
    log('error', 'watcher', msg)
    try { broadcast({ type: 'watcher-degraded', message: msg }) } catch { /* 尚无客户端 */ }
  })
  watcher = w
}

/** Called by POST /api/storage after the vault path changes. */
async function restartWatcher() {
  if (watcher) {
    try { await watcher.close() } catch { /* already closed */ }
    watcher = null
  }
  startWatcher()
}

startWatcher()

/* ------------------------------------------------------------------ boot */

server.listen(PORT, HOST, () => {
  log('info', 'boot', `同步服务已启动：${HOST}:${PORT}，仓库 ${VAULT}`)
  console.log('')
  console.log('  Lumen Notes · 同步服务已启动')
  console.log('  ────────────────────────────────────────────')
  console.log(`  本机        http://localhost:${PORT}`)
  for (const ip of lanIps()) console.log(`  局域网      http://${ip}:${PORT}`)
  console.log(`  仓库目录    ${VAULT}${VAULT === DEFAULT_VAULT ? '（默认）' : '（用户自选）'}`)
  console.log(`  历史目录    ${historyRoot()}（隐藏，保留最近 ${historyLimit()} 次）`)
  console.log(`  配置文件    ${CONFIG_FILE}`)
  console.log(`  前端产物    ${fs.existsSync(path.join(DIST, 'index.html')) ? 'dist/ 已就绪' : '未构建（开发模式用 5173）'}`)
  try {
    fs.writeFileSync(path.join(LOG_DIR, 'pair-token.txt'), PAIR_TOKEN, { mode: 0o600 })
    console.log('  配对码      见同步面板二维码（排障副本：userData/logs/pair-token.txt）')
  } catch { console.log('  配对码      见同步面板二维码') }
  console.log('  ────────────────────────────────────────────')
  console.log('')
})
