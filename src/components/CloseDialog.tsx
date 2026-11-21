import { useEffect } from 'react'

export interface CloseDialogProps {
  open: boolean
  /** Linux 托盘不可靠，不提供“最小化到托盘”。 */
  hasTray: boolean
  onResolve: (action: 'tray' | 'quit') => void
  onCancel: () => void
}

export function CloseDialog({ open, hasTray, onResolve, onCancel }: CloseDialogProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onCancel])

  if (!open) return null
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel() }}>
      <div className="close-dialog" role="dialog" aria-modal="true">
        <div className="close-dialog-title">关闭 Lumen Notes</div>
        <div className="close-dialog-actions">
          {hasTray && (
            <button className="btn btn-primary" onClick={() => onResolve('tray')}>最小化到托盘</button>
          )}
          <button className="btn" onClick={() => onResolve('quit')}>退出应用程序</button>
          <button className="btn btn-ghost" onClick={onCancel}>取消</button>
        </div>
      </div>
    </div>
  )
}
