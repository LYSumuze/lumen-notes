import type { Heading } from '../types'

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/<[^>]*>/g, '')
    .replace(/[`*_~\[\]()#!.,:;?'"\/\\|]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

/** Deduplicate heading ids the same way most markdown renderers do. */
export function assignIds(headings: Omit<Heading, 'id'>[]): Heading[] {
  const seen = new Map<string, number>()
  return headings.map((h) => {
    const base = slugify(h.text) || 'section'
    const n = (seen.get(base) || 0) + 1
    seen.set(base, n)
    return { ...h, id: n === 1 ? base : `${base}-${n}` }
  })
}

/**
 * Parse ATX headings without relying on the renderer, so the outline also
 * works in pure source mode and while the preview is still debouncing.
 */
export function parseHeadings(source: string): Heading[] {
  const raw: Omit<Heading, 'id'>[] = []
  let fenced = false
  let fenceChar = ''
  source.split('\n').forEach((text, i) => {
    const fence = /^\s*(`{3,}|~{3,})/.exec(text)
    if (fence) {
      if (!fenced) { fenced = true; fenceChar = fence[1][0] }
      else if (fence[1][0] === fenceChar) fenced = false
      return
    }
    if (fenced) return
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(text)
    if (m) raw.push({ level: m[1].length, text: m[2].trim(), line: i })
  })
  return assignIds(raw)
}

/** Build a tree-ish list with `depth` for indentation rendering. */
export function outlineRows(headings: Heading[]): (Heading & { depth: number })[] {
  const stack: number[] = []
  return headings.map((h) => {
    while (stack.length && stack[stack.length - 1] >= h.level) stack.pop()
    const depth = stack.length
    stack.push(h.level)
    return { ...h, depth }
  })
}
