/**
 * POST /api/account/inbox/hold (docs/plans/channels-inbox.md, phase 2;
 * migration 702)
 *   { item_key, until: ISO time | null } → { held_until } put an inbox item
 *   off until then (in the future, 90 days at most), or bring it back now
 *   (null). It comes back by itself at that time, or sooner when something
 *   new arrives in it. The person's own row only (inbox_hold's RLS); a row
 *   holds the item's key and two times, nothing an item says.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { holdUntilError, isInboxItemKey } from '@/lib/inbox/items'

export async function POST(request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  let input: Record<string, unknown>
  try {
    input = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }
  if (!isInboxItemKey(input.item_key)) return badRequest('item_key must be an inbox item')
  const until = input.until ?? null
  if (until !== null) {
    const why = holdUntilError(until)
    if (why) return badRequest(why)
  }
  const key = { user_id: auth.user.id, workspace_id: auth.workspaceId, item_key: input.item_key }
  if (until === null) {
    const { error } = await auth.supabase.from('inbox_hold').delete().eq('user_id', key.user_id).eq('workspace_id', key.workspace_id).eq('item_key', key.item_key)
    if (error) {
      console.error('[inbox] hold clear failed:', error.message)
      return serverError()
    }
    return NextResponse.json({ held_until: null })
  }
  const held_until = new Date(until as string).toISOString()
  const { error } = await auth.supabase
    .from('inbox_hold')
    .upsert({ ...key, held_until, held_at: new Date().toISOString() }, { onConflict: 'user_id,workspace_id,item_key' })
  if (error) {
    console.error('[inbox] hold failed:', error.message)
    return serverError()
  }
  return NextResponse.json({ held_until })
}
