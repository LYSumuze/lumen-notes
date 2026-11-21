import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './Icons'
import { formatShortcut } from '../lib/commands'

export interface PaletteItem {
  id: string
  title: string
  subtitle?: string
  shortcut?: string
  group?: string
  icon?: string
  run: () => void
}

export function CommandPalette({ open, title, items, onClose, hideShortcuts = false }: {
  open: boolean
  title: string
  items: PaletteItem[]
  onClose: () => void
  /** Phone: keyboard hints and the ↑↓/↵/Esc footer have no meaning on touch. */
  hideShortcuts?: boolean
}) {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) { setQuery(''); setIndex(0); window.setTimeout(() => inputRef.current?.focus(), 20) }
  }, [open, title])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items
      .map((it) => {
        const t = it.title.toLowerCase()
        const s = (it.subtitle || '').toLowerCase()
        let score = 0
        if (t.startsWith(q)) score = 4
        else if (t.includes(q)) score = 3
        else if (s.includes(q)) score = 2
        else if (q.split('').every((ch) => t.includes(ch))) score = 1
        return { it, score }
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.it)
  }, [query, items])

  useEffect(() => { setIndex(0) }, [query, title])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return }
      if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(i + 1, filtered.length - 1)) }
      if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)) }
      if (e.key === 'Enter') {
        e.preventDefault()
        const item = filtered[index]
        if (item) { onClose(); item.run() }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, filtered, index, onClose])

  useEffect(() => {
    listRef.current?.querySelector('.palette-item.active')?.scrollIntoView({ block: 'nearest' })
  }, [index])

  if (!open) return null
  let lastGroup = ''
  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className={`palette ${hideShortcuts ? 'no-shortcuts' : ''}`}>
        <div className="palette-input">
          <Icon name={title.includes('文件') ? 'file' : 'command'} size={18} />
          <input ref={inputRef} value={query} placeholder={title} onChange={(e) => setQuery(e.target.value)} />
          {!hideShortcuts && <kbd>ESC</kbd>}
        </div>
        <div className="palette-list" ref={listRef}>
          {filtered.map((it, i) => {
            const showGroup = it.group && it.group !== lastGroup
            lastGroup = it.group || ''
            return (
              <div key={it.id}>
                {showGroup && <div className="palette-group">{it.group}</div>}
                <button
                  className={`palette-item ${i === index ? 'active' : ''}`}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => { onClose(); it.run() }}
                >
                  <Icon name={it.icon || 'dot'} size={15} />
                  <span className="palette-title">{it.title}</span>
                  {it.subtitle && <span className="palette-sub">{it.subtitle}</span>}
                  {!hideShortcuts && it.shortcut && <kbd>{formatShortcut(it.shortcut)}</kbd>}
                </button>
              </div>
            )
          })}
          {!filtered.length && <div className="empty-hint">没有匹配项</div>}
        </div>
        {!hideShortcuts && <div className="palette-footer"><span>↑↓ 选择</span><span>↵ 执行</span><span>Esc 关闭</span></div>}
      </div>
    </div>
  )
}
