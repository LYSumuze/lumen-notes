import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './Icons'
import {
  conflictTitle, latestContent, sideBySide, timeline,
  type ConvergeConflict, type ResolveItem, type TimelineEntry,
} from '../lib/vcs'
import {
  loadVcs, loadConflicts, saveConflicts, resolveVersions,
  loadAssetConflicts, saveAssetConflicts, resolveAssetVersions,
  type LoadedVcs,
} from '../lib/vcsStore'
import { clientId } from '../lib/sync'
import type { AssetConflict } from '../types'

interface Props {
  open: boolean
  onClose: () => void
  path: string
  online: boolean
  currentContent: string
  isDesktop: boolean
  /** Server already wrote the .md; this only refreshes the editor / tree. */
  onApply: (content: string, path: string) => Promise<void>
  /** 统一的「保存 / 不保存 / 取消」守卫，选版本会覆盖当前缓冲区。 */
  onGuard: () => Promise<boolean>
}

function stamp(t: number) {
  const d = new Date(t)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  const time = d.toLocaleTimeString('zh-CN', { hour12: false })
  return sameDay ? `今天 ${time}` : d.toLocaleString('zh-CN', { hour12: false })
}

const shortName = (p: string) => p.split('/').pop() || p
const sizeLabel = (n: number) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`

/**
 * Read at render time, not at module load: main.tsx sets `data-platform` in
 * its own body, which runs AFTER all imports have been evaluated.
 */
const isPhone = () => typeof document !== 'undefined'
  && document.documentElement.dataset.platform === 'android'

interface DiffSides {
  left: { line?: number; text: string; changed: boolean; empty: boolean }[]
  right: { line?: number; text: string; changed: boolean; empty: boolean }[]
  changes: number
}

/**
 * Phone replacement for the two-column line diff. A 390px screen cannot fit
 * two 1fr columns (each ends up <100px and Chinese text wraps one character
 * per line). Show one full-width row per line, with the two versions stacked
 * and clearly labelled only where they differ.
 */
function UnifiedDiff({ sides, neutral, showAll }: { sides: DiffSides; neutral: boolean; showAll: boolean }) {
  const rows = sides.left.map((l, i) => ({ l, r: sides.right[i], i }))
  const near = new Set<number>()
  if (!neutral) {
    rows.forEach(({ l, r }, i) => {
      if (l.changed || r.changed) { near.add(i - 1); near.add(i); near.add(i + 1) }
    })
  }
  const visible = showAll || neutral ? rows : rows.filter(({ i }) => near.has(i))
  if (!visible.length) {
    return <div className="m-diff-empty">两侧内容一致，没有差异</div>
  }
  return (
    <div className="m-diff-list">
      {visible.map(({ l, r, i }) => {
        const changed = !neutral && (l.changed || r.changed)
        return (
          <div className={`m-diff-row ${changed ? 'changed' : ''}`} key={i}>
            <div className="m-diff-num">{l.line ?? r.line ?? ''}</div>
            {changed ? (
              <div className="m-diff-stack">
                <div className="m-diff-side"><b>本端</b><span>{l.empty ? '（空行）' : (l.text || ' ')}</span></div>
                <div className="m-diff-side cloud"><b>云端</b><span>{r.empty ? '（空行）' : (r.text || ' ')}</span></div>
              </div>
            ) : (
              <div className="m-diff-side plain"><span>{l.text || ' '}</span></div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * 一条不可变时间线 + 一处分屏。
 * 拉取后的整仓差异放在「待处理 N 篇」里逐篇切换，左右两栏按行号对齐，
 * 差异行两侧统一红色高亮；选定版本后走唯一一条写回路径。
 */
export function HistoryPanel(props: Props) {
  const { open, onClose, path, online, currentContent, isDesktop, onApply, onGuard } = props
  const phone = isPhone()
  const [data, setData] = useState<LoadedVcs | null>(null)
  const [conflicts, setConflicts] = useState<ConvergeConflict[]>([])
  const [assetConflicts, setAssetConflicts] = useState<AssetConflict[]>([])
  const [assetBusy, setAssetBusy] = useState('')
  const [activePath, setActivePath] = useState(path)
  const [selected, setSelected] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  /** Phone unified diff: show only changed lines + context, or the whole note. */
  const [showAll, setShowAll] = useState(false)

  const contentRef = useRef(currentContent)
  contentRef.current = currentContent
  const diffRef = useRef<HTMLDivElement>(null)

  const selfId = clientId

  const reload = useCallback(async () => {
    if (!open) return
    setLoading(true)
    setError('')
    try {
      const list = await loadConflicts()
      setConflicts(list)
      setAssetConflicts(await loadAssetConflicts())
      // A pending conflict wins over the open note, so the user sees something
      // actionable the moment 拉取 opens this panel.
      const target = list[0]?.path || path
      setActivePath(target)
      setData(await loadVcs(target, online, contentRef.current))
    } catch (e: any) {
      setError(e.message || '读取版本失败')
    } finally { setLoading(false) }
  }, [open, path, online])

  useEffect(() => { reload() }, [reload])
  useEffect(() => {
    if (!open) { setNotice(''); setError(''); setSelected('') }
  }, [open])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, busy, onClose])

  const showPath = async (next: string) => {
    setActivePath(next)
    setSelected('')
    setNotice('')
    setLoading(true)
    try { setData(await loadVcs(next, online, '')) }
    catch (e: any) { setError(e.message || '读取版本失败') }
    finally { setLoading(false) }
  }

  const state = data?.state
  const entries: TimelineEntry[] = useMemo(() => state ? timeline(state) : [], [state])
  const picked = entries.find((v) => v.id === selected) || entries[0]
  const active = conflicts.find((c) => c.path === activePath) || null

  // One side-by-side comparison, not three separate diff views.
  const leftContent = active ? active.localContent : (picked?.content ?? '')
  const rightContent = active ? active.peerContent : latestContent(state?.cloud)
  const leftTitle = active ? '本地版本 · 本设备' : (picked ? `选中版本 · ${stamp(picked.at)}` : '本地版本')
  const rightTitle = active ? `云端版本 · ${active.deviceName || '对端'}` : '云端最新版本'
  const leftDeleted = !!active?.localDeleted
  const rightDeleted = !!active?.peerDeleted
  // A deleted-vs-content conflict is a difference of EXISTENCE, not of lines.
  // Diffing "" against the full note would paint every line red, which lies
  // about what happened. Show one honest two-column state card instead.
  const deletedSide = !!active && (leftDeleted || rightDeleted)

  // No conflict + nothing published yet: comparing against an empty cloud
  // would paint the whole note red. Show the local version and an honest
  // "还没有版本" state on the right instead of a fake 100% diff.
  const neutral = !active && !state?.cloud?.versions?.length
  const sides = useMemo(
    () => sideBySide(leftContent, neutral ? leftContent : rightContent),
    [leftContent, rightContent, neutral],
  )

  // Long notes: jump straight to the first changed line.
  useEffect(() => {
    const el = diffRef.current
    if (!el) return
    const first = el.querySelector('.split-cell.changed') as HTMLElement | null
    if (!first) { el.scrollTop = 0; return }
    const top = first.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop
    el.scrollTop = Math.max(0, top - 40)
  }, [sides, activePath])

  const run = async (fn: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try { await fn() }
    catch (e: any) { setError(e.message || '操作失败') }
    finally { setBusy(false) }
  }

  /** 唯一写回路径：服务端落盘 + 两端版本 + 基线 + 广播，然后刷新编辑器。 */
  const resolve = (item: ResolveItem, content: string, label: string) => run(async () => {
    // 选版本会写回 .md 并刷新编辑器；编辑器里有未保存草稿时先让用户决定，
    // 不能等刷新完再被 Ctrl+S 把草稿写回去，看起来像「恢复失败」。
    if (!(await onGuard())) return
    const r = await resolveVersions({ selfId, items: [item] })
    if (!r.applied) throw new Error(r.failed.join('；') || '写入失败')
    const next = await loadConflicts()
    setConflicts(next)
    if (item.choice !== 'delete') await onApply(content, activePath)
    else await onApply('', activePath)
    setSelected('')
    setNotice(`${label}，已记为两端新的共同版本`)
    await reload()
  })

  const skip = () => run(async () => {
    const next = conflicts.filter((c) => c.path !== activePath)
    await saveConflicts(next)
    setConflicts(next)
    if (next.length) await showPath(next[0].path)
    else { setActivePath(path); setData(await loadVcs(path, online, contentRef.current)) }
  })

  /** Attachments cannot be diffed line by line: one simple two-choice card. */
  const chooseAsset = async (c: AssetConflict, choice: 'local' | 'peer') => {
    setAssetBusy(c.path)
    setError('')
    try {
      const r = await resolveAssetVersions({ selfId, assets: [{ path: c.path, choice }] })
      const first = r.results[0]
      if (!first?.ok) throw new Error(first?.error || '写入失败')
      const next = assetConflicts.filter((x) => x.path !== c.path)
      await saveAssetConflicts(next)
      setAssetConflicts(next)
      setNotice(choice === 'local' ? '已保留本端附件' : '已使用对端附件')
    } catch (e: any) {
      setError(e.message || '操作失败')
    } finally { setAssetBusy('') }
  }

  const choices: { label: string; item: ResolveItem; content: string; primary?: boolean }[] = active
    ? [
      {
        label: leftDeleted ? '两端都删除' : '用本地版本',
        item: {
          path: activePath,
          choice: leftDeleted ? 'delete' : 'local',
          content: active.localContent,
        },
        content: active.localContent,
      },
      {
        label: rightDeleted ? '两端都删除' : '用云端版本并保存',
        item: {
          path: activePath,
          choice: rightDeleted ? 'delete' : 'peer',
          content: active.peerContent,
        },
        content: active.peerContent,
        primary: true,
      },
    ]
    : []

  if (!open) return null
  return (
    <div className="modal-backdrop history-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose() }}>
      <div className={`history-modal vcs-modal ${phone ? 'phone-history' : ''}`}>
        <div className="settings-head">
          <h2><Icon name="history" size={18} /> 历史版本</h2>
          <div className="head-actions">
            <button className="icon-btn" onClick={reload} title="刷新"><Icon name="refresh" size={16} /></button>
            <button className="icon-btn" onClick={onClose} title="关闭"><Icon name="close" size={18} /></button>
          </div>
        </div>

        <div className="history-sub">
          <span className="history-path"><Icon name="file" size={13} /> {activePath || '未打开文件'}</span>
          <span>{online ? '已连接' : '离线'} · 待处理 {conflicts.length} 篇</span>
        </div>

        {conflicts.length > 0 && (
          <div className="pending-bar">
            <span className="pending-label"><Icon name="alert" size={14} /> 待处理 {conflicts.length} 篇</span>
            <div className="pending-chips">
              {conflicts.map((c) => (
                <button
                  key={c.path}
                  className={`pending-chip ${c.path === activePath ? 'active' : ''}`}
                  title={`${c.path} · ${conflictTitle(c.kind)}`}
                  onClick={() => void showPath(c.path)}
                >
                  {shortName(c.path)}
                </button>
              ))}
            </div>
          </div>
        )}

        {assetConflicts.length > 0 && (
          <div className="asset-conflicts">
            <div className="asset-conflicts-head">
              <Icon name="alert" size={14} /> 附件待处理 {assetConflicts.length} 项
            </div>
            {assetConflicts.map((c) => (
              <div className="asset-conflict" key={c.path}>
                <div className="asset-conflict-name" title={c.path}>{shortName(c.path)}</div>
                <div className="asset-conflict-sides">
                  <span className="asset-side">
                    <strong>本端</strong>{sizeLabel(c.localSize)} · {c.localMtime ? stamp(c.localMtime) : '暂无时间'}
                  </span>
                  <span className="asset-side">
                    <strong>{c.deviceName || '对端'}</strong>{sizeLabel(c.peerSize)} · {c.peerMtime ? stamp(c.peerMtime) : '暂无时间'}
                  </span>
                </div>
                <div className="asset-conflict-actions">
                  <button className="btn" disabled={!!assetBusy} onClick={() => void chooseAsset(c, 'local')}>
                    保留本端
                  </button>
                  <button className="btn" disabled={!!assetBusy} onClick={() => void chooseAsset(c, 'peer')}>
                    使用对端
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {active && (
          <div className="conflict-head">
            <Icon name="alert" size={15} />
            <strong>{conflictTitle(active.kind)}</strong>
            <span>来自 {active.deviceName || '另一台设备'}</span>
          </div>
        )}

        <div className="history-body">
          <div className="history-list vcs-list">
            <div className="history-cap">当前笔记 · 最近 15 条</div>
            {loading && <div className="empty-hint">读取中…</div>}
            {!loading && !entries.length && <div className="empty-hint">还没有版本记录。<br />保存笔记后会自动生成。</div>}
            {entries.map((v, idx) => (
              <button
                key={`${v.source}-${v.id}`}
                className={`history-row vcs-row ${v.id === picked?.id ? 'active' : ''}`}
                onClick={() => { setSelected(v.id); setNotice('') }}
              >
                <span className="history-time">{stamp(v.at)}</span>
                <span className="history-meta">
                  <em className={`tag ${v.merged ? 'merged' : v.source === 'cloud' ? 'cloud' : 'local'}`}>
                    {v.deleted ? '已删除' : v.merged ? '两端一致' : v.source === 'cloud' ? '同步到云' : '本端保存'}
                  </em>
                  {idx === 0 && <em className="tag server">最新</em>}
                </span>
                <span className="history-size">{v.deleted ? '笔记已删除' : `${v.content.length} 字符 · ${v.message}`}</span>
              </button>
            ))}
          </div>

          <div className="history-preview">
            {phone && !deletedSide && (
              <div className="m-diff-tools">
                <span>{neutral ? '云仓库还没有版本' : `差异 ${sides.changes} 行`}</span>
                <button className="btn" onClick={() => setShowAll((v) => !v)}>
                  {showAll ? '仅看差异' : '显示全文'}
                </button>
              </div>
            )}
            <div className="split-head">
              <div className="split-title">
                <b>{leftTitle}</b>
                <span>{leftDeleted ? '已删除' : `${leftContent.length} 字符`}</span>
              </div>
              <div className="split-title">
                <b>{rightTitle}</b>
                <span>{neutral ? '还没有版本' : rightDeleted ? '已删除' : `${rightContent.length} 字符`}</span>
              </div>
            </div>

            <div className="split-diff" ref={diffRef}>
              {deletedSide && (
                <div className="deleted-note">
                  {leftDeleted ? '本地已删除这篇笔记' : '云端已删除这篇笔记'} · 选择保留内容或两端都删除
                </div>
              )}
              {deletedSide ? (
                <div className="deleted-compare">
                  <div className="deleted-side">
                    {leftDeleted
                      ? <div className="deleted-empty">此端已删除，没有内容可对比</div>
                      : <pre className="deleted-preview">{leftContent}</pre>}
                  </div>
                  <div className="deleted-side">
                    {rightDeleted
                      ? <div className="deleted-empty">此端已删除，没有内容可对比</div>
                      : <pre className="deleted-preview">{rightContent}</pre>}
                  </div>
                </div>
              ) : (
                <>
                  {neutral && (
                    <div className="deleted-note">云仓库还没有版本。点顶栏「同步」把当前内容发布到这里。</div>
                  )}
                  {phone ? (
                    <UnifiedDiff sides={sides} neutral={neutral} showAll={showAll} />
                  ) : (
                    <>
                      {sides.left.map((l, i) => {
                        const r = sides.right[i]
                        return (
                          <div className="split-line" key={i}>
                            <div className={`split-cell ${!neutral && l.changed ? 'changed' : ''} ${!neutral && l.empty ? 'empty' : ''}`}>
                              <span className="split-ln">{l.line ?? ''}</span>
                              <span className="split-text">{l.empty ? ' ' : (l.text || ' ')}</span>
                            </div>
                            <div className={`split-cell ${!neutral && r.changed ? 'changed' : ''} ${!neutral && r.empty ? 'empty' : ''}`}>
                              <span className="split-ln">{neutral ? '' : (r.line ?? '')}</span>
                              <span className="split-text">{neutral ? ' ' : (r.empty ? ' ' : (r.text || ' '))}</span>
                            </div>
                          </div>
                        )
                      })}
                      {!sides.changes && !neutral && <div className="split-same">两侧内容一致，没有差异</div>}
                    </>
                  )}
                </>
              )}
            </div>

            <div className="vcs-actions">
              {active ? (
                <>
                  <span className="diff-counts">{deletedSide ? '一端已删除，请选保留内容或两端都删除' : `差异 ${sides.changes} 行`}</span>
                  <button className="btn" disabled={busy} onClick={() => void skip()}>暂不处理</button>
                  {choices.map((c) => (
                    <button
                      key={c.label}
                      className={`btn ${c.primary ? 'btn-primary' : ''}`}
                      disabled={busy}
                      onClick={() => void resolve(c.item, c.content, c.label)}
                    >{c.label}</button>
                  ))}
                </>
              ) : (
                <>
                  <span className="diff-counts">{neutral ? '云仓库还没有版本' : `本地与云端${sides.changes ? `相差 ${sides.changes} 行` : '一致'}`}</span>
                  <button
                    className="btn btn-primary"
                    disabled={busy || !picked || !!picked.deleted}
                    onClick={() => void resolve(
                      { path: activePath, choice: 'local', content: picked?.content ?? '', restore: true },
                      picked?.content ?? '', '保存并更新',
                    )}
                  >保存并更新</button>
                </>
              )}
            </div>

            {notice && <div className="vcs-notice"><Icon name="check" size={14} /> {notice}</div>}
            {error && <div className="sync-error"><Icon name="alert" size={15} /> {error}</div>}
          </div>
        </div>
      </div>
    </div>
  )
}
