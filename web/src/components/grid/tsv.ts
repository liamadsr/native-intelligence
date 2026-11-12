/**
 * Tab-separated text, the way spreadsheets put a range on the clipboard:
 * cells split by tabs, rows by newlines, and a cell holding a tab, a newline
 * or a quote wrapped in double quotes (a quote inside doubled). Reads what
 * Google Sheets, Excel and Numbers write, CRLF included.
 *
 * Client-safe and pure.
 */

/** A pasted block as rows of cells. A trailing newline adds no empty row. */
export function parseTsv(text: string): string[][] {
  if (!text) return []
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let i = 0
  // A cell is quoted only when its first character is a quote.
  let quoted = false
  let atCellStart = true
  const n = text.length
  while (i < n) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i += 2
          continue
        }
        quoted = false
        i += 1
        continue
      }
      cell += ch
      i += 1
      continue
    }
    if (atCellStart && ch === '"') {
      quoted = true
      atCellStart = false
      i += 1
      continue
    }
    if (ch === '\t') {
      row.push(cell)
      cell = ''
      atCellStart = true
      i += 1
      continue
    }
    if (ch === '\r' || ch === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      atCellStart = true
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1
      continue
    }
    cell += ch
    atCellStart = false
    i += 1
  }
  // The last row, unless the text ended on a newline.
  if (!atCellStart || cell !== '' || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

/** One cell as TSV writes it: quoted when it holds a tab, a newline or a quote. */
function tsvCell(value: string): string {
  return /[\t\n\r"]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** Rows of cells as TSV, for the clipboard. */
export function toTsv(rows: readonly (readonly string[])[]): string {
  return rows.map((r) => r.map(tsvCell).join('\t')).join('\n')
}
