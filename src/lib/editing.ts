import { EditorSelection } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

type View = EditorView

/**
 * A phone toolbar tap must not change the editor's focus: `view.focus()`
 * re-opens the soft keyboard. commands.ts owns the focus decision (its `E()`
 * wrapper refocuses for palette / shortcut use, but is suppressed for the
 * accessory bar via runWithoutRefocus). Every editing helper routes its
 * focus through this guard so the two mechanisms cannot disagree.
 */
let suppressFocus = false
export function setSuppressEditorFocus(value: boolean) { suppressFocus = value }
function focusIfAllowed(view: View) {
  if (!suppressFocus) view.focus()
}

/**
 * Replace whole lines and keep the caret AFTER the inserted marker.
 *
 * CodeMirror maps an untouched selection with assoc = -1. When the change is
 * an insertion made exactly at the caret (an empty line, or a line prefix),
 * that leaves the caret in front of the new text — picking H6 produced
 * `|###### ` instead of `###### |`. Headings, lists, quotes, ordered lists
 * and task lists all route through here, so they all had the same symptom.
 *
 * Each change replaces one whole line, so shifting the positions by that
 * line's net length delta keeps a mid-line caret at the same offset into the
 * note body, and puts an empty-line caret right after the new prefix.
 */
function eachSelectedLine(view: View, fn: (lineText: string) => string) {
  const { state } = view
  const sel = state.selection.main
  const fromLine = state.doc.lineAt(sel.from).number
  const toLine = state.doc.lineAt(sel.to).number
  const changes: { from: number; to: number; insert: string }[] = []
  for (let n = fromLine; n <= toLine; n++) {
    const line = state.doc.line(n)
    const next = fn(line.text)
    if (next !== line.text) changes.push({ from: line.from, to: line.to, insert: next })
  }
  if (!changes.length) return
  const deltas = changes.map((c) => c.insert.length - (c.to - c.from))
  const totalDelta = deltas.reduce((a, b) => a + b, 0)
  const map = (pos: number) => {
    let out = pos
    for (let i = 0; i < changes.length; i++) {
      if (pos < changes[i].from) break
      out += deltas[i]
    }
    return Math.max(0, Math.min(out, state.doc.length + totalDelta))
  }
  const from = map(sel.from)
  const to = map(sel.to)
  view.dispatch({
    changes,
    selection: from === to ? EditorSelection.cursor(from) : EditorSelection.range(from, to),
    scrollIntoView: true,
  })
}

/** Wrap / unwrap the selection: bold, italic, inline code, strikethrough, math ... */
export function toggleWrap(view: View, before: string, after = before, placeholder = '') {
  const { state } = view
  const sel = state.selection.main
  const text = state.doc.sliceString(sel.from, sel.to)
  const outerFrom = Math.max(0, sel.from - before.length)
  const outerTo = Math.min(state.doc.length, sel.to + after.length)
  if (
    state.doc.sliceString(outerFrom, sel.from) === before &&
    state.doc.sliceString(sel.to, outerTo) === after
  ) {
    view.dispatch({
      changes: [
        { from: outerFrom, to: sel.from, insert: '' },
        { from: sel.to, to: outerTo, insert: '' },
      ],
      selection: EditorSelection.range(outerFrom, outerFrom + text.length),
      scrollIntoView: true,
    })
    return
  }
  const body = text || placeholder
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: before + body + after },
    selection: EditorSelection.range(sel.from + before.length, sel.from + before.length + body.length),
    scrollIntoView: true,
  })
  focusIfAllowed(view)
}

export function insertLink(view: View) {
  const sel = view.state.selection.main
  const text = view.state.doc.sliceString(sel.from, sel.to) || '链接文字'
  const insert = `[${text}](url)`
  const urlStart = sel.from + insert.indexOf('url')
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert },
    selection: EditorSelection.range(urlStart, urlStart + 3),
    scrollIntoView: true,
  })
  focusIfAllowed(view)
}

export function insertBlock(view: View, text: string, cursorOffset?: number) {
  const sel = view.state.selection.main
  const line = view.state.doc.lineAt(sel.from)
  const prefix = line.text.trim() ? '\n\n' : '\n'
  const insert = prefix + text
  const pos = sel.from + (cursorOffset ?? insert.length)
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert },
    selection: EditorSelection.cursor(pos),
    scrollIntoView: true,
  })
  focusIfAllowed(view)
}

/** level 1..6 sets a heading; level 0 strips it (picker's 「正文」 item). */
export function setHeading(view: View, level: number) {
  const target = level > 0 ? '#'.repeat(level) + ' ' : ''
  eachSelectedLine(view, (line) => {
    const stripped = line.replace(/^\s{0,3}#{1,6}\s+/, '')
    return target + stripped
  })
  focusIfAllowed(view)
}

export function togglePrefix(view: View, prefix: string | ((n: number) => string)) {
  const { state } = view
  const sel = state.selection.main
  const fromLine = state.doc.lineAt(sel.from).number
  const toLine = state.doc.lineAt(sel.to).number
  const count = toLine - fromLine + 1
  let n = 0
  const lines: string[] = []
  for (let i = fromLine; i <= toLine; i++) lines.push(state.doc.line(i).text)
  const make = (i: number) => (typeof prefix === 'function' ? prefix(i + 1) : prefix)
  const allHave = lines.every((l, i) => l.startsWith(make(i)))
  eachSelectedLine(view, (line) => {
    const p = make(n++)
    if (allHave) return line.slice(p.length)
    return p + line.replace(/^\s{0,3}[-*+]\s+(\[[ xX]\](?:\s+|$))?/, '')
  })
  focusIfAllowed(view)
}

export function toggleTask(view: View) {
  const { state } = view
  const sel = state.selection.main
  const fromLine = state.doc.lineAt(sel.from).number
  const toLine = state.doc.lineAt(sel.to).number
  const lines: string[] = []
  for (let i = fromLine; i <= toLine; i++) lines.push(state.doc.line(i).text)
  // An empty task item has no text after the box, and markdown-it trims the
  // trailing space. Match end-of-line too, or pressing 任务 twice stacks
  // another `[ ] ` onto the same line.
  const allTasks = lines.every((l) => /^\s*[-*+]\s+\[[ xX]\](?:\s+|$)/.test(l))
  eachSelectedLine(view, (line) => {
    if (allTasks) return line.replace(/^(\s*[-*+]\s+)\[[ xX]\](?:\s+|$)/, '$1')
    if (/^\s*[-*+]\s+/.test(line)) return line.replace(/^(\s*[-*+]\s+)/, '$1[ ] ')
    return line.replace(/^(\s*)/, '$1- [ ] ')
  })
  focusIfAllowed(view)
}

/** Flip a `- [ ]` / `- [x]` at a given 0-based source line (preview checkbox). */
export function flipTaskAtLine(view: View, lineNumber: number): boolean {
  if (lineNumber < 0 || lineNumber >= view.state.doc.lines) return false
  const line = view.state.doc.line(lineNumber + 1)
  const m = /^(\s*[-*+]\s+\[)([ xX])(\])/.exec(line.text)
  if (!m) return false
  const next = m[2] === ' ' ? 'x' : ' '
  view.dispatch({ changes: { from: line.from + m[1].length, to: line.from + m[1].length + 1, insert: next } })
  return true
}

export function indentSelection(view: View, direction: 1 | -1) {
  const { state } = view
  const sel = state.selection.main
  const fromLine = state.doc.lineAt(sel.from).number
  const toLine = state.doc.lineAt(sel.to).number
  const changes: { from: number; to: number; insert: string }[] = []
  let deltaFirst = 0
  let deltaAll = 0
  for (let n = fromLine; n <= toLine; n++) {
    const line = state.doc.line(n)
    if (direction === 1) {
      changes.push({ from: line.from, to: line.from, insert: '  ' })
      if (n === fromLine) deltaFirst = 2
      deltaAll += 2
    } else if (/^ {1,2}\S/.test(line.text) || line.text.startsWith('  ')) {
      const remove = line.text.startsWith('  ') ? 2 : 1
      changes.push({ from: line.from, to: line.from + remove, insert: '' })
      if (n === fromLine) deltaFirst = -remove
      deltaAll -= remove
    } else if (line.text.startsWith('\t')) {
      changes.push({ from: line.from, to: line.from + 1, insert: '' })
      if (n === fromLine) deltaFirst = -1
      deltaAll -= 1
    }
  }
  if (!changes.length) return
  view.dispatch({
    changes,
    selection:
      sel.from === sel.to
        ? EditorSelection.cursor(Math.max(0, sel.from + deltaFirst))
        : EditorSelection.range(Math.max(0, sel.from + deltaFirst), sel.to + deltaAll),
    scrollIntoView: true,
  })
}

export function moveLine(view: View, direction: -1 | 1) {
  const { state } = view
  const sel = state.selection.main
  const fromLine = state.doc.lineAt(sel.from).number
  const toLine = state.doc.lineAt(sel.to).number
  if ((direction === -1 && fromLine === 1) || (direction === 1 && toLine === state.doc.lines)) return
  const start = state.doc.line(fromLine).from
  const end = state.doc.line(toLine).to
  const block = state.doc.sliceString(start, end)
  if (direction === -1) {
    const prev = state.doc.line(fromLine - 1)
    const insert = block + '\n' + prev.text
    view.dispatch({
      changes: { from: prev.from, to: end, insert },
      selection: EditorSelection.range(sel.from - prev.text.length - 1, sel.to - prev.text.length - 1),
      scrollIntoView: true,
    })
  } else {
    const next = state.doc.line(toLine + 1)
    const insert = next.text + '\n' + block
    view.dispatch({
      changes: { from: start, to: next.to, insert },
      selection: EditorSelection.range(sel.from + next.text.length + 1, sel.to + next.text.length + 1),
      scrollIntoView: true,
    })
  }
  focusIfAllowed(view)
}

export function duplicateLine(view: View) {
  const { state } = view
  const sel = state.selection.main
  const fromLine = state.doc.lineAt(sel.from).number
  const toLine = state.doc.lineAt(sel.to).number
  const text = state.doc.sliceString(state.doc.line(fromLine).from, state.doc.line(toLine).to)
  const at = state.doc.line(toLine).to
  view.dispatch({
    changes: { from: at, to: at, insert: '\n' + text },
    selection: EditorSelection.range(sel.from, sel.to),
    scrollIntoView: true,
  })
  focusIfAllowed(view)
}

export function deleteLine(view: View) {
  const { state } = view
  const sel = state.selection.main
  const fromLine = state.doc.lineAt(sel.from).number
  const toLine = state.doc.lineAt(sel.to).number
  const from = state.doc.line(fromLine).from
  let to = state.doc.line(toLine).to
  if (toLine < state.doc.lines) to = state.doc.line(toLine + 1).from
  else if (from > 0) to = Math.max(0, from - 1)
  const change = state.changes({ from: Math.min(from, to), to, insert: '' })
  view.dispatch({
    changes: change,
    selection: EditorSelection.cursor(change.mapPos(sel.from, 1)),
    scrollIntoView: true,
  })
  focusIfAllowed(view)
}

export function wordStats(text: string) {
  const chars = text.length
  const cjk = (text.match(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g) || []).length
  const words = (text.replace(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g, ' ').match(/[A-Za-z0-9_'-]+/g) || []).length
  return { chars, words: cjk + words, lines: text ? text.split('\n').length : 0 }
}
