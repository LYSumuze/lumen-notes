import MarkdownIt from 'markdown-it'
import katex from 'katex'
import hljs from 'highlight.js/lib/common'
import 'katex/dist/katex.min.css'
import { assignIds, slugify } from './outline'
import { assetUrl } from './sync'
import type { Heading } from '../types'

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function katexHtml(tex: string, display: boolean) {
  try {
    return katex.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      strict: 'ignore',
      trust: false,
      output: 'html',
    })
  } catch (e: any) {
    return `<span class="math-error" title="${escapeHtml(e.message)}">${escapeHtml(tex)}</span>`
  }
}

/** $...$ inline math + $$...$$ display math (single- or multi-line). */
function mathPlugin(md: MarkdownIt) {
  md.inline.ruler.before('escape', 'math_inline', (state: any, silent: boolean) => {
    const src: string = state.src
    const pos: number = state.pos
    if (src[pos] !== '$' || src[pos + 1] === '$') return false
    if (pos > 0 && src[pos - 1] === '\\') return false
    let end = -1
    for (let i = pos + 1; i < src.length; i++) {
      if (src[i] === '\\') { i++; continue }
      if (src[i] === '$') { end = i; break }
      if (src[i] === '\n') break
    }
    if (end < 0) return false
    const tex = src.slice(pos + 1, end)
    if (!tex.trim() || /^\s|\s$/.test(tex) || tex.includes('\n')) return false
    if (!silent) {
      const t = state.push('math_inline', 'math', 0)
      t.content = tex
    }
    state.pos = end + 1
    return true
  })

  md.block.ruler.after(
    'blockquote',
    'math_block',
    (state: any, startLine: number, endLine: number, silent: boolean) => {
      const start = state.bMarks[startLine] + state.tShift[startLine]
      const max = state.eMarks[startLine]
      if (state.src.slice(start, start + 2) !== '$$') return false
      let firstLine = state.src.slice(start + 2, max).trim()
      let content = ''
      let found = false
      let next = startLine
      if (firstLine.endsWith('$$')) {
        content = firstLine.slice(0, -2).trim()
        found = true
      } else {
        content = firstLine
        while (!found) {
          next++
          if (next >= endLine) break
          const s = state.bMarks[next] + state.tShift[next]
          const line = state.src.slice(s, state.eMarks[next]).trim()
          if (line.endsWith('$$')) {
            content += '\n' + line.slice(0, -2).trim()
            found = true
          } else content += '\n' + line
        }
      }
      if (!found) return false
      if (silent) return true
      const token = state.push('math_block', 'math', 0)
      token.block = true
      token.content = content.trim()
      token.map = [startLine, next + 1]
      state.line = next + 1
      return true
    },
    { alt: ['paragraph', 'reference', 'blockquote', 'list'] }
  )

  md.renderer.rules.math_inline = (tokens: any[], idx: number) =>
    `<span class="math-inline">${katexHtml(tokens[idx].content, false)}</span>`
  md.renderer.rules.math_block = (tokens: any[], idx: number) =>
    `<div class="math-block" data-line="${tokens[idx].map?.[0] ?? 0}">${katexHtml(tokens[idx].content, true)}</div>`
}

/** [[Note]] / [[Note|Alias]] internal links. */
function wikiPlugin(md: MarkdownIt) {
  md.inline.ruler.before('link', 'wikilink', (state: any, silent: boolean) => {
    const src: string = state.src
    const pos: number = state.pos
    if (src.slice(pos, pos + 2) !== '[[') return false
    const end = src.indexOf(']]', pos + 2)
    if (end < 0) return false
    const body = src.slice(pos + 2, end)
    if (!body.trim() || body.includes('\n')) return false
    if (!silent) {
      const t = state.push('wikilink', '', 0)
      t.content = body
    }
    state.pos = end + 2
    return true
  })
  md.renderer.rules.wikilink = (tokens: any[], idx: number) => {
    const [target, alias] = tokens[idx].content.split('|')
    return `<a class="internal-link" data-wiki="${escapeHtml(target.trim())}">${escapeHtml((alias || target).trim())}</a>`
  }
}

/** - [ ] / - [x] checkboxes that can be toggled back into the source. */
function taskPlugin(md: MarkdownIt) {
  md.core.ruler.after('inline', 'task_list', (state: any) => {
    const tokens = state.tokens
    for (let i = 2; i < tokens.length; i++) {
      const inline = tokens[i]
      if (inline.type !== 'inline' || !inline.children?.length) continue
      const para = tokens[i - 1]
      const item = tokens[i - 2]
      if (para?.type !== 'paragraph_open' || item?.type !== 'list_item_open') continue
      // An empty task item (`- [ ] `) arrives here as just `[ ]`: markdown-it
      // trims the trailing space. Requiring \s+ after the box made those items
      // fall through to a plain list bullet with a literal `[]` in the preview.
      const m = /^\[([ xX])\](?:\s+|$)/.exec(inline.content)
      if (!m) continue
      const checked = m[1].toLowerCase() === 'x'
      const line = para.map?.[0] ?? 0
      inline.content = inline.content.slice(m[0].length)
      if (inline.children[0]?.type === 'text') {
        inline.children[0].content = inline.children[0].content.replace(/^\[([ xX])\](?:\s+|$)/, '')
      }
      const cb = new state.Token('html_inline', '', 0)
      cb.content = `<input type="checkbox" class="task-cb" data-line="${line}"${checked ? ' checked' : ''}>`
      inline.children.unshift(cb)
      item.attrJoin('class', 'task-item')
      para.attrJoin('class', 'task-para')
    }
  })
}

/**
 * Attach source line numbers to block-level elements. This is the backbone of
 * two-way scroll sync and click-to-jump between source and reading panes.
 */
// Only real content blocks get anchors. Table internals (thead/tr/th/td) and
// other wrapper tokens also carry maps, but including them would flood the
// scroll-sync anchor list with duplicate positions.
const LINE_ANCHOR_TAGS = new Set([
  'heading_open', 'paragraph_open', 'blockquote_open',
  'bullet_list_open', 'ordered_list_open', 'list_item_open',
  'table_open', 'fence', 'code_block', 'hr', 'math_block', 'html_block',
])

function sourceLinePlugin(md: MarkdownIt) {
  md.core.ruler.push('source_line', (state: any) => {
    const headings: { level: number; text: string; line: number }[] = []
    const seen = new Map<string, number>()
    const tokens = state.tokens
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]
      if (t.map && LINE_ANCHOR_TAGS.has(t.type)) t.attrSet('data-line', String(t.map[0]))
      if (t.type === 'heading_open') {
        const inline = tokens[i + 1]
        const raw = inline?.content || ''
        const plain = raw.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_$]/g, '')
        const base = slugify(plain) || 'section'
        const n = (seen.get(base) || 0) + 1
        seen.set(base, n)
        const id = n === 1 ? base : `${base}-${n}`
        t.attrSet('id', id)
        headings.push({ level: Number(t.tag.slice(1)), text: plain, line: t.map?.[0] ?? 0 })
      }
    }
    state.env.headings = assignIds(headings)
  })
}

/* ------------------------------------------------------------------ *
 * Plain-text diagrams (ASCII tables, box-drawing folder trees) are
 * usually written without fences. As a normal paragraph they lose their
 * line breaks and alignment, and linkify turns names like README.md into
 * links. Detect a contiguous run of diagram lines and emit an equal-width
 * code block instead. The .md on disk is never rewritten; token.map keeps
 * the two-way scroll anchors on their real source lines.
 * ------------------------------------------------------------------ */
const BOX_CHARS = /[├└│┌┐┘┬┴┼─]/
const ASCII_BORDER = /^[+|][\-=+|:\s]+[+|]$/
const ASCII_BORDER_ANCHOR = /^[+|][\-=+]+[+|]$/

function isDiagramLine(line: string): boolean {
  const t = line.trim()
  if (!t) return false
  if (BOX_CHARS.test(t)) return true
  if (ASCII_BORDER.test(t)) return true
  return /^\|.*\|$/.test(t)
}

/** Bare folder/file names at the edge of a tree (`project/`, `README.md`). */
function isPathLike(line: string): boolean {
  const t = line.trim()
  return /[.\/\\]/.test(t) && t.length <= 60 && !/\s/.test(t) && /^[\w.\-/\\]+$/.test(t)
}

function asciiBlockPlugin(md: MarkdownIt) {
  // After `table`: a real GFM table is consumed first and never reaches us.
  md.block.ruler.after('table', 'ascii_block', (state: any, startLine: number, endLine: number, silent: boolean) => {
    let next = startLine
    const lines: string[] = []
    let diagramLines = 0
    while (next < endLine) {
      const s = state.bMarks[next] + state.tShift[next]
      const text = state.src.slice(s, state.eMarks[next])
      const diagram = isDiagramLine(text)
      if (!diagram && !isPathLike(text)) break
      lines.push(text)
      if (diagram) diagramLines++
      next++
    }
    if (diagramLines < 2) return false
    // A genuine diagram must contain a border or a box-drawing line; a couple
    // of stray `| a | b |` lines must not turn into a code block.
    if (!lines.some((l) => BOX_CHARS.test(l) || ASCII_BORDER_ANCHOR.test(l.trim()))) return false
    if (silent) return true
    const token = state.push('code_block', 'code', 0)
    token.content = lines.join('\n')
    token.map = [startLine, next]
    token.attrSet('class', 'md-text-block')
    state.line = next
    return true
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] })
}

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  breaks: false,
  highlight(str, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre class="hljs"><code class="language-${lang}">${hljs.highlight(str, { language: lang, ignoreIllegals: true }).value}</code></pre>`
      } catch { /* fall through */ }
    }
    return `<pre class="hljs"><code>${escapeHtml(str)}</code></pre>`
  },
})

md.use(mathPlugin)
md.use(wikiPlugin)
md.use(taskPlugin)
md.use(sourceLinePlugin)
md.use(asciiBlockPlugin)

// Our custom highlighter returns a complete <pre> and therefore bypasses
// renderAttrs(); inject the source-line anchor into that <pre> explicitly.
const defaultFence = md.renderer.rules.fence
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const html = defaultFence
    ? defaultFence(tokens, idx, options, env, self)
    : `<pre><code>${escapeHtml(tokens[idx].content)}</code></pre>\n`
  const line = tokens[idx].map?.[0]
  return line == null ? html : html.replace(/^<pre/, `<pre data-line="${line}"`)
}

const defaultImage = md.renderer.rules.image
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const t = tokens[idx]
  const src = t.attrGet('src') || ''
  if (/^\/\//.test(src)) {
    // Protocol-relative URL from a static-site export.
    t.attrSet('src', `https:${src}`)
  } else if (src && !/^(https?:|data:|blob:|#|\/raw)/.test(src)) {
    // `/images/x.png` is vault-root relative (Hexo / GitHub Pages), while
    // `images/x.png` is relative to the note itself.
    const rootRelative = src.startsWith('/')
    const clean = src.replace(/^\/+/, '')
    const dir = String(env.filePath || '').split('/').slice(0, -1).join('/')
    const target = rootRelative || !dir ? clean : `${dir}/${clean}`
    t.attrSet('src', assetUrl(target))
  }
  t.attrSet('loading', 'lazy')
  return defaultImage ? defaultImage(tokens, idx, options, env, self) : self.renderToken(tokens, idx, options)
}

// External links open in a new tab; internal/wiki links are handled by the app.
const defaultLinkOpen = md.renderer.rules.link_open || ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const href = tokens[idx].attrGet('href') || ''
  if (/^https?:/i.test(href)) {
    tokens[idx].attrSet('target', '_blank')
    tokens[idx].attrSet('rel', 'noopener noreferrer')
  }
  return defaultLinkOpen(tokens, idx, options, env, self)
}

/* ------------------------------------------------------------------ *
 * Static-site frontmatter (GitHub Pages / Hexo / Jekyll).
 * markdown-it reads the closing `---` as a setext heading underline, which
 * turns the whole YAML block into one giant <h2>. We mask the block with
 * blank lines before rendering (so every data-line anchor, the outline and
 * two-way scroll sync keep pointing at real source lines) and show it as a
 * compact properties card instead. The .md on disk is never rewritten.
 * ------------------------------------------------------------------ */
interface FmField {
  key: string
  value: string
  kind: 'title' | 'date' | 'tags' | 'bool' | 'text'
}

const FM_TAG_KEYS = new Set([
  'tags', 'tag', 'categories', 'category', 'keywords', 'keyword', 'series',
])

function cleanFmValue(raw: string): string {
  let s = raw.trim()
  if (s.length > 1 && (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'")) ||
    (s.startsWith('`') && s.endsWith('`'))
  )) s = s.slice(1, -1)
  return s.trim()
}

function splitFmValue(raw: string): string[] {
  const s = raw.trim()
  if (s.startsWith('[') && s.endsWith(']')) {
    return s.slice(1, -1).split(',').map(cleanFmValue).filter(Boolean)
  }
  return s.split(/[,，;；]/).map(cleanFmValue).filter(Boolean)
}

function parseFrontmatter(source: string): { fields: FmField[]; lineCount: number } | null {
  const lines = source.split('\n')
  const head = (lines[0] || '').replace(/^\uFEFF/, '').trim()
  if (head !== '---' && head !== '+++') return null
  const toml = head === '+++'
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].trim()
    const closed = toml ? t === '+++' : /^(---|\.\.\.)\s*$/.test(t)
    if (closed) { end = i; break }
  }
  if (end < 1) return null

  const fields: FmField[] = []
  let last: FmField | null = null
  for (let i = 1; i < end; i++) {
    const t = lines[i].replace(/\r$/, '').trim()
    if (!t || t.startsWith('#') || t.startsWith('//')) continue
    // `tags:\n  - Linux\n  - Arch` — fold YAML list items into the last key.
    const item = /^[-*]\s+(.+)$/.exec(t)
    if (item && last && last.kind === 'tags') {
      const v = cleanFmValue(item[1])
      if (v) last.value += `, ${v}`
      continue
    }
    const m = toml
      ? /^([^:=\s]+)\s*=\s*(.*)$/.exec(t)
      : /^([\w\u4e00-\u9fa5.-]+)\s*[:：]\s*(.*)$/.exec(t)
    if (!m) continue
    const key = m[1].trim()
    const value = cleanFmValue(m[2])
    const lower = key.toLowerCase()
    let kind: FmField['kind'] = 'text'
    if (lower === 'title') kind = 'title'
    else if (FM_TAG_KEYS.has(lower)) kind = 'tags'
    else if (/^(true|false|yes|no)$/i.test(value)) kind = 'bool'
    else if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(value) || /^(date|updated|lastmod|publish_date)$/i.test(lower)) kind = 'date'
    last = { key, value, kind }
    fields.push(last)
  }
  return { fields, lineCount: end + 1 }
}

function fmValueHtml(f: FmField): string {
  // Plain text only: no chips, badges or coloured highlights in the reading pane.
  if (f.kind === 'tags') {
    return escapeHtml(splitFmValue(f.value).join(', ') || f.value)
  }
  if (f.kind === 'bool') {
    return /^(true|yes)$/i.test(f.value) ? '是' : '否'
  }
  return escapeHtml(f.value)
}

function renderFrontmatter(fields: FmField[]): string {
  if (!fields.length) return ''
  const rows = fields.map((f) =>
    `<div class="md-fm-row md-fm-kind-${f.kind}"><dt title="${escapeHtml(f.key)}">${escapeHtml(f.key)}</dt><dd>${fmValueHtml(f)}</dd></div>`
  ).join('')
  return `<section class="md-frontmatter" data-line="0">` +
    `<div class="md-fm-head">属性 <span class="md-fm-hint">frontmatter</span></div>` +
    `<dl class="md-fm-grid">${rows}</dl></section>\n`
}

export interface RenderResult {
  html: string
  headings: Heading[]
}

export function renderMarkdown(source: string, filePath = ''): RenderResult {
  const env: any = { filePath }
  const fm = parseFrontmatter(source)
  let body = source
  let prefix = ''
  if (fm) {
    const lines = source.split('\n')
    for (let i = 0; i < fm.lineCount && i < lines.length; i++) lines[i] = ''
    body = lines.join('\n')
    prefix = renderFrontmatter(fm.fields)
  }
  const html = prefix + md.render(body, env)
  return { html, headings: env.headings || [] }
}

/** Inline preview used by the file explorer / search result snippets. */
export function renderInline(source: string): string {
  return md.renderInline(source)
}
