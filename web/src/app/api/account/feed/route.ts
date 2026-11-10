/**
 * GET /api/account/feed — the one cross-kind list (the shared entity layer,
 * phase 4): what happened to the workspace's records, from the activity log
 * (entity_activity, migration 488), for every kind the registry marks
 * `activity`.
 *
 * The filter is the shared shape in src/lib/entities/feed-model.ts: kinds,
 * assigned_to=me, mentioned=me (both: either, the Inbox), linked_to=type:id,
 * actor=me|agent|<member>, entity=type:id (one record's History), since,
 * cursor, group=entity|none, limit.
 *
 * `{ entries, next_cursor }` grouped (one per record, its newest event), or
 * `{ events, next_cursor }` with group=none. Reads on the session client, and
 * src/lib/entities/feed.ts re-applies each private kind's visibility before
 * anything is answered: a row about a record the viewer can't read is never
 * in it.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { parseFeedQuery } from '@/lib/entities/feed-model'
import { loadFeed } from '@/lib/entities/feed'

export async function GET(request: NextRequest) {
  const filter = parseFeedQuery(request.nextUrl.searchParams)
  if ('error' in filter) return badRequest(filter.error)

  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId, member } = auth

  const feed = await loadFeed(supabase, { workspaceId, userId: user.id, memberId: member.id }, filter)
  if ('error' in feed) {
    console.error('[feed] read failed:', feed.error)
    return serverError('Could not read the activity')
  }
  return NextResponse.json({ ...feed, workspace_id: workspaceId })
}
