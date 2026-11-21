/**
 * Two-way scroll mapping between the CodeMirror source pane and the rendered
 * reading pane. Block-level elements carry `data-line` (see sourceLinePlugin).
 * Positions are interpolated between two neighbouring anchors so scrolling
 * feels continuous rather than snapping paragraph by paragraph.
 */
import type { EditorHandle } from '../types'

interface Anchor { line: number; top: number }

export class ScrollSync {
  private anchors: Anchor[] = []
  private lock: 'editor' | 'preview' | null = null
  private timer: number | undefined
  private enabled = true

  constructor(
    private getEditor: () => EditorHandle | null,
    private getPreview: () => HTMLElement | null
  ) {}

  setEnabled(v: boolean) { this.enabled = v }

  refresh() {
    const container = this.getPreview()
    if (!container) { this.anchors = []; return }
    const baseTop = container.getBoundingClientRect().top - container.scrollTop
    const nodes = Array.from(container.querySelectorAll<HTMLElement>('[data-line]'))
    const map = new Map<number, number>()
    for (const el of nodes) {
      const line = Number(el.getAttribute('data-line'))
      if (!Number.isFinite(line)) continue
      const top = el.getBoundingClientRect().top - baseTop
      if (!map.has(line) || top < map.get(line)!) map.set(line, top)
    }
    this.anchors = [...map.entries()]
      .map(([line, top]) => ({ line, top }))
      .sort((a, b) => a.line - b.line || a.top - b.top)
      // Only keep the first anchor per line, monotonically increasing in top.
      .filter((a, i, arr) => i === 0 || (a.line > arr[i - 1].line && a.top >= arr[i - 1].top - 2))
  }

  private claim(who: 'editor' | 'preview', force = false) {
    if (!this.enabled) return false
    if (this.lock && this.lock !== who) return false
    if (!force && this.lock === who && !this.timer) return false
    this.lock = who
    if (this.timer) clearTimeout(this.timer)
    this.timer = window.setTimeout(() => { this.lock = null; this.timer = undefined }, 160)
    return true
  }

  private pair(line: number): [Anchor, Anchor] | null {
    const a = this.anchors
    if (!a.length) return null
    let i = a.length - 1
    while (i > 0 && a[i].line > line) i--
    const first = a[i]
    const second = a[i + 1] || { line: first.line + 1, top: first.top + 40 }
    return [first, second]
  }

  /** Source pane scrolled -> move reading pane. */
  onEditorScroll() {
    if (!this.claim('editor')) return
    const editor = this.getEditor()
    const preview = this.getPreview()
    if (!editor || !preview || !this.anchors.length) return
    const line = editor.getTopLine()
    const pair = this.pair(line)
    if (!pair) return
    const [a, b] = pair
    const ratio = b.line > a.line ? Math.min(1, Math.max(0, (line - a.line) / (b.line - a.line))) : 0
    const top = a.top + ratio * (b.top - a.top)
    if (Math.abs(preview.scrollTop - top) > 1) preview.scrollTop = top
  }

  /** Reading pane scrolled -> move source pane. */
  onPreviewScroll() {
    if (!this.claim('preview')) return
    const editor = this.getEditor()
    const preview = this.getPreview()
    if (!editor || !preview || !this.anchors.length) return
    const y = preview.scrollTop
    const a = this.anchors
    let i = a.length - 1
    while (i > 0 && a[i].top > y) i--
    const first = a[i]
    const second = a[i + 1] || { line: first.line + 1, top: first.top + 40 }
    const ratio = second.top > first.top ? Math.min(1, Math.max(0, (y - first.top) / (second.top - first.top))) : 0
    editor.scrollToLine(Math.max(1, Math.round(first.line + ratio * (second.line - first.line)) + 1), false)
  }

  /** Clicked in the source: bring the matching rendered block to the top. */
  jumpFromEditor(line: number) {
    const preview = this.getPreview()
    if (!preview || !this.anchors.length) return
    this.claim('editor', true) // suppress the echo from the preview scroll event
    const pair = this.pair(line)
    if (!pair) return
    const [a, b] = pair
    const ratio = b.line > a.line ? Math.min(1, Math.max(0, (line - a.line) / (b.line - a.line))) : 0
    const top = a.top + ratio * (b.top - a.top)
    preview.scrollTo({ top: Math.max(0, top - 8), behavior: 'smooth' })
    this.flash(preview, line)
  }

  /** Clicked in the reading pane: put the caret on the matching source line. */
  jumpFromPreview(line: number) {
    const editor = this.getEditor()
    if (!editor) return
    this.claim('preview', true)
    editor.scrollToLine(line + 1, true)
    this.flash(this.getPreview(), line)
  }

  private flash(preview: HTMLElement | null, line: number) {
    if (!preview) return
    const el = preview.querySelector<HTMLElement>(`[data-line="${line}"]`)
    if (!el) return
    el.classList.remove('sync-flash')
    void el.offsetWidth
    el.classList.add('sync-flash')
    window.setTimeout(() => el.classList.remove('sync-flash'), 900)
  }
}
