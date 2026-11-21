import { useEffect, useMemo, useState } from 'react'
import QRCode from 'qrcode'
import { Icon } from './Icons'
import { formatShortcut } from '../lib/commands'
import { api } from '../lib/sync'
import { revealPath, chooseVault, hasSystemTray } from '../native/platform'
import { isAndroidNative, LumenScan, readAndroidClipboard } from '../native/androidBridge'
import type { CommandDef, Device, SyncInfo, SyncScope, ThemeName, TreeSort, VaultSort } from '../types'
import { CONFIGURABLE_ACTIONS, DEFAULT_TOOLBAR, MORE_ID, normalizeToolbar } from '../lib/toolbar'

// Injected by vite.config.ts from package.json (single source of truth).
declare const __APP_VERSION__: string
const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.1.0'

export type SettingsTab = 'sync' | 'storage' | 'editor' | 'toolbar' | 'shortcuts' | 'general' | 'about'

export interface SettingsValues {
  theme: ThemeName
  fontSize: number
  showLineNumbers: boolean
  syncScroll: boolean
  scope: SyncScope
  syncTarget: string
  /** Phone only: 'system' follows the OS dark setting; manual uses `theme`. */
  themeMode: 'manual' | 'system'
  /** Phone editor format-strip button ids, in display order. */
  toolbarCommands: string[]
  /** Sidebar file-tree ordering; display only, never affects paths on disk. */
  treeSort: TreeSort
  /** First-run vault list ordering; display only. */
  vaultSort: VaultSort
  /** 点窗口关闭按钮时：ask=每次询问，tray=最小化到托盘，quit=退出应用程序。 */
  closeAction: 'ask' | 'tray' | 'quit'
}

interface Props {
  open: boolean
  onClose: () => void
  tab: SettingsTab
  onTab: (t: SettingsTab) => void
  online: boolean
  wsConnected: boolean
  info: SyncInfo | null
  devices: Device[]
  settings: SettingsValues
  onSettings: (patch: Partial<SettingsValues>) => void
  onReconnect: (base: string) => void
  onPair: (code: string) => void
  /** Phone: apply a desktop QR / copied pairing link (http://host/?pair=...). */
  onPairLink?: (raw: string) => void
  onRefresh: () => void
  onUnpair: (id: string) => void
  commands: CommandDef[]
  scopeLabel: string
  stats: { docs: number; pending: number; conflicts: number; history: number }
  onOpenHistory: () => void
  onSyncCurrent: () => void
  onSyncVault: () => void
  onFetch: () => void
  isDesktop: boolean
  currentPath: string
  currentContent: string
  onToast: (text: string, action?: { label: string; run: () => void }) => void
  onVaultChanged: () => void
  /** Desktop: open the native folder picker. Web: disabled (explained in UI). */
  onChangeVault: () => void
}

const TABS: { id: SettingsTab; label: string; icon: string }[] = [
  { id: 'storage', label: '仓库', icon: 'folder' },
  { id: 'sync', label: '局域网同步', icon: 'qr' },
  { id: 'editor', label: '编辑器', icon: 'edit' },
  { id: 'toolbar', label: '编辑工具栏', icon: 'command' },
  { id: 'shortcuts', label: '快捷键', icon: 'keyboard' },
  { id: 'general', label: '通用', icon: 'settings' },
  { id: 'about', label: '关于', icon: 'dot' },
]

function Toggle({ value, onChange, label, hint }: { value: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <div className="setting-row">
      <div><div className="setting-label">{label}</div>{hint && <div className="setting-hint">{hint}</div>}</div>
      <button className={`switch ${value ? 'on' : ''}`} onClick={() => onChange(!value)} aria-label={label}><span /></button>
    </div>
  )
}

export function SyncPanel(props: Props) {
  const {
    open, onClose, tab, onTab, online, wsConnected, info, devices, settings,
    onSettings, onReconnect, onPair, onRefresh, onUnpair, commands,
    stats, onOpenHistory, onSyncCurrent, onSyncVault, onFetch,
  } = props
  const [qr, setQr] = useState('')
  const [baseInput, setBaseInput] = useState(settings.syncTarget)
  const [pairCode, setPairCode] = useState('')
  const [copied, setCopied] = useState('')
  const [linkInput, setLinkInput] = useState('')
  const mobile = isAndroidNative()
  const [exporting, setExporting] = useState(false)
  const [lastReport, setLastReport] = useState('')
  // 「编辑工具栏」现在两端都有：手机底部是键盘附件栏，桌面是标题栏下的
  // 横向格式条，两者共用同一份 settings.toolbarCommands。只有手机隐藏
  // 「快捷键」页（触屏没有物理键盘可提示）。
  const tabs = mobile ? TABS.filter((t) => t.id !== 'shortcuts') : TABS
  const activeTab = mobile && tab === 'shortcuts' ? 'editor' : tab

  /* Phone format strip: tick to show, arrows to reorder, "more" stays pinned. */
  const toolbarList = normalizeToolbar(settings.toolbarCommands).filter((id) => id !== MORE_ID)
  const setToolbar = (next: string[]) => onSettings({ toolbarCommands: normalizeToolbar(next) })
  const toggleToolbar = (id: string) => {
    const i = toolbarList.indexOf(id)
    setToolbar(i >= 0 ? toolbarList.filter((x) => x !== id) : [...toolbarList, id])
  }
  const moveToolbar = (id: string, delta: number) => {
    const i = toolbarList.indexOf(id)
    const j = i + delta
    if (i < 0 || j < 0 || j >= toolbarList.length) return
    const next = [...toolbarList]
    ;[next[i], next[j]] = [next[j], next[i]]
    setToolbar(next)
  }

  const applyLink = (raw: string) => props.onPairLink?.(raw)
  const scanQr = async () => {
    try {
      const r = await LumenScan.scanQr()
      if (r && r.text) applyLink(r.text)
    } catch (e: any) { props.onToast('扫码失败：' + (e?.message || '未知错误')) }
  }
  const pasteLink = async () => {
    let text = ''
    try {
      text = mobile
        ? (await readAndroidClipboard()).trim()
        : (await navigator.clipboard.readText()).trim()
    } catch {
      // Fall back to the Web API on desktop if the native bridge is unavailable.
      try { text = (await navigator.clipboard.readText()).trim() } catch { /* no clipboard access */ }
    }
    if (!text) { props.onToast('剪贴板为空，请长按输入框粘贴'); return }
    setLinkInput(text)
    applyLink(text)
  }

  useEffect(() => { setBaseInput(settings.syncTarget) }, [settings.syncTarget])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // A nested folder picker handles Escape first.
      if (document.querySelector('.folder-picker')) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const pairUrl = info ? `${info.primaryUrl}/?pair=${info.pairToken}` : ''
  useEffect(() => {
    if (!open || activeTab !== 'sync' || !pairUrl || mobile) { setQr(''); return }
    let alive = true
    QRCode.toDataURL(pairUrl, {
      width: 248, margin: 1, errorCorrectionLevel: 'M',
      color: { dark: '#202024', light: '#ffffff' },
    }).then((d) => { if (alive) setQr(d) }).catch(() => setQr(''))
    return () => { alive = false }
  }, [open, activeTab, pairUrl, mobile])

  const shortcutGroups = useMemo(() => {
    const groups = new Map<string, CommandDef[]>()
    for (const c of commands) {
      if (!c.shortcut) continue
      if (!groups.has(c.group)) groups.set(c.group, [])
      groups.get(c.group)!.push(c)
    }
    return [...groups.entries()]
  }, [commands])

  const copy = (text: string) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(text); window.setTimeout(() => setCopied(''), 1600)
    }).catch(() => {})
  }

  /** One click: build the diagnostic report on the service and offer to reveal it. */
  const exportReport = async () => {
    if (exporting) return
    setExporting(true)
    try {
      const r = await api.report()
      setLastReport(r.path)
      const run = () => {
        if (props.isDesktop) void revealPath(r.path).catch(() => {})
        else copy(r.path)
      }
      props.onToast(
        r.degraded
          ? `安装目录不可写，报告已保存到：${r.path}`
          : `诊断报告已生成：${r.path}`,
        { label: props.isDesktop ? '打开所在文件夹' : '复制路径', run },
      )
    } catch (e: any) {
      props.onToast('导出日志失败：' + (e?.message || '未知错误'))
    } finally { setExporting(false) }
  }

  const ua = navigator.userAgent
  const osName = /Windows/i.test(ua) ? 'Windows'
    : /Mac OS/i.test(ua) ? 'macOS'
      : /Android/i.test(ua) ? 'Android'
        : /iPhone|iPad/i.test(ua) ? 'iOS'
          : /Linux/i.test(ua) ? 'Linux' : ''
  const platformLabel = [props.isDesktop ? '桌面端' : '移动设备', osName].filter(Boolean).join(' · ')

  if (!open) return null
  return (
    <div className="modal-backdrop settings-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="settings-modal">
        <div className="settings-side">
          <div className="settings-title">Lumen Notes</div>
          {tabs.map((t) => (
            <button key={t.id} className={activeTab === t.id ? 'active' : ''} onClick={() => onTab(t.id)}>
              <Icon name={t.icon} size={16} /> {t.label}
            </button>
          ))}
        </div>
        <div className="settings-main">
          <div className="settings-head">
            <h2>{tabs.find((t) => t.id === activeTab)?.label}</h2>
            <button className="icon-btn" onClick={onClose} title="关闭"><Icon name="close" size={18} /></button>
          </div>

          {activeTab === 'storage' && (
            <div className="settings-content">
              <div className="section-title first">当前仓库</div>
              <div className="local-card">
                <div className="local-card-head">
                  <Icon name="folder" size={17} />
                  <div>
                    <strong>笔记仓库</strong>
                    {!online && <span>离线 · 无法读取仓库路径</span>}
                  </div>
                </div>
                <div className="vault-path" title={info?.vault || ''}>{info?.vault || '—'}</div>
                <div className="local-card-actions">
                  <button
                    className="btn btn-primary"
                    title="重新选择本地仓库"
                    onClick={() => {
                      if (props.isDesktop) { props.onChangeVault(); return }
                      void chooseVault().then((v) => { if (v) props.onVaultChanged() })
                    }}
                  ><Icon name="folder" size={15} /> 更改仓库…</button>
                  <button className="btn" onClick={onRefresh}><Icon name="refresh" size={15} /> 刷新</button>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'sync' && (
            <div className="settings-content">
              {/* 与状态栏一致：health 只代表本机服务活着，不代表跨端同步状态，不能用强调色染色。 */}
              <div className="status-banner">
                <Icon name={online ? 'wifi' : 'wifiOff'} size={17} />
                <div>
                  <strong>{online ? (mobile ? '电脑端已连接' : '本机服务运行中') : (mobile ? '未连接电脑端' : '本机服务未启动')}</strong>
                  <span>{online ? (wsConnected ? '实时通道已连接' : '正在重连实时通道') : (mobile ? '请扫码或粘贴配对链接' : '请启动桌面端')}</span>
                </div>
                <button className="icon-btn" onClick={onRefresh} title="刷新状态"><Icon name="refresh" size={16} /></button>
              </div>

              <div className="local-card">
                <div className="local-card-head">
                  <Icon name="device" size={17} />
                  <div>
                    <strong>本地仓库 / 云仓库</strong>
                    <span>本设备 {stats.docs} 篇 · 历史版本 {stats.history} 条</span>
                  </div>
                </div>
                <div className="local-card-actions">
                  <button className="btn btn-primary" onClick={onSyncCurrent}><Icon name="sync" size={15} /> 同步当前笔记</button>
                  <button className="btn" onClick={onSyncVault}><Icon name="vault" size={15} /> 全仓同步</button>
                  <button className="btn" onClick={onFetch}><Icon name="fetch" size={15} /> 拉取</button>
                  <button className="btn" onClick={onOpenHistory}><Icon name="history" size={15} /> 历史版本</button>
                </div>
              </div>

              <div className="section-title first">连接电脑</div>
              {mobile && (
                <>
                  <div className="base-row">
                    <input className="text-input" value={linkInput} onChange={(e) => setLinkInput(e.target.value)} placeholder="粘贴电脑端配对链接" />
                    <button className="btn" disabled={!linkInput.trim()} onClick={() => { applyLink(linkInput.trim()); setLinkInput('') }}>连接</button>
                  </div>
                  <div className="base-row">
                    <button className="btn btn-primary" onClick={() => void scanQr()}><Icon name="qr" size={15} /> 扫码连接</button>
                    <button className="btn" onClick={() => void pasteLink()}><Icon name="link" size={15} /> 读取剪贴板</button>
                  </div>
                </>
              )}
              <div className="base-row">
                <input className="text-input" value={baseInput} onChange={(e) => setBaseInput(e.target.value)} placeholder="IP:端口，如 192.168.1.10:18740" />
                <button className="btn btn-primary" onClick={() => onReconnect(baseInput.trim())}>连接</button>
              </div>
              <div className="base-row">
                <input className="text-input" value={pairCode} onChange={(e) => setPairCode(e.target.value)} placeholder="配对码" />
                <button className="btn" disabled={!pairCode.trim()} onClick={() => { onPair(pairCode.trim()); setPairCode('') }}>配对</button>
              </div>

              {!mobile && (
                <div className="sync-grid">
                  <div className="qr-card">
                    {qr ? <img src={qr} alt="配对二维码" /> : (
                      <div className="qr-placeholder"><Icon name="qr" size={46} /><span>{online ? '生成中…' : '同步服务不可用'}</span></div>
                    )}
                    <div className="qr-caption">手机扫码加入同一个仓库</div>
                  </div>
                  <div className="sync-desc">
                    <h3>局域网地址</h3>
                    <div className="address-list">
                      {(info?.urls || []).map((u) => (
                        <button key={u} className="address" onClick={() => copy(`${u}/?pair=${info?.pairToken || ''}`)}>
                          <Icon name="link" size={14} /><span>{u}</span>
                          <em>{copied === `${u}/?pair=${info?.pairToken || ''}` ? '已复制' : '复制'}</em>
                        </button>
                      ))}
                      {!info?.urls?.length && <div className="empty-hint">未检测到局域网地址</div>}
                    </div>
                  </div>
                </div>
              )}

              <div className="section-title">已绑定设备 <span className="panel-count">{devices.length}</span></div>
              <div className="device-list">
                {devices.map((d) => (
                  <div className="device" key={d.id}>
                    <Icon name="device" size={18} />
                    <div><strong>{d.name}</strong><span>{d.ip} · {/iPhone|Android|Mobile/i.test(d.ua) ? '移动端' : '桌面端'}</span></div>
                    <button className="icon-btn" title="解除绑定" onClick={() => onUnpair(d.id)}><Icon name="trash" size={15} /></button>
                  </div>
                ))}
                {!devices.length && <div className="empty-hint">暂无设备</div>}
              </div>
            </div>
          )}

          {activeTab === 'editor' && (
            <div className="settings-content">
              <div className="section-title first">外观</div>
              <div className="setting-row">
                <div><div className="setting-label">主题</div></div>
                {mobile ? (
                  <div className="seg seg3">
                    <button className={settings.themeMode === 'system' ? 'active' : ''} onClick={() => onSettings({ themeMode: 'system' })}>跟随系统</button>
                    <button className={settings.themeMode === 'manual' && settings.theme === 'light' ? 'active' : ''} onClick={() => onSettings({ themeMode: 'manual', theme: 'light' })}><Icon name="sun" size={14} /> 浅色</button>
                    <button className={settings.themeMode === 'manual' && settings.theme === 'dark' ? 'active' : ''} onClick={() => onSettings({ themeMode: 'manual', theme: 'dark' })}><Icon name="moon" size={14} /> 深色</button>
                  </div>
                ) : (
                  <div className="seg">
                    <button className={settings.theme === 'dark' ? 'active' : ''} onClick={() => onSettings({ theme: 'dark' })}><Icon name="moon" size={14} /> 深色</button>
                    <button className={settings.theme === 'light' ? 'active' : ''} onClick={() => onSettings({ theme: 'light' })}><Icon name="sun" size={14} /> 浅色</button>
                  </div>
                )}
              </div>
              <div className="setting-row">
                <div><div className="setting-label">编辑器字号</div></div>
                <div className="stepper">
                  <button onClick={() => onSettings({ fontSize: Math.max(11, settings.fontSize - 1) })}>−</button>
                  <span>{settings.fontSize}px</span>
                  <button onClick={() => onSettings({ fontSize: Math.min(26, settings.fontSize + 1) })}>+</button>
                </div>
              </div>
              <Toggle label="显示行号" value={settings.showLineNumbers} onChange={(v) => onSettings({ showLineNumbers: v })} />
              <div className="section-title">分屏预览</div>
              <Toggle label="双向滚动同步" value={settings.syncScroll} onChange={(v) => onSettings({ syncScroll: v })} />
            </div>
          )}

          {activeTab === 'toolbar' && (
            <div className="settings-content">
              <div className="section-title first">显示的按钮</div>
              <p className="setting-note">勾选要出现的按钮，用箭头调整顺序。标题按钮可展开选择 1–6 级。</p>
              <div className="tb-custom-list">
                {CONFIGURABLE_ACTIONS.map((a) => {
                  const i = toolbarList.indexOf(a.id)
                  const on = i >= 0
                  return (
                    <div className={`tb-custom-row ${on ? 'on' : ''}`} key={a.id}>
                      <button className={`tb-check ${on ? 'on' : ''}`} onClick={() => toggleToolbar(a.id)} aria-label={`${on ? '隐藏' : '显示'}${a.label}`}>
                        <Icon name={on ? 'check' : 'plus'} size={15} />
                      </button>
                      <Icon name={a.icon} size={17} />
                      <span className="tb-custom-label">{a.label}</span>
                      <span className="tb-custom-order">{on ? i + 1 : ''}</span>
                      <button className="tb-arrow" disabled={!on || i === 0} onClick={() => moveToolbar(a.id, -1)} aria-label="上移"><Icon name="chevronUp" size={16} /></button>
                      <button className="tb-arrow" disabled={!on || i === toolbarList.length - 1} onClick={() => moveToolbar(a.id, 1)} aria-label="下移"><Icon name="chevronDown" size={16} /></button>
                    </div>
                  )
                })}
              </div>
              <div className="tb-custom-actions">
                <button className="btn" onClick={() => setToolbar(DEFAULT_TOOLBAR)}><Icon name="refresh" size={14} /> 恢复默认</button>
              </div>
            </div>
          )}

          {activeTab === 'shortcuts' && (
            <div className="settings-content">
              {shortcutGroups.map(([group, list]) => (
                <div key={group}>
                  <div className="section-title">{group}</div>
                  <div className="shortcut-list">
                    {list.map((c) => (
                      <div className="shortcut-row" key={c.id}><span>{c.name}</span><kbd>{formatShortcut(c.shortcut)}</kbd></div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {activeTab === 'about' && (
            <div className="settings-content about">
              <div className="about-card">
                <img className="about-logo" src={`${import.meta.env.BASE_URL}icon.png`} alt="" />
                <div className="about-name">
                  <strong>Lumen Notes</strong>
                  <span>Markdown 笔记 · 本地仓库 · 局域网同步</span>
                </div>
              </div>
              <div className="about-rows">
                <div><span>版本</span><strong>v{APP_VERSION}</strong></div>
                <div><span>平台</span><strong>{platformLabel}</strong></div>
                <div><span>仓库</span><strong className="about-path" title={info?.vault || ''}>{info?.vault || '—'}</strong></div>
              </div>
              <div className="about-actions">
                <button className="btn" disabled={exporting} onClick={() => void exportReport()}>
                  <Icon name="download" size={14} /> {exporting ? '正在生成…' : '导出日志'}
                </button>
                {lastReport && <div className="about-export-path" title={lastReport}>{lastReport}</div>}
              </div>
            </div>
          )}

          {activeTab === 'general' && (
            <div className="settings-content">
              <div className="section-title first">关闭主窗口</div>
              <div className="setting-row">
                <div className="setting-label">关闭时</div>
                <div className="seg">
                  <button className={settings.closeAction === 'ask' ? 'active' : ''} onClick={() => onSettings({ closeAction: 'ask' })}>每次询问</button>
                  <button
                      className={settings.closeAction === 'tray' ? 'active' : ''}
                      disabled={!hasSystemTray()}
                      title={!hasSystemTray() ? '当前系统没有可用的托盘图标，此选项已禁用' : undefined}
                      onClick={() => onSettings({ closeAction: 'tray' })}
                    >最小化到托盘</button>
                  <button className={settings.closeAction === 'quit' ? 'active' : ''} onClick={() => onSettings({ closeAction: 'quit' })}>退出应用程序</button>
                </div>
              </div>
              <p className="setting-note">点窗口关闭按钮时的行为；选「每次询问」会弹窗让你选。系统托盘不可用时会自动按「退出应用程序」处理，避免窗口藏起来找不到。</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
