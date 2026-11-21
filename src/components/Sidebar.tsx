import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Icon } from './Icons'
import { outlineRows } from '../lib/outline'
import { sortTree } from '../lib/syncEngine'
import type { AssetInfo, Heading, SearchHit, SidebarTab, TreeNode, TreeSort } from '../types'

export interface FileActions {
  onOpen: (path: string) => void
  onNewFile: (dir?: string) => void
  onNewFolder: (dir?: string) => void
  onRename: (node: TreeNode) => void
  onDelete: (node: TreeNode) => void
  /** Double-clicking an image in the img/ tree shows it in the preview pane. */
  onPreviewAsset: (path: string) => void
  /** Phone: rows show a permanent ⋯ that opens a bottom action sheet. */
  mobile?: boolean
  onNodeMenu?: (node: TreeNode) => void
}

function TreeItem({ node, depth, currentPath, activeAsset, actions }: {
  node: TreeNode; depth: number; currentPath: string; activeAsset: string | null; actions: FileActions
}) {
  const [open, setOpen] = useState(depth < 2)
  const [menu, setMenu] = useState(false)
  const rowRef = useRef<HTMLDivElement>(null)
  const isFolder = node.type === 'folder'
  const isAsset = node.type === 'asset'
  // img/ and img/<note>/ are managed attachment folders, not note folders.
  // Their rows must not offer 删除/重命名/新建: deleting a directory would
  // fsp.rm() every picture at once with no history backup.
  // Mirror the server's isAssetScope(): Windows folds IMG / "img " / "img."
  // onto img/, so a case-sensitive check would leave a dangerous 删除/重命名
  // menu on the attachment folders.
  const head = node.path.replace(/\\/g, '/').split('/')[0]
  const isImgScope = isFolder && head.replace(/[.\s]+$/g, '').toLowerCase() === 'img'
  const active = isAsset ? node.path === activeAsset : node.path === currentPath

  // 用 mousedown 而非 click：相邻按钮的 stopPropagation 会挡住 click 冒泡到
  // document，导致已打开的菜单关不掉。行内边界保证点本行/菜单内部不误关。
  useEffect(() => {
    if (!menu) return
    const onDown = (e: MouseEvent) => {
      if (!rowRef.current?.contains(e.target as Node)) setMenu(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menu])

  return (
    <div className="tree-group">
      <div
        ref={rowRef}
        className={`tree-row ${isAsset ? 'asset' : ''} ${active ? 'active' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => {
          setMenu(false)
          if (isFolder) setOpen((v) => !v)
          else if (isAsset) {
            // Touch has no reliable double-tap: open the image on first tap.
            if (actions.mobile) actions.onPreviewAsset(node.path)
          } else actions.onOpen(node.path)
        }}
        onDoubleClick={() => { if (isAsset && !actions.mobile) actions.onPreviewAsset(node.path) }}
      >
        <span className="tree-chevron">
          {isFolder ? <Icon name={open ? 'chevronDown' : 'chevronRight'} size={13} /> : null}
        </span>
        <Icon name={isFolder ? 'folder' : isAsset ? 'image' : 'file'} size={15} />
        <span className="tree-label" title={node.path}>{node.name.replace(/\.(md|markdown|txt)$/i, '')}</span>
        {(actions.mobile ? !isImgScope : !isAsset && !isImgScope) && (
          <button
            className="tree-more" title="更多操作" aria-label="更多操作"
            onClick={(e) => {
              e.stopPropagation()
              if (actions.mobile) actions.onNodeMenu?.(node)
              else setMenu((v) => !v)
            }}
          ><Icon name="more" size={15} /></button>
        )}
        {!actions.mobile && !isAsset && !isImgScope && menu && (
          <div className="context-menu" onClick={(e) => e.stopPropagation()}>
            {isFolder && <>
              <button onClick={() => { setMenu(false); actions.onNewFile(node.path) }}><Icon name="file" size={14} /> 新建笔记</button>
              <button onClick={() => { setMenu(false); actions.onNewFolder(node.path) }}><Icon name="folder" size={14} /> 新建文件夹</button>
              <div className="menu-sep" />
            </>}
            <button onClick={() => { setMenu(false); actions.onRename(node) }}><Icon name="edit" size={14} /> 重命名</button>
            <button className="danger" onClick={() => { setMenu(false); actions.onDelete(node) }}><Icon name="trash" size={14} /> 删除</button>
          </div>
        )}
      </div>
      {isFolder && open && (
        <div>
          {(node.children || []).map((child) => (
            <TreeItem key={child.path} node={child} depth={depth + 1} currentPath={currentPath} activeAsset={activeAsset} actions={actions} />
          ))}
          {!node.children?.length && <div className="tree-empty" style={{ paddingLeft: 26 + depth * 14 }}>空文件夹</div>}
        </div>
      )}
    </div>
  )
}

const SORT_OPTIONS: { id: TreeSort; label: string }[] = [
  { id: 'name-asc', label: '名称 A → Z' },
  { id: 'name-desc', label: '名称 Z → A' },
  { id: 'mtime-desc', label: '最近修改优先' },
  { id: 'mtime-asc', label: '最早修改优先' },
  { id: 'size-desc', label: '从大到小' },
  { id: 'size-asc', label: '从小到大' },
]

export function FileTree({ tree, currentPath, vault, scopeLabel, sort, onSort, actions, showImgFolder, imgDir, imgAssets, activeAsset }: {
  tree: TreeNode[]; currentPath: string; vault: string; scopeLabel?: string
  sort: TreeSort; onSort: (m: TreeSort) => void; actions: FileActions; showImgFolder?: boolean
  imgDir?: string; imgAssets?: AssetInfo[]; activeAsset?: string | null
}) {
  const [sortMenu, setSortMenu] = useState(false)
  const sortWrapRef = useRef<HTMLDivElement>(null)
  // img/ 是展示用子树：只放当前笔记的图片目录与文件名，不列其它笔记的目录。
  // 服务端 walk() 只认笔记文件，所以这里用附件清单自己构造，避免空文件夹。
  const treeWithAssets = useMemo(() => {
    if (!showImgFolder || !imgDir || !imgAssets?.length) return tree
    const children: TreeNode[] = imgAssets.map((a) => ({
      name: a.path.split('/').pop() || a.path,
      path: a.path, type: 'asset', size: a.size, mtime: a.mtime,
    }))
    const noteFolder: TreeNode = {
      name: imgDir, path: `img/${imgDir}`, type: 'folder', children,
      size: children.reduce((s, n) => s + (n.size || 0), 0),
      mtime: children.reduce((m, n) => Math.max(m, n.mtime || 0), 0),
    }
    const imgNode: TreeNode = {
      name: 'img', path: 'img', type: 'folder', children: [noteFolder],
      size: noteFolder.size, mtime: noteFolder.mtime,
    }
    return [...tree.filter((n) => !(n.name === 'img' && n.type === 'folder')), imgNode]
  }, [tree, showImgFolder, imgDir, imgAssets])
  const ordered = useMemo(() => sortTree(treeWithAssets, sort), [treeWithAssets, sort])
  // img/ 只在「已保存的当前笔记引用了图片」时才出现在文件树。
  const visible = useMemo(
    () => showImgFolder ? ordered : ordered.filter((n) => !(n.name === 'img' && n.type === 'folder')),
    [ordered, showImgFolder]
  )

  // 与 TreeItem 一致：mousedown + 容器边界，点任意外部区域都收起。
  useEffect(() => {
    if (!sortMenu) return
    const onDown = (e: MouseEvent) => {
      if (!sortWrapRef.current?.contains(e.target as Node)) setSortMenu(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [sortMenu])

  return (
    <div className="file-tree">
      <div className="panel-head">
        <span className="vault-name"><Icon name="files" size={14} /> {vault}</span>
        <div className="panel-head-actions">
          <div className="sort-wrap" ref={sortWrapRef}>
            <button className={sortMenu ? 'is-open' : ''} title="文件树排序" aria-label="文件树排序"
              onClick={(e) => { e.stopPropagation(); setSortMenu((v) => !v) }}>
              <Icon name="sort" size={15} />
            </button>
            {sortMenu && (
              <div className="sort-menu" onClick={(e) => e.stopPropagation()}>
                {SORT_OPTIONS.map((o, i) => (
                  <div key={o.id}>
                    {i > 0 && i % 2 === 0 && <div className="menu-sep" />}
                    <button className={`sort-option ${sort === o.id ? 'active' : ''}`}
                      onClick={() => { onSort(o.id); setSortMenu(false) }}>
                      <span className="sort-check">{sort === o.id && <Icon name="check" size={13} />}</span>
                      {o.label}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <button title="新建文件夹" onClick={() => { setSortMenu(false); actions.onNewFolder() }}><Icon name="folder" size={15} /></button>
          <button title="新建笔记" onClick={() => { setSortMenu(false); actions.onNewFile() }}><Icon name="plus" size={16} /></button>
        </div>
      </div>
      {scopeLabel && <div className="scope-hint">同步范围：{scopeLabel}</div>}
      <div className="tree-scroll">
        {visible.length ? visible.map((n) => (
          <TreeItem key={n.path} node={n} depth={0} currentPath={currentPath} activeAsset={activeAsset || null} actions={actions} />
        )) : <div className="empty-hint">还没有笔记，点右上角 + 新建一篇</div>}
      </div>
    </div>
  )
}

export function Outline({ headings, activeLine, onJump, compact = false }: {
  headings: Heading[]; activeLine: number; onJump: (line: number) => void; compact?: boolean
}) {
  const rows = useMemo(() => outlineRows(headings), [headings])
  let activeId = ''
  for (const h of headings) if (h.line <= activeLine) activeId = h.id
  return (
    <div className="outline-panel">
      {!compact && <div className="panel-head"><span><Icon name="outline" size={14} /> 目录大纲</span><span className="panel-count">{headings.length}</span></div>}
      <div className="outline-scroll">
        {rows.length ? rows.map((h) => (
          <button
            key={`${h.line}-${h.id}`}
            className={`outline-row ${h.id === activeId ? 'active' : ''} lvl-${Math.min(h.level, 6)}`}
            style={{ paddingLeft: 10 + h.depth * 14 }}
            title={h.text}
            onClick={() => onJump(h.line)}
          >
            <span className="outline-dot" />
            <span className="outline-text">{h.text || '（无标题）'}</span>
          </button>
        )) : <div className="empty-hint">用 # 标题 建立大纲</div>}
      </div>
    </div>
  )
}

export function SearchPanel({ query, onQuery, hits, searching, onOpen }: {
  query: string; onQuery: (v: string) => void; hits: SearchHit[]; searching: boolean; onOpen: (path: string, line: number) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <div className="search-panel">
      <div className="panel-head"><span><Icon name="search" size={14} /> 全仓库搜索</span></div>
      <div className="search-input-wrap">
        <Icon name="search" size={15} />
        <input ref={inputRef} value={query} onChange={(e) => onQuery(e.target.value)} placeholder="搜索笔记内容…" />
        {query && <button onClick={() => { onQuery(''); inputRef.current?.focus() }}><Icon name="close" size={14} /></button>}
      </div>
      <div className="search-results">
        {searching && <div className="empty-hint">搜索中…</div>}
        {!searching && query && !hits.length && <div className="empty-hint">没有匹配结果</div>}
        {!query && <div className="empty-hint">支持跨文件全文搜索，点击结果直接跳转</div>}
        {hits.slice(0, 200).map((hit, i) => (
          <button key={`${hit.path}-${hit.line}-${i}`} className="search-hit" onClick={() => onOpen(hit.path, hit.line)}>
            <span className="hit-file"><Icon name="file" size={13} /> {hit.path}</span>
            <span className="hit-line">第 {hit.line + 1} 行 · {hit.text.trim().slice(0, 90)}</span>
          </button>
        ))}
        {hits.length > 200 && <div className="empty-hint">仅显示前 200 条结果</div>}
      </div>
    </div>
  )
}

export function Sidebar({ tab, onTab, children }: { tab: SidebarTab; onTab: (t: SidebarTab) => void; children: ReactNode }) {
  const tabs: { id: SidebarTab; icon: string; label: string }[] = [
    { id: 'files', icon: 'files', label: '文件' },
    { id: 'outline', icon: 'outline', label: '大纲' },
    { id: 'search', icon: 'search', label: '搜索' },
  ]
  return (
    <aside className="sidebar">
      <div className="sidebar-tabs">
        {tabs.map((t) => (
          <button key={t.id} className={tab === t.id ? 'active' : ''} title={t.label} onClick={() => onTab(t.id)}>
            <Icon name={t.icon} size={16} /><span>{t.label}</span>
          </button>
        ))}
      </div>
      <div className="sidebar-body">{children}</div>
    </aside>
  )
}
