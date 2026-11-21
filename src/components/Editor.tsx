import { useEffect, useRef } from 'react'
import type { CSSProperties } from 'react'
import { EditorSelection, EditorState, Prec, StateEffect, StateField, Transaction } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { indentWithTab, redoDepth, undoDepth } from '@codemirror/commands'
import { HighlightStyle, syntaxHighlighting, syntaxTree } from '@codemirror/language'
import { markdown } from '@codemirror/lang-markdown'
import { tags } from '@lezer/highlight'
import { basicSetup } from 'codemirror'
import type { EditorHandle } from '../types'

const mdHighlight = HighlightStyle.define([
  { tag: tags.heading, color: 'var(--md-h)', fontWeight: '600' },
  { tag: tags.heading1, color: 'var(--md-h)', fontWeight: '700' },
  { tag: tags.heading2, color: 'var(--md-h)', fontWeight: '700' },
  { tag: tags.strong, color: 'var(--md-bold)', fontWeight: '700' },
  { tag: tags.emphasis, color: 'var(--md-em)', fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through', color: 'var(--text-faint)' },
  { tag: tags.link, color: 'var(--md-link)', textDecoration: 'underline' },
  { tag: tags.url, color: 'var(--md-link)' },
  { tag: tags.monospace, color: 'var(--md-code-fg)' },
  { tag: tags.quote, color: 'var(--text-muted)', fontStyle: 'italic' },
  { tag: tags.list, color: 'var(--accent)' },
  { tag: tags.meta, color: 'var(--text-faint)' },
  { tag: tags.processingInstruction, color: 'var(--text-faint)' },
  { tag: tags.contentSeparator, color: 'var(--accent)' },
])

const cmTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'transparent',
    color: 'var(--text-normal)',
    fontSize: 'var(--editor-size)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.72', overflow: 'auto', overscrollBehavior: 'contain' },
  '.cm-content': { padding: '16px 0 62vh', caretColor: 'var(--accent)', minHeight: '100%' },
  '.cm-line': { padding: '0 14px 0 8px' },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--text-faint)', border: 'none', paddingRight: '4px' },
  '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-muted)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'var(--selection)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--selection-match)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--bg-hover)', border: 'none', color: 'var(--text-muted)' },
  '.cm-tooltip': { backgroundColor: 'var(--bg-float)', border: '1px solid var(--border)', color: 'var(--text-normal)' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--accent)', color: '#fff' },
  '.cm-panels': { backgroundColor: 'var(--bg-secondary)', color: 'var(--text-normal)' },
  '.cm-searchMatch': { backgroundColor: 'var(--selection-match)' },
})

/* ------------------------------------------------------------------ Enter
   @codemirror/lang-markdown registers `insertNewlineContinueMarkup` on Enter.
   On a marker line with no text it DELETES the marker to "end the list", so a
   `- [ ] ` / `- ` / `1. ` just inserted from the toolbar vanished on the very
   first Enter (the user never got to type anything).

   Plan A: Enter on a marker line keeps the current line and opens a fresh
   marker of the same kind. A second Enter on that generated empty line ends
   the list. Typing on the generated line clears the marker, so writing a
   checklist keeps continuing normally.
   ------------------------------------------------------------------------ */
const LIST_MARKER = /^(\s*)(?:([-*+])|(\d+)([.)])|(>))\s+(\[[ xX]\](?:\s+|$))?/

interface ContinuedLine { from: number; text: string }
const setContinuedLine = StateEffect.define<ContinuedLine | null>()

/** The empty marker line produced by our own Enter; cleared once edited. */
const continuedLine = StateField.define<ContinuedLine | null>({
  create: () => null,
  update(value, tr) {
    let own: ContinuedLine | null | undefined
    for (const e of tr.effects) if (e.is(setContinuedLine)) own = e.value
    // This effect travels with the change that creates the line, so `from` is
    // already in post-change coordinates — do not map it again.
    if (own !== undefined) return own
    if (!value) return null
    if (!tr.docChanged) return value
    const from = tr.changes.mapPos(value.from, 1)
    if (from > tr.state.doc.length) return null
    const line = tr.state.doc.lineAt(from)
    return line.from === from && line.text === value.text
      ? { from, text: value.text }
      : null
  },
})

/** Next line's prefix: same list/quote, next ordinal, always an open task. */
function markerContinuation(m: RegExpExecArray) {
  const indent = m[1] || ''
  const lead = m[5] ? '> '
    : m[3] ? `${Number(m[3]) + 1}${m[4]} `
      : `${m[2]} `
  const task = m[6] ? '[ ] ' : ''
  return indent + lead + task
}

/** Never rewrite markup inside a fenced / indented code block. */
function insideCode(state: EditorState, pos: number) {
  let node = syntaxTree(state).resolveInner(pos, -1)
  while (node) {
    if (/FencedCode|CodeBlock|CodeText|InlineCode/.test(node.name)) return true
    node = node.parent
  }
  return false
}

const continueMarkerOnEnter = keymap.of([{
  key: 'Enter',
  run(view) {
    const { state } = view
    const sel = state.selection.main
    if (!sel.empty) return false
    const line = state.doc.lineAt(sel.head)
    if (sel.head !== line.to) return false
    const m = LIST_MARKER.exec(line.text)
    if (!m || insideCode(state, sel.head)) return false
    const body = line.text.slice(m[0].length)
    // Nested quotes / code fences need lang-markdown's own handling.
    if (body.startsWith('>')) return false
    const pending = state.field(continuedLine, false)
    const isGeneratedEmpty = !!pending && pending.from === line.from && pending.text === line.text
    if (body.trim() === '' && isGeneratedEmpty) {
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: '' },
        selection: EditorSelection.cursor(line.from),
        scrollIntoView: true,
      })
      return true
    }
    const prefix = markerContinuation(m)
    const insert = '\n' + prefix
    view.dispatch({
      changes: { from: sel.head, insert },
      selection: EditorSelection.cursor(sel.head + insert.length),
      scrollIntoView: true,
      effects: setContinuedLine.of({ from: sel.head + 1, text: prefix }),
    })
    return true
  },
}])

interface Props {
  value: string
  docKey: string
  onChange: (value: string) => void
  onCursor: (line: number, col: number) => void
  onScroll: () => void
  onClickJump: (line: number) => void
  onHandle: (handle: EditorHandle | null) => void
  /** undo/redo stack depth, for disabling buttons when a stack is empty. */
  onHistoryChange?: (undo: number, redo: number) => void
  fontSize: number
  showLineNumbers: boolean
  /** Paste / drop / button all route here; App copies the file into img/<note>/. */
  onInsertImage?: (file: File) => void
}

export function Editor({
  value, docKey, onChange, onCursor, onScroll, onClickJump, onHandle,
  onHistoryChange, fontSize, showLineNumbers, onInsertImage,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const cb = useRef({ onChange, onCursor, onScroll, onClickJump, onInsertImage, onHistoryChange })
  cb.current = { onChange, onCursor, onScroll, onClickJump, onInsertImage, onHistoryChange }
  const docKeyRef = useRef(docKey)
  // Programmatic value changes (switching notes, restoring history, sync)
  // must NOT look like user input, or explicit-save mode marks them dirty.
  const applyingRef = useRef(false)
  /** Coalesce the caret-follow measurement to one frame per burst of typing. */
  const caretFollowRef = useRef(false)
  /** Rebuild a fresh EditorState (and thus an empty undo history) on demand. */
  const stateFactoryRef = useRef<((doc: string) => EditorState) | null>(null)

  useEffect(() => {
    if (!hostRef.current) return
    const extensions = [
      basicSetup,
      Prec.highest(keymap.of([indentWithTab])),
      // Must outrank markdown()'s Prec.high Enter keymap.
      continuedLine,
      Prec.highest(continueMarkerOnEnter),
      markdown(),
      EditorView.lineWrapping,
      EditorView.updateListener.of((u) => {
        if (u.docChanged && !applyingRef.current) {
          cb.current.onChange(u.state.doc.toString())
          // Typing at the bottom (especially Enter) used to leave the new
          // line behind the soft keyboard: CodeMirror only guarantees the
          // caret is inside its scroller, whose lower half can be covered
          // by an IME, a candidate strip or a resized keyboard layout.
          // Measure the real visible bottom edge and the real toolbar
          // height — never a fixed fraction of the scroller.
          if (!caretFollowRef.current) {
            caretFollowRef.current = true
            const head = u.state.selection.main.head
            requestAnimationFrame(() => {
              caretFollowRef.current = false
              const v = viewRef.current
              if (!v || v.state.doc.length < head) return
              const coords = v.coordsAtPos(head)
              const rect = v.scrollDOM.getBoundingClientRect()
              if (!coords || !rect.height) return
              const vv = window.visualViewport
              const visibleBottom = vv ? vv.offsetTop + vv.height : window.innerHeight
              const bar = document.querySelector<HTMLElement>('.m-toolbar')
              const barH = bar ? bar.getBoundingClientRect().height : 0
              const lineH = v.defaultLineHeight || 24
              const safeBottom = Math.min(rect.bottom, visibleBottom - barH) - lineH
              if (coords.bottom > safeBottom) {
                const margin = Math.max(lineH * 2,
                  Math.min(rect.height * 0.6, rect.bottom - safeBottom))
                v.dispatch({
                  effects: EditorView.scrollIntoView(head, { y: 'nearest', yMargin: margin }),
                  annotations: Transaction.addToHistory.of(false),
                })
              }
            })
          }
        }
        if (u.docChanged) {
          cb.current.onHistoryChange?.(undoDepth(u.state), redoDepth(u.state))
        }
        if (u.docChanged || u.selectionSet) {
          const sel = u.state.selection.main
          const line = u.state.doc.lineAt(sel.head)
          cb.current.onCursor(line.number, sel.head - line.from + 1)
        }
      }),
      // Images pasted or dropped into the editor become vault attachments,
      // not inline data URIs that would bloat the .md forever.
      EditorView.domEventHandlers({
        paste(event) {
          const image = Array.from(event.clipboardData?.files || []).find((f) => f.type.startsWith('image/'))
          if (!image || !cb.current.onInsertImage) return false
          event.preventDefault()
          cb.current.onInsertImage(image)
          return true
        },
        drop(event) {
          const image = Array.from(event.dataTransfer?.files || []).find((f) => f.type.startsWith('image/'))
          if (!image || !cb.current.onInsertImage) return false
          event.preventDefault()
          cb.current.onInsertImage(image)
          return true
        },
      }),
      syntaxHighlighting(mdHighlight),
      cmTheme,
      EditorView.contentAttributes.of({ spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' }),
    ]
    const makeState = (doc: string) => EditorState.create({ doc, extensions })
    stateFactoryRef.current = makeState
    const view = new EditorView({
      parent: hostRef.current,
      state: makeState(value),
    })
    viewRef.current = view

    const handle: EditorHandle = {
      view,
      scroller: view.scrollDOM,
      getTopLine() {
        const rect = view.scrollDOM.getBoundingClientRect()
        const pos = view.posAtCoords({ x: rect.left + 48, y: rect.top + 6 }, false)
        if (pos == null) return 0
        return view.state.doc.lineAt(pos).number - 1
      },
      scrollToLine(line: number, setCursor = false) {
        const n = Math.min(Math.max(1, Math.round(line)), view.state.doc.lines)
        const pos = view.state.doc.line(n).from
        view.dispatch({
          effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 4 }),
          ...(setCursor ? { selection: EditorSelection.cursor(pos) } : {}),
        })
      },
      getCursorLine() {
        return view.state.doc.lineAt(view.state.selection.main.head).number
      },
      insertText(text: string) {
        const sel = view.state.selection.main
        view.dispatch({
          changes: { from: sel.from, to: sel.to, insert: text },
          selection: EditorSelection.cursor(sel.from + text.length),
        })
        view.focus()
      },
      /** Soft keyboard can shrink the viewport without moving the caret. */
      ensureCursorVisible() {
        try {
          view.dispatch({
            effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'center', yMargin: 24 }),
            annotations: Transaction.addToHistory.of(false),
          })
        } catch { /* editor not measured yet */ }
      },
      /** Explicitly re-focus the editor (toolbar taps on Android must not
       *  leave the caret in a <button>, which would close the IME). */
      focus() {
        view.focus()
      },
    }
    onHandle(handle)

    const scroller = view.scrollDOM
    const scrollHandler = () => cb.current.onScroll()
    scroller.addEventListener('scroll', scrollHandler, { passive: true })
    const clickHandler = () => {
      const line = view.state.doc.lineAt(view.state.selection.main.head).number - 1
      cb.current.onClickJump(line)
    }
    view.contentDOM.addEventListener('click', clickHandler)

    return () => {
      scroller.removeEventListener('scroll', scrollHandler)
      view.contentDOM.removeEventListener('click', clickHandler)
      stateFactoryRef.current = null
      onHandle(null)
      view.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * Content arriving from outside the editor — switching notes, accepting a
   * sync/refresh, restoring a history version, adopting an external rewrite —
   * gets a BRAND NEW EditorState. A plain `dispatch` full-document change was
   * recorded by CodeMirror's history as one undoable step, so Ctrl+Z could
   * paste the previous note's text into the current file (and mark it dirty,
   * which then allowed saving that text over the wrong .md). A fresh state
   * also isolates each note's undo stack, like a normal editor.
   *
   * setState() keeps the view instance and its contentDOM/scrollDOM nodes, so
   * the EditorHandle and the listeners above stay valid. It does not fire
   * updateListener, hence the explicit history-depth notification below.
   */
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const isNewDoc = docKeyRef.current !== docKey
    // Even when two notes happen to have identical text, switching must still
    // reset the undo stack.
    if (!isNewDoc && value === view.state.doc.toString()) return
    docKeyRef.current = docKey
    const make = stateFactoryRef.current
    if (!make) return
    const previousHead = view.state.selection.main.head
    const previousTop = view.scrollDOM.scrollTop
    applyingRef.current = true
    try {
      view.setState(make(value))
      view.dispatch({
        selection: EditorSelection.cursor(isNewDoc ? 0 : Math.min(previousHead, value.length)),
        ...(isNewDoc ? { effects: EditorView.scrollIntoView(0, { y: 'start' }) } : {}),
        annotations: Transaction.addToHistory.of(false),
      })
      if (!isNewDoc) {
        view.scrollDOM.scrollTop = previousTop
        requestAnimationFrame(() => {
          if (viewRef.current === view) view.scrollDOM.scrollTop = previousTop
        })
      }
    } finally { applyingRef.current = false }
    cb.current.onHistoryChange?.(0, 0)
  }, [value, docKey])

  useEffect(() => {
    viewRef.current?.requestMeasure()
  }, [fontSize, showLineNumbers])

  return (
    <div className="editor-wrap">
      <div
        className={`editor-host ${showLineNumbers ? '' : 'hide-gutters'}`}
        ref={hostRef}
        style={{ '--editor-size': `${fontSize}px` } as CSSProperties}
      />
    </div>
  )
}
