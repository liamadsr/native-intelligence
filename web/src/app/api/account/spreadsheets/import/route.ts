import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { MAX_COLUMNS, MAX_ROWS } from '@/lib/spreadsheets/a1'
import { ensureEngine, newModel } from '@/lib/spreadsheets/engine-server'
import { spreadsheetRefusal } from '@/lib/spreadsheets/responses'
import { createSpreadsheet } from '@/lib/spreadsheets/store'
import { saveWorkbook } from '@/lib/spreadsheets/workbook'
import { csvToRows } from '@/lib/spreadsheets/csv'
import { MAX_XLSX_BYTES, XlsxError } from '@/lib/spreadsheets/xlsx-shared'
import { xlsxToWorkbook } from '@/lib/spreadsheets/xlsx-read'

export const runtime = 'nodejs'

/** The most cells a CSV import lays down, so one huge file cannot build a workbook that will not store. */
const MAX_CSV_CELLS = 2_000_000

/** A new workbook (base64) from CSV rows placed at A1, truncated to the grid's limits. */
function workbookFromCsv(rows: string[][]): { workbook: string; warnings: string[] } {
  const warnings: string[] = []
  let height = rows.length
  if (height > MAX_ROWS) {
    height = MAX_ROWS
    warnings.push(`Only the first ${MAX_ROWS.toLocaleString('en-US')} rows were imported.`)
  }
  let width = rows.reduce((w, r) => Math.max(w, r.length), 0)
  if (width > MAX_COLUMNS) {
    width = MAX_COLUMNS
    warnings.push(`Only the first ${MAX_COLUMNS.toLocaleString('en-US')} columns were imported.`)
  }
  const model = newModel()
  try {
    model.pauseEvaluation()
    let cells = 0
    for (let r = 0; r < height && cells < MAX_CSV_CELLS; r++) {
      const row = rows[r]
      for (let c = 0; c < Math.min(row.length, width); c++) {
        const value = row[c]
        if (value === '') continue
        // A CSV field is data: a leading =,+,-,@ is not meant as a formula, so keep it as text.
        model.setUserInput(0, r + 1, c + 1, /^[=+\-@]/.test(value) ? `'${value}` : value)
        if (++cells >= MAX_CSV_CELLS) {
          warnings.push('The file was large; some cells were left out.')
          break
        }
      }
    }
    model.resumeEvaluation()
    model.evaluate()
    return { workbook: saveWorkbook(model), warnings }
  } finally {
    model.free()
  }
}

function stem(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/\s+/g, ' ').trim().slice(0, 300) || 'Imported spreadsheet'
}

/**
 * POST (multipart): a NEW spreadsheet from an uploaded .xlsx or .csv, in the
 * field `file`, with an optional `title`. Answers `{ spreadsheet, warnings }`:
 * what could not be carried over from an .xlsx is a warning, never a failure;
 * a file that is not a spreadsheet, or is too large, is a 400 with a sentence.
 */
export async function POST(request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId, member } = auth

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return badRequest('Send the file as multipart form data in a field named "file".')
  }
  const file = form.get('file')
  if (!(file instanceof File) && !(file instanceof Blob)) return badRequest('Attach the file in a field named "file".')
  const titleField = form.get('title')
  const fileName = file instanceof File ? file.name : ''
  const title = typeof titleField === 'string' && titleField.trim() ? titleField : stem(fileName || 'Imported spreadsheet')

  const bytes = new Uint8Array(await file.arrayBuffer())
  if (bytes.byteLength > MAX_XLSX_BYTES) return badRequest('This file is larger than 50 MB.')
  if (bytes.byteLength === 0) return badRequest('That file is empty.')

  // Decide xlsx vs csv by extension, then by the zip signature (an .xlsx is a zip starting "PK").
  const lower = fileName.toLowerCase()
  const type = (file instanceof File ? file.type : '') || ''
  const looksZip = bytes[0] === 0x50 && bytes[1] === 0x4b
  const isXlsx = lower.endsWith('.xlsx') || type.includes('spreadsheetml') || (!lower.endsWith('.csv') && !lower.endsWith('.tsv') && !lower.endsWith('.txt') && looksZip)

  try {
    ensureEngine()
    let workbook: string
    let warnings: string[]
    if (isXlsx) {
      const imported = await xlsxToWorkbook(bytes)
      workbook = imported.workbook
      warnings = imported.warnings
    } else {
      const text = new TextDecoder('utf-8').decode(bytes)
      const built = workbookFromCsv(csvToRows(text))
      workbook = built.workbook
      warnings = built.warnings
    }
    const made = await createSpreadsheet(supabase, { workspaceId, memberId: member.id, title, workbook, editSource: 'human' })
    if (!made.ok) return spreadsheetRefusal(made)
    return NextResponse.json({ spreadsheet: made.value, warnings }, { status: 201 })
  } catch (e) {
    if (e instanceof XlsxError) return badRequest(e.message)
    return serverError(e instanceof Error ? e.message : 'Could not import the file')
  }
}
