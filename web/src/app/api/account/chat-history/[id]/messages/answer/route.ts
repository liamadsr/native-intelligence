import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * PATCH /api/account/chat-history/[id]/messages/answer
 *
 * Flips a live-capture ask_user tool part to output-available with the user's
 * answer (live-agent → chat merge, WS-2b). Server-side mutation ONLY of the
 * targeted tool part (located by toolCallId) — it never accepts a client-
 * supplied ui_message blob, so a caller can't overwrite other parts, change the
 * role, or inject content. Scoped to the caller's own message in the named
 * conversation; a cross-conversation / cross-user id 404s.
 *
 * This is best-effort history truthing — the client already flips the part in
 * local state to dismiss the popover. It exists so a reload shows the answered
 * question, not a stale pending one.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const { tool_call_id, output } = (await request.json()) as {
    tool_call_id?: string
    output?: unknown
  }
  if (!tool_call_id || typeof tool_call_id !== 'string') {
    return NextResponse.json({ error: 'tool_call_id required' }, { status: 400 })
  }

  // Find the message carrying this tool part, scoped to the caller + conversation.
  const { data: rows } = await supabase
    .from('chat_messages')
    .select('id, ui_message')
    .eq('conversation_id', id)
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)
    .eq('role', 'assistant')

  type Part = { type?: string; toolCallId?: string; state?: string; output?: unknown }
  let targetRowId: string | null = null
  let nextUiMessage: Record<string, unknown> | null = null

  for (const row of rows ?? []) {
    const ui = row.ui_message as { parts?: Part[] } | null
    const parts = ui?.parts
    if (!Array.isArray(parts)) continue
    const idx = parts.findIndex(
      (p) => p.type === 'tool-ask_user' && p.toolCallId === tool_call_id,
    )
    if (idx === -1) continue
    // Mutate ONLY this part — nothing else in the message is touched.
    const nextParts = parts.map((p, i) =>
      i === idx ? { ...p, state: 'output-available', output: output ?? {} } : p,
    )
    targetRowId = row.id as string
    nextUiMessage = { ...(ui as Record<string, unknown>), parts: nextParts }
    break
  }

  if (!targetRowId || !nextUiMessage) {
    return NextResponse.json({ error: 'Question not found' }, { status: 404 })
  }

  // Count the affected rows: a missing UPDATE RLS policy (or any other reason
  // the row isn't visible/writable) makes the UPDATE a silent 0-row no-op with
  // NO error — which previously left the DB question input-available forever,
  // permanently tripping the one-pending-question guard. Treating 0 rows as a
  // failure surfaces that class instead of shipping green. (Migration 176 adds
  // the UPDATE policy so this path succeeds for the owner.)
  const { error, count } = await supabase
    .from('chat_messages')
    .update({ ui_message: nextUiMessage }, { count: 'exact' })
    .eq('id', targetRowId)
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!count) {
    return NextResponse.json(
      { error: 'Answer did not persist (0 rows updated)' },
      { status: 500 },
    )
  }
  return NextResponse.json({ ok: true })
}
