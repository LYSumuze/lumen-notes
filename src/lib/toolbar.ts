/**
 * Editor format strip. One catalogue drives BOTH shells: the phone accessory
 * bar above the soft keyboard and the desktop strip under the title bar. The
 * visible/ordered subset lives in settings (`toolbarCommands`), so ticking a
 * command in 设置 → 编辑工具栏 changes both platforms (each device keeps its
 * own localStorage, so a phone and a PC can differ).
 *
 * Undo / redo, 自定义 and 全部命令 are fixed chrome, never part of the
 * configurable list — otherwise the user could remove the only way back
 * into the customiser.
 *
 * Headings are ONE button (`fmt.heading`) that opens a 1–6 level picker. The
 * six real commands (fmt.h1…fmt.h6, plus fmt.h0 for 正文) stay in the command
 * palette / shortcuts; they are deliberately not configurable toolbar items.
 */
export type ToolbarKind = 'command' | 'image' | 'more' | 'heading'

export interface ToolbarAction {
  id: string
  label: string
  icon: string
  /** Buttons of the same group sit together; a thin divider separates groups. */
  group: number
  kind: ToolbarKind
}

export const MORE_ID = '__more__'
export const IMAGE_ID = '__image__'
export const UNDO_ID = '__undo__'
export const REDO_ID = '__redo__'
/** Opens the level picker; never dispatched through runCommandById. */
export const HEADING_ID = 'fmt.heading'
/** Command id behind the picker's 「正文」 item. */
export const BODY_ID = 'fmt.h0'
export const HEADING_LEVELS = ['fmt.h1', 'fmt.h2', 'fmt.h3', 'fmt.h4', 'fmt.h5', 'fmt.h6'] as const

/** Short captions shown under the icon on the labelled bars. */
const SHORT_LABELS: Record<string, string> = {
  [HEADING_ID]: '标题',
  'fmt.bold': '加粗', 'fmt.italic': '斜体', 'fmt.strike': '删除',
  'fmt.code': '代码', 'fmt.math': '公式',
  'fmt.bullet': '列表', 'fmt.ordered': '编号', 'fmt.task': '任务', 'fmt.quote': '引用',
  'insert.link': '链接', [IMAGE_ID]: '图片', 'insert.table': '表格',
  'insert.codeblock': '代码块', 'insert.mathblock': '公式块',
  'insert.hr': '分隔', 'insert.date': '日期',
  'edit.up': '上移', 'edit.down': '下移', 'edit.dup': '复制', 'edit.del': '删除',
  [MORE_ID]: '更多',
}
export function shortLabel(a: ToolbarAction): string {
  return SHORT_LABELS[a.id] || a.label.slice(0, 2)
}

export const TOOLBAR_ACTIONS: ToolbarAction[] = [
  { id: HEADING_ID, label: '标题', icon: 'heading', group: 0, kind: 'heading' },
  { id: 'fmt.bold', label: '加粗', icon: 'bold', group: 1, kind: 'command' },
  { id: 'fmt.italic', label: '斜体', icon: 'italic', group: 1, kind: 'command' },
  { id: 'fmt.strike', label: '删除线', icon: 'strike', group: 1, kind: 'command' },
  { id: 'fmt.code', label: '行内代码', icon: 'code', group: 1, kind: 'command' },
  { id: 'fmt.math', label: '行内公式', icon: 'code', group: 1, kind: 'command' },
  { id: 'fmt.bullet', label: '无序列表', icon: 'outline', group: 2, kind: 'command' },
  { id: 'fmt.ordered', label: '有序列表', icon: 'ordered', group: 2, kind: 'command' },
  { id: 'fmt.task', label: '任务列表', icon: 'task', group: 2, kind: 'command' },
  { id: 'fmt.quote', label: '引用', icon: 'quote', group: 2, kind: 'command' },
  { id: 'insert.link', label: '链接', icon: 'link', group: 3, kind: 'command' },
  { id: IMAGE_ID, label: '插入图片', icon: 'image', group: 3, kind: 'image' },
  { id: 'insert.table', label: '表格', icon: 'table', group: 3, kind: 'command' },
  { id: 'insert.codeblock', label: '代码块', icon: 'codeblock', group: 3, kind: 'command' },
  { id: 'insert.mathblock', label: '公式块', icon: 'codeblock', group: 3, kind: 'command' },
  { id: 'insert.hr', label: '分隔线', icon: 'hr', group: 3, kind: 'command' },
  { id: 'insert.date', label: '日期', icon: 'calendar', group: 3, kind: 'command' },
  { id: 'edit.up', label: '上移行', icon: 'chevronUp', group: 4, kind: 'command' },
  { id: 'edit.down', label: '下移行', icon: 'chevronDown', group: 4, kind: 'command' },
  { id: 'edit.dup', label: '复制行', icon: 'plus', group: 4, kind: 'command' },
  { id: 'edit.del', label: '删除行', icon: 'trash', group: 4, kind: 'command' },
  { id: MORE_ID, label: '全部命令', icon: 'more', group: 5, kind: 'more' },
]

export const DEFAULT_TOOLBAR: string[] = [
  HEADING_ID, 'fmt.bold', 'fmt.italic', 'fmt.bullet',
  'fmt.quote', 'insert.link', IMAGE_ID, MORE_ID,
]

/** Actions offered in 设置 → 编辑工具栏. Fixed chrome is deliberately absent. */
export const CONFIGURABLE_ACTIONS = TOOLBAR_ACTIONS.filter(
  (a) => a.id !== MORE_ID,
)
const KNOWN = new Set(TOOLBAR_ACTIONS.map((a) => a.id))
export const TOOLBAR_BY_ID = new Map(TOOLBAR_ACTIONS.map((a) => [a.id, a]))

/**
 * Old saved configs contain fmt.h1…fmt.h6 as six separate buttons. Collapse
 * them into the single 标题 button so an upgrade never silently drops a
 * heading control. Unknown / duplicate / legacy fixed ids are dropped, the
 * list is capped at 14, and 「全部命令」 stays pinned at the end.
 */
const LEGACY_HEADINGS = new Set<string>([...HEADING_LEVELS, BODY_ID])
export function normalizeToolbar(input: unknown): string[] {
  const raw = Array.isArray(input) ? input : []
  const out: string[] = []
  for (const rawId of raw) {
    if (typeof rawId !== 'string') continue
    const id = LEGACY_HEADINGS.has(rawId) ? HEADING_ID : rawId
    if (!KNOWN.has(id) || id === MORE_ID) continue
    if (id === UNDO_ID || id === REDO_ID) continue
    if (out.includes(id) || out.length >= 14) continue
    out.push(id)
  }
  if (!out.length) out.push(...DEFAULT_TOOLBAR.filter((id) => id !== MORE_ID))
  out.push(MORE_ID)
  return out
}
