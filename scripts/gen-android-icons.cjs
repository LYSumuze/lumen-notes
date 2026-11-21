/**
 * Generate the Android launcher / splash assets from the same master as the
 * desktop icon: electron/icon-master.png (512x512, white rounded square with
 * the purple "L"). Replaces Capacitor's stock robot artwork.
 *
 *   node scripts/gen-android-icons.cjs
 *
 * Uses pngjs (already in the dependency tree through electron/gen-icon.cjs);
 * no native image tooling or network access is needed. Output is deterministic.
 */
const fs = require('node:fs')
const path = require('node:path')
const { PNG } = require('pngjs')

const ROOT = path.resolve(__dirname, '..')
const MASTER = path.join(ROOT, 'electron', 'icon-master.png')
const RES = path.join(ROOT, 'android', 'app', 'src', 'main', 'res')

if (!fs.existsSync(MASTER)) {
  console.error('Missing electron/icon-master.png')
  process.exit(1)
}
const master = PNG.sync.read(fs.readFileSync(MASTER))
if (master.width !== master.height) {
  console.error('The icon master must be square.')
  process.exit(1)
}

const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)))

/** Area-average downscale with premultiplied alpha (same rule as gen-icon.cjs). */
function resize(src, size) {
  if (src.width === size && src.height === size) return src
  const out = new PNG({ width: size, height: size })
  const scale = src.width / size
  for (let y = 0; y < size; y++) {
    const sy0 = y * scale, sy1 = (y + 1) * scale
    const iy0 = Math.max(0, Math.floor(sy0)), iy1 = Math.min(src.height, Math.ceil(sy1))
    for (let x = 0; x < size; x++) {
      const sx0 = x * scale, sx1 = (x + 1) * scale
      const ix0 = Math.max(0, Math.floor(sx0)), ix1 = Math.min(src.width, Math.ceil(sx1))
      let r = 0, g = 0, b = 0, a = 0, area = 0
      for (let yy = iy0; yy < iy1; yy++) {
        const wy = Math.min(yy + 1, sy1) - Math.max(yy, sy0)
        if (wy <= 0) continue
        for (let xx = ix0; xx < ix1; xx++) {
          const wx = Math.min(xx + 1, sx1) - Math.max(xx, sx0)
          if (wx <= 0) continue
          const w = wx * wy
          area += w
          const i = (yy * src.width + xx) * 4
          const al = src.data[i + 3] / 255
          if (al <= 0) continue
          r += src.data[i] * al * w
          g += src.data[i + 1] * al * w
          b += src.data[i + 2] * al * w
          a += al * w
        }
      }
      const o = (y * size + x) * 4
      if (a > 0) {
        out.data[o] = clamp(r / a)
        out.data[o + 1] = clamp(g / a)
        out.data[o + 2] = clamp(b / a)
        out.data[o + 3] = clamp(area > 0 ? (a / area) * 255 : 0)
      }
    }
  }
  return out
}

/**
 * Isolate the purple glyph on a transparent canvas, cropped to its exact
 * bounding box. Adaptive icons put the artwork on a separate background layer,
 * so the white rounded square must not be part of the foreground.
 */
function glyph(src) {
  const tmp = new PNG({ width: src.width, height: src.height })
  for (let i = 0; i < src.data.length; i += 4) {
    const r = src.data[i], g = src.data[i + 1], b = src.data[i + 2], a = src.data[i + 3]
    if (a > 0 && (b - g) > 22 && (r - g) > 10 && b > 90) {
      tmp.data[i] = r; tmp.data[i + 1] = g; tmp.data[i + 2] = b; tmp.data[i + 3] = a
    }
  }
  let minX = src.width, minY = src.height, maxX = -1, maxY = -1
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      if (tmp.data[(y * src.width + x) * 4 + 3] === 0) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  const w = maxX - minX + 1, h = maxY - minY + 1
  const out = new PNG({ width: w, height: h })
  for (let y = 0; y < h; y++) {
    const from = ((y + minY) * src.width + minX) * 4
    tmp.data.copy(out.data, y * w * 4, from, from + w * 4)
  }
  return out
}

/** Paste `art` into the middle of `dst`, scaling it to artW x artH. */
function paste(dst, art, artW, artH, circularBg) {
  // The area-average resize is square; the glyph is taller than it is wide, so
  // scale it non-uniformly into a square canvas instead (keeps the L upright).
  const scaled = new PNG({ width: artW, height: artH })
  const src = art
  for (let y = 0; y < artH; y++) {
    const sy = Math.min(src.height - 1, Math.floor(y * src.height / artH))
    for (let x = 0; x < artW; x++) {
      const sx = Math.min(src.width - 1, Math.floor(x * src.width / artW))
      const from = (sy * src.width + sx) * 4, to = (y * artW + x) * 4
      scaled.data[to] = src.data[from]
      scaled.data[to + 1] = src.data[from + 1]
      scaled.data[to + 2] = src.data[from + 2]
      scaled.data[to + 3] = src.data[from + 3]
    }
  }
  const ox = Math.floor((dst.width - artW) / 2), oy = Math.floor((dst.height - artH) / 2)
  for (let y = 0; y < artH; y++) {
    for (let x = 0; x < artW; x++) {
      const dx = ox + x, dy = oy + y
      if (dx < 0 || dy < 0 || dx >= dst.width || dy >= dst.height) continue
      if (circularBg) {
        const cx = dst.width / 2, cy = dst.height / 2, r = Math.min(cx, cy) - 0.5
        if ((dx + 0.5 - cx) ** 2 + (dy + 0.5 - cy) ** 2 > r * r) continue
      }
      const from = (y * artW + x) * 4, to = (dy * dst.width + dx) * 4
      const a = scaled.data[from + 3] / 255
      if (a <= 0) continue
      for (let c = 0; c < 3; c++) {
        dst.data[to + c] = clamp(dst.data[to + c] * (1 - a) + scaled.data[from + c] * a)
      }
      dst.data[to + 3] = 255
    }
  }
}

/** Transparent 108dp adaptive foreground with the glyph inside the safe zone. */
function adaptive(size, g) {
  const out = new PNG({ width: size, height: size })
  const h = Math.round(size * 0.40)                 // safe zone is 66/108 of the canvas
  const w = Math.max(1, Math.round(h * g.width / g.height))
  paste(out, g, w, h, false)
  return out
}

/** Round launcher: opaque white circle + purple L, no square corners. */
function round(size, g) {
  const out = new PNG({ width: size, height: size })
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const cx = size / 2, cy = size / 2, r = Math.min(cx, cy) - 0.5
      const inside = (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r
      out.data[i] = out.data[i + 1] = out.data[i + 2] = 255
      out.data[i + 3] = inside ? 255 : 0
    }
  }
  const h = Math.round(size * 0.50)
  const w = Math.max(1, Math.round(h * g.width / g.height))
  paste(out, g, w, h, true)
  return out
}

function write(rel, png) {
  const file = path.join(RES, rel)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, PNG.sync.write(png))
  console.log('  ', rel, png.width + 'x' + png.height)
}

const g = glyph(master)
console.log('glyph bbox:', g.width + 'x' + g.height)

const DENSITIES = [
  { dir: 'mipmap-mdpi', scale: 1 },
  { dir: 'mipmap-hdpi', scale: 1.5 },
  { dir: 'mipmap-xhdpi', scale: 2 },
  { dir: 'mipmap-xxhdpi', scale: 3 },
  { dir: 'mipmap-xxxhdpi', scale: 4 },
]

for (const d of DENSITIES) {
  const launcher = Math.round(48 * d.scale)
  const fore = Math.round(108 * d.scale)
  write(`${d.dir}/ic_launcher.png`, resize(master, launcher))
  write(`${d.dir}/ic_launcher_round.png`, round(launcher, g))
  write(`${d.dir}/ic_launcher_foreground.png`, adaptive(fore, g))
}

// Splash screens: keep each existing canvas size, paint a plain white background
// and centre the full squared logo on it. Capacitor's stock splash is its robot.
const splashDirs = [
  'drawable', 'drawable-port-mdpi', 'drawable-port-hdpi', 'drawable-port-xhdpi',
  'drawable-port-xxhdpi', 'drawable-port-xxxhdpi', 'drawable-land-mdpi',
  'drawable-land-hdpi', 'drawable-land-xhdpi', 'drawable-land-xxhdpi',
  'drawable-land-xxxhdpi',
]
for (const dir of splashDirs) {
  const file = path.join(RES, dir, 'splash.png')
  if (!fs.existsSync(file)) continue
  const old = PNG.sync.read(fs.readFileSync(file))
  const w = old.width, h = old.height
  const out = new PNG({ width: w, height: h })
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = out.data[i + 1] = out.data[i + 2] = out.data[i + 3] = 255
  }
  const side = Math.round(Math.min(w, h) * 0.38)
  const logo = resize(master, side)
  const ox = Math.floor((w - side) / 2), oy = Math.floor((h - side) / 2)
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const from = (y * side + x) * 4, to = ((oy + y) * w + ox + x) * 4
      const a = logo.data[from + 3] / 255
      for (let c = 0; c < 3; c++) {
        out.data[to + c] = clamp(255 * (1 - a) + logo.data[from + c] * a)
      }
    }
  }
  write(`${dir}/splash.png`, out)
}

console.log('Android icon assets generated.')
