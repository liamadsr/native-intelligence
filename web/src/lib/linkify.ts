/**
 * Find the web links (http/https URLs) in free text, so text the app shows as
 * plain text can make them clickable: a document's bare URLs (the editor's
 * url-link-decorations), comments, chat messages, plain-text emails, and the
 * other text surfaces that render a string as-is (components/ui/linkify.tsx).
 *
 * Only http(s) with an explicit scheme: "partiful.com/e/…" stays text. Trailing
 * punctuation belongs to the sentence, not the link ("…/e/abc." or "(see
 * https://x.com/a)"), unless a closing bracket balances one inside the URL
 * (https://en.wikipedia.org/wiki/Foo_(bar)).
 *
 * Client-safe and cheap: a string without "://" returns at once.
 */

export interface UrlMatch {
  /** Index of the first character in the text. */
  start: number
  /** Index just past the last character. */
  end: number
  url: string
}

/** The scheme, then everything up to whitespace or a character that can't
 *  end a link in running text (quotes, angle brackets, backticks). */
const URL_RE = /https?:\/\/[^\s<>"'`]+/gi

/** Characters that end a sentence or wrap a link, never end one. */
const TRAILING_PUNCTUATION = '.,;:!?*_~'
const CLOSING_TO_OPENING: Record<string, string> = { ')': '(', ']': '[', '}': '{' }

function count(s: string, ch: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) if (s[i] === ch) n++
  return n
}

function trimTrailing(url: string): string {
  let s = url
  while (s.length > 0) {
    const last = s[s.length - 1]
    if (TRAILING_PUNCTUATION.includes(last)) {
      s = s.slice(0, -1)
      continue
    }
    const opening = CLOSING_TO_OPENING[last]
    if (opening && count(s, last) > count(s, opening)) {
      s = s.slice(0, -1)
      continue
    }
    break
  }
  return s
}

function hasHost(url: string): boolean {
  try {
    const u = new URL(url)
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.hostname.length > 0
  } catch {
    return false
  }
}

/** Every http(s) URL in `text`, in order. */
export function findUrls(text: string): UrlMatch[] {
  if (!text || !text.includes('://')) return []
  const matches: UrlMatch[] = []
  const re = new RegExp(URL_RE.source, 'gi')
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    // Part of a longer word ("xhttps://…"): not a link.
    const before = m.index > 0 ? text[m.index - 1] : ''
    if (before && /[A-Za-z0-9]/.test(before)) continue
    const url = trimTrailing(m[0])
    if (!url || !hasHost(url)) continue
    matches.push({ start: m.index, end: m.index + url.length, url })
  }
  return matches
}

export interface TextPart {
  text: string
  /** Set when this part is a link: the URL it opens (the text itself). */
  url?: string
}

/** `text` cut into plain runs and links, in order. Always at least one part. */
export function splitByUrls(text: string): TextPart[] {
  const matches = findUrls(text)
  if (matches.length === 0) return [{ text }]
  const parts: TextPart[] = []
  let at = 0
  for (const m of matches) {
    if (m.start > at) parts.push({ text: text.slice(at, m.start) })
    parts.push({ text: m.url, url: m.url })
    at = m.end
  }
  if (at < text.length) parts.push({ text: text.slice(at) })
  return parts
}
