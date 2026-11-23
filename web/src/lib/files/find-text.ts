/**
 * Find in a document's pages (the PDF viewer's find bar): every place a query
 * occurs, page by page, case- and accent-insensitive, with the text around
 * it. Pure, so it is tested apart from pdf.js.
 */

export interface FindMatch {
  /** 1-based page number. */
  page: number
  /** Which occurrence on its page (0-based). */
  index: number
  /** Where it starts in the page's text. */
  offset: number
  length: number
  /** A short excerpt around it. */
  excerpt: string
}

/** Lowercased with diacritics removed, one character per character (so offsets line up). */
export function foldForFind(text: string): string {
  let out = ''
  for (const ch of text) {
    const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '')
    // Keep one unit per original unit, so an offset in the folded text is the original's.
    const folded = base.length === ch.length ? base.toLowerCase() : ch.toLowerCase()
    out += folded.length === ch.length ? folded : ch
  }
  return out
}

/**
 * A page's text from its text items (pdf.js `getTextContent().items`), with
 * where each item starts in it: whitespace runs become one space, and an
 * item that ends a line is followed by a space unless it already ends in one.
 * The starts let a match's offset be mapped back to the items' spans.
 */
export function pageTextOf(items: readonly { str?: string; hasEOL?: boolean }[]): { text: string; starts: number[] } {
  let text = ''
  const starts: number[] = []
  for (const item of items) {
    starts.push(text.length)
    let str = (item.str ?? '').replace(/\s+/g, ' ')
    if (text.endsWith(' ') && str.startsWith(' ')) str = str.slice(1)
    text += str
    if (item.hasEOL && !text.endsWith(' ') && text.length > 0) text += ' '
  }
  return { text, starts }
}

/**
 * The parts of items `[start, end)` of a page that a match covers: for each
 * item touched, the item's index and the range inside its own string. Items
 * whose text was shortened by pageTextOf (a leading space dropped) are
 * clamped to their string.
 */
export function matchSpans(
  starts: readonly number[],
  strs: readonly string[],
  offset: number,
  length: number,
): { item: number; from: number; to: number }[] {
  const out: { item: number; from: number; to: number }[] = []
  const end = offset + length
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i]
    const e = i + 1 < starts.length ? starts[i + 1] : Number.POSITIVE_INFINITY
    if (e <= offset || s >= end) continue
    const str = strs[i] ?? ''
    const from = Math.max(0, Math.min(str.length, offset - s))
    const to = Math.max(from, Math.min(str.length, end - s))
    if (to > from) out.push({ item: i, from, to })
  }
  return out
}

/** The most matches one search reports (a find in a 2,000-page PDF stays quick). */
export const MAX_FIND_MATCHES = 1000

export function findInPages(pages: readonly string[], query: string, max = MAX_FIND_MATCHES): FindMatch[] {
  const needle = foldForFind(query.trim().replace(/\s+/g, ' '))
  if (!needle) return []
  const matches: FindMatch[] = []
  for (let p = 0; p < pages.length; p++) {
    // Offsets are into the page's text as given (the viewer maps them to its
    // text layer), so it is not reshaped here: the viewer hands each page's
    // text with its whitespace runs already single spaces (pageTextOf).
    const text = pages[p]
    const hay = foldForFind(text)
    let at = hay.indexOf(needle)
    let index = 0
    while (at !== -1) {
      const start = Math.max(0, at - 30)
      const end = Math.min(text.length, at + needle.length + 30)
      matches.push({
        page: p + 1,
        index,
        offset: at,
        length: needle.length,
        excerpt: `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`,
      })
      if (matches.length >= max) return matches
      index++
      at = hay.indexOf(needle, at + Math.max(1, needle.length))
    }
  }
  return matches
}
