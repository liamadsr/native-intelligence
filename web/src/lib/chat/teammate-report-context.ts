/**
 * The "Teammate updates" turn-context section (bots v2, phase 7): what the
 * teammates this conversation delegated to reported since the model's last
 * turn, so it can answer "did the Writer finish?" and refer to the result.
 *
 * The reports themselves are chat_messages rows the work recorder appended
 * (src/lib/work/chat-report.ts). They are in the person's view of the chat but
 * not in eve's durable history, which grows only through the turns the client
 * sends. So each turn's context repeats the ones the model may not have seen.
 *
 * "Since your last turn": a turn's rows (the user's message and the reply) are
 * written when the turn ENDS, and nothing records when it started. A report
 * written while the previous turn ran is older than that turn's rows yet was
 * never shown to the model. So the window opens at the end of the turn before
 * the previous one (the second-newest user row), not at the previous turn's
 * end: no report is missed, and one the model already saw a turn ago can come
 * round once more. The chat-agent sends a section only when its text changed
 * (agents/chat-agent/lib/turn-context.ts), so an unchanged list is not resent.
 *
 * Scoped to the verified token's conversation, user and workspace; bounded to
 * the newest TEAMMATE_REPORT_CONTEXT_LIMIT reports. One round trip (three reads
 * at once), on the (conversation_id, created_at) indexes.
 *
 * In a home thread, a server-written turn (A4 slice 5, home-turn-server.ts)
 * may already have handed a report to the agent as a background update: that
 * message is in eve's history, so the section skips the reports such a turn
 * carried (home_turn.report_message_ids, status sent or done).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  TEAMMATE_REPORT_KIND,
  TEAMMATE_TEXT_NOTE,
  parseTeammateReport,
  teammateReportContextLine,
  type TeammateReport,
} from './teammate-report'
import { HOME_TURN_DELIVERED_STATUSES } from './home-turn'

/** The most reports one turn's section lists. */
export const TEAMMATE_REPORT_CONTEXT_LIMIT = 5

/** The section's heading. Pinned by tests. */
export const TEAMMATE_UPDATES_HEADING = '## Teammate updates'

interface ReportRow {
  created_at: string
  ui_message: { id?: unknown; metadata?: { teammate_report?: unknown } | null } | null
}

/**
 * The report message ids a home turn already delivered in this conversation
 * (A4 slice 5): a `home_turn` row eve took the message of (sent or done)
 * carried them into the agent's own history, so the section leaves them out.
 * Best-effort: a failed read (or a database without migration 333) leaves
 * every report in, as before.
 */
async function deliveredByHomeTurns(
  supabase: SupabaseClient,
  scope: { conversationId: string; userId: string },
): Promise<Set<string>> {
  try {
    const { data, error } = await supabase
      .from('home_turn')
      .select('report_message_ids')
      .eq('conversation_id', scope.conversationId)
      .eq('user_id', scope.userId)
      .in('status', [...HOME_TURN_DELIVERED_STATUSES])
      .order('created_at', { ascending: false })
      .limit(20)
    if (error) return new Set()
    const ids = new Set<string>()
    for (const row of (data ?? []) as Array<{ report_message_ids?: unknown }>) {
      if (Array.isArray(row.report_message_ids)) for (const id of row.report_message_ids) if (typeof id === 'string') ids.add(id)
    }
    return ids
  } catch {
    return new Set()
  }
}

/**
 * The section for these reports, oldest first, or null when there are none.
 * The lines are Dial8's template; every string a run wrote sits in a
 * `<teammate-text>` fence, and the section says that fenced text is data
 * (TEAMMATE_TEXT_NOTE): a run steered by untrusted content must not read here
 * as the person's approval.
 */
export function renderTeammateUpdatesBlock(reports: readonly TeammateReport[]): string | null {
  if (reports.length === 0) return null
  return [
    TEAMMATE_UPDATES_HEADING,
    'Since your last turn, teammates you delegated work to from this conversation reported back. ' +
      'Each report is shown to the person in this chat, but your history does not include it. ' +
      TEAMMATE_TEXT_NOTE,
    ...reports.map(teammateReportContextLine),
    // The main chat answers and approves only at the person's word (bots-v4 A2,
    // agents/chat-agent/instructions.md "Your bots"), right where a report lands.
    "Use this when the person asks about that work. Answer a teammate's question or approve its draft only when the person tells you to (send_work_answer, settle_work_item or settle_card); otherwise point them to that agent's page.",
  ].join('\n')
}

/**
 * The section for this turn: the conversation's reports written after the
 * second-newest user row (all of them while there are fewer than two), newest
 * TEAMMATE_REPORT_CONTEXT_LIMIT, listed oldest first. Throws on a failed read;
 * the prompt builder treats the layer as best-effort.
 */
export async function buildTeammateUpdatesBlock(
  supabase: SupabaseClient,
  scope: { conversationId: string; userId: string; workspaceId: string },
): Promise<string | null> {
  const messages = () => supabase.from('chat_messages')
  const [turns, reports, delivered] = await Promise.all([
    messages()
      .select('created_at')
      .eq('conversation_id', scope.conversationId)
      .eq('user_id', scope.userId)
      .eq('workspace_id', scope.workspaceId)
      .eq('role', 'user')
      .order('created_at', { ascending: false })
      .limit(2),
    messages()
      .select('created_at, ui_message')
      .eq('conversation_id', scope.conversationId)
      .eq('user_id', scope.userId)
      .eq('workspace_id', scope.workspaceId)
      .eq('role', 'assistant')
      .eq('ui_message->metadata->>kind', TEAMMATE_REPORT_KIND)
      .order('created_at', { ascending: false })
      .limit(TEAMMATE_REPORT_CONTEXT_LIMIT * 2),
    deliveredByHomeTurns(supabase, scope),
  ])
  if (turns.error) throw new Error(turns.error.message)
  if (reports.error) throw new Error(reports.error.message)

  const turnTimes = ((turns.data ?? []) as Array<{ created_at: string }>)
    .map((r) => Date.parse(r.created_at))
    .filter(Number.isFinite)
    .sort((a, b) => b - a)
  const since = turnTimes.length >= 2 ? turnTimes[1] : null

  const fresh = ((reports.data ?? []) as ReportRow[])
    // A server-written home turn already put it in the agent's history (A4 slice 5).
    .filter((r) => !(typeof r.ui_message?.id === 'string' && delivered.has(r.ui_message.id)))
    .map((r) => ({ at: Date.parse(r.created_at), report: parseTeammateReport(r.ui_message?.metadata?.teammate_report) }))
    .filter((r): r is { at: number; report: TeammateReport } => r.report !== null && Number.isFinite(r.at))
    .filter((r) => since === null || r.at > since)
    .sort((a, b) => b.at - a.at)
    .slice(0, TEAMMATE_REPORT_CONTEXT_LIMIT)
    .reverse()
  return renderTeammateUpdatesBlock(fresh.map((r) => r.report))
}
