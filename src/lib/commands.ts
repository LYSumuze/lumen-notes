import type { EditorHandle, CommandDef, ViewMode } from '../types'
import { redo as cmRedo, undo as cmUndo } from '@codemirror/commands'
import * as ed from './editing'
import { setSuppressEditorFocus } from './editing'

/**
 * A toolbar button on a touch device should not change the editor's focus:
 * `view.focus()` re-opens the soft keyboard even when the user had dismissed
 * it, and losing focus mid-command makes the keyboard flicker. Callers that
 * render a keyboard accessory bar wrap their command in this helper.
 */
let suppressRefocus = false
export function runWithoutRefocus(run: () => void) {
  const previous = suppressRefocus
  suppressRefocus = true
  // editing.ts helpers focus the view themselves; silence those too, or a
  // toolbar tap still re-opens the IME even though E() skipped its focus.
  setSuppressEditorFocus(true)
  try { run() } finally {
    suppressRefocus = previous
    setSuppressEditorFocus(previous)
  }
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

export function keyMatches(e: KeyboardEvent, key: string): boolean {
  const k = key.toLowerCase()
  const code = e.code || ''
  if (/^[0-9]$/.test(k) && code === `Digit${k}`) return true
  if (/^[a-z]$/.test(k) && code === `Key${k.toUpperCase()}`) return true
  if (k === '-' && (code === 'Minus' || e.key === '-')) return true
  if (k === '=' && (code === 'Equal' || e.key === '=')) return true
  if (k === '`' && (code === 'Backquote' || e.key === '`')) return true
  if (k === '\\' && (code === 'Backslash' || e.key === '\\')) return true
  return e.key?.toLowerCase() === k
}

export function matchShortcut(e: KeyboardEvent, shortcut: string): boolean {
  if (!shortcut) return false
  const parts = shortcut.split('+')
  const key = parts.pop() || ''
  const wantMod = parts.includes('Mod')
  const wantShift = parts.includes('Shift')
  const wantAlt = parts.includes('Alt')
  const mod = isMac ? e.metaKey : e.ctrlKey
  if (wantMod !== mod) return false
  if (!wantMod && (e.ctrlKey || e.metaKey)) return false
  if (wantShift !== e.shiftKey || wantAlt !== e.altKey) return false
  return keyMatches(e, key)
}

export function formatShortcut(shortcut?: string): string {
  if (!shortcut) return ''
  if (isMac) {
    return shortcut
      .replace('Mod', '⌘').replace('Shift', '⇧').replace('Alt', '⌥')
      .replace('ArrowUp', '↑').replace('ArrowDown', '↓').replace(/\+/g, '')
  }
  return shortcut.replace('Mod', 'Ctrl').replace('ArrowUp', '↑').replace('ArrowDown', '↓')
}

export interface CommandContext {
  editor: () => EditorHandle | null
  setMode: (m: ViewMode) => void
  toggleEditRead: () => void
  openPalette: () => void
  quickSwitch: () => void
  openSearch: () => void
  openFiles: () => void
  openOutline: () => void
  openSync: () => void
  openSettings: () => void
  openHistory: () => void
  openStorage: () => void
  downloadMd: () => void
  renameCurrent: () => void
  deleteCurrent: () => void
  openShortcuts: () => void
  openAbout: () => void
  openWelcome: () => void
  saveAs: () => void
  syncCurrent: () => void
  syncVaultNow: () => void
  fetchNow: () => void
  save: () => void
  newFile: () => void
  newFolder: () => void
  toggleTheme: () => void
  zoom: (delta: number) => void
  toggleSidebar: () => void
  toggleRight: () => void
  toggleSyncScroll: () => void
  insertDate: () => void
  insertImage: () => void
}

export function buildCommands(ctx: CommandContext): CommandDef[] {
  const E = (fn: (view: EditorHandle['view']) => void): (() => void) => () => {
    const h = ctx.editor()
    if (h?.view) { fn(h.view); if (!suppressRefocus) h.view.focus() }
  }
  const c = (id: string, name: string, group: string, shortcut: string | undefined, run: () => void): CommandDef =>
    ({ id, name, group, shortcut, run })

  return [
    // ---- view ----
    c('view.toggle-edit-read', '编辑 / 阅读', '视图', 'Mod+E', ctx.toggleEditRead),
    c('view.split', '分屏', '视图', 'Mod+Shift+E', () => ctx.setMode('split')),
    c('view.source', '仅源码', '视图', undefined, () => ctx.setMode('source')),
    c('view.reading', '仅阅读', '视图', undefined, () => ctx.setMode('reading')),
    c('view.files', '文件树', '视图', 'Mod+Alt+F', ctx.openFiles),
    c('view.outline', '大纲', '视图', 'Mod+Alt+O', ctx.openOutline),
    c('view.right', '右侧栏', '视图', 'Mod+Alt+R', ctx.toggleRight),
    c('view.sidebar', '左侧栏', '视图', 'Mod+Alt+B', ctx.toggleSidebar),
    c('view.sync-scroll', '双向滚动', '视图', undefined, ctx.toggleSyncScroll),
    c('view.theme', '切换主题', '视图', 'Mod+Alt+L', ctx.toggleTheme),
    c('view.zoom-in', '放大', '视图', 'Mod+=', () => ctx.zoom(1)),
    c('view.zoom-out', '缩小', '视图', 'Mod+-', () => ctx.zoom(-1)),

    // ---- formatting: transform the selection / current line ----
    c('fmt.bold', '加粗', '格式', 'Mod+B', E((v) => ed.toggleWrap(v, '**', '**', '粗体'))),
    c('fmt.italic', '斜体', '格式', 'Mod+I', E((v) => ed.toggleWrap(v, '*', '*', '斜体'))),
    c('fmt.strike', '删除线', '格式', 'Mod+Shift+X', E((v) => ed.toggleWrap(v, '~~', '~~', '删除线'))),
    c('fmt.code', '行内代码', '格式', 'Mod+`', E((v) => ed.toggleWrap(v, '`', '`', '代码'))),
    c('fmt.math', '行内公式', '格式', 'Mod+Shift+M', E((v) => ed.toggleWrap(v, '$', '$', 'E=mc^2'))),
    c('fmt.h0', '正文', '格式', 'Mod+0', E((v) => ed.setHeading(v, 0))),
    c('fmt.h1', '一级标题', '格式', 'Mod+1', E((v) => ed.setHeading(v, 1))),
    c('fmt.h2', '二级标题', '格式', 'Mod+2', E((v) => ed.setHeading(v, 2))),
    c('fmt.h3', '三级标题', '格式', 'Mod+3', E((v) => ed.setHeading(v, 3))),
    c('fmt.h4', '四级标题', '格式', 'Mod+4', E((v) => ed.setHeading(v, 4))),
    c('fmt.h5', '五级标题', '格式', 'Mod+5', E((v) => ed.setHeading(v, 5))),
    c('fmt.h6', '六级标题', '格式', 'Mod+6', E((v) => ed.setHeading(v, 6))),
    c('fmt.bullet', '切换无序列表', '格式', 'Mod+Shift+7', E((v) => ed.togglePrefix(v, '- '))),
    c('fmt.ordered', '切换有序列表', '格式', 'Mod+Shift+8', E((v) => ed.togglePrefix(v, (n) => `${n}. `))),
    c('fmt.quote', '切换引用', '格式', 'Mod+Shift+Q', E((v) => ed.togglePrefix(v, '> '))),
    c('fmt.task', '切换任务列表', '格式', 'Mod+Enter', E((v) => ed.toggleTask(v))),

    // ---- insert: add new content / blocks ----
    c('insert.image', '图片', '插入', undefined, ctx.insertImage),
    c('insert.link', '链接', '插入', 'Mod+K', E((v) => ed.insertLink(v))),
    c('insert.hr', '分隔线', '插入', 'Mod+Alt+-', E((v) => ed.insertBlock(v, '\n---\n'))),
    c('insert.table', '表格', '插入', 'Mod+Alt+T', E((v) =>
      ed.insertBlock(v, '| 列 1 | 列 2 | 列 3 |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |'))),
    c('insert.codeblock', '代码块', '插入', 'Mod+Alt+C', E((v) => ed.insertBlock(v, '```js\n\n```', 6))),
    c('insert.mathblock', '公式块', '插入', 'Mod+Shift+B', E((v) => ed.insertBlock(v, '$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$', 3))),
    c('insert.date', '日期', '插入', 'Mod+Alt+D', ctx.insertDate),

    // ---- editing ----
    // No shortcut here on purpose: CodeMirror's historyKeymap already owns
    // Mod+Z / Mod+Shift+Z / Mod+Y. Registering them again would double-run
    // the command from the global shortcut handler. These entries exist so
    // the native menu and the command palette drive the SAME history stack.
    c('edit.undo', '撤销', '编辑', undefined, () => {
      const v = ctx.editor()?.view
      if (v) cmUndo(v)
    }),
    c('edit.redo', '重做', '编辑', undefined, () => {
      const v = ctx.editor()?.view
      if (v) cmRedo(v)
    }),
    c('edit.up', '上移行', '编辑', 'Alt+ArrowUp', E((v) => ed.moveLine(v, -1))),
    c('edit.down', '下移行', '编辑', 'Alt+ArrowDown', E((v) => ed.moveLine(v, 1))),
    c('edit.dup', '复制行', '编辑', 'Mod+Shift+D', E((v) => ed.duplicateLine(v))),
    c('edit.del', '删除行', '编辑', 'Mod+Shift+K', E((v) => ed.deleteLine(v))),
    c('edit.indent', '增加缩进', '编辑', 'Tab', E((v) => ed.indentSelection(v, 1))),
    c('edit.outdent', '减少缩进', '编辑', 'Shift+Tab', E((v) => ed.indentSelection(v, -1))),

    // ---- files (menu order: pick workspace -> create -> read/write -> rename/delete -> history) ----
    c('app.storage', '更改仓库…', '文件', 'Mod+Alt+Shift+O', ctx.openStorage),
    c('file.new', '新建笔记', '文件', 'Mod+N', ctx.newFile),
    c('file.new-folder', '新建文件夹', '文件', 'Mod+Shift+N', ctx.newFolder),
    c('file.save', '保存', '文件', 'Mod+S', ctx.save),
    c('file.save-as', '另存为…', '文件', 'Mod+Shift+S', ctx.saveAs),
    c('file.download', '导出 .md', '文件', undefined, ctx.downloadMd),
    c('file.rename-current', '重命名', '文件', undefined, ctx.renameCurrent),
    c('file.delete-current', '删除', '文件', undefined, ctx.deleteCurrent),
    c('app.history', '历史版本', '应用', 'Mod+Alt+H', ctx.openHistory),

    c('nav.palette', '命令面板', '导航', 'Mod+P', ctx.openPalette),
    c('nav.quick', '快速切换', '导航', 'Mod+O', ctx.quickSwitch),
    c('nav.search', '搜索', '导航', 'Mod+Shift+F', ctx.openSearch),

    c('app.sync-cloud', '同步当前笔记', '应用', 'Mod+Alt+S', ctx.syncCurrent),
    c('app.sync-vault', '全仓同步', '应用', undefined, ctx.syncVaultNow),
    c('app.fetch', '拉取', '应用', 'Mod+Alt+P', ctx.fetchNow),
    c('app.sync', '同步设置', '应用', 'Mod+Alt+Shift+S', ctx.openSync),
    c('app.welcome', '欢迎页', '应用', undefined, ctx.openWelcome),
    c('app.settings', '设置', '应用', 'Mod+,', ctx.openSettings),

    c('help.shortcuts', '快捷键', '帮助', undefined, ctx.openShortcuts),
    c('help.about', '关于', '帮助', undefined, ctx.openAbout),
  ]
}
