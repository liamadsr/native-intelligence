/**
 * POST /api/account/inbox/notifications (docs/plans/channels-inbox.md, phase 2)
 *   { ids: uuid[], action: 'done' | 'undone' | 'read' } → { updated }
 *   done: archived (is_archived, the notification's own "done": its banner
 *   comes down everywhere); undone: back (the toast's Undo); read: read
 *   (opening an item). At most 200 ids, the person's own only: every write
 *   is fenced on their member id in this workspace, as the notification
 *   PATCH route's is.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { isUuid } from '@/lib/team-chat/types'

const MAX_IDS = 200

export async function POST(request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  let input: Record<string, unknown>
  try {
    input = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }
  const action = input.action
  if (action !== 'done' && action !== 'undone' && action !== 'read') return badRequest('action must be done, undone or read')
  if (!Array.isArray(input.ids) || input.ids.length === 0 || input.ids.length > MAX_IDS || !input.ids.every(isUuid)) {
    return badRequest(`ids must be 1 to ${MAX_IDS} notification ids`)
  }
  const ids = [...new Set(input.ids as string[])]
  const now = new Date().toISOString()
  const patch =
    action === 'done' ? { is_archived: true } : action === 'undone' ? { is_archived: false } : { is_read: true, read_at: now }
  let query = auth.supabase.from('notification').update(patch).in('id', ids).eq('recipient_id', auth.member.id).eq('workspace_id', auth.workspaceId)
  // Reading never re-dates a notification already read.
  if (action === 'read') query = query.eq('is_read', false)
  const { data, error } = await query.select('id')
  if (error) {
    console.error('[inbox] notifications update failed:', error.message)
    return serverError()
  }
  return NextResponse.json({ updated: (data ?? []).length })
}
