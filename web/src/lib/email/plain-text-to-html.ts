/**
 * Convert user-typed plain text into a safe HTML email body.
 *
 * Every line is HTML-escaped (so `<`, `>`, `&`, quotes typed by a human land as
 * literal text, not markup) and becomes one line of the email, the way mail
 * clients write what is typed in their own composer: a `<div>` per line, and
 * `<div><br></div>` for a blank one. Never a `<p>` per line: clients give
 * every paragraph a margin, so a line break showed as a gap and a blank line
 * as a double one. Runs of spaces keep their width (`&nbsp;`), as typed. The
 * whole thing is wrapped in a styled container.
 *
 * This is the single escaping seam for compose paths that hand-build body_html;
 * the send API does not sanitize, so escaping MUST happen here.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** One typed line as HTML: escaped, its leading space and runs of spaces kept (HTML collapses them). */
function lineHtml(line: string): string {
  if (!line) return '<br>'
  return escapeHtml(line).replace(/^ | (?= )/g, '&nbsp;')
}

export function plainTextToHtml(text: string): string {
  const body = text
    .split(/\r\n|\r|\n/)
    .map((line) => `<div>${lineHtml(line)}</div>`)
    .join('\n')
  return `<div style="font-family: sans-serif; line-height: 1.5;">${body}</div>`
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/** HTML entities as text, in one pass (so `&amp;lt;` stays `&lt;`). */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
    if (name[0] !== '#') return NAMED_ENTITIES[name.toLowerCase()] ?? entity
    const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1))
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity
  })
}

/**
 * The plain-text part for an HTML body sent without one. Reads what
 * plainTextToHtml writes back to the text that was typed (a line per `<div>`,
 * a blank line per `<div><br></div>`), and other HTML sensibly: a line per
 * `<br>` and per block, a blank line after a paragraph.
 */
export function htmlToPlainText(html: string): string {
  const text = html
    // Line breaks between tags are layout; inside text they are a space.
    .replace(/>\s*[\r\n]\s*</g, '><')
    .replace(/\s*[\r\n]+\s*/g, ' ')
    // A blank line: a block holding only a <br>.
    .replace(/<(div|p)\b[^>]*>\s*<br\s*\/?>\s*<\/\1>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/(div|li|tr|h[1-6]|blockquote|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
  return decodeEntities(text)
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\s+$/g, '')
}
