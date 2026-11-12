import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { notFound, serverError } from '@/lib/api-errors'
import { fieldValueLabels } from '@/lib/crm/custom-field-references'
import { isUuid } from '@/lib/tables/ops'
import { listColumns, listRows } from '@/lib/tables/store'

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
    const named = columns.filter((c) => c.field_type === 'person' || c.field_type === 'relation')
    const labels = named.length && page.rows.length ? await fieldValueLabels(supabase, workspaceId, named, page.rows.map((r) => r.custom_fields)) : {}
    return NextResponse.json({ rows: page.rows, has_more: page.hasMore, labels })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not load rows')
  }
}
