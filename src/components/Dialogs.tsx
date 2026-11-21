import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icons'

export interface InputRequest {
  title: string
  value?: string
  placeholder?: string
  confirmText?: string
}
export interface ConfirmRequest {
  message: string
  confirmText?: string
  danger?: boolean
}

/**
 * Escape must work even when focus is still in the editor. A keydown handler
 * attached only to .dialog-card never fires because the card has no focus;
 * listen on document (capture phase) while exactly one modal is pending.
 */
function useEscape(active: boolean, onEscape: () => void) {
  const cb = useRef(onEscape)
  cb.current = onEscape
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); cb.current() }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [active])
}

export function InputDialog({
  request, onResolve,
}: { request: InputRequest | null; onResolve: (v: string | null) => void }) {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  useEscape(!!request, () => onResolve(null))
  useEffect(() => {
    if (request) {
      setValue(request.value || '')
      window.setTimeout(() => { inputRef.current?.focus(); inputRef.current?.select() }, 30)
    }
  }, [request])
  if (!request) return null
  const submit = () => onResolve(value.trim() || null)
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onResolve(null) }}>
      <div className="dialog-card" tabIndex={-1} onKeyDown={(e) => { if (e.key === 'Escape') onResolve(null); if (e.key === 'Enter') submit() }}>
        <div className="dialog-title">{request.title}</div>
        <input
          ref={inputRef} className="text-input" value={value} placeholder={request.placeholder || ''}
          onChange={(e) => setValue(e.target.value)}
        />
        <div className="dialog-actions">
          <button className="btn" onClick={() => onResolve(null)}>取消</button>
          <button className="btn btn-primary" onClick={submit}>{request.confirmText || '确定'}</button>
        </div>
      </div>
    </div>
  )
}

export function ConfirmDialog({
  request, onResolve,
}: { request: ConfirmRequest | null; onResolve: (v: boolean) => void }) {
  useEscape(!!request, () => onResolve(false))
  if (!request) return null
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onResolve(false) }}>
      <div className="dialog-card" tabIndex={-1} onKeyDown={(e) => { if (e.key === 'Escape') onResolve(false) }}>
        <div className="dialog-title">{request.message}</div>
        <div className="dialog-actions">
          <button className="btn" onClick={() => onResolve(false)}>取消</button>
          <button className={`btn ${request.danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => onResolve(true)}>
            {request.confirmText || '确定'}
          </button>
        </div>
      </div>
    </div>
  )
}

export interface SaveChoiceRequest { message: string }
export type SaveChoice = 'save' | 'discard' | 'cancel'

/** "Save / Don't save / Cancel" — the classic desktop-editor leave prompt. */
export function SaveChoiceDialog({
  request, onResolve,
}: { request: SaveChoiceRequest | null; onResolve: (v: SaveChoice) => void }) {
  useEscape(!!request, () => onResolve('cancel'))
  if (!request) return null
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onResolve('cancel') }}>
      <div className="dialog-card" tabIndex={-1} onKeyDown={(e) => { if (e.key === 'Escape') onResolve('cancel') }}>
        <div className="dialog-title">{request.message}</div>
        <p className="muted small">保存会写入本设备副本并生成一条历史版本；不保存会丢弃这次修改并回到上次保存的内容。</p>
        <div className="dialog-actions">
          <button className="btn" onClick={() => onResolve('cancel')}>取消</button>
          <button className="btn btn-danger" onClick={() => onResolve('discard')}>不保存</button>
          <button className="btn btn-primary" onClick={() => onResolve('save')}>保存</button>
        </div>
      </div>
    </div>
  )
}

export interface DraftChoiceRequest { message: string; savedAt: string }
export type DraftChoice = 'edit' | 'save' | 'discard' | 'cancel'

/**
 * Cold-start prompt for a parked unsaved draft. One dialog replaces the old
 * pair: a "restore / discard" confirm followed immediately by the leave-guard
 * "save / don't save" prompt for the very same buffer.
 */
export function DraftChoiceDialog({
  request, onResolve,
}: { request: DraftChoiceRequest | null; onResolve: (v: DraftChoice) => void }) {
  useEscape(!!request, () => onResolve('cancel'))
  if (!request) return null
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onResolve('cancel') }}>
      <div className="dialog-card" tabIndex={-1} onKeyDown={(e) => { if (e.key === 'Escape') onResolve('cancel') }}>
        <div className="dialog-title">{request.message}</div>
        <p className="muted small">上次退出时这段内容未写入文件（{request.savedAt}）。恢复后可继续编辑或直接保存；丢弃则回到文件里的内容。</p>
        <div className="dialog-actions">
          <button className="btn btn-danger" onClick={() => onResolve('discard')}>丢弃</button>
          <button className="btn" onClick={() => onResolve('edit')}>恢复并继续编辑</button>
          <button className="btn btn-primary" onClick={() => onResolve('save')}>恢复并保存</button>
        </div>
      </div>
    </div>
  )
}

export interface DiskChangeRequest { path: string }
/** 'disk' = adopt the externally rewritten .md; 'mine' = overwrite it. */
export type DiskChoice = 'disk' | 'mine' | 'cancel'

/** Shown before a save would silently overwrite a note edited outside the app. */
export function DiskChangeDialog({
  request, onResolve,
}: { request: DiskChangeRequest | null; onResolve: (v: DiskChoice) => void }) {
  useEscape(!!request, () => onResolve('cancel'))
  if (!request) return null
  const name = request.path.split('/').pop() || request.path
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onResolve('cancel') }}>
      <div className="dialog-card disk-change-card" tabIndex={-1} onKeyDown={(e) => { if (e.key === 'Escape') onResolve('cancel') }}>
        <div className="dialog-title">「{name}」在磁盘上已被外部修改</div>
        <p className="muted small">磁盘上是外部写入的新内容，编辑器里是你尚未保存的修改。选择以哪一版为准。</p>
        <div className="dialog-actions">
          <button className="btn" onClick={() => onResolve('cancel')}>取消</button>
          <button className="btn" onClick={() => onResolve('disk')}>使用磁盘新内容</button>
          <button className="btn btn-primary" onClick={() => onResolve('mine')}>保留我的修改并覆盖</button>
        </div>
      </div>
    </div>
  )
}

export function Toast({ toast, onDismiss }: {
  toast: { id: number; text: string; action?: { label: string; run: () => void }; sticky?: boolean } | null
  onDismiss: () => void
}) {
  useEffect(() => {
    // A failed disk write keeps the buffer unsaved; its retry hint must not
    // disappear after a few seconds. Only the close button dismisses it.
    if (!toast || toast.sticky) return
    const t = window.setTimeout(onDismiss, toast.action ? 8000 : 3600)
    return () => clearTimeout(t)
  }, [toast, onDismiss])
  if (!toast) return null
  return (
    <div className="toast" key={toast.id}>
      <Icon name="dot" size={12} />
      <span>{toast.text}</span>
      {toast.action && (
        <button className="toast-action" onClick={() => { toast.action!.run(); onDismiss() }}>{toast.action.label}</button>
      )}
      <button className="toast-close" onClick={onDismiss}><Icon name="close" size={14} /></button>
    </div>
  )
}
