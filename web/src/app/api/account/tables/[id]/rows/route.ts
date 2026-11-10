import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { notFound, serverError } from '@/lib/api-errors'
import { isUuid } from '@/lib/tables/ops'
import { listRows } from '@/lib/tables/store'

/** GET ?offset=&limit=&archived=1: a page of the table's rows, in order. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth
  const { id } = await params
  if (!isUuid(id)) return notFound('Table not found')
  const p = request.nextUrl.searchParams
  try {
    const page = await listRows(supabase, workspaceId, id, {
      offset: Number(p.get('offset')) || 0,
      limit: Number(p.get('limit')) || 100,
      archived: p.get('archived') === '1',
    })
    return NextResponse.json({ rows: page.rows, has_more: page.hasMore })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not load rows')
  }
}
