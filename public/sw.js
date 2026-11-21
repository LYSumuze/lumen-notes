/* Lumen Notes · offline app shell
 * Precaches the built UI (including CSS-referenced fonts) during install, so
 * the very first online visit is enough for both devices to open and edit
 * notes with the sync service completely unreachable.
 * API / WebSocket traffic is never cached.
 */
const CACHE = 'lumen-shell-v75'
const isApi = (u) => /^\/(api|health|raw|ws)(\/|$)/.test(u.pathname)

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE)
    const html = await fetch('./index.html')
    const text = await html.clone().text()
    await cache.put('./index.html', html.clone())
    await cache.put('./', html.clone())

    const refs = [...text.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1])
    const assets = [...new Set(refs.filter((u) => /\.(js|css|svg|png|ico|webmanifest)$/.test(u)))]
    await cache.addAll([...new Set([
      './manifest.webmanifest', './icon.svg', './icon.png',
      './icon-192.png', './icon-512.png', ...assets,
    ])])

    // Fonts live behind url() in the generated CSS.
    for (const css of assets.filter((u) => u.endsWith('.css'))) {
      const res = await fetch(css)
      const body = await res.clone().text()
      const base = new URL(css, self.location.href)
      const fonts = [...body.matchAll(/url\((?:"|')?([^"')]+\.(?:woff2?|ttf|svg|png))(?:"|')?\)/g)]
        .map((m) => new URL(m[1], base).href)
      for (const f of new Set(fonts)) await cache.add(f).catch(() => {})
    }
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  let url
  try { url = new URL(req.url) } catch { return }
  if (url.origin !== self.location.origin || isApi(url)) return

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone()
        caches.open(CACHE).then((c) => c.put('./index.html', copy)).catch(() => {})
        return res
      }).catch(async () =>
        (await caches.match('./index.html')) ||
        (await caches.match('./')) ||
        new Response('<meta charset="utf-8"><body>离线缓存尚未就绪，请联网打开一次 Lumen Notes。</body>',
          { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
      )
    )
    return
  }

  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok && res.type === 'basic') {
        const copy = res.clone()
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {})
      }
      return res
    }))
  )
})
