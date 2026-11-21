import { useEffect } from 'react'

/** Fired while the visual viewport changes; detail.settled marks the final frame. */
export const VIEWPORT_RESIZE_EVENT = 'lumen:viewport-resize'
/** MainActivity publishes the real IME inset (CSS px) here. */
export const IME_INSET_EVENT = 'lumen:ime'

const MIN_H = 240

/**
 * On Android 15 / targetSdk 35 the window is edge-to-edge by default. With
 * `adjustResize` the WebView AND `visualViewport.height` frequently do NOT
 * shrink when the IME appears, so JavaScript alone cannot measure the
 * keyboard at all — that is why the previous pure-JS attempts (v68/v69/v70)
 * left the accessory bar behind the keyboard on real devices.
 *
 * MainActivity reads `WindowInsetsCompat.Type.ime()` on the decor view and
 * writes `--m-ime-h` (CSS px) plus a `lumen:ime` event. That authoritative
 * value wins; `visualViewport` remains the fallback for browsers / older
 * shells where the native inset is unavailable.
 *
 * `.app` / `.m-shell` are sized from --m-viewport-h so the accessory bar sits
 * on the keyboard's top edge. A DOM calibration pass then measures the bar
 * itself and shrinks the shell by any remaining overflow. We keep sampling
 * for the whole keyboard animation, then fire one `settled` event so the
 * editor can re-centre the caret against the final geometry.
 *
 * Desktop never installs this hook.
 */
export function useMobileViewportHeight(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return
    const root = document.documentElement
    const vv = window.visualViewport
    let lastVisible = -1
    let lastKb = -1
    let raf = 0
    let settleTimer = 0
    let sampling = false
    let settled = true
    // Layout viewport height while no IME is showing. The native inset is
    // subtracted from this, not from the (possibly unchanged) current height.
    let baseline = window.innerHeight

    const imeInset = (): number | null => {
      const raw = root.style.getPropertyValue('--m-ime-h')
      if (!raw) return null
      const n = parseFloat(raw)
      return Number.isFinite(n) && n >= 0 ? n : null
    }

    const measuredBottom = () => {
      const layout = window.innerHeight
      const visual = vv ? Math.round(vv.height) : layout
      const jsVisible = Math.min(layout, visual)
      const ime = imeInset()
      if (ime === null) return Math.max(MIN_H, jsVisible)

      if (ime <= 0) baseline = layout
      else if (baseline < layout) baseline = layout
      // When the WebView was already resized by the system, baseline - ime
      // equals layout; when it was not, this is the only correct shrink.
      const nativeVisible = ime > 0 ? Math.max(MIN_H, baseline - ime) : layout
      return Math.max(MIN_H, Math.min(jsVisible, nativeVisible))
    }

    const apply = () => {
      const layout = window.innerHeight
      let visible = measuredBottom()

      // Calibrate against the real accessory bar: measure its actual bottom
      // edge and shrink the shell by any overflow past the visible viewport.
      for (let pass = 0; pass < 3; pass++) {
        root.style.setProperty('--m-viewport-h', `${visible}px`)
        const bar = document.querySelector<HTMLElement>('.m-toolbar')
        if (!bar) break
        const rect = bar.getBoundingClientRect()
        root.style.setProperty('--m-toolbar-h', `${Math.round(rect.height)}px`)
        const overflow = Math.round(rect.bottom - visible)
        if (overflow <= 1) break
        visible = Math.max(MIN_H, visible - overflow)
      }
      root.style.setProperty('--m-viewport-h', `${visible}px`)

      // Fixed-position elements (toast, sheets) use the *current* layout
      // viewport as their coordinate system, so the inset they must avoid is
      // layout - visible. On devices where the WebView is resized by the
      // system this is already zero and the toast correctly stays put.
      const keyboard = Math.max(0, layout - visible)
      root.style.setProperty('--m-keyboard-h', `${keyboard}px`)
      root.dataset.keyboard = keyboard > 120 ? 'open' : 'closed'
      if (visible !== lastVisible || keyboard !== lastKb) {
        lastVisible = visible
        lastKb = keyboard
        window.dispatchEvent(new CustomEvent(VIEWPORT_RESIZE_EVENT, {
          detail: { height: visible, keyboard, settled: false },
        }))
      }
    }

    const finish = () => {
      sampling = false
      apply()
      if (!settled) {
        settled = true
        window.dispatchEvent(new CustomEvent(VIEWPORT_RESIZE_EVENT, {
          detail: { height: lastVisible, keyboard: lastKb, settled: true },
        }))
      }
    }

    const schedule = () => {
      settled = false
      window.clearTimeout(settleTimer)
      settleTimer = window.setTimeout(finish, 260)
      if (sampling) return
      sampling = true
      const tick = () => {
        if (!sampling) return
        apply()
        raf = requestAnimationFrame(tick)
      }
      raf = requestAnimationFrame(tick)
    }

    apply()
    vv?.addEventListener('resize', schedule)
    vv?.addEventListener('scroll', schedule)
    window.addEventListener('resize', schedule)
    window.addEventListener('focusin', schedule)
    window.addEventListener('focusout', schedule)
    window.addEventListener(IME_INSET_EVENT, schedule)
    return () => {
      sampling = false
      window.clearTimeout(settleTimer)
      cancelAnimationFrame(raf)
      vv?.removeEventListener('resize', schedule)
      vv?.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('focusin', schedule)
      window.removeEventListener('focusout', schedule)
      window.removeEventListener(IME_INSET_EVENT, schedule)
      root.style.removeProperty('--m-viewport-h')
      root.style.removeProperty('--m-keyboard-h')
      root.style.removeProperty('--m-toolbar-h')
      delete root.dataset.keyboard
    }
  }, [enabled])
}
