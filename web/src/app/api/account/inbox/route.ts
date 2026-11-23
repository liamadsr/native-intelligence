/**
 * GET /api/account/inbox (docs/plans/channels-inbox.md, phase 2)
 *   → { items, held, mail } what needs the person, in one list: their own
 *     notifications (Signal channels' messages, DMs, mentions, assignments,
 *     comments, shares, reminders, work that needs them), one item per
 *     conversation, and their mail that needs a reply or is important; `held`
 *     is what they put off (inbox_hold, migration 702), soonest back first;
 *     `mail` the mail rows, for the page to read their subjects live.
 * Read as the person, under RLS (src/lib/inbox/read.ts says what each read
 * is fenced to).
 */
import { NextResponse } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { serverError } from '@/lib/api-errors'
import { readInbox } from '@/lib/inbox/read'

export async function GET() {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  try {
    const inbox = await readInbox(auth.supabase, { userId: auth.user.id, workspaceId: auth.workspaceId, memberId: auth.member.id })
    return NextResponse.json(inbox)
  } catch (err) {
    console.error('[inbox] read failed:', err instanceof Error ? err.message : 'unknown')
    return serverError()
  }
}
