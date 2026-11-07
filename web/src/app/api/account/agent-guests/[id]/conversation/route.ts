import { requireUser } from '@/lib/api-auth'
import { notFound, serverError } from '@/lib/api-errors'
import { readHistoryPage } from '@/lib/chat/history-page'
import { getGuest } from '@/lib/guests/store'
import { NextResponse, type NextRequest } from 'next/server'

type RouteContext = { params: Promise<{ id: string }> }

/** The newest messages the conversation card reads in one go. */
export const GUEST_CONVERSATION_PAGE = 200

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * GET: one guest's conversation with the agent the owner made for them (guest
 * access PR4), for the read-only conversation card in the owner's chat
 * (src/components/chat-cards/pages/guest-card.tsx): the guest, and their
 * thread's newest messages, oldest first, as the chat stores them (the
 * guest's texts are `user` messages, the agent's replies `assistant` ones).
 * `?before=<ui message id>` pages back.
 *
 * Only the guest's owner: the guest row and the thread are both read as them
 * (RLS, and owner_user_id / user_id here too). A guest who was removed still
 * shows what was said; one that isn't theirs, or never was, is a 404 either way.
 * Read-only: nothing here writes, and the thread has no session to talk in
 * (the eve-session mint refuses it, GUEST_CONVERSATION).
 */
export async function GET(request: NextRequest, { params }: RouteContext) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { supabase, user } = auth
  const { id } = await params
  if (!UUID_RE.test(id)) return notFound('No such person')

  let guest
  try {
    guest = await getGuest(supabase, user.id, id)
  } catch (err) {
    console.error('[agent-guests] guest read failed:', err instanceof Error ? err.message : err)
    return serverError('Could not read this person')
  }
  if (!guest) return notFound('No such person')

  const view = { id: guest.id, displayName: guest.displayName, preset: guest.preset, state: guest.state, channel: 'sms' as const }

  const { data: conv, error: convError } = await supabase
    .from('chat_conversations')
    .select('id')
    .eq('agent_guest_id', guest.id)
    .eq('user_id', user.id)
    .eq('workspace_id', guest.workspaceId)
    .maybeSingle<{ id: string }>()
  if (convError) {
    console.error('[agent-guests] conversation read failed:', convError.message)
    return serverError('Could not read the conversation')
  }
  // They haven't texted yet: no thread.
  if (!conv) return NextResponse.json({ guest: view, conversationId: null, messages: [], hasMore: false })

  const before = new URL(request.url).searchParams.get('before')
  try {
    const page = await readHistoryPage(supabase, {
      conversationId: conv.id,
      userId: user.id,
      workspaceId: guest.workspaceId,
      limit: GUEST_CONVERSATION_PAGE,
      before: before && before.length <= 512 ? before : null,
    })
    return NextResponse.json({ guest: view, conversationId: conv.id, messages: page.messages, hasMore: page.hasMore })
  } catch (err) {
    console.error('[agent-guests] messages read failed:', err instanceof Error ? err.message : err)
    return serverError('Could not read the conversation')
  }
}
