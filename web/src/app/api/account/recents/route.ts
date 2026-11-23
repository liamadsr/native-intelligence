/**
 * GET /api/account/recents — Recent's direct reads (src/lib/entities/recents.ts;
 * docs/plans/recent-panel.md): what the person did themselves to records the
 * activity log doesn't hold (their Drive uploads, their coding jobs), each
 * from its own table on the session client. The home panel merges this with
 * the feed's Inbox and actor=me lists (GET /api/account/feed).
 *
 * `{ entries, workspace_id }`, newest first. A source that fails is left out.
 */
import { NextResponse } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { loadRecentSources } from '@/lib/entities/recents'

export async function GET() {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId, member } = auth
  const entries = await loadRecentSources(supabase, { workspaceId, userId: user.id, memberId: member.id })
  entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  return NextResponse.json({ entries, workspace_id: workspaceId })
}
