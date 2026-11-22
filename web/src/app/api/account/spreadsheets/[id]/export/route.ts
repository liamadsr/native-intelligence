import { type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { ensureEngine, loadModel } from '@/lib/spreadsheets/engine-server'
import { getSpreadsheet } from '@/lib/spreadsheets/store'
import { listSheets } from '@/lib/spreadsheets/workbook'
import { workbookToXlsx } from '@/lib/spreadsheets/xlsx-write'
import { sheetToCsv } from '@/lib/spreadsheets/csv'

export const runtime = 'nodejs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/** A title as a safe download filename stem: the usual characters kept, the rest an underscore. */
function safeStem(title: string): string {
  const cleaned = title.replace(/[^\w.\- ]+/g, '_').replace(/\s+/g, ' ').trim()
  return (cleaned || 'spreadsheet').slice(0, 120)
}

function disposition(stem: string, ext: string): string {
  const name = `${stem}.${ext}`
  // A plain ASCII name for old clients, and the real (possibly non-ASCII) one per RFC 5987.
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

/**
 * GET: the spreadsheet as a download. `?format=xlsx` (the default) sends the
 * whole workbook; `?format=csv&sheet=<index>` sends one sheet's values. The
 * editor downloads the open workbook itself; this is for agents and links, so
 * it exports what the server has stored.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth
  const { id } = await params
  if (!UUID.test(id)) return notFound('Spreadsheet not found.')

  const format = (request.nextUrl.searchParams.get('format') ?? 'xlsx').toLowerCase()
  if (format !== 'xlsx' && format !== 'csv') return badRequest('Export as xlsx or csv.')

  try {
    const spreadsheet = await getSpreadsheet(supabase, workspaceId, id)
    if (!spreadsheet) return notFound('Spreadsheet not found.')
    ensureEngine()
    const model = loadModel(spreadsheet.workbook, spreadsheet.title)
    try {
      const stem = safeStem(spreadsheet.title)
      if (format === 'csv') {
        const sheets = listSheets(model)
        const raw = Number(request.nextUrl.searchParams.get('sheet') ?? '0')
        const index = Number.isInteger(raw) && raw >= 0 && raw < sheets.length ? raw : -1
        if (index < 0) return badRequest('That sheet does not exist.')
        const csv = sheetToCsv(model, index)
        return new Response(`﻿${csv}`, {
          headers: {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': disposition(sheets.length > 1 ? `${stem} - ${sheets[index].name}` : stem, 'csv'),
            'Cache-Control': 'no-store',
          },
        })
      }
      const bytes = await workbookToXlsx(model)
      return new Response(new Uint8Array(bytes), {
        headers: {
          'Content-Type': XLSX_TYPE,
          'Content-Disposition': disposition(stem, 'xlsx'),
          'Cache-Control': 'no-store',
        },
      })
    } finally {
      model.free()
    }
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not export the spreadsheet')
  }
}
