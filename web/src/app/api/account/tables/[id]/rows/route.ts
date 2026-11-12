import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { fieldValueLabels } from '@/lib/crm/custom-field-references'
import { isUuid } from '@/lib/tables/ops'
import { listColumns, listRows, queryRows } from '@/lib/tables/store'
import type { DataColumn, DataRow } from '@/lib/tables/types'
import type { SortConfig, ViewFilter } from '@/lib/views/types'
import type { SupabaseClient } from '@supabase/supabase-js'

/** The most filters and sorts one view sends. */
const MAX_FILTERS = 50
const MAX_SORTS = 5

/**
 * GET ?offset=&limit=&archived=1: a page of the table's rows, in order.
 * ?ids=a,b: those rows (the grid reads a teammate's new or moved rows).
 * `labels` names the people and linked records the page's values hold, read
 * through the caller's RLS: one read for the members, one per linked kind.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth
  const { id } = await params
  if (!isUuid(id)) return notFound('Table not found')
  const p = request.nextUrl.searchParams
  const ids = p.get('ids')
  try {
    const [page, columns] = await Promise.all([
      listRows(supabase, workspaceId, id, {
        offset: Number(p.get('offset')) || 0,
        limit: Number(p.get('limit')) || 100,
        archived: p.get('archived') === '1',
        ...(ids !== null ? { ids: ids.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
      }),
      listColumns(supabase, workspaceId, id),
    ])
    return NextResponse.json({ rows: page.rows, has_more: page.hasMore, labels: await labelsFor(supabase, workspaceId, columns, page.rows) })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not load rows')
  }
}

/**
 * POST { filters, ordering, offset, limit, time_zone }: a page of the live rows as a
 * view asks for them, filtered and sorted on the server (queryRows), with
 * the same `labels` as GET.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId, user } = auth
  const { id } = await params
  if (!isUuid(id)) return notFound('Table not found')
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') return badRequest('Send the view as JSON')
  const filters = Array.isArray(body.filters) ? body.filters.filter(isFilter) : []
  const ordering = Array.isArray(body.ordering) ? body.ordering.filter(isSort) : []
  if (filters.length > MAX_FILTERS) return badRequest(`A view takes at most ${MAX_FILTERS} filters`)
  if (ordering.length > MAX_SORTS) return badRequest(`A view takes at most ${MAX_SORTS} sorts`)
  try {
    const columns = await listColumns(supabase, workspaceId, id)
    const page = await queryRows(supabase, workspaceId, id, columns, {
      filters,
      ordering,
      offset: Number(body.offset) || 0,
      limit: Number(body.limit) || 100,
      userId: user.id,
      ...(typeof body.time_zone === 'string' && body.time_zone.length <= 64 ? { timeZone: body.time_zone } : {}),
    })
    return NextResponse.json({ rows: page.rows, has_more: page.hasMore, labels: await labelsFor(supabase, workspaceId, columns, page.rows) })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not load rows')
  }
}

function labelsFor(db: SupabaseClient, workspaceId: string, columns: DataColumn[], rows: DataRow[]): Promise<Record<string, string>> | Record<string, string> {
  const named = columns.filter((c) => c.field_type === 'person' || c.field_type === 'relation')
  return named.length && rows.length ? fieldValueLabels(db, workspaceId, named, rows.map((r) => r.custom_fields)) : {}
}

function isFilter(v: unknown): v is ViewFilter {
  const f = v as Partial<ViewFilter> | null
  return !!f && typeof f === 'object' && typeof f.field === 'string' && typeof f.operator === 'string'
}

function isSort(v: unknown): v is SortConfig {
  const s = v as Partial<SortConfig> | null
  return !!s && typeof s === 'object' && typeof s.field === 'string' && (s.direction === 'asc' || s.direction === 'desc')
}
