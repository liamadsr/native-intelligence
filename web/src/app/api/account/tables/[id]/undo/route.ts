import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { undoChange } from '@/lib/tables/store'
import { tableRefusal } from '@/lib/tables/responses'

/** POST { change_id? }: take back one change to the table (default: its latest). */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const { id } = await params
  const body = (await request.json().catch(() => ({}))) as { change_id?: unknown }
  const changeId = typeof body?.change_id === 'string' ? body.change_id : null
  const result = await undoChange(supabase, workspaceId, id, changeId, { userId: user.id, source: 'person' })
  if (!result.ok) return tableRefusal(result)
  return NextResponse.json(result.value)
}
