import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from './Icons'
import type { VaultEntry } from '../native/platform'
import type { VaultSort } from '../types'
import { isAndroidNative } from '../native/androidBridge'

interface WelcomeProps {
  initialStage?: 'vault' | 'home'
  native: boolean
  online: boolean
  vaultName: string
  recents: string[]
  /** Native shells: pick a local folder as this device's vault.
   *  Returns false when the picker was cancelled (stay on the vault step). */
  onSelectVault: () => boolean | void | Promise<boolean | void>
  /** Read the folders recorded in userData for the 「已有仓库」 list. */
  onListVaults: () => Promise<VaultEntry[]>
  /** Switch to a folder from that list. */
  onSelectVaultPath: (path: string) => Promise<boolean | void>
  /** Create a new vault folder with the native picker. */
  onCreateVault: () => Promise<boolean | void>
  vaultSort: VaultSort
  onVaultSort: (mode: VaultSort) => void
  /** Open the LAN sync / pairing panel. */
  onConnect: () => void
  /** Browse the vault's folders in the sidebar file tree. */
  onOpenFolder: () => void | Promise<void>
  /** Open a specific file via the quick switcher. */
  onOpenFile: () => void | Promise<void>
  /** Create a new note in the vault. */
  onNewFile: () => void | Promise<void>
  onOpenRecent: (path: string) => void
  onRemoveRecent: (path: string) => void
  onClose: () => void
}

const SORT_LABELS: Record<VaultSort, string> = {
  'name-asc': '名称 A → Z',
  'name-desc': '名称 Z → A',
  'used-desc': '最近使用优先',
  'used-asc': '最早使用优先',
}
const SORT_ORDER: VaultSort[] = ['name-asc', 'name-desc', 'used-desc', 'used-asc']

function nameOf(p: string) {
  return p.split('/').pop()?.replace(/\.(md|markdown|txt)$/i, '') || p
}
function usedAt(t: number) {
  if (!t) return '已配置'
  const d = new Date(t)
  const today = new Date()
  return d.toDateString() === today.toDateString()
    ? `今天 ${d.toLocaleTimeString('zh-CN', { hour12: false })}`
    : d.toLocaleString('zh-CN', { hour12: false })
}

/** In-memory ordering only: no folder is scanned or touched. */
function sortVaults(list: VaultEntry[], mode: VaultSort): VaultEntry[] {
  const byName = (a: VaultEntry, b: VaultEntry) => a.name.localeCompare(b.name, 'zh-CN')
  if (mode === 'name-desc') return [...list].sort((a, b) => -byName(a, b))
  if (mode === 'used-desc') return [...list].sort((a, b) => b.lastUsedAt - a.lastUsedAt || byName(a, b))
  if (mode === 'used-asc') return [...list].sort((a, b) => a.lastUsedAt - b.lastUsedAt || byName(a, b))
  return [...list].sort(byName)
}

export function Welcome(props: WelcomeProps) {
  const { initialStage = 'vault', native, vaultName, recents, vaultSort, onVaultSort } = props
  const [stage, setStage] = useState<'vault' | 'vaults' | 'home'>(initialStage)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [sortOpen, setSortOpen] = useState(false)
  const sortWrapRef = useRef<HTMLDivElement>(null)
  const [vaults, setVaults] = useState<VaultEntry[]>([])
  const [listError, setListError] = useState('')

  // 点下拉以外的区域收起排序菜单。用 mousedown，避免被 click 上的
  // stopPropagation 拦截后「点空白不消失」。
  useEffect(() => {
    if (!sortOpen) return
    const onDown = (e: MouseEvent) => {
      if (!sortWrapRef.current?.contains(e.target as Node)) setSortOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [sortOpen])

  useEffect(() => {
    if (stage !== 'vaults') return
    let alive = true
    void props.onListVaults()
      .then((list) => { if (alive) { setVaults(list); setListError('') } })
      .catch((e: any) => { if (alive) setListError(e?.message || '读取仓库列表失败') })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = q
      ? vaults.filter((v) => v.name.toLowerCase().includes(q) || v.path.toLowerCase().includes(q))
      : vaults
    return sortVaults(list, vaultSort)
  }, [vaults, query, vaultSort])

  const handleSelect = async () => {
    setBusy(true)
    let ok: boolean | void = true
    try { ok = await props.onSelectVault() } finally { setBusy(false) }
    // A cancelled folder picker must not leave the picker step. Once a vault
    // is confirmed, dismiss the whole screen instead of showing a second step.
    if (ok !== false) props.onClose()
  }

  const chooseFromList = async (p: string) => {
    setBusy(true)
    let ok: boolean | void = true
    try { ok = await props.onSelectVaultPath(p) }
    catch (e: any) { setListError(e?.message || '切换仓库失败'); ok = false }
    finally { setBusy(false) }
    if (ok !== false) props.onClose()
  }

  const createVault = async () => {
    setBusy(true)
    let ok: boolean | void = true
    try { ok = await props.onCreateVault() }
    catch (e: any) { setListError(e?.message || '新建仓库失败'); ok = false }
    finally { setBusy(false) }
    if (ok !== false) props.onClose()
  }

  if (stage === 'vaults') {
    return (
      <div className="welcome-screen welcome-screen--center">
        <div className="vault-picker">
          <button className="vault-picker-back" onClick={() => setStage('vault')}>
            <Icon name="chevronDown" size={15} /> 返回
          </button>
          <span className="welcome-kicker">已有仓库</span>
          <h2>选择笔记仓库</h2>

          <div className="vault-picker-tools">
            <label className="vault-search">
              <Icon name="search" size={15} />
              <input
                value={query} onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索仓库名称或路径" aria-label="搜索仓库"
              />
            </label>
            <div className="vault-sort-wrap" ref={sortWrapRef}>
              <button className="vault-sort-btn" title="仓库列表排序" onClick={() => setSortOpen((v) => !v)}>
                <Icon name="sort" size={15} /> {SORT_LABELS[vaultSort]}
              </button>
              {sortOpen && (
                <div className="vault-sort-menu">
                  {SORT_ORDER.map((mode) => (
                    <button
                      key={mode}
                      className={`vault-sort-option${mode === vaultSort ? ' active' : ''}`}
                      onClick={() => { onVaultSort(mode); setSortOpen(false) }}
                    >
                      <Icon name="check" size={13} /> {SORT_LABELS[mode]}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="vault-list">
            {listError && <div className="vault-empty">{listError}</div>}
            {!listError && visible.length === 0 && (
              <div className="vault-empty">
                {vaults.length ? '没有找到匹配的仓库' : '还没有记录任何仓库'}
              </div>
            )}
            {visible.map((v) => (
              <button
                key={v.path} className="vault-item" disabled={busy}
                onClick={() => void chooseFromList(v.path)}
              >
                <span className="vault-item-ic"><Icon name="folder" size={18} /></span>
                <span className="vault-item-text">
                  <strong>{v.name}</strong>
                  <span className="vault-item-path" title={v.path}>{v.path}</span>
                </span>
                <span className="vault-item-time">{usedAt(v.lastUsedAt)}</span>
              </button>
            ))}
          </div>

          <div className="vault-picker-actions">
            <button className="welcome-primary" disabled={busy} onClick={() => void createVault()}>
              <Icon name="folder" size={17} /> 新建仓库
            </button>
            <button className="welcome-ghost" disabled={busy} onClick={() => void handleSelect()}>
              选择其他文件夹…
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={`welcome-screen${stage === 'home' ? ' welcome-screen--center' : ''}`}>
      {stage === 'vault' ? (
        <>
          <div className="welcome-brand-side">
            <span className="welcome-logo"><img src="./icon.png" alt="" /></span>
            <h1>Lumen Notes</h1>
            <p className="welcome-tagline">本地 Markdown 笔记</p>
            <ul className="welcome-features">
              <li>多端跨平台</li>
              <li>历史版本回溯</li>
              <li>局域网多设备同步</li>
            </ul>
          </div>

          <div className="welcome-action-side">
            <span className="welcome-kicker">首次启动</span>
            <h2>设置笔记仓库</h2>
            <p className="welcome-desc">笔记以 .md 文件保存在所选文件夹，路径可在设置更改。</p>
            <div className="welcome-actions">
              <button className="welcome-primary" disabled={busy} onClick={handleSelect}>
                <Icon name={native ? 'folder' : 'qr'} size={17} />
                {native ? '选择本地文件夹…' : '连接电脑…'}
              </button>
              {/* A phone has one SAF tree, not a desktop vault history. */}
              {!isAndroidNative() && (
                <button className="welcome-ghost" onClick={() => setStage('vaults')}>已有仓库，直接开始</button>
              )}
            </div>
          </div>
        </>
      ) : (
        <div className="welcome-modal">
          <button className="welcome-close" title="进入 Lumen Notes" onClick={props.onClose}>
            <Icon name="close" size={18} />
          </button>

          <div className="welcome-home">
            <div className="welcome-home-head">
              <span className="welcome-vault-tag"><Icon name="folder" size={14} /> {vaultName}</span>
              <button className="welcome-link" onClick={() => setStage('vault')}>重新选择仓库</button>
            </div>

            <div className="welcome-tiles">
              <button className="welcome-tile" onClick={() => void props.onOpenFolder()}>
                <span className="tile-ic"><Icon name="folder" size={22} /></span>
                <span className="tile-label">打开文件夹</span>
                <span className="tile-sub">浏览仓库里的文件夹与文件</span>
              </button>
              <button className="welcome-tile" onClick={() => void props.onOpenFile()}>
                <span className="tile-ic"><Icon name="file" size={22} /></span>
                <span className="tile-label">打开文件</span>
                <span className="tile-sub">快速切换到某篇笔记</span>
              </button>
              <button className="welcome-tile" onClick={() => void props.onNewFile()}>
                <span className="tile-ic"><Icon name="plus" size={22} /></span>
                <span className="tile-label">新建笔记</span>
                <span className="tile-sub">在仓库里创建一篇新笔记</span>
              </button>
            </div>

            <div className="welcome-recents">
              <div className="welcome-recents-head">
                <Icon name="history" size={15} /> 最近文件
              </div>
              {recents.length ? (
                <div className="recent-list">
                  {recents.map((p) => (
                    <div key={p} className="recent-row" onClick={() => props.onOpenRecent(p)}>
                      <span className="recent-ic"><Icon name="file" size={15} /></span>
                      <span className="recent-text">
                        <span className="recent-name">{nameOf(p)}</span>
                        <span className="recent-path">{p}</span>
                      </span>
                      <button
                        className="recent-x"
                        title="从最近列表移除"
                        onClick={(e) => { e.stopPropagation(); props.onRemoveRecent(p) }}
                      ><Icon name="close" size={14} /></button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="recent-empty">还没有最近打开的笔记，从上方「打开文件夹」开始。</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
