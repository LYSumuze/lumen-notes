import { useEffect } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Icon } from '../components/Icons'
import type { FileActions } from '../components/Sidebar'
import type { TreeNode } from '../types'
import { MobileConnect } from './MobileConnect'
import type { MobileConnectProps } from './MobileConnect'
import { MobileEditorBar, MobileEditorSeg } from './MobileEditorBar'
import { useMobileViewportHeight } from './useViewportHeight'

export type MobileTab = 'notes' | 'search' | 'connect' | 'mine'

export type MobileSheet =
  | null
  | { kind: 'main' }
  | { kind: 'node'; node: TreeNode }

export type ThemeChoice = 'system' | 'light' | 'dark'

export interface MobileSettingsProps {
  vaultName: string
  /** The theme actually applied (system dark mode resolved). */
  theme: 'light' | 'dark'
  themeMode: 'manual' | 'system'
  fontSize: number
  showLineNumbers: boolean
  onThemeMode: (mode: ThemeChoice) => void
  /** One-tap flip in the app bar; leaves "follow system" mode. */
  onToggleTheme: () => void
  onFontSize: (delta: number) => void
  onLineNumbers: () => void
  onChooseVault: () => void
  onOpenHistory: () => void
  onExportLog: () => void
  onOpenAbout: () => void
}

export interface MobileProps {
  /* ---- navigation ---- */
  tab: MobileTab
  editorOpen: boolean
  pane: 'edit' | 'read'
  sheet: MobileSheet
  setTab: (t: MobileTab) => void
  setPane: (p: 'edit' | 'read') => void
  setSheet: (s: MobileSheet) => void
  /* ---- current document ---- */
  title: string
  dirty: boolean
  currentPath: string
  onSave: () => void
  onSync: () => void
  onFetch: () => void
  /** Top-left back arrow in the editor. Also used by the hardware back key. */
  onBack: () => void
  /* ---- slots rendered by App so Mount state is preserved ---- */
  fileTree: ReactNode
  searchPanel: ReactNode
  editorPane: ReactNode
  previewPane: ReactNode
  cssVars: CSSProperties
  /* ---- actions ---- */
  actions: FileActions
  toolbar: string[]
  onCommand: (id: string) => void
  onUndo: () => void
  onRedo: () => void
  /** CodeMirror history depth — disable the buttons on empty stacks. */
  canUndo: boolean
  canRedo: boolean
  onInsertImage: () => void
  onOpenPalette: () => void
  onOpenSettings: () => void
  /** Open the settings dialog straight on the "编辑工具栏" tab. */
  onOpenToolbarSettings: () => void
  /** Pin focus back onto the editor when a toolbar button is tapped. */
  onPinFocus: () => void
  onOpenHistory: () => void
  /* ---- status ---- */
  lanLabel: string
  connected: boolean
  updates: number
  queued: number
  /* ---- pages ---- */
  connect: MobileConnectProps
  settings: MobileSettingsProps
}

const TABS: { id: MobileTab; label: string; icon: string }[] = [
  { id: 'notes', label: '笔记', icon: 'files' },
  { id: 'search', label: '搜索', icon: 'search' },
  { id: 'connect', label: '连接', icon: 'qr' },
  { id: 'mine', label: '我的', icon: 'user' },
]

const TAB_TITLE: Record<MobileTab, string> = {
  notes: '笔记', search: '搜索', connect: '连接电脑', mine: '我的',
}

const THEME_OPTIONS: { id: ThemeChoice; label: string }[] = [
  { id: 'system', label: '跟随系统' },
  { id: 'light', label: '浅色' },
  { id: 'dark', label: '深色' },
]

function MobileSettings(props: MobileSettingsProps) {
  const s = props
  const selected: ThemeChoice = s.themeMode === 'system' ? 'system' : s.theme
  return (
    <div className="m-page">
      <div className="m-section">当前仓库</div>
      <button className="m-card m-row" onClick={s.onChooseVault}>
        <Icon name="folder" size={20} />
        <span className="m-row-main">
          <strong>{s.vaultName || '手机仓库'}</strong>
          <small>由系统文件夹授权 · 点击更换</small>
        </span>
        <Icon name="chevronRight" size={17} />
      </button>

      <div className="m-section">外观</div>
      <div className="m-card m-theme-card">
        <div className="m-theme-label">主题</div>
        <div className="m-theme-seg">
          {THEME_OPTIONS.map((o) => (
            <button key={o.id} className={selected === o.id ? 'on' : ''} onClick={() => s.onThemeMode(o.id)}>
              {o.label}
            </button>
          ))}
        </div>
      </div>
      <div className="m-card">
        <div className="m-row">
          <span className="m-row-main"><strong>编辑器字号</strong></span>
          <span className="m-stepper">
            <button onClick={() => s.onFontSize(-1)} aria-label="缩小字号">−</button>
            <b>{s.fontSize}px</b>
            <button onClick={() => s.onFontSize(1)} aria-label="放大字号">+</button>
          </span>
        </div>
        <button className="m-row" onClick={s.onLineNumbers}>
          <span className="m-row-main"><strong>显示行号</strong></span>
          <span className="m-row-value">{s.showLineNumbers ? '开' : '关'}</span>
          <Icon name="check" size={17} className={s.showLineNumbers ? 'm-on' : ''} />
        </button>
      </div>

      <div className="m-section">其他</div>
      <div className="m-card">
        <button className="m-row" onClick={s.onOpenHistory}>
          <Icon name="history" size={19} /><span className="m-row-main"><strong>历史版本</strong></span>
          <Icon name="chevronRight" size={17} />
        </button>
        <button className="m-row" onClick={s.onExportLog}>
          <Icon name="download" size={19} /><span className="m-row-main"><strong>导出日志</strong></span>
          <Icon name="chevronRight" size={17} />
        </button>
        <button className="m-row" onClick={s.onOpenAbout}>
          <Icon name="settings" size={19} /><span className="m-row-main"><strong>关于</strong></span>
          <Icon name="chevronRight" size={17} />
        </button>
      </div>

      <p className="m-note">
        手机端笔记保存在你授权的文件夹里；连接同一局域网的电脑后可发布、拉取并逐篇处理冲突。
      </p>
    </div>
  )
}

/**
 * Phone-only shell. Desktop keeps its own render tree in App.tsx, so this file
 * changes nothing outside `html[data-platform="android"]`. All screens stay
 * mounted (only CSS visibility changes) so CodeMirror keeps its cursor and
 * scroll position when the user switches tabs.
 */
export function MobileShell(props: MobileProps) {
  const showEditor = props.editorOpen
  const node = props.sheet?.kind === 'node' ? props.sheet.node : null
  const isFolder = node?.type === 'folder'
  const isAsset = node?.type === 'asset'

  // Keep the shell (and the format strip) above the soft keyboard.
  useMobileViewportHeight(true)

  useEffect(() => {
    if (!props.sheet) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // A real dialog owns Escape while it is open.
      if (document.querySelector('.modal-backdrop')) return
      props.setSheet(null)
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [props.sheet, props.setSheet])

  const closeSheet = () => props.setSheet(null)

  return (
    <div className="m-shell">
      <header className="m-appbar">
        {showEditor ? (
          <button className="m-ab-btn" onClick={props.onBack} aria-label="返回笔记列表">
            <Icon name="chevronRight" size={22} className="m-back-icon" />
          </button>
        ) : (
          <button className="m-ab-btn" onClick={() => props.setSheet({ kind: 'main' })} aria-label="更多操作">
            <Icon name="menu" size={22} />
          </button>
        )}
        <div className="m-ab-title">
          <span>{showEditor ? (props.title || '未命名') : TAB_TITLE[props.tab]}</span>
          {showEditor && props.dirty && <i className="m-dirty-dot" title="未保存" />}
        </div>
        {showEditor ? (
          <>
            <button className={`m-ab-save ${props.dirty ? '' : 'off'}`} disabled={!props.dirty} onClick={props.onSave}>
              保存
            </button>
            <button className="m-ab-btn compact" onClick={props.onSync} aria-label="同步当前笔记" title="同步当前笔记">
              <Icon name="sync" size={20} />
            </button>
            <button className="m-ab-btn compact" onClick={props.onFetch} aria-label="拉取" title="拉取">
              <Icon name="fetch" size={20} />
            </button>
            <button className="m-ab-btn compact" onClick={() => props.setSheet({ kind: 'main' })} aria-label="更多操作">
              <Icon name="more" size={22} />
            </button>
          </>
        ) : (
          <>
            <button className="m-ab-btn" onClick={props.settings.onToggleTheme} aria-label="切换主题">
              <Icon name={props.settings.theme === 'dark' ? 'sun' : 'moon'} size={20} />
            </button>
            <button className="m-ab-btn" onClick={() => props.setTab('search')} aria-label="搜索">
              <Icon name="search" size={21} />
            </button>
          </>
        )}
      </header>

      <div className="m-viewport">
        {/* ---------------------------------------------------- notes */}
        <section className={`m-screen ${props.tab === 'notes' && !showEditor ? 'on' : ''}`}>
          <div className="m-page m-notes-page">
            <div className="m-banner">
              <Icon name={props.connected ? 'wifi' : 'wifiOff'} size={20} />
              <div>
                <strong>{props.connected ? '电脑端已连接' : props.lanLabel}</strong>
                <span>可离线编辑，连接后同步</span>
              </div>
            </div>
            {props.updates > 0 && (
              <button className="m-alert" onClick={props.onOpenHistory}>
                <Icon name="alert" size={18} />
                <span>待处理 {props.updates} 篇，需要选择版本</span>
                <Icon name="chevronRight" size={16} />
              </button>
            )}
            {props.queued > 0 && <div className="m-hint">离线登记 {props.queued} 条，连接后补推</div>}
            <div className="m-filetree">{props.fileTree}</div>
          </div>
          <button className="m-fab" onClick={() => props.actions.onNewFile()} aria-label="新建笔记">
            <Icon name="plus" size={26} />
          </button>
        </section>

        {/* --------------------------------------------------- search */}
        <section className={`m-screen ${props.tab === 'search' && !showEditor ? 'on' : ''}`}>
          <div className="m-page m-search-page">{props.searchPanel}</div>
        </section>

        {/* -------------------------------------------------- connect */}
        <section className={`m-screen ${props.tab === 'connect' && !showEditor ? 'on' : ''}`}>
          <MobileConnect {...props.connect} />
        </section>

        {/* ----------------------------------------------------- mine */}
        <section className={`m-screen ${props.tab === 'mine' && !showEditor ? 'on' : ''}`}>
          <MobileSettings {...props.settings} />
        </section>

        {/* -------------------------------------------------- editor */}
        <section className={`m-screen m-editor-screen ${showEditor ? 'on' : ''}`}>
          <MobileEditorSeg pane={props.pane} onPane={props.setPane} />
          <div className="m-panes" style={props.cssVars}>
            <div className={`pane source-pane ${props.pane !== 'edit' ? 'pane-hidden' : ''}`}>
              {props.editorPane}
            </div>
            <div className={`pane preview-pane ${props.pane !== 'read' ? 'pane-hidden' : ''}`}>
              {props.previewPane}
            </div>
          </div>
          {props.pane === 'edit' && (
            <MobileEditorBar
              toolbar={props.toolbar}
              onCommand={props.onCommand} onUndo={props.onUndo} onRedo={props.onRedo}
              canUndo={props.canUndo} canRedo={props.canRedo}
              onInsertImage={props.onInsertImage} onMore={props.onOpenPalette}
              onCustomize={props.onOpenToolbarSettings}
              onPinFocus={props.onPinFocus}
            />
          )}
        </section>
      </div>

      {!showEditor && (
        <nav className="m-tabbar">
          {TABS.map((t) => (
            <button key={t.id} className={props.tab === t.id ? 'on' : ''} onClick={() => props.setTab(t.id)}>
              <Icon name={t.icon} size={22} /><span>{t.label}</span>
            </button>
          ))}
        </nav>
      )}

      <div className={`m-sheet-mask ${props.sheet ? 'on' : ''}`} onClick={closeSheet} />
      <div className={`m-sheet ${props.sheet ? 'on' : ''}`}>
        <div className="m-sheet-grip" />
        <h3>{node ? node.name.replace(/\.(md|markdown|txt)$/i, '') : '操作'}</h3>
        {props.sheet?.kind === 'main' && (
          <>
            <button className="m-btn m-sheet-btn" onClick={() => { closeSheet(); props.actions.onNewFile() }}>
              <Icon name="plus" size={19} />新建笔记
            </button>
            <button className="m-btn m-sheet-btn" onClick={() => { closeSheet(); props.actions.onNewFolder() }}>
              <Icon name="folderPlus" size={19} />新建文件夹
            </button>
            <button className="m-btn m-sheet-btn" onClick={() => { closeSheet(); props.onOpenPalette() }}>
              <Icon name="command" size={19} />全部命令
            </button>
            <button className="m-btn m-sheet-btn" onClick={() => { closeSheet(); props.onOpenHistory() }}>
              <Icon name="history" size={19} />历史版本
            </button>
            <button className="m-btn m-sheet-btn" onClick={() => { closeSheet(); props.onOpenSettings() }}>
              <Icon name="settings" size={19} />设置
            </button>
          </>
        )}
        {node && (
          <>
            {!isFolder && !isAsset && (
              <button className="m-btn m-sheet-btn" onClick={() => { closeSheet(); props.actions.onOpen(node.path) }}>
                <Icon name="file" size={19} />打开笔记
              </button>
            )}
            {isAsset && (
              <button className="m-btn m-sheet-btn" onClick={() => { closeSheet(); props.actions.onPreviewAsset(node.path) }}>
                <Icon name="image" size={19} />查看图片
              </button>
            )}
            {isFolder && (
              <>
                <button className="m-btn m-sheet-btn" onClick={() => { closeSheet(); props.actions.onNewFile(node.path) }}>
                  <Icon name="plus" size={19} />在此新建笔记
                </button>
                <button className="m-btn m-sheet-btn" onClick={() => { closeSheet(); props.actions.onNewFolder(node.path) }}>
                  <Icon name="folderPlus" size={19} />在此新建文件夹
                </button>
              </>
            )}
            {!isAsset && (
              <>
                <button className="m-btn m-sheet-btn" onClick={() => { closeSheet(); props.actions.onRename(node) }}>
                  <Icon name="edit" size={19} />重命名
                </button>
                <button className="m-btn m-sheet-btn danger" onClick={() => { closeSheet(); props.actions.onDelete(node) }}>
                  <Icon name="trash" size={19} />删除
                </button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
