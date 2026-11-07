import { inngest } from '@/lib/inngest/client'
import { scrubMailFromMessage } from '@/lib/chat/mail-tool-scrub'
import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * POST /api/account/chat-history: create a conversation row with its first
 * messages (use-chat-auto-save's create).
 *
 * There is no list: the main chat is the person's one home thread
 * (docs/plans/one-chat.md, Slice 1), so the history popover and its GET went.
 * One conversation is read, renamed or answered at [id], the home thread is got
 * or created at /home, and a live meeting's at /live.
 */
export async function POST(request: NextRequest) {
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

  const { title, messages } = await request.json()

  if (!messages?.length) {
    return NextResponse.json({ error: 'Messages required' }, { status: 400 })
  }

  const { data: conv, error: convError } = await supabase
    .from('chat_conversations')
    .insert({
      user_id: user.id,
      workspace_id: workspaceId,
      title: title || 'New conversation',
    })
    .select('id')
    .single()

  if (convError || !conv) {
    return NextResponse.json(
      { error: convError?.message || 'Failed to create conversation' },
      { status: 500 },
    )
  }

  const rows = messages.map((m: { role: string }) => ({
    conversation_id: conv.id,
    user_id: user.id,
    workspace_id: workspaceId,
    role: m.role,
    // No stored mail: a mail tool's output is kept as a pointer.
    ui_message: scrubMailFromMessage(m),
  }))

  const { error: msgError } = await supabase.from('chat_messages').insert(rows)

  if (msgError) {
    return NextResponse.json({ error: msgError.message }, { status: 500 })
  }

  // Knowledge: signal conversation activity. The debounced ingest function
  // extracts claims once the chat goes quiet — see conversation-ingest.ts.
  // (This route only ever CREATES ordinary chats — it never sets
  // ai_team_member_id — so a teammate thread can't reach this signal here.)
  try {
    await inngest.send({
      name: 'conversation/activity',
      data: { workspaceId, userId: user.id, conversationId: conv.id },
    })
  } catch {
    // Knowledge extraction is best-effort; never fail the save for it.
  }

  return NextResponse.json({ conversationId: conv.id })
}
