/**
 * Lumen Notes icon pipeline.
 *
 * Source of truth: electron/icon-master.png — the 512x512 RGBA master with the
 * "purple L on a white rounded square" design.
 *
 * Composition rule: the white rounded square is FULL BLEED — it touches all
 * four canvas edges, with no transparent padding ring around it. Only the
 * rounded corners themselves are transparent. Any padding in a freshly
 * exported master is normalized away here, and the normalized master is
 * written back so the source of truth always matches the shipped icons.
 *
 * Re-run with `node electron/gen-icon.cjs` after replacing the master; every
 * derived icon below is regenerated deterministically. Uses pngjs (already
 * present through qrcode); no native image tooling or network is required.
 */
const fs = require('node:fs')
const path = require('node:path')
const { PNG } = require('pngjs')

const ROOT = path.resolve(__dirname, '..')
const MASTER = path.join(__dirname, 'icon-master.png')
const PUBLIC = path.join(ROOT, 'public')

if (!fs.existsSync(MASTER)) {
  console.error('Missing electron/icon-master.png — export the 512x512 master first.')
  process.exit(1)
}

const master = PNG.sync.read(fs.readFileSync(MASTER))
if (master.width !== master.height) {
  console.error('The icon master must be square.')
  process.exit(1)
}

/**
 * The design has a 1px semi-transparent grey outline around the white rounded
 * square (e.g. rgba(191,193,193,149)). At 16-32px that ring turns into a dirty
 * checkerboard around the icon, so small variants use a copy where every
 * semi-transparent *neutral* pixel is turned white. The purple L and its own
 * anti-aliased (non-neutral) edge pixels are left untouched.
 */
function cleanEdges(src) {
  const out = new PNG({ width: src.width, height: src.height })
  out.data.set(src.data)
  for (let i = 0; i < out.data.length; i += 4) {
    const a = out.data[i + 3]
    if (a === 0 || a === 255) continue
    const r = out.data[i], g = out.data[i + 1], b = out.data[i + 2]
    if (Math.abs(r - g) < 16 && Math.abs(g - b) < 16) {
      out.data[i] = 255
      out.data[i + 1] = 255
      out.data[i + 2] = 255
    }
  }
  return out
}

/**
 * Area-average downscale with premultiplied alpha.
 *
 * Bilinear point sampling only reads 4 source pixels per destination pixel;
 * going 512 -> 16 that skips ~99% of the source, aliasing the rounded corners
 * and the L strokes into hard, blocky edges. Averaging *every* source pixel
 * covered by the destination pixel (with partial-pixel weights) keeps the
 * alpha ramp smooth, and premultiplying avoids dark/coloured halos where
 * fully transparent pixels have arbitrary RGB values.
 */
function resize(src, size, sizeY = size) {
  if (src.width === size && src.height === sizeY) return src
  const out = new PNG({ width: size, height: sizeY })
  // Separate axis scales: a tight crop of the artwork is not perfectly square,
  // and stretching it by ~1% is far better than reintroducing a padding ring.
  const scaleX = src.width / size, scaleY = src.height / sizeY
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)))
  for (let y = 0; y < sizeY; y++) {
    const sy0 = y * scaleY, sy1 = (y + 1) * scaleY
    const iy0 = Math.max(0, Math.floor(sy0)), iy1 = Math.min(src.height, Math.ceil(sy1))
    for (let x = 0; x < size; x++) {
      const sx0 = x * scaleX, sx1 = (x + 1) * scaleX
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

/** Crop the opaque rounded-square artwork to its EXACT bounding box, dropping
 *  the transparent padding and the faint 1px outline around it. Unlike a square
 *  "trim", this deliberately keeps the crop non-square so stretching it to the
 *  full canvas never reintroduces a transparent padding column. */
function cropTight(src) {
  let minX = src.width, minY = src.height, maxX = -1, maxY = -1
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      // Only fully opaque pixels define the crop box: any translucent outline
      // pixel left on a straight edge would average into a grey band.
      if (src.data[(y * src.width + x) * 4 + 3] < 240) continue
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
    const to = y * w * 4
    src.data.copy(out.data, to, from, from + w * 4)
  }
  return out
}

/**
 * The area average can leave the outermost straight edge ~90% opaque
 * (alpha 231). On a dark taskbar that reads as a grey band around the whole
 * icon. Snap only the straight segments to 0/255; the corner arcs keep their
 * soft alpha ramp.
 */
function snapStraightEdges(out, lo, hi, corner) {
  const size = out.width
  const snap = (x, y) => {
    const i = (y * size + x) * 4
    const a = out.data[i + 3]
    if (a === 0 || a === 255) return
    if (a >= 128) out.data[i + 3] = 255
    else {
      out.data[i] = 0; out.data[i + 1] = 0; out.data[i + 2] = 0
      out.data[i + 3] = 0
    }
  }
  for (let x = lo + corner; x <= hi - corner; x++) { snap(x, lo); snap(x, hi) }
  for (let y = lo + corner; y <= hi - corner; y++) { snap(lo, y); snap(hi, y) }
}

/** Compose small icons at their FINAL size. No padding: the artwork is
 *  full bleed, so the white square reaches every edge of the 16/32px icon,
 *  keeping the glyph legible in the taskbar. Straight edges land exactly on
 *  pixel boundaries; corners keep the ramp. */
function composeSmall(block, size) {
  const out = resize(block, size)
  // The artwork's corner radius is ~0.24 of its side. Snapping only beyond
  // that keeps the whole rounded arc smooth instead of squaring it off.
  snapStraightEdges(out, 0, size - 1, Math.max(2, Math.round(size * 0.24)))
  return out
}

/**
 * Normalize a master to full bleed: crop the transparent padding ring away,
 * scale the artwork up to fill the whole canvas, then snap the straight edges.
 * The purple L grows with the whole picture (it is NOT scaled independently).
 * Idempotent — a master that is already full bleed comes back unchanged.
 */
function fullBleed(master) {
  const tight = cropTight(cleanEdges(master))
  const out = resize(tight, master.width, master.height)
  snapStraightEdges(out, 0, master.width - 1, Math.round(master.width * 0.24))
  return out
}

/** Vista+ ICO: PNG-compressed images with a classic ICONDIR directory. */
function buildIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)              // reserved
  header.writeUInt16LE(1, 2)              // type: icon
  header.writeUInt16LE(images.length, 4)  // count
  let offset = 6 + images.length * 16
  const entries = []
  for (const { size, data } of images) {
    const e = Buffer.alloc(16)
    e[0] = size >= 256 ? 0 : size         // 0 means 256
    e[1] = size >= 256 ? 0 : size
    e[2] = 0                              // no palette
    e[3] = 0
    e.writeUInt16LE(1, 4)                 // colour planes
    e.writeUInt16LE(32, 6)                // bits per pixel
    e.writeUInt32LE(data.length, 8)
    e.writeUInt32LE(offset, 12)
    offset += data.length
    entries.push(e)
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)])
}

function write(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, buf)
  console.log('wrote', path.relative(ROOT, file), buf.length, 'bytes')
}

// Normalize away the transparent padding ring, then keep the master in sync
// with the composition that is actually shipped.
const design = fullBleed(master)
write(MASTER, PNG.sync.write(design))

// Small icons are composed on a pixel grid from the trimmed rounded square;
// large ones are a straight area-average of the full-bleed design.
const block = design // already square and full bleed
const iconFor = (size) => (size <= 64 ? composeSmall(block, size) : resize(design, size))

// Full-size assets (window icon, favicon, PWA manifest).
const png512 = PNG.sync.write(design)
write(path.join(__dirname, 'icon.png'), png512)
write(path.join(PUBLIC, 'icon.png'), png512)
write(path.join(PUBLIC, 'icon-512.png'), png512)
write(path.join(PUBLIC, 'icon-192.png'), PNG.sync.write(iconFor(192)))

// Tray: native 16px base (1:1 at 100% DPI) plus @2x for HiDPI. Electron's
// nativeImage.createFromPath() picks up the @2x variant automatically.
write(path.join(__dirname, 'tray.png'), PNG.sync.write(iconFor(16)))
write(path.join(__dirname, 'tray@2x.png'), PNG.sync.write(iconFor(32)))

// Extra 20/40 entries cover 125% / 250% DPI without an extra OS downscale.
// app-icon.ico is the path the shell loads; a distinct filename avoids the
// Windows icon cache serving a stale copy after the artwork changes.
// icon.ico is kept in sync for any shortcut that still points at the old name.
const icoSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
const ico = buildIco(icoSizes.map((size) => ({ size, data: PNG.sync.write(iconFor(size)) })))
write(path.join(__dirname, 'app-icon.ico'), ico)
write(path.join(__dirname, 'icon.ico'), ico)
