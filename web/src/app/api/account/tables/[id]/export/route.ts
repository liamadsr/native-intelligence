import { type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { fieldValueLabels } from '@/lib/crm/custom-field-references'
import { EXPORT_MAX_ROWS, exportCsv, exportFileName } from '@/lib/tables/csv'
import { isUuid } from '@/lib/tables/ops'
import { EXPORT_PAGE, getTable, queryRows } from '@/lib/tables/store'
import { viewColumns } from '@/lib/tables/views'
import type { DataColumn, DataRow } from '@/lib/tables/types'
import type { SortConfig, ViewFilter } from '@/lib/views/types'

const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/

/**
 * POST { filters, ordering, order, hidden, view_name, time_zone }: the view
 * as CSV, as the reader sees it: its filters and sorts (run on the server,
 * formulas and rollups worked out for them), its shown columns in its order,
 * each value as it reads (lib/tables/csv.ts). At most EXPORT_MAX_ROWS rows.
 * A view on a formula or a rollup of a table too big to run it on comes
 * without those filters and sorts, and says so (X-Computed-Skipped).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId, user } = auth
  const { id } = await params
  if (!isUuid(id)) return notFound('Table not found')
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') return badRequest('Send the view as JSON')
  const filters = (Array.isArray(body.filters) ? body.filters : []).filter(
    (f): f is ViewFilter => !!f && typeof f === 'object' && typeof (f as ViewFilter).field === 'string' && typeof (f as ViewFilter).operator === 'string',
  )
  const ordering = (Array.isArray(body.ordering) ? body.ordering : []).filter(
    (s): s is SortConfig => !!s && typeof s === 'object' && typeof (s as SortConfig).field === 'string' && ((s as SortConfig).direction === 'asc' || (s as SortConfig).direction === 'desc'),
  )
  if (filters.length > 50 || ordering.length > 5) return badRequest('A view takes at most 50 filters and 5 sorts')
  const keys = (v: unknown) => (Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string' && KEY_RE.test(k)) : [])
  const timeZone = typeof body.time_zone === 'string' && body.time_zone.length <= 64 ? body.time_zone : undefined
  try {
    const table = await getTable(supabase, workspaceId, id)
    if (!table) return notFound('Table not found')
    const shown = viewColumns(table.columns, keys(body.order), keys(body.hidden))
    const rows: DataRow[] = []
    const labels: Record<string, string> = {}
    let skipped = false
    const named = table.columns.filter((c): c is DataColumn & { field_type: 'person' | 'relation' } => c.field_type === 'person' || c.field_type === 'relation')
    for (let offset = 0; offset < EXPORT_MAX_ROWS; ) {
      const page = await queryRows(supabase, workspaceId, id, table.columns, {
        filters,
        ordering,
        offset,
        limit: Math.min(EXPORT_PAGE, EXPORT_MAX_ROWS - offset),
        pageCap: EXPORT_PAGE,
        userId: user.id,
        timeZone,
        computed: { workspaceId, userId: user.id, timeZone },
        // A view on a formula or a rollup runs once, whole.
        computedWhole: true,
      })
      if (page.computedSkipped) skipped = true
      rows.push(...page.rows)
      if (named.length && page.rows.length) Object.assign(labels, await fieldValueLabels(supabase, workspaceId, named, page.rows.map((r) => r.custom_fields)))
      offset += page.rows.length
      if (!page.hasMore || !page.rows.length) break
    }
    const name = exportFileName(table.name, typeof body.view_name === 'string' ? body.view_name.slice(0, 80) : null)
    // The byte-order mark: Excel then reads the file as UTF-8.
    return new Response(`\uFEFF${exportCsv(rows, shown, labels)}`, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${name.replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        'Cache-Control': 'no-store',
        // The page says the view's formula filters and sorts were left out (a table too big to run them on).
        ...(skipped ? { 'X-Computed-Skipped': '1' } : {}),
      },
    })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not export the view')
  }
}
