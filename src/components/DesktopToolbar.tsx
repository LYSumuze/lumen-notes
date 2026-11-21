import { useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { Icon } from './Icons'
import { formatShortcut } from '../lib/commands'
import {
  BODY_ID, HEADING_ID, HEADING_LEVELS, MORE_ID, TOOLBAR_BY_ID,
  normalizeToolbar, shortLabel,
} from '../lib/toolbar'

export interface DesktopToolbarProps {
  /** Same user setting as the phone accessory bar. */
  toolbar: string[]
  onCommand: (id: string) => void
  onUndo: () => void
  onRedo: () => void
  canUndo: boolean
  canRedo: boolean
  onInsertImage: () => void
  onMore: () => void
  onCustomize: () => void
}

interface Bubble { left: number; top: number }

/**
 * Desktop counterpart of the phone accessory bar. The button set, order and
 * visibility come from 设置 → 编辑工具栏, shared with the Android shell.
 * Undo / redo / 自定义 / 全部命令 are fixed so the customiser is always
 * reachable.
 *
 * The heading button opens a 1–6 level popover. It is rendered as a fixed
 * element anchored to the button: the scrollable format strip would otherwise
 * clip an absolutely positioned child. The popover opens downwards because
 * the strip sits directly below the title bar.
 */
export function DesktopToolbar(props: DesktopToolbarProps) {
  const ids = normalizeToolbar(props.toolbar).filter((id) => id !== MORE_ID)
  const actions = ids.map((id) => TOOLBAR_BY_ID.get(id)).filter(Boolean)
  const [bubble, setBubble] = useState<Bubble | null>(null)
  const headingBtn = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!bubble) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (popover.current?.contains(t) || headingBtn.current?.contains(t)) return
      setBubble(null)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setBubble(null) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [bubble])

  const keepFocus = (e: ReactMouseEvent) => e.preventDefault()

  const toggleHeading = (e: ReactMouseEvent<HTMLButtonElement>) => {
    if (bubble) { setBubble(null); return }
    const r = e.currentTarget.getBoundingClientRect()
    setBubble({ left: Math.max(8, Math.min(r.left, window.innerWidth - 236)), top: r.bottom + 6 })
  }

  const run = (id: string, e: ReactMouseEvent<HTMLButtonElement>) => {
    const a = TOOLBAR_BY_ID.get(id)
    if (!a) return
    if (a.kind === 'heading') { toggleHeading(e); return }
    if (a.kind === 'command') props.onCommand(id)
    else if (a.kind === 'image') props.onInsertImage()
    else props.onMore()
    setBubble(null)
  }

  const fixed = (label: string, icon: string, onClick: () => void, disabled = false) => (
    <button key={label} className="dtb-btn" title={label} aria-label={label}
      disabled={disabled} onMouseDown={keepFocus} onClick={onClick}>
      <Icon name={icon} size={17} />
    </button>
  )

  return (
    <>
      <div className="desktop-toolbar desktop-flex">
        <div className="dtb-cluster">
          {fixed('撤销', 'undo', props.onUndo, !props.canUndo)}
          {fixed('重做', 'redo', props.onRedo, !props.canRedo)}
        </div>
        <i className="dtb-div" />
        <div className="dtb-scroll">
          {actions.map((a, i) => (
            <span className="dtb-cell" key={a!.id}>
              {i > 0 && actions[i - 1]!.group !== a!.group && <i className="dtb-div" />}
              <button
                ref={a!.id === HEADING_ID ? headingBtn : undefined}
                className={`dtb-btn labelled ${a!.id === HEADING_ID && bubble ? 'on' : ''}`}
                title={a!.label} aria-label={a!.label}
                aria-expanded={a!.id === HEADING_ID ? !!bubble : undefined}
                onMouseDown={keepFocus} onClick={(e) => run(a!.id, e)}
              >
                <Icon name={a!.icon} size={16} />
                <span className="dtb-cap">{shortLabel(a!)}</span>
              </button>
            </span>
          ))}
        </div>
        <i className="dtb-div" />
        <div className="dtb-cluster">
          {fixed('编辑工具栏', 'sliders', props.onCustomize)}
          {fixed('全部命令', 'more', props.onMore)}
        </div>
      </div>

      {bubble && (
        <div className="dtb-popover" ref={popover}
          style={{ left: bubble.left, top: bubble.top }}>
          <div className="dtb-popover-title">标题级别</div>
          {HEADING_LEVELS.map((id, i) => (
            <button key={id} className="dtb-popover-row"
              onMouseDown={keepFocus} onClick={() => { props.onCommand(id); setBubble(null) }}>
              <span className="dtb-popover-h">H{i + 1}</span>
              <span>{i + 1} 级标题</span>
              <kbd>{formatShortcut(`Mod+${i + 1}`)}</kbd>
            </button>
          ))}
          <button className="dtb-popover-row" onMouseDown={keepFocus}
            onClick={() => { props.onCommand(BODY_ID); setBubble(null) }}>
            <span className="dtb-popover-h">¶</span>
            <span>正文</span>
            <kbd>{formatShortcut('Mod+0')}</kbd>
          </button>
        </div>
      )}
    </>
  )
}
