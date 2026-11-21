import { useEffect, useState } from 'react'
import { Icon } from './Icons'
import { api } from '../lib/sync'
import type { BrowseResult } from '../types'

interface Props {
  open: boolean
  initialPath?: string
  home?: string
  onClose: () => void
  onPick: (path: string, migrate: boolean) => Promise<void>
}

/** Server-side folder browser: only directory names ever leave the host. */
export function FolderPicker({ open, initialPath = '', home = '', onClose, onPick }: Props) {
  const [current, setCurrent] = useState(initialPath || home)
  const [input, setInput] = useState('')
  const [data, setData] = useState<BrowseResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [migrate, setMigrate] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setCurrent(initialPath || home || '')
    setError('')
  }, [open, initialPath, home])

  useEffect(() => {
    if (!open) return
    let alive = true
    setLoading(true)
    setError('')
    api.browse(current)
      .then((d) => { if (alive) { setData(d); setInput(d.path) } })
      .catch((e: any) => { if (alive) setError(e.message || '读取目录失败') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [open, current])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !saving) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, saving, onClose])

  if (!open) return null

  const choose = async (p: string) => {
    if (!p.trim() || saving) return
    setSaving(true)
    setError('')
    try { await onPick(p.trim(), migrate); onClose() }
    catch (e: any) { setError(e.message || '切换失败') }
    finally { setSaving(false) }
  }

  return (
    <div className="modal-backdrop fp-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) onClose() }}>
      <div className="folder-picker">
        <div className="settings-head">
          <h2>选择笔记保存位置</h2>
          <button className="icon-btn" onClick={onClose} title="关闭"><Icon name="close" size={18} /></button>
        </div>

        <div className="fp-body">
          <div className="fp-pathbar">
            <button className="icon-btn" title="上一级" disabled={!data?.parent} onClick={() => data?.parent && setCurrent(data.parent)}>
              <Icon name="chevronRight" size={17} className="flip" />
            </button>
            <input
              className="text-input" value={input} placeholder="输入完整文件夹路径"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && input.trim()) setCurrent(input.trim()) }}
            />
            <button className="btn" onClick={() => input.trim() && setCurrent(input.trim())}>转到</button>
          </div>

          <div className="fp-shortcuts">
            {home && <button onClick={() => setCurrent(home)}><Icon name="device" size={13} /> 主目录</button>}
            {initialPath && <button onClick={() => setCurrent(initialPath)}><Icon name="folder" size={13} /> 当前仓库</button>}
            {(data?.drives || []).map((d) => (
              <button key={d.path} onClick={() => setCurrent(d.path)}><Icon name="laptop" size={13} /> {d.name}</button>
            ))}
          </div>

          <div className="fp-current">
            <Icon name="folder" size={16} />
            <strong>{data?.path || current || '…'}</strong>
            <em>{data?.notes ? `已有 ${data.notes} 篇笔记` : '没有 .md 笔记'}</em>
          </div>

          <div className="fp-list">
            {loading && <div className="empty-hint">正在读取目录…</div>}
            {!loading && !data?.dirs.length && <div className="empty-hint">这里没有子文件夹，可以直接使用当前目录</div>}
            {(data?.dirs || []).map((d) => (
              <div className="fp-row" key={d.path}>
                <button className="fp-enter" onClick={() => setCurrent(d.path)} title="进入此文件夹">
                  <Icon name="folder" size={16} /><span>{d.name}</span><Icon name="chevronRight" size={14} />
                </button>
                <button className="fp-use" onClick={() => choose(d.path)}>选它</button>
              </div>
            ))}
          </div>

          {error && <div className="fp-error"><Icon name="alert" size={14} /> {error}</div>}
          {data && !data.selectable && (
            <div className="fp-warn"><Icon name="alert" size={14} /> 这个目录不能直接作为仓库，请进入一个具体子文件夹</div>
          )}

        </div>

        <div className="fp-footer">
          <div className="fp-footer-top">
            <label className="check-row">
              <input type="checkbox" checked={migrate} onChange={(e) => setMigrate(e.target.checked)} />
              把当前仓库里的 <code>.md</code> 复制到新位置（不会覆盖同名文件）
            </label>
            <span className="muted small">输入一个还不存在的路径会自动创建该文件夹</span>
          </div>
          <div className="fp-footer-btns">
            <button className="btn" onClick={onClose} disabled={saving}>取消</button>
            <button className="btn btn-primary" disabled={!data?.selectable || saving} onClick={() => choose(data?.path || current)}>
              {saving ? '切换中…' : '使用此文件夹'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
