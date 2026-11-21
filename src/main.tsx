import { Capacitor } from '@capacitor/core'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

if (Capacitor.isNativePlatform()) {
  document.documentElement.dataset.platform = Capacitor.getPlatform()
}
const root = document.getElementById('root')
if (root) createRoot(root).render(<App />)

// Cache the app shell so the editor still opens when the LAN sync service is
// down / the device is offline. Only the production bundle is registered;
// the Vite dev server must stay uncached. Android already ships dist/ inside
// the APK, so a stale SW cache there would only hide `cap sync` updates.
if (import.meta.env.PROD && 'serviceWorker' in navigator && !Capacitor.isNativePlatform()) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {})
  })
}
