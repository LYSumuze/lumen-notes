import { useEffect, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent, RefObject } from 'react'
import { Icon } from '../components/Icons'
import {
  BODY_ID, HEADING_ID, HEADING_LEVELS, MORE_ID, TOOLBAR_BY_ID,
  normalizeToolbar,
} from '../lib/toolbar'

export interface MobileEditorBarProps {
  /** Button ids in display order, from settings.toolbarCommands. */
  toolbar: string[]
  onCommand: (id: string) => void
  onUndo: () => void
  onRedo: () => void
  canUndo: boolean
  canRedo: boolean
  onInsertImage: () => void
  onMore: () => void
  /** Open 设置 → 编辑工具栏 directly from the bar. */
  onCustomize: () => void
  /** Pin focus back onto the editor before any toolbar button runs. */
  onPinFocus: () => void
}

/** Full-width segmented edit/read switch, always visible above the content. */
export function MobileEditorSeg({ pane, onPane }: { pane: 'edit' | 'read'; onPane: (p: 'edit' | 'read') => void }) {
  return (
    <div className="m-seg">
      <button className={pane === 'edit' ? 'on' : ''} onClick={() => onPane('edit')}>编辑</button>
      <button className={pane === 'read' ? 'on' : ''} onClick={() => onPane('read')}>阅读</button>
    </div>
  )
}

type Panel = null | 'heading' | 'more'

/**
 * Keyboard accessory bar: a single compact row of icon-only buttons (34px
 * pitch, 46px tall) sitting on the IME's top edge. Undo / redo and 「⋯」 are
 * pinned; the configurable format buttons scroll horizontally in between.
 *
 * Every button prevents the default mousedown so CodeMirror keeps the caret:
 * tapping a format button must not close the IME and re-open it from focus().
 */
export function MobileEditorBar(props: MobileEditorBarProps) {
  const ids = normalizeToolbar(props.toolbar).filter((id) => id !== MORE_ID)
  const actions = ids.map((id) => TOOLBAR_BY_ID.get(id)).filter(Boolean)
  const [panel, setPanel] = useState<Panel>(null)
  const headingBtn = useRef<HTMLButtonElement>(null)
  const moreBtn = useRef<HTMLButtonElement>(null)
  const sheet = useRef<HTMLDivElement>(null)

  const hadFocus = useRef(false)

  // React's synthetic mousedown on WebView is fired for touch taps too.
  // preventDefault stops the <button> from stealing focus from CodeMirror.
  // We record whether the caret was live BEFORE the tap: only in that case
  // do we put focus back afterwards. Focusing unconditionally (v70) popped
  // the IME back up whenever the user had deliberately dismissed it.
  const keepFocus = (e: ReactMouseEvent) => {
    e.preventDefault()
    const el = document.activeElement as HTMLElement | null
    hadFocus.current = !!el?.closest?.('.cm-content')
  }
  const restore = () => { if (hadFocus.current) props.onPinFocus() }
  /** Wrap every click so focus is restored once, only when it was already on. */
  const act = (fn: () => void) => () => { fn(); restore() }

  useEffect(() => {
    if (!panel) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (sheet.current?.contains(t)) return
      if (headingBtn.current?.contains(t) || moreBtn.current?.contains(t)) return
      setPanel(null)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPanel(null) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [panel])

  const run = (id: string) => {
    const a = TOOLBAR_BY_ID.get(id)
    if (!a) return
    if (a.kind === 'heading') { setPanel((p) => p === 'heading' ? null : 'heading'); return }
    if (a.kind === 'command') props.onCommand(id)
    else if (a.kind === 'image') props.onInsertImage()
    else props.onMore()
    setPanel(null)
  }
  const pick = (id: string) => { props.onCommand(id); setPanel(null) }

  const fixed = (
    label: string, icon: string, onClick: () => void,
    opts: { ref?: RefObject<HTMLButtonElement>; on?: boolean; disabled?: boolean } = {},
  ) => (
    <button
      ref={opts.ref} className={`m-tb-fixed ${opts.on ? 'on' : ''}`}
      disabled={opts.disabled}
      title={label} aria-label={label}
      onMouseDown={keepFocus} onClick={act(onClick)}
    ><Icon name={icon} size={18} /></button>
  )

  return (
    <div className="m-toolbar">
      <div className="m-tb-cluster">
        {fixed('撤销', 'undo', props.onUndo, { disabled: !props.canUndo })}
        {fixed('重做', 'redo', props.onRedo, { disabled: !props.canRedo })}
      </div>
      <i className="m-toolbar-div" />
      <div className="m-toolbar-scroll">
        {actions.map((a, i) => (
          <span className="m-toolbar-cell" key={a!.id}>
            {i > 0 && actions[i - 1]!.group !== a!.group && <i className="m-toolbar-div" />}
            <button
              ref={a!.id === HEADING_ID ? headingBtn : undefined}
              className={`m-tb-action ${a!.id === HEADING_ID && panel === 'heading' ? 'on' : ''}`}
              title={a!.label} aria-label={a!.label}
              aria-expanded={a!.id === HEADING_ID ? panel === 'heading' : undefined}
              onMouseDown={keepFocus} onClick={act(() => run(a!.id))}
            >
              <Icon name={a!.icon} size={18} />
            </button>
          </span>
        ))}
      </div>
      <i className="m-toolbar-div pin" />
      {fixed('更多', 'more', () => setPanel((p) => p === 'more' ? null : 'more'),
        { ref: moreBtn, on: panel === 'more' })}

      {panel && (
        <div className={`m-tb-sheet ${panel}`} ref={sheet}>
          {panel === 'heading' ? (
            <>
              <div className="m-tb-sheet-title">标题级别</div>
              <div className="m-tb-levels">
                {HEADING_LEVELS.map((id, i) => (
                  <button key={id} className="m-tb-level"
                    title={`${i + 1} 级标题`} aria-label={`${i + 1} 级标题`}
                    onMouseDown={keepFocus} onClick={act(() => pick(id))}>
                    H{i + 1}
                  </button>
                ))}
              </div>
              <button className="m-tb-sheet-row" onMouseDown={keepFocus} onClick={act(() => pick(BODY_ID))}>
                <Icon name="outline" size={17} /> 正文（清除标题）
              </button>
            </>
          ) : (
            <>
              <div className="m-tb-sheet-title">工具</div>
              <button className="m-tb-sheet-row" onMouseDown={keepFocus}
                onClick={act(() => { props.onCustomize(); setPanel(null) })}>
                <Icon name="sliders" size={17} /> 编辑工具栏
              </button>
              <button className="m-tb-sheet-row" onMouseDown={keepFocus}
                onClick={act(() => { props.onMore(); setPanel(null) })}>
                <Icon name="more" size={17} /> 全部命令
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
