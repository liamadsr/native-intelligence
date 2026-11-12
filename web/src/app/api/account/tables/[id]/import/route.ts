import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { apiError, badRequest, notFound, serverError } from '@/lib/api-errors'
import { IMPORT_MAX_COLUMNS, IMPORT_MAX_ROWS, importOps, type ImportTarget } from '@/lib/tables/csv'
import { isUuid } from '@/lib/tables/ops'
import { applyOps, listColumns } from '@/lib/tables/store'
import { tableRefusal } from '@/lib/tables/responses'
import { isCustomFieldType } from '@/lib/crm/custom-field-types'

/** The longest cell read; the longest file name kept in the change's reason. */
const MAX_CELL = 2000
const MAX_NAME = 120
/**
 * The largest request: a file of IMPORT_MAX_BYTES (5 MB) grows a little as
 * JSON (quotes, commas, escapes). Read with this limit, never whole first.
 */
const MAX_IMPORT_BODY = 6 * 1024 * 1024
/** The most characters all the cells may hold together (a 5 MB file's worth). */
const MAX_CELL_CHARS = 5_500_000

const tooBig = () => apiError('That file is too big to import. Split it and import each part.', { status: 413, code: 'TOO_LARGE' })

/** The body as JSON, read up to `max` bytes: null when it is more, or not JSON. */
async function readCappedJson(request: NextRequest, max: number): Promise<{ ok: true; value: unknown } | { ok: false; tooBig: boolean }> {
  const reader = request.body?.getReader()
  if (!reader) return { ok: false, tooBig: false }
  const parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => {})
      return { ok: false, tooBig: true }
    }
    parts.push(value)
  }
  const bytes = new Uint8Array(size)
  let at = 0
  for (const p of parts) {
    bytes.set(p, at)
    at += p.byteLength
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) }
  } catch {
    return { ok: false, tooBig: false }
  }
}

/**
 * POST { file_name, headers, rows, targets }: a spreadsheet brought into the
 * table as ONE batch (source `import`), so one Undo takes it all back. The
 * file was read in the page (the contact import's reader); this checks its
 * size, maps it again on the server (lib/tables/csv.ts importOps) and writes
 * it through the one write path. At most IMPORT_MAX_ROWS rows, a request of
 * MAX_IMPORT_BODY bytes (413 past it, read with that limit, not whole) and
 * MAX_CELL_CHARS characters of cells.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const { id } = await params
  if (!isUuid(id)) return notFound('Table not found')
  if (Number(request.headers.get('content-length') ?? 0) > MAX_IMPORT_BODY) return tooBig()
  const read = await readCappedJson(request, MAX_IMPORT_BODY)
  if (!read.ok && read.tooBig) return tooBig()
  const body = (read.ok ? read.value : null) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') return badRequest('Send the file’s headers, rows and where each column goes.')
  const headers = Array.isArray(body.headers) ? body.headers.map((h) => String(h ?? '').slice(0, 120)) : null
  const rows = Array.isArray(body.rows) ? body.rows : null
  const targets = Array.isArray(body.targets) ? body.targets : null
  if (!headers || !rows || !targets) return badRequest('Send the file’s headers, rows and where each column goes.')
  if (headers.length > IMPORT_MAX_COLUMNS) return badRequest(`A file brings in at most ${IMPORT_MAX_COLUMNS} columns.`)
  if (rows.length > IMPORT_MAX_ROWS) return badRequest(`A file brings in at most ${IMPORT_MAX_ROWS.toLocaleString()} rows. Split it and import each part.`)
  const sheetRows: string[][] = []
  let chars = 0
  for (const r of rows) {
    if (!Array.isArray(r)) return badRequest('Each row is a list of cells.')
    const cells = r.slice(0, headers.length).map((c) => String(c ?? '').slice(0, MAX_CELL))
    for (const c of cells) chars += c.length
    if (chars > MAX_CELL_CHARS) return tooBig()
    sheetRows.push(cells)
  }
  const parsedTargets: ImportTarget[] = []
  for (const t of targets as Array<Record<string, unknown>>) {
    if (t?.kind === 'title' || t?.kind === 'skip') parsedTargets.push({ kind: t.kind })
    else if (t?.kind === 'column' && typeof t.key === 'string') parsedTargets.push({ kind: 'column', key: t.key })
    else if (t?.kind === 'new' && typeof t.label === 'string' && isCustomFieldType(t.field_type) && t.field_type !== 'relation' && t.field_type !== 'person') {
      parsedTargets.push({ kind: 'new', label: t.label, field_type: t.field_type, ...(Array.isArray(t.options) ? { options: t.options.map(String) } : {}) })
    } else return badRequest('Each column of the file goes to the name, a column, a new column, or nowhere.')
  }
  const fileName = typeof body.file_name === 'string' ? body.file_name.replace(/[\r\n]+/g, ' ').trim().slice(0, MAX_NAME) : ''
  try {
    const columns = await listColumns(supabase, workspaceId, id, { deleted: true })
    const wantsPeople = parsedTargets.some((t) => t.kind === 'column' && columns.find((c) => c.key === t.key)?.field_type === 'person')
    const members = wantsPeople ? await workspaceMembers(supabase, workspaceId) : []
    const planned = importOps({ headers, rows: sheetRows }, parsedTargets, columns, { members })
    if (!planned.ok) return badRequest(planned.error)
    const { plan } = planned
    const result = await applyOps(
      supabase,
      workspaceId,
      id,
      { baseVersion: null, ops: plan.ops },
      { userId: user.id, source: 'import', reason: `Imported ${plan.rows.toLocaleString()} ${plan.rows === 1 ? 'row' : 'rows'}${fileName ? ` from ${fileName}` : ''}` },
    )
    if (!result.ok) return tableRefusal(result)
    return NextResponse.json({ ...result.value, rows: plan.rows, over: plan.over, misfits: plan.misfits, held: plan.held })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not import the file')
  }
}

async function workspaceMembers(db: import('@supabase/supabase-js').SupabaseClient, workspaceId: string): Promise<Array<{ id: string; name: string }>> {
  const { data, error } = await db.from('member').select('id, display_name, role').eq('workspace_id', workspaceId)
  if (error) return []
  return ((data ?? []) as Array<{ id: string; display_name: string | null; role: string | null }>)
    .filter((m) => m.role !== 'guest')
    .map((m) => ({ id: m.id, name: m.display_name?.trim() || 'Member' }))
}
