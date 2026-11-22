/**
 * A range on the system clipboard, both ways. Other spreadsheets read
 * tab-separated text and an HTML table; this app writes both, and reads
 * whichever it is given.
 */

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (ch) => ESCAPES[ch])
}

/** Rows of text as the table Excel and Google Sheets paste from. */
export function tableHtml(rows: readonly (readonly string[])[]): string {
  const body = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell).replace(/\r?\n/g, '<br>')}</td>`).join('')}</tr>`)
    .join('')
  return `<table>${body}</table>`
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&')
}

/**
 * The first table in a piece of clipboard HTML, as rows of text (tags
 * dropped, line breaks kept). Null when there is no table. Merged cells
 * take their place and leave the cells they cover empty.
 */
export function parseTableHtml(html: string): string[][] | null {
  const table = /<table[\s\S]*?<\/table>/i.exec(html)
  if (!table) return null
  const rows: string[][] = []
  const taken = new Set<string>()
  let r = 0
  for (const tr of table[0].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const row: string[] = rows[r] ?? (rows[r] = [])
    let c = 0
    for (const td of tr[1].matchAll(/<t[dh]([^>]*)>([\s\S]*?)<\/t[dh]>/gi)) {
      while (taken.has(`${r}:${c}`)) {
        row[c] ??= ''
        c += 1
      }
      const text = decodeEntities(
        td[2]
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<\/p>\s*<p[^>]*>/gi, '\n')
          .replace(/<[^>]+>/g, '')
          .replace(/[ \t\r\f]*\n[ \t\r\f]*/g, '\n')
          .replace(/[ \t\r\f]+/g, ' '),
      ).trim()
      row[c] = text
      const colspan = Math.max(1, Number(/colspan\s*=\s*"?(\d+)/i.exec(td[1])?.[1] ?? 1))
      const rowspan = Math.max(1, Number(/rowspan\s*=\s*"?(\d+)/i.exec(td[1])?.[1] ?? 1))
      for (let dr = 0; dr < rowspan; dr++) {
        for (let dc = 0; dc < colspan; dc++) {
          if (dr || dc) taken.add(`${r + dr}:${c + dc}`)
        }
      }
      c += colspan
    }
    r += 1
  }
  if (!rows.length) return null
  const width = Math.max(...rows.map((row) => row.length))
  return rows.map((row) => Array.from({ length: width }, (_, i) => row[i] ?? ''))
}

/** The same text whatever line endings the clipboard gave it back with. */
export function sameClipboardText(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\r\n?/g, '\n').replace(/\n+$/, '')
  return norm(a) === norm(b)
}
