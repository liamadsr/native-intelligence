import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, notFound } from '@/lib/api-errors'
import { isUuid, undoDealEvent } from '@/lib/crm/deals'

/** POST { event_id? }: take back one change to a deal (default: its latest). */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const { id } = await params
  if (!isUuid(id)) return notFound('Deal not found')
  const body = (await request.json().catch(() => ({}))) as { event_id?: unknown }
  const eventId = typeof body?.event_id === 'string' ? body.event_id : undefined
  const result = await undoDealEvent(supabase, workspaceId, { dealId: id, eventId }, { userId: user.id, source: 'person' })
  if (!result.ok) return result.error === 'Deal not found' ? notFound(result.error) : badRequest(result.error)
  return NextResponse.json({ deal: result.deal, restored: result.restored, kept: result.kept })
}
