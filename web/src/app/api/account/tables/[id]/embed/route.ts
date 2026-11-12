import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { notFound, serverError } from '@/lib/api-errors'
import { fieldValueLabels } from '@/lib/crm/custom-field-references'
import { EMBED_ROWS } from '@/lib/tables/embed'
import { isUuid } from '@/lib/tables/ops'
import { getTable, queryRows } from '@/lib/tables/store'
import { readTableSettings, viewColumns } from '@/lib/tables/views'
import type { DataColumn } from '@/lib/tables/types'
import type { SortConfig, ViewFilter } from '@/lib/views/types'

type EmbedView = { id: string; name: string; layout: string; filters: ViewFilter[] | null; ordering: SortConfig[] | null; display_properties: string[] | null; metadata: unknown }

/**
 * GET ?view=<id>&time_zone=: what a doc's table embed shows, for the reader:
 * the table's name, the view's name and layout, its shown columns and its
 * first EMBED_ROWS rows (filtered and sorted as the view says, formulas and
 * rollups worked out for this reader), and whether there are more. A table
 * the reader can't open is a 404 (`locked`): the embed shows a placeholder,
 * never the table's name. A view of another table, or one gone, falls back
 * to the table's own order.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId, user } = auth
  const { id } = await params
  if (!isUuid(id)) return notFound('Table not found')
  const p = request.nextUrl.searchParams
  const viewId = p.get('view')
  const zone = p.get('time_zone')
  const timeZone = zone && zone.length <= 64 ? zone : undefined
  try {
    const table = await getTable(supabase, workspaceId, id)
    if (!table || table.archived_at) return NextResponse.json({ error: 'Table not found', locked: true }, { status: 404 })
    let view: EmbedView | null = null
    if (viewId && isUuid(viewId)) {
      // A table's views are read under the table's own access (602).
      const { data } = await supabase
        .from('view')
        .select('id, name, layout, filters, ordering, display_properties, metadata')
        .eq('workspace_id', workspaceId)
        .eq('scope_type', 'data_table')
        .eq('scope_id', id)
        .eq('id', viewId)
        .maybeSingle()
      view = (data as EmbedView | null) ?? null
    }
    const shown = viewColumns(table.columns, view?.display_properties ?? [], readTableSettings(view?.metadata)?.hidden ?? [])
    const page = await queryRows(supabase, workspaceId, id, table.columns, {
      filters: Array.isArray(view?.filters) ? view.filters : [],
      ordering: Array.isArray(view?.ordering) ? view.ordering : [],
      limit: EMBED_ROWS,
      userId: user.id,
      timeZone,
      computed: { workspaceId, userId: user.id, timeZone },
    })
    const named = shown.filter((c): c is DataColumn & { field_type: 'person' | 'relation' } => c.field_type === 'person' || c.field_type === 'relation')
    const labels = named.length && page.rows.length ? await fieldValueLabels(supabase, workspaceId, named, page.rows.map((r) => r.custom_fields)) : {}
    return NextResponse.json({
      table: { id: table.id, name: table.name, icon: table.icon, visibility: table.visibility },
      view: view ? { id: view.id, name: view.name, layout: view.layout } : null,
      columns: shown,
      rows: page.rows,
      has_more: page.hasMore,
      labels,
    })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not read the table')
  }
}
