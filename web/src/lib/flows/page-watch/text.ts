/**
 * A fetched page's visible text, one line per block (and one per table row
 * or list item, its cells joined with " | "): what a page watch
 * compares between reads. Pure. HTML goes through htmlparser2's streaming
 * tokenizer (already a dependency: the site audit reads pages with it), so a
 * broken page still yields its text and nothing is ever executed or
 * rendered; plain text and JSON are split into lines as they are.
 *
 * What is dropped: everything inside script, style, noscript, svg, template,
 * head and the like (none of it is what a reader sees), comments, empty
 * lines, and runs of whitespace. Entities are decoded by the tokenizer. Every
 * line and the line count are capped, so a huge page costs a bounded amount
 * to hash and store.
 */
import { Parser } from 'htmlparser2'

export const PAGE_TEXT_MAX_LINES = 2000
export const PAGE_TEXT_MAX_LINE_CHARS = 500

/* Elements whose content is never visible text. */
const HIDDEN_TAGS = new Set(['script', 'style', 'noscript', 'svg', 'template', 'head', 'iframe', 'object', 'canvas', 'math', 'select', 'datalist'])

/* Elements that start a new line: block-level boxes, breaks. */
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'br', 'caption', 'dd', 'details', 'dialog', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr',
  'html', 'legend', 'main', 'menu', 'nav', 'ol', 'option', 'p', 'pre', 'section', 'summary', 'table', 'tbody',
  'td', 'tfoot', 'th', 'thead', 'title', 'ul',
])

/*
 * Elements whose text is ONE line however many boxes it is laid out in: a
 * table row (its cells), a list item, a label, a button. Inside one, a block
 * or a cell boundary becomes " | " instead of a new line, so a row reads
 * "Basic | $12" and a change to its price is a new line that says which
 * plan, not a bare "$12" that may already be elsewhere on the page. A group
 * opened inside another (a nested list, a table in a list item) ends the
 * outer group's line so far and is its own line.
 */
const GROUP_TAGS = new Set(['tr', 'li', 'label', 'button'])
const PART_JOIN = ' | '

function tidy(line: string): string | null {
  const flat = line.replace(/[\s\u00a0\u200b\u200c\u200d\ufeff]+/g, ' ').trim()
  if (!flat) return null
  return flat.length > PAGE_TEXT_MAX_LINE_CHARS ? flat.slice(0, PAGE_TEXT_MAX_LINE_CHARS) : flat
}

/** Lines of visible text from HTML. */
export function htmlToLines(html: string): string[] {
  const lines: string[] = []
  const groups: Array<{ tag: string; parts: string[] }> = []
  let current = ''
  let hidden = 0
  const full = () => lines.length >= PAGE_TEXT_MAX_LINES
  const pushLine = (text: string) => {
    if (full()) return
    const line = tidy(text)
    if (line) lines.push(line)
  }
  // The text since the last boundary: a part of the open group, else a line of its own.
  const endPart = () => {
    const part = tidy(current)
    current = ''
    if (!part) return
    const group = groups[groups.length - 1]
    if (group) group.parts.push(part)
    else pushLine(part)
  }
  const emitGroup = (group: { parts: string[] }) => {
    if (group.parts.length) pushLine(group.parts.join(PART_JOIN))
    group.parts = []
  }
  const parser = new Parser(
    {
      onopentag(name) {
        if (HIDDEN_TAGS.has(name)) {
          hidden += 1
          return
        }
        if (hidden > 0) return
        if (GROUP_TAGS.has(name)) {
          endPart()
          const outer = groups[groups.length - 1]
          if (outer) emitGroup(outer)
          groups.push({ tag: name, parts: [] })
        } else if (BLOCK_TAGS.has(name)) {
          endPart()
        }
      },
      ontext(text) {
        if (hidden > 0 || full()) return
        // A runaway line (a page with no blocks) is cut here, before it grows without end.
        if (current.length < PAGE_TEXT_MAX_LINE_CHARS * 4) current += text
      },
      onclosetag(name) {
        if (HIDDEN_TAGS.has(name)) {
          if (hidden > 0) hidden -= 1
          return
        }
        if (hidden > 0) return
        if (GROUP_TAGS.has(name)) {
          endPart()
          // The tokenizer closes what a new row or item implies, so the top is this group (or one left open inside it).
          const at = groups.map((g) => g.tag).lastIndexOf(name)
          if (at === -1) return
          while (groups.length > at) emitGroup(groups.pop()!)
        } else if (BLOCK_TAGS.has(name)) {
          endPart()
        }
      },
    },
    { decodeEntities: true, lowerCaseTags: true, recognizeSelfClosing: true },
  )
  parser.write(html)
  parser.end()
  endPart()
  while (groups.length) emitGroup(groups.pop()!)
  return lines
}

/** Lines of a plain text body (also what JSON reads as: one line per line it was written in). */
export function plainTextToLines(text: string): string[] {
  const lines: string[] = []
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = tidy(raw)
    if (!line) continue
    lines.push(line)
    if (lines.length >= PAGE_TEXT_MAX_LINES) break
  }
  return lines
}

/** A JSON body pretty-printed first, so a one-line API answer still reads as many lines. */
function jsonToLines(text: string): string[] {
  try {
    return plainTextToLines(JSON.stringify(JSON.parse(text), null, 1))
  } catch {
    return plainTextToLines(text)
  }
}

/**
 * The page's lines for its media type: HTML (and XHTML) parsed, JSON
 * pretty-printed, any other text read as it is. A type that isn't text at
 * all (an image, a PDF) has no lines.
 */
export function pageToLines(body: string, contentType: string): string[] {
  const type = contentType.trim().toLowerCase()
  if (type === 'text/html' || type === 'application/xhtml+xml' || type === '') {
    // No type given: HTML when it looks like markup, plain text otherwise.
    if (type === '' && !/<[a-z!/]/i.test(body)) return plainTextToLines(body)
    return htmlToLines(body)
  }
  if (type === 'application/json' || type.endsWith('+json')) return jsonToLines(body)
  if (type.startsWith('text/')) return plainTextToLines(body)
  return []
}
