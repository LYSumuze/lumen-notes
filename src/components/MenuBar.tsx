import { useEffect, useMemo, useRef, useState } from 'react'
import type { CommandDef } from '../types'
import { formatShortcut } from '../lib/commands'

export interface MenuBarProps {
  commands: CommandDef[]
}

type Item =
  | { kind: 'sep' }
  | { kind: 'cmd'; id: string; label?: string; disabled?: boolean; hint?: string }
  | { kind: 'toggle'; label: string; value: boolean; onChange: (v: boolean) => void; hint?: string }

interface Group { id: string; label: string; key: string; items: Item[] }

const sep = (): Item => ({ kind: 'sep' })
const cmd = (id: string, opts: { label?: string; disabled?: boolean; hint?: string } = {}): Item =>
  ({ kind: 'cmd', id, ...opts })

const VAULT_LABEL = '更改仓库…'

function buildGroups(): Group[] {
  return [
    {
      id: 'file', label: '文件', key: 'f', items: [
        cmd('app.storage', { label: VAULT_LABEL }), sep(),
        cmd('file.new'), cmd('file.new-folder'), sep(),
        cmd('file.save'), cmd('file.save-as'), cmd('file.download'), sep(),
        cmd('file.rename-current'), cmd('file.delete-current'), sep(),
        cmd('app.history'),
      ],
    },
    {
      id: 'edit', label: '编辑', key: 'e', items: [
        cmd('edit.up'), cmd('edit.down'), cmd('edit.dup'), cmd('edit.del'), sep(),
        cmd('edit.indent'), cmd('edit.outdent'), sep(),
        cmd('nav.palette'),
      ],
    },
    {
      id: 'search', label: '搜索', key: 's', items: [
        cmd('nav.quick'), cmd('nav.search'), sep(),
        cmd('view.files'), cmd('view.outline'),
      ],
    },
    {
      id: 'view', label: '视图', key: 'v', items: [
        cmd('view.toggle-edit-read'), cmd('view.split'), cmd('view.source'), cmd('view.reading'), sep(),
        cmd('view.sidebar'), cmd('view.right'), cmd('view.sync-scroll'), sep(),
        cmd('view.theme'), cmd('view.zoom-in'), cmd('view.zoom-out'),
      ],
    },
    {
      id: 'insert', label: '插入', key: 'i', items: [
        cmd('insert.image'), cmd('insert.link'), cmd('insert.hr'), sep(),
        cmd('insert.table'), cmd('insert.codeblock'), cmd('insert.mathblock'), sep(),
        cmd('insert.date'),
      ],
    },
    {
      id: 'format', label: '格式', key: 'o', items: [
        cmd('fmt.bold'), cmd('fmt.italic'), cmd('fmt.strike'), cmd('fmt.code'), cmd('fmt.math'), sep(),
        cmd('fmt.h1'), cmd('fmt.h2'), cmd('fmt.h3'), sep(),
        cmd('fmt.bullet'), cmd('fmt.ordered'), cmd('fmt.quote'), cmd('fmt.task'),
      ],
    },
    {
      id: 'sync', label: '同步', key: 'y', items: [
        cmd('app.sync-cloud'), cmd('app.sync-vault'), cmd('app.fetch'), sep(),
        cmd('app.sync', { label: '连接设备…' }), sep(),
        cmd('app.history'),
      ],
    },
    {
      id: 'settings', label: '设置', key: 't', items: [
        cmd('app.settings'), cmd('app.storage', { label: VAULT_LABEL }), sep(),
        cmd('view.theme'), cmd('view.zoom-in'), cmd('view.zoom-out'),
      ],
    },
    {
      id: 'help', label: '帮助', key: 'h', items: [
        cmd('help.shortcuts'), cmd('help.about'), sep(),
        cmd('nav.palette'),
      ],
    },
  ]
}

export function MenuBar(props: MenuBarProps) {
  const [open, setOpen] = useState<string | null>(null)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [expanded, setExpanded] = useState<string | null>('file')
  const rootRef = useRef<HTMLDivElement>(null)

  const groups = useMemo(() => buildGroups(), [])
  const byId = useMemo(() => new Map(props.commands.map((c) => [c.id, c])), [props.commands])
  const close = () => { setOpen(null); setMobileOpen(false) }

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { close(); return }
      if (!e.altKey || e.ctrlKey || e.metaKey) return
      const g = groups.find((x) => x.key === e.key.toLowerCase())
      if (!g) return
      e.preventDefault()
      if (window.innerWidth <= 860) { setMobileOpen(true); setExpanded(g.id); setOpen(null) }
      else { setOpen(g.id); setMobileOpen(false) }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [groups])

  const itemNode = (item: Item, i: number) => {
    if (item.kind === 'sep') return <div className="menu-sep" key={`s${i}`} />
    if (item.kind === 'toggle') {
      return (
        <button className="menu-item" key={`t${i}`} onClick={() => { item.onChange(!item.value); close() }}>
          <span className="menu-check">{item.value ? '✓' : ''}</span>
          <span className="menu-label">{item.label}</span>
          <span className="menu-shortcut" />
          {item.hint && <span className="menu-hint">{item.hint}</span>}
        </button>
      )
    }
    const def = byId.get(item.id)
    if (!def) return null
    const disabled = !!item.disabled
    return (
      <button
        className={`menu-item ${disabled ? 'disabled' : ''}`} key={item.id}
        disabled={disabled} title={item.hint}
        onClick={() => { if (disabled) return; close(); def.run() }}
      >
        <span className="menu-check" />
        <span className="menu-label">{item.label || def.name}</span>
        <span className="menu-shortcut">{def.shortcut ? formatShortcut(def.shortcut) : ''}</span>
        {disabled && item.hint && <span className="menu-hint">{item.hint}</span>}
      </button>
    )
  }

  return (
    <div className="menubar-wrap" ref={rootRef}>
      <div className="menubar">
        {groups.map((g) => (
          <div className="menu-group" key={g.id}>
            <button
              className={`menu-top ${open === g.id ? 'active' : ''}`}
              onClick={() => setOpen(open === g.id ? null : g.id)}
              onMouseEnter={() => { if (open) setOpen(g.id) }}
            >
              {g.label}({g.key.toUpperCase()})
            </button>
            {open === g.id && (
              <div className="menu-dropdown">
                <div className="menu-caption">{g.label}</div>
                {g.items.map(itemNode)}
              </div>
            )}
          </div>
        ))}
        <div className="menubar-spacer" />
      </div>

      <button
        className={`menu-trigger ${mobileOpen ? 'active' : ''}`}
        title="菜单（也可用 Alt+F / Alt+E 等助记键）"
        onClick={() => { setMobileOpen(!mobileOpen); setOpen(null) }}
      >☰</button>

      {mobileOpen && (
        <div className="menu-mobile">
          {groups.map((g) => (
            <div className="menu-mobile-group" key={g.id}>
              <button className="menu-mobile-top" onClick={() => setExpanded(expanded === g.id ? null : g.id)}>
                <span>{g.label}({g.key.toUpperCase()})</span>
                <span>{expanded === g.id ? '−' : '+'}</span>
              </button>
              {expanded === g.id && <div className="menu-mobile-items">{g.items.map(itemNode)}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
