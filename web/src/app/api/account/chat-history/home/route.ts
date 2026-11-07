import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { resolveHomeConversation } from '@/lib/chat/home-message-writer'
import { NextResponse } from 'next/server'
import { HomeThreadUnavailableError } from '@/lib/chat/home-thread'

/**
 * POST /api/account/chat-history/home — get-or-create the member's durable
 * HOME THREAD (docs/plans/always-on-agent.md §2c, A3): the one conversation
 * per person per workspace every surface opens (`chat_conversations.is_home`,
 * migration 330), got or created race-safely (ensureHomeThread, through
 * src/lib/onboarding/home-conversation-pointer.ts, which checks the caller is
 * a member first). Answers { conversationId, created, workspaceId }.
 *
 * Called by the client home-thread helper (src/lib/chat/home-thread-client.ts:
 * the chat strip's home tab, voice asks and the other surfaces that open the
 * home thread), and by the onboarding adoption on FIRST LAND, to find the
 * conversation the signup researcher's brief was written into (or will be).
 * No usage gate and no token: a send mints through the eve-session route
 * (the ordinary mint with this id, or { action: 'mint', home: true }).
 *
 * Owner-only: the home conversation belongs to the member. It is created here
 * (empty) even before the researcher finishes so the client can subscribe and
 * the resync-on-SUBSCRIBED fetch / Realtime INSERT delivers the brief the
 * instant finish_research writes it — no polling.
 */
export async function POST() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) {
    return NextResponse.json({ error: 'No workspace' }, { status: 400 })
  }

  let resolved: Awaited<ReturnType<typeof resolveHomeConversation>>
  try {
    resolved = await resolveHomeConversation(supabase, { userId: user.id, workspaceId })
  } catch (err) {
    // A database without migration 330: no home thread here yet, never a 500.
    if (err instanceof HomeThreadUnavailableError) {
      return NextResponse.json({ error: 'Home threads are not available yet', code: 'HOME_THREAD_UNAVAILABLE' }, { status: 404 })
    }
    throw err
  }
  if (!resolved) {
    return NextResponse.json({ error: 'Failed to resolve home conversation' }, { status: 500 })
  }

  return NextResponse.json({
    conversationId: resolved.conversationId,
    created: resolved.created,
    // The workspace it is the home thread of (the client caches by it).
    workspaceId,
  })
}
