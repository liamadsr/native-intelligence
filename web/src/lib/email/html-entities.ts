/**
 * HTML entities in a provider's plain-text field, decoded once. Gmail's
 * `snippet` is HTML-escaped (`it&#39;s`, `&amp;`, `&quot;`), so a preview shown
 * as text reads the escapes literally. One pass: `&amp;lt;` becomes `&lt;`,
 * never `<`. An unknown or malformed entity is left as written. Pure.
 */
const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  copy: '©',
  reg: '®',
  trade: '™',
}

function fromCodePoint(code: number): string | null {
  if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return null
  return String.fromCodePoint(code)
}

export function decodeHtmlEntities(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,8});/g, (whole, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X'
      return fromCodePoint(parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10)) ?? whole
    }
    return NAMED[body.toLowerCase()] ?? whole
  })
}

/** A nullable field, decoded. */
export function decodeEntitiesOrNull(text: string | null): string | null {
  return text == null ? null : decodeHtmlEntities(text)
}
