import { isAreaKey } from '@/lib/packs/registry'
import { scrubMailFromMessage } from '@/lib/chat/mail-tool-scrub'
import { inngest } from '@/lib/inngest/client'
import { createClient } from '@/lib/supabase/server'
import { parseHistoryPage, readHistoryPage } from '@/lib/chat/history-page'
import { withCreatedAt } from '@/lib/chat/message-time'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { NextResponse, type NextRequest } from 'next/server'

type RouteContext = { params: Promise<{ id: string }> }

/** Longest conversation name accepted. The client caps its own at 60; this is
 *  the server's bound on what a rename may store. */
const MAX_TITLE_CHARS = 120

/**
 * GET: the conversation's messages and its row's fields. With `?limit=N`
 * (`&before=<ui message id>`), only the newest N messages before that point,
 * oldest first, and `hasMore` (src/lib/chat/history-page.ts: a months-long
 * home thread loads a page at a time). Without `limit`, every message, as
 * before.
 */
export async function GET(request: NextRequest, { params }: RouteContext) {
  const { id } = await params
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

  const page = parseHistoryPage(request?.url ? new URL(request.url).searchParams : new URLSearchParams())
  let messages: unknown[]
  let hasMore = false
  if (page) {
    try {
      const read = await readHistoryPage(supabase, { conversationId: id, userId: user.id, workspaceId, ...page })
      messages = read.messages
      hasMore = read.hasMore
    } catch (err) {
      console.error('[chat-history] page read failed:', err instanceof Error ? err.message : err)
      return NextResponse.json({ error: 'Failed to load messages' }, { status: 500 })
    }
  } else {
    const { data, error } = await supabase
      .from('chat_messages')
      .select('ui_message, created_at')
      .eq('conversation_id', id)
      .eq('user_id', user.id)
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: true })

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    // Each message carries its row's time (message-time.ts): the chat's day lines.
    messages = data?.map((m) => withCreatedAt(m.ui_message, m.created_at)) || []
  }

  // The conversation's row, best-effort beside the thread, as it always was:
  // a failed read (or no row) still answers the messages, with these fields
  // null. So it says whether the row was read (`agentTeammateKnown`): the
  // client tells a conversation that isn't there from one it couldn't read.
  const { data: conv, error: convError } = await supabase
    .from('chat_conversations')
    .select('title, capture_id, recipe_id, focus_area, eve_session_id')
    .eq('id', id)
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (convError) console.error('[chat-history] conversation read failed:', convError.message)

  return NextResponse.json({
    messages,
    // Paged reads only: older messages remain before the first one answered.
    ...(page ? { hasMore } : {}),
    // The conversation's name — a tab is a chat, and the tab it loads into is
    // labelled with it. ('New conversation' is the column default: untitled.)
    title: conv?.title ?? null,
    // Live-capture conversation linkage (migration 173): a capture's
    // conversation is its live agent's, which the main chat never binds.
    captureId: conv?.capture_id ?? null,
    recipeId: conv?.recipe_id ?? null,
    // False when the conversation row couldn't be read (a failed read, or
    // none of yours here): the row's fields above then mean nothing.
    agentTeammateKnown: !convError && !!conv,
    // The area it is focused on (one-agent S3, migration 318): reopening it
    // carries on focused, the main agent with that area's pack. Null for none.
    // The eve session the conversation's row holds (A3: a window carrying the
    // home thread on re-attaches when another window replaced it). Null when
    // there is none, or the row couldn't be read.
    eveSessionId: (conv as { eve_session_id?: string | null } | null)?.eve_session_id ?? null,
    focusArea: isAreaKey((conv as { focus_area?: unknown } | null)?.focus_area) ? (conv as { focus_area: string }).focus_area : null,
  })
}

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  const { id } = await params
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

  const body = await request.json()
  const { messages } = body

  // An optional new NAME for the conversation (its tab's label): the one the
  // chat was given from its first message, or a rename. Validated here, not
  // trusted — it is shown back in every tab bar and history list.
  let title: string | undefined
  if (body.title !== undefined) {
    const t = typeof body.title === 'string' ? body.title.trim() : ''
    if (!t || t.length > MAX_TITLE_CHARS) {
      return NextResponse.json({ error: 'Invalid title' }, { status: 400 })
    }
    title = t
  }

  if (!messages?.length) {
    if (title === undefined) {
      return NextResponse.json({ error: 'Messages required' }, { status: 400 })
    }
    // A rename alone. Not activity: `updated_at` is left alone (history is
    // ordered by it, and naming a chat is not using it) and no knowledge
    // ingest is signalled — there is nothing new in the conversation.
    const { error: titleError } = await supabase
      .from('chat_conversations')
      .update({ title })
      .eq('id', id)
      .eq('user_id', user.id)
      .eq('workspace_id', workspaceId)
    if (titleError) {
      return NextResponse.json({ error: titleError.message }, { status: 500 })
    }
    return NextResponse.json({ ok: true })
  }

  const rows = messages.map((m: { role: string }) => ({
    conversation_id: id,
    user_id: user.id,
    workspace_id: workspaceId,
    role: m.role,
    // No stored mail: a mail tool's output is kept as a pointer.
    ui_message: scrubMailFromMessage(m),
  }))

  // Upsert on the message identity index (migration 173): a message the server
  // already wrote (live-capture agent posts arrive via Realtime, born-saved) or
  // a re-sent slice from an autosave race lands on the existing row instead of
  // duplicating the bubble on reload.
  const { error: msgError } = await supabase
    .from('chat_messages')
    .upsert(rows, { onConflict: 'conversation_id,ui_message_id', ignoreDuplicates: true })

  if (msgError) {
    return NextResponse.json({ error: msgError.message }, { status: 500 })
  }

  await supabase
    .from('chat_conversations')
    .update({
      updated_at: new Date().toISOString(),
      ...(title !== undefined ? { title } : {}),
    })
    .eq('id', id)
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)

  // Knowledge: signal conversation activity. The debounced ingest function
  // extracts claims once the chat goes quiet — see conversation-ingest.ts.
  //
  // Not for a teammate thread (bots v2, migration 300): a conversation with a
  // bot is a working conversation, never a source of facts. Read separately
  // from the save so the save never depends on it; no row (not the caller's)
  // or a failed read means "don't signal" — fail closed.
  const { data: conv } = await supabase
    .from('chat_conversations')
    .select('ai_team_member_id, agent_guest_id')
    .eq('id', id)
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)
    .maybeSingle<{ ai_team_member_id: string | null; agent_guest_id: string | null }>()
  // Nor a guest's thread (guest access): their words are never the owner's facts.
  if (conv && !conv.ai_team_member_id && !conv.agent_guest_id) {
    try {
      await inngest.send({
        name: 'conversation/activity',
        data: { workspaceId, userId: user.id, conversationId: id },
      })
    } catch {
      // Knowledge extraction is best-effort; never fail the save for it.
    }
  }

  return NextResponse.json({ ok: true })
}
