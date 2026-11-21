import { useEffect, useState } from 'react'
import type { RefObject, MouseEvent } from 'react'
import { Icon } from './Icons'
import { assetUrl, assetDiskUrl } from '../lib/sync'

interface Props {
  html: string
  containerRef: RefObject<HTMLDivElement>
  onScroll: () => void
  onTaskToggle: (line: number) => void
  onWiki: (target: string) => void
  onJump: (line: number) => void
  /** When set, the preview pane shows this attachment instead of the note. */
  asset?: string | null
  onCloseAsset?: () => void
}

export function Preview({ html, containerRef, onScroll, onTaskToggle, onWiki, onJump, asset, onCloseAsset }: Props) {
  const [srcIndex, setSrcIndex] = useState(0)
  const [failed, setFailed] = useState(false)
  useEffect(() => { setSrcIndex(0); setFailed(false) }, [asset])

  const handleClick = (e: MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    const checkbox = target.closest('input.task-cb') as HTMLInputElement | null
    if (checkbox) {
      e.preventDefault()
      onTaskToggle(Number(checkbox.dataset.line || 0))
      return
    }
    const wiki = target.closest('.internal-link') as HTMLElement | null
    if (wiki) {
      e.preventDefault()
      onWiki(wiki.dataset.wiki || '')
      return
    }
    if (target.closest('a')) return
    const block = target.closest('[data-line]') as HTMLElement | null
    if (block) onJump(Number(block.dataset.line || 0))
  }

  const assetName = asset ? (asset.split('/').pop() || asset) : ''
  // The tree may hold either a real disk path or its URI-encoded form. Try
  // both before declaring the picture missing: a literal `%20` inside a file
  // name must be encoded verbatim, while `%20` standing for a space must be
  // decoded first.
  const urls = asset
    ? [assetDiskUrl(asset), assetUrl(asset)].filter((v, i, a) => a.indexOf(v) === i)
    : []
  const src = urls[Math.min(srcIndex, Math.max(0, urls.length - 1))] || ''

  return (
    <div className="preview-scroll" ref={containerRef} onScroll={onScroll}>
      {asset ? (
        <div className="asset-preview">
          <div className="asset-preview-bar">
            <span className="asset-preview-name" title={assetName}><Icon name="image" size={14} /> {assetName}</span>
            <button className="asset-preview-back" onClick={onCloseAsset}>返回笔记预览</button>
          </div>
          <div className="asset-preview-body">
            {failed ? (
              <div className="asset-preview-error">
                <Icon name="image" size={22} />
                <strong>图片无法加载</strong>
                <span>{assetName}</span>
                <p>文件可能已被移走或删除；历史版本里的图片仍可打开。</p>
              </div>
            ) : (
              <img
                src={src} alt={assetName}
                onLoad={() => setFailed(false)}
                onError={() => {
                  if (srcIndex + 1 < urls.length) setSrcIndex((v) => v + 1)
                  else setFailed(true)
                }}
              />
            )}
          </div>
        </div>
      ) : (
        <div className="preview-inner markdown-body" onClick={handleClick} dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  )
}
