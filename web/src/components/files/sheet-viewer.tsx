'use client'

/**
 * A spreadsheet, read only: an .xlsx's first sheet or a CSV/TSV, through the
 * spreadsheet import readers (crm/import/sources/spreadsheet.ts: readXlsx,
 * parseCsv), shown as a grid with A, B, C… columns and row numbers.
 */
import * as React from 'react'
import { Loader2 } from 'lucide-react'
import { parseCsv, readXlsx, type Sheet } from '@/lib/crm/import/sources/spreadsheet'
import { extensionOf } from '@/lib/files/viewer-kind'

/** A CSV's characters: UTF-16 by its byte-order mark, else UTF-8 when valid, else Windows-1252 (Excel's CSV). */
export function decodeSheetText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('windows-1252').decode(bytes)
  }
}

/** A column's letters: 0 → A, 25 → Z, 26 → AA. */
export function columnLetters(index: number): string {
  let n = index + 1
  let out = ''
  while (n > 0) {
    const r = (n - 1) % 26
    out = String.fromCharCode(65 + r) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

const MAX_SHOWN_ROWS = 5000

export default function SheetViewer({ blob, name, onDownload }: { blob: Blob; name: string; onDownload: () => void }) {
  const [sheet, setSheet] = React.useState<Sheet | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const isXlsx = extensionOf(name) === 'xlsx' || blob.type.includes('spreadsheetml')
  React.useEffect(() => {
    let live = true
    void (async () => {
      try {
        const bytes = new Uint8Array(await blob.arrayBuffer())
        const read = isXlsx ? await readXlsx(bytes) : parseCsv(decodeSheetText(bytes), extensionOf(name) === 'tsv' ? '\t' : undefined)
        if (live) setSheet(read)
      } catch {
        if (live) setError('This spreadsheet could not be read.')
      }
    })()
    return () => {
      live = false
    }
  }, [blob, isXlsx, name])
  if (error)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm">
        <p className="text-destructive">{error}</p>
        <button type="button" onClick={onDownload} className="text-xs text-muted-foreground underline hover:text-foreground">
          Download it
        </button>
      </div>
    )
  if (!sheet)
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label="Loading" />
      </div>
    )
  // The readers split off a header row; the viewer shows it as row 1, as the file has it.
  const rows = [sheet.headers, ...sheet.rows]
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0)
  const shown = rows.slice(0, MAX_SHOWN_ROWS)
  const cut = rows.length > MAX_SHOWN_ROWS || sheet.truncated
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-1.5 text-xs text-muted-foreground">
        <span>Read only</span>
        {isXlsx && <span>First sheet</span>}
        <span className="ml-auto">
          {rows.length.toLocaleString()} rows · {width} columns
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-background">
        <table className="border-collapse text-xs" data-file-viewer-sheet="">
          <thead className="sticky top-0 z-10 bg-muted">
            <tr>
              <th className="sticky left-0 z-20 border border-border bg-muted px-2 py-1" />
              {Array.from({ length: width }, (_, c) => (
                <th key={c} className="min-w-20 border border-border px-2 py-1 font-medium text-muted-foreground">
                  {columnLetters(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, r) => (
              <tr key={r}>
                <th className="sticky left-0 border border-border bg-muted px-2 py-1 text-right font-normal tabular-nums text-muted-foreground">{r + 1}</th>
                {Array.from({ length: width }, (_, c) => (
                  <td key={c} className="max-w-80 truncate border border-border px-2 py-1" title={row[c] ?? ''}>
                    {row[c] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {cut && <p className="p-4 text-xs text-muted-foreground">Only the first rows are shown. Download the file for the rest.</p>}
      </div>
    </div>
  )
}
