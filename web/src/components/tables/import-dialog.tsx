'use client'

/**
 * Bring a spreadsheet into a table (Tables, phase 6): pick a CSV, TSV or
 * Excel file, map each of its columns (the row's name, a column the table
 * has, a new column of a guessed type, or nothing), check the first rows as
 * they will land and how many cells won't fit, then import. The file is read
 * here by the contact import's own reader; the server maps it again and
 * writes it as ONE batch, so one Undo takes it all back.
 */
import { useMemo, useState } from 'react'
import { FileUp } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { CUSTOM_FIELD_TYPES, CUSTOM_FIELD_TYPE_LABELS, formatFieldValue, type CustomFieldType } from '@/lib/crm/custom-field-types'
import { guessColumnType, IMPORT_MAX_BYTES, IMPORT_MAX_ROWS, importable, importOps, planImport, type ImportSheet, type ImportTarget } from '@/lib/tables/csv'
import type { DataColumn } from '@/lib/tables/types'
import { fieldClass } from './column-forms'

/** The types a file's new column may take (a person and a link need ids, not text). */
const NEW_TYPES = CUSTOM_FIELD_TYPES.filter((t) => t !== 'person' && t !== 'relation')
const PREVIEW_ROWS = 5

/** A target as one select value. */
const targetValue = (t: ImportTarget) => (t.kind === 'column' ? `column:${t.key}` : t.kind)

/** A file read into its header and rows, by the contact import's reader. */
export async function readSheet(file: File): Promise<{ ok: true; sheet: ImportSheet; truncated: boolean } | { ok: false; error: string }> {
  if (file.size > IMPORT_MAX_BYTES) return { ok: false, error: `That file is over ${Math.round(IMPORT_MAX_BYTES / 1024 / 1024)} MB. Split it and import each part.` }
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'xls') return { ok: false, error: 'That is the old Excel format (.xls). Save it as .xlsx or CSV and pick it again.' }
  if (!['csv', 'tsv', 'txt', 'xlsx', ''].includes(ext)) return { ok: false, error: 'Pick a CSV, TSV or Excel (.xlsx) file.' }
  try {
    const [{ parseCsv, readXlsx }, { decodeText }] = await Promise.all([import('@/lib/crm/import/sources/spreadsheet'), import('@/lib/crm/import/file')])
    const bytes = new Uint8Array(await file.arrayBuffer())
    const sheet = ext === 'xlsx' ? await readXlsx(bytes) : parseCsv(decodeText(bytes), ext === 'tsv' ? '\t' : undefined)
    if (!sheet.headers.length || !sheet.rows.length) return { ok: false, error: 'That file has no rows under its header.' }
    return { ok: true, sheet: { headers: sheet.headers, rows: sheet.rows.slice(0, IMPORT_MAX_ROWS) }, truncated: !!sheet.truncated || sheet.rows.length > IMPORT_MAX_ROWS }
  } catch (err) {
    return { ok: false, error: `That file could not be read: ${err instanceof Error ? err.message : String(err)}` }
  }
}

export function ImportDialog({
  tableId,
  columns,
  onClose,
  onImported,
  initial,
}: {
  tableId: string
  columns: readonly DataColumn[]
  onClose: () => void
  /** The import landed: its change, for an Undo. */
  onImported: (changeId: string | null, rows: number) => void
  /** A file already read (a test, a screenshot). */
  initial?: { name: string; sheet: ImportSheet; truncated?: boolean }
}) {
  const [file, setFile] = useState<{ name: string; sheet: ImportSheet; truncated: boolean } | null>(initial ? { truncated: false, ...initial } : null)
  const [targets, setTargets] = useState<ImportTarget[]>(() => (initial ? planImport(initial.sheet, columns) : []))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const fillable = useMemo(() => columns.filter(importable), [columns])

  const pick = async (f: File | undefined) => {
    if (!f) return
    setError(null)
    const read = await readSheet(f)
    if (!read.ok) return setError(read.error)
    setFile({ name: f.name, sheet: read.sheet, truncated: read.truncated })
    setTargets(planImport(read.sheet, columns))
  }

  // What the import will do: the first rows as they land, and the cells that won't fit.
  const preview = useMemo(() => {
    if (!file) return null
    const planned = importOps(file.sheet, targets, columns.map((c) => ({ ...c })), { newId: () => 'preview' })
    return planned
  }, [file, targets, columns])

  const setTarget = (i: number, t: ImportTarget) => setTargets((prev) => prev.map((x, j) => (j === i ? t : x)))

  const submit = async () => {
    if (!file || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/account/tables/${encodeURIComponent(tableId)}/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_name: file.name, headers: file.sheet.headers, rows: file.sheet.rows, targets }),
      })
      const json = (await res.json().catch(() => ({}))) as { error?: string; change_id?: string | null; rows?: number }
      if (!res.ok) throw new Error(json.error || 'Could not import the file')
      onImported(json.change_id ?? null, json.rows ?? 0)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not import the file')
      setBusy(false)
    }
  }

  const ops = preview?.ok ? preview.plan.ops : []
  const firstRows = ops.flatMap((o) => (o.op === 'insert_rows' ? o.rows : [])).slice(0, PREVIEW_ROWS)
  const newCols = ops.filter((o) => o.op === 'create_column')
  const shownCols = preview?.ok ? preview.plan.columns : []

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle>Import a spreadsheet</DialogTitle>
          <DialogDescription>
            A CSV or Excel file, up to {IMPORT_MAX_ROWS.toLocaleString()} rows. Each row becomes a row of the table, as one change you can undo.
          </DialogDescription>
        </DialogHeader>
        {!file ? (
          <label className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground hover:bg-muted/30">
            <FileUp className="h-6 w-6" aria-hidden />
            <span>Pick a file to import</span>
            <input type="file" accept=".csv,.tsv,.txt,.xlsx,text/csv" className="sr-only" onChange={(e) => void pick(e.target.files?.[0])} />
          </label>
        ) : (
          <div className="min-w-0 space-y-4">
            <p className="text-sm text-foreground">
              <span className="font-medium">{file.name}</span>
              <span className="text-muted-foreground"> · {file.sheet.rows.length.toLocaleString()} rows, {file.sheet.headers.length} columns</span>
              {file.truncated && <span className="text-muted-foreground"> · only the first {IMPORT_MAX_ROWS.toLocaleString()} rows</span>}
            </p>
            <div className="overflow-hidden rounded-lg border border-border">
              <table className="w-full table-fixed text-sm" data-import-mapping="">
                <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">In the file</th>
                    <th className="px-3 py-2 font-medium">Goes to</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {file.sheet.headers.map((h, i) => {
                    const t = targets[i] ?? { kind: 'skip' }
                    const sample = file.sheet.rows.find((r) => (r[i] ?? '').trim())?.[i] ?? ''
                    return (
                      <tr key={i}>
                        <td className="w-[45%] px-3 py-2 align-top">
                          <span className="block truncate font-medium text-foreground">{h}</span>
                          {sample && <span className="block truncate text-xs text-muted-foreground">e.g. {sample}</span>}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex gap-2">
                            <select
                              aria-label={`Where ${h} goes`}
                              className={cn(fieldClass, 'cursor-pointer')}
                              value={targetValue(t)}
                              onChange={(e) => {
                                const v = e.target.value
                                if (v === 'title' || v === 'skip') setTarget(i, { kind: v })
                                else if (v.startsWith('column:')) setTarget(i, { kind: 'column', key: v.slice('column:'.length) })
                                else setTarget(i, { kind: 'new', label: h.trim().slice(0, 60) || `Column ${i + 1}`, ...guessColumnType(h, file.sheet.rows.slice(0, 500).map((r) => r[i] ?? '')) })
                              }}
                            >
                              <option value="title">The row’s name</option>
                              {fillable.map((c) => (
                                <option key={c.key} value={`column:${c.key}`}>{c.label}</option>
                              ))}
                              <option value="new">A new column</option>
                              <option value="skip">Don’t import</option>
                            </select>
                            {t.kind === 'new' && (
                              <select
                                aria-label={`Type of ${h}`}
                                className={cn(fieldClass, 'w-36 shrink-0 cursor-pointer')}
                                value={t.field_type}
                                onChange={(e) => {
                                  const field_type = e.target.value as CustomFieldType
                                  const options = field_type === 'select' || field_type === 'multi_select' ? [...new Set(file.sheet.rows.flatMap((r) => (field_type === 'multi_select' ? (r[i] ?? '').split(',') : [r[i] ?? ''])).map((x) => x.trim()).filter(Boolean))].slice(0, 50) : undefined
                                  setTarget(i, { kind: 'new', label: t.label, field_type, ...(options ? { options } : {}) })
                                }}
                              >
                                {NEW_TYPES.map((x) => (
                                  <option key={x} value={x}>{CUSTOM_FIELD_TYPE_LABELS[x]}</option>
                                ))}
                              </select>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {preview && !preview.ok && <p className="text-sm text-destructive">{preview.error}</p>}
            {preview?.ok && (
              <div className="min-w-0 space-y-2">
                <p className="text-xs font-medium text-muted-foreground">The first rows, as they’ll land</p>
                <div className="overflow-x-auto rounded-lg border border-border">
                  <table className="w-full text-sm" data-import-preview="">
                    <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                      <tr>
                        <th className="whitespace-nowrap px-3 py-1.5 font-medium">Name</th>
                        {shownCols.map((c) => (
                          <th key={c.key} className="whitespace-nowrap px-3 py-1.5 font-medium">{c.label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {firstRows.map((r, n) => (
                        <tr key={n}>
                          <td className="max-w-[200px] truncate px-3 py-1.5 font-medium">{r.title || <span className="text-muted-foreground">Untitled</span>}</td>
                          {shownCols.map((c) => (
                            <td key={c.key} className={cn('max-w-[180px] truncate px-3 py-1.5', (c.field_type === 'number' || c.field_type === 'currency') && 'text-right tabular-nums')}>
                              {formatFieldValue(c.field_type, r.values?.[c.key] ?? null)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-xs text-muted-foreground">
                  {preview.plan.rows.toLocaleString()} {preview.plan.rows === 1 ? 'row' : 'rows'}
                  {newCols.length > 0 && `, ${newCols.length} new ${newCols.length === 1 ? 'column' : 'columns'}`}.
                  {preview.plan.misfits.map((m) => ` ${m.count.toLocaleString()} ${m.count === 1 ? 'cell in' : 'cells in'} ${m.header} ${m.count === 1 ? 'doesn’t fit and stays' : 'don’t fit and stay'} empty (like “${m.example}”).`).join('')}
                </p>
              </div>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" disabled={!file || busy || !preview?.ok} onClick={() => void submit()}>
            {busy ? 'Importing…' : preview?.ok ? `Import ${preview.plan.rows.toLocaleString()} ${preview.plan.rows === 1 ? 'row' : 'rows'}` : 'Import'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Toast for a landed import, with its Undo. */
export function importedToast(rows: number, undo?: () => void) {
  toast(`Imported ${rows.toLocaleString()} ${rows === 1 ? 'row' : 'rows'}`, undo ? { action: { label: 'Undo', onClick: undo } } : undefined)
}
