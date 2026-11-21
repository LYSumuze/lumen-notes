import { useState } from 'react'
import { Icon } from '../components/Icons'
import type { Device } from '../types'

export interface MobileConnectProps {
  connected: boolean
  online: boolean
  wsConnected: boolean
  base: string
  devices: Device[]
  updates: number
  queued: number
  onScan: () => void
  onConnectLink: (raw: string) => void
  /** Native clipboard read; resolves to the text (empty when unavailable). */
  onPaste: () => Promise<string>
  onManual: (base: string, code: string) => void
  onSyncCurrent: () => void
  onSyncVault: () => void
  onFetch: () => void
  onOpenHistory: () => void
  onToast: (text: string) => void
}

/**
 * Phone connection page. Pairing is a first-level tab with a single prominent
 * scan button, instead of the desktop's 菜单 → 同步 → 设置 → 局域网 tab path.
 * Transport / pairing logic stays in App.tsx; this file is presentation only.
 */
export function MobileConnect(props: MobileConnectProps) {
  const [link, setLink] = useState('')
  const [fold, setFold] = useState(false)
  const [addr, setAddr] = useState('')
  const [code, setCode] = useState('')

  const state = props.connected ? '电脑端已连接' : props.online ? '未连接电脑端' : '服务未连接'
  const sub = props.connected
    ? '实时通道已连接'
    : props.online
      ? '请扫码或粘贴配对链接'
      : '可离线编辑，连接后同步'

  const paste = async () => {
    try {
      const text = await props.onPaste()
      if (!text) { props.onToast('剪贴板为空'); return }
      setLink(text)
      props.onToast('已读取剪贴板')
    } catch { props.onToast('无法读取剪贴板，请长按输入框粘贴') }
  }

  const connectLink = () => {
    const raw = link.trim()
    if (!raw) { props.onToast('请先粘贴配对链接'); return }
    props.onConnectLink(raw)
  }

  const connectManual = () => {
    if (!addr.trim()) { props.onToast('请填写电脑端地址'); return }
    props.onManual(addr.trim(), code.trim())
    setFold(false)
  }

  return (
    <div className="m-page m-connect">
      <div className="m-banner">
        <Icon name={props.connected ? 'wifi' : 'wifiOff'} size={20} />
        <div>
          <strong>{state}</strong>
          <span>{sub}</span>
        </div>
      </div>

      {(props.updates > 0 || props.queued > 0) && (
        <button className="m-alert" onClick={props.onOpenHistory}>
          <Icon name="alert" size={18} />
          <span>
            {props.updates > 0 ? `待处理 ${props.updates} 篇，需要选择版本` : `待补推 ${props.queued} 条`}
          </span>
          <Icon name="chevronRight" size={16} />
        </button>
      )}

      <div className="m-section">连接电脑</div>
      <button className="m-scan-hero" onClick={props.onScan}>
        <span className="m-scan-ring"><Icon name="qr" size={36} /></span>
        <strong>扫码连接</strong>
        <span>扫描电脑端配对二维码</span>
      </button>

      <div className="m-section">配对链接</div>
      <input
        className="m-input" value={link} inputMode="url" autoComplete="off" spellCheck={false}
        placeholder="粘贴电脑端配对链接"
        onChange={(e) => setLink(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') connectLink() }}
      />
      <div className="m-link-row">
        <button className="m-btn" onClick={() => void paste()}>
          <Icon name="link" size={18} />读取剪贴板
        </button>
        <button className="m-btn primary m-grow" onClick={connectLink}>
          <Icon name="check" size={18} />连接
        </button>
      </div>

      <div className={`m-fold ${fold ? 'open' : ''}`}>
        <button className="m-fold-head" onClick={() => setFold((v) => !v)}>
          手动输入地址与配对码
          <Icon name={fold ? 'chevronDown' : 'chevronRight'} size={17} />
        </button>
        {fold && (
          <div className="m-fold-body">
            <input className="m-input" value={addr} inputMode="url" autoComplete="off" spellCheck={false}
              placeholder="IP:端口，如 192.168.1.10:18740"
              onChange={(e) => setAddr(e.target.value)} />
            <input className="m-input" value={code} autoComplete="off" spellCheck={false}
              placeholder="配对码（若电脑端要求）" style={{ marginTop: 8 }}
              onChange={(e) => setCode(e.target.value)} />
            <button className="m-btn block" style={{ marginTop: 8 }} onClick={connectManual}>
              连接
            </button>
          </div>
        )}
      </div>

      <div className="m-section">同步</div>
      <div className="m-grid3">
        <button className="m-btn m-tile" onClick={props.onSyncCurrent}>
          <Icon name="sync" size={20} />当前笔记
        </button>
        <button className="m-btn m-tile" onClick={props.onSyncVault}>
          <Icon name="vault" size={20} />全仓同步
        </button>
        <button className="m-btn m-tile" onClick={props.onFetch}>
          <Icon name="fetch" size={20} />拉取
        </button>
      </div>
      <p className="m-hint">同步只发布到云仓库；「拉取」才会把对端更新收敛到本机。</p>

      <div className="m-section">已绑定设备</div>
      {props.devices.length ? props.devices.map((d) => (
        <div className="m-device" key={d.id}>
          <Icon name={/Android/i.test(d.ua) ? 'device' : 'laptop'} size={20} />
          <div>
            <strong>{d.name || '未命名设备'}</strong>
            <small>{d.ip || '局域网设备'}</small>
          </div>
        </div>
      )) : <div className="m-hint m-hint-box">还没有绑定设备，扫码或粘贴链接后会自动登记。</div>}

      <div className="m-section">当前服务地址</div>
      <div className="m-hint m-hint-box m-mono">{props.base || '未设置'}</div>
    </div>
  )
}
