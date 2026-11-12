import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { notFound, serverError } from '@/lib/api-errors'
import { isUuid } from '@/lib/tables/ops'
import { listChanges } from '@/lib/tables/store'

/**
 * GET ?limit=: the table's write history, newest first (what Undo takes back).
 * ?after_version=N: only the changes after N, oldest first (the grid catching up).
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth
  const { id } = await params
  if (!isUuid(id)) return notFound('Table not found')
  const p = request.nextUrl.searchParams
  const after = p.get('after_version')
  const afterVersion = after !== null && /^\d+$/.test(after) ? Number(after) : undefined
  try {
    // A type change's every-row values stay on the server: the history shows their count.
    const changes = await listChanges(supabase, workspaceId, id, Number(p.get('limit')) || 50, { summary: true, ...(afterVersion !== undefined ? { afterVersion } : {}) })
    return NextResponse.json({ changes })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not load the history')
  }
}
