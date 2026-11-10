import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { notFound, serverError } from '@/lib/api-errors'
import { isUuid } from '@/lib/tables/ops'
import { listChanges } from '@/lib/tables/store'

/** GET ?limit=: the table's write history, newest first (what Undo takes back). */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth
  const { id } = await params
  if (!isUuid(id)) return notFound('Table not found')
  try {
    const changes = await listChanges(supabase, workspaceId, id, Number(request.nextUrl.searchParams.get('limit')) || 50)
    return NextResponse.json({ changes })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not load the history')
  }
}
