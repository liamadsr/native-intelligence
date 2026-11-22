'use client'

/**
 * The "Import and export" menu, pinned at the right of the footer. Import… takes
 * a .xlsx or .csv: a .csv is pasted at the active cell of the open workbook (one
 * undo step), an .xlsx becomes a new spreadsheet through the import route, whose
 * warnings are then shown with an offer to open it. Download .xlsx and Download
 * .csv run the engine in the browser on the open workbook and save a file, so a
 * download needs no round trip to the server.
 */
import { useRef, useState } from 'react'
import { Download, FileDown, FileUp, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { WorkbookController } from '@/lib/spreadsheets/controller'
import { csvToRows, sheetToCsv } from '@/lib/spreadsheets/csv'
import { workbookToXlsx } from '@/lib/spreadsheets/xlsx-write'

interface Props {
  workbook: WorkbookController
  title: string
  onMessage: (message: string) => void
  /** Open another spreadsheet (a freshly imported one). Absent when the editor stands alone. */
  onOpen?: (id: string, title: string) => void
  focusGrid: () => void
}

interface Imported {
  id: string
  title: string
  warnings: string[]
}

function fileStem(title: string): string {
  return (title.replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, ' ').trim() || 'spreadsheet').slice(0, 120)
}

/** Save `data` to the viewer's machine as `name`. */
function download(data: Blob, name: string): void {
  const url = URL.createObjectURL(data)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export function ImportExport({ workbook, title, onMessage, onOpen, focusGrid }: Props) {
  const fileInput = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [imported, setImported] = useState<Imported | null>(null)

  const downloadXlsx = async () => {
    try {
      const bytes = await workbookToXlsx(workbook.model)
      download(new Blob([new Uint8Array(bytes)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${fileStem(title)}.xlsx`)
    } catch (e) {
      onMessage(e instanceof Error ? e.message : 'Could not build the .xlsx file.')
    }
  }

  const downloadCsv = () => {
    try {
      const sheet = workbook.sheet
      const name = workbook.sheets()[sheet]?.name
      const csv = sheetToCsv(workbook.model, sheet)
      const stem = workbook.sheets().length > 1 && name ? `${fileStem(title)} - ${fileStem(name)}` : fileStem(title)
      download(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }), `${stem}.csv`)
    } catch (e) {
      onMessage(e instanceof Error ? e.message : 'Could not build the .csv file.')
    }
  }

  const onPick = async (file: File) => {
    const isCsv = /\.csv$/i.test(file.name) || file.type === 'text/csv'
    setBusy(true)
    try {
      if (isCsv) {
        const rows = csvToRows(await file.text())
        if (!rows.length) {
          onMessage('That file had nothing to paste.')
          return
        }
        const result = workbook.pasteValues(rows)
        if (!result.ok) onMessage(result.message)
        else focusGrid()
        return
      }
      // An .xlsx becomes a new spreadsheet through the route.
      const form = new FormData()
      form.set('file', file)
      const res = await fetch('/api/account/spreadsheets/import', { method: 'POST', body: form })
      const json = (await res.json().catch(() => ({}))) as { spreadsheet?: { id: string; title: string }; warnings?: string[]; error?: string }
      if (!res.ok || !json.spreadsheet) {
        onMessage(json.error || 'Could not import that file.')
        return
      }
      setImported({ id: json.spreadsheet.id, title: json.spreadsheet.title, warnings: json.warnings ?? [] })
    } catch (e) {
      onMessage(e instanceof Error ? e.message : 'Could not import that file.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <input
        ref={fileInput}
        type="file"
        accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) void onPick(file)
        }}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-[12.5px] text-muted-foreground" disabled={busy} aria-label="Import and export">
            <Upload className="h-3.5 w-3.5" />
            Import and export
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top" className="w-56">
          {!workbook.readOnly && (
            <>
              <DropdownMenuItem onSelect={() => fileInput.current?.click()}>
                <FileUp className="h-4 w-4" />
                Import…
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem onSelect={() => void downloadXlsx()}>
            <Download className="h-4 w-4" />
            Download .xlsx
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => downloadCsv()}>
            <FileDown className="h-4 w-4" />
            Download .csv (this sheet)
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={imported !== null} onOpenChange={(open) => !open && setImported(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Imported “{imported?.title}”</DialogTitle>
            <DialogDescription>
              {imported && imported.warnings.length > 0
                ? 'The spreadsheet was imported. Some things in the file could not be carried over:'
                : 'The spreadsheet was imported with nothing left behind.'}
            </DialogDescription>
          </DialogHeader>
          {imported && imported.warnings.length > 0 && (
            <ul className="max-h-56 list-disc space-y-1 overflow-y-auto pl-5 text-sm text-muted-foreground">
              {imported.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setImported(null)}>
              Close
            </Button>
            {onOpen && (
              <Button
                size="sm"
                onClick={() => {
                  const target = imported
                  setImported(null)
                  if (target) onOpen(target.id, target.title)
                }}
              >
                Open it
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
