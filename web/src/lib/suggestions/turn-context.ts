import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * The chat's `suggestions` turn-context section: what the person did with the
 * suggestions this conversation staged since their last message, so the agent
 * knows without re-reading the board, and doesn't suggest a dismissed one
 * again (docs/plans/suggestions-everywhere.md, "Feedback loop in chat").
 *
 * Null when the conversation has no suggestions, or none resolved since the
 * last turn and none pending: the section is then left out.
 */
const LIST_LIMIT = 8

interface Row {
  display_text: string | null
  status: string
  resolved_at: string | null
  expire_reason: string | null
  extra: Record<string, unknown> | null
}

export function renderSuggestionUpdates(rows: Row[], since: number | null): string | null {
  const pending = rows.filter((r) => r.status === 'pending').length
  const fresh = rows.filter(
    (r) => r.status !== 'pending' && r.resolved_at && (since === null || Date.parse(r.resolved_at) > since),
  )
  if (fresh.length === 0 && pending === 0) return null

  const lines = ['## Your suggestions in this conversation']
  if (fresh.length > 0) {
    lines.push('Since the user\'s last message:')
    for (const r of fresh.slice(0, LIST_LIMIT)) {
      const reason = typeof r.extra?.dismiss_reason === 'string' ? ` ("${r.extra.dismiss_reason}")` : ''
      const verb =
        r.status === 'applied'
          ? 'applied'
          : r.status === 'dismissed'
            ? `dismissed${reason}`
            : r.expire_reason === 'already_true'
              ? 'already done another way'
              : 'expired'
      lines.push(`- ${verb}: ${r.display_text ?? '(untitled)'}`)
    }
    if (fresh.length > LIST_LIMIT) lines.push(`- …and ${fresh.length - LIST_LIMIT} more`)
  }
  if (pending > 0) lines.push(`${pending} still pending.`)
  lines.push("Don't suggest a dismissed change again unless the user asks.")
  return lines.join('\n')
}

export async function buildSuggestionUpdatesBlock(
  supabase: SupabaseClient,
  scope: { conversationId: string; userId: string },
): Promise<string | null> {
  const [turns, suggestions] = await Promise.all([
    supabase
      .from('chat_messages')
      .select('created_at')
      .eq('conversation_id', scope.conversationId)
      .eq('user_id', scope.userId)
      .eq('role', 'user')
      .order('created_at', { ascending: false })
      .limit(2),
    supabase
      .from('proposed_change')
      .select('display_text, status, resolved_at, expire_reason, extra')
      .eq('conversation_id', scope.conversationId)
      .order('created_at', { ascending: false })
      .limit(50),
  ])
  if (turns.error) throw new Error(turns.error.message)
  if (suggestions.error) throw new Error(suggestions.error.message)
  const rows = (suggestions.data ?? []) as Row[]
  if (rows.length === 0) return null

  // The latest user message is this turn's own; "since the last message" is
  // since the one before it.
  const times = ((turns.data ?? []) as Array<{ created_at: string }>)
    .map((r) => Date.parse(r.created_at))
    .filter(Number.isFinite)
    .sort((a, b) => b - a)
  const since = times.length >= 2 ? times[1] : null
  return renderSuggestionUpdates(rows, since)
}
