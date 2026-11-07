/**
 * The capture pass's nightly catch-up (always-on plan §3b, slice A2c;
 * decision 8: it counts as the person's usage). Conversations with real
 * activity since their last capture that never compacted would otherwise
 * never be read; this queues the same job for them, from the stored chat
 * history (chat_messages), on the memory-learning cron.
 *
 * Bounds, so a nightly job can't run away:
 *   - only main-chat conversations: never a teammate's thread or a bot as the
 *     chat's agent (they keep their own memory), never a device ask;
 *   - only conversations changed in the last CATCHUP_ACTIVE_HOURS, changed
 *     since their eve session's last capture. A session with NO profile epoch
 *     counts as never captured and is a candidate too (queueProfileCapture
 *     makes its epoch): a home thread's sessions had none from 2026-10-15 to
 *     10-18, while their memory slot was off, and must not be dropped;
 *   - only messages after the session's `captured_through_at`; a session never
 *     captured (no epoch, or an epoch with no capture yet) reads only the
 *     window's messages, so a long history is never reprocessed; at least
 *     CATCHUP_MIN_NEW_TURNS new messages from the person;
 *   - at most `maxSessions` queued per run, never-captured and longest-ago
 *     first, before a wall-clock deadline;
 *   - idempotent: the operation id is the session plus its newest message,
 *     so a second run over the same messages queues nothing.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { DEVICE_ASK_CONVERSATION_TITLE } from '@/lib/chat/device-ask-eve'
import { sliceFromUiMessages, sliceHasPersonText } from './capture-slice'
import { queueProfileCapture, type SendCaptureEvent } from './profile-capture'

/**
 * Learn more each night (Liam, 2026-10-17: cost is not the constraint now):
 * three days of conversations, two new turns from the person, up to 200
 * sessions a run. Still bounded, and still only queued here.
 */
export const CATCHUP_ACTIVE_HOURS = 72
export const CATCHUP_MIN_NEW_TURNS = 2
export const CATCHUP_MAX_SESSIONS = 200
/** Stored messages read per conversation at most (the newest). */
const MESSAGES_READ_MAX = 300
/** Conversations looked at per run at most: room for CATCHUP_MAX_SESSIONS after the filters. */
const CONVERSATIONS_READ_MAX = 1_000

export interface CatchupOptions {
  now?: Date
  maxSessions?: number
  minNewTurns?: number
  /** Stop starting new sessions after this many ms. */
  deadlineMs?: number
}

export type CatchupOutcome = 'queued' | 'too_few_turns' | 'replayed' | 'refused' | 'failed'

export interface CatchupSummary {
  candidates: number
  considered: number
  queued: number
  outcomes: Array<{ sessionId: string; outcome: CatchupOutcome }>
  stoppedBy: 'done' | 'max_sessions' | 'deadline'
}

interface ConversationRow {
  id: string
  user_id: string
  workspace_id: string | null
  eve_session_id: string | null
  updated_at: string | null
}

interface EpochRow {
  session_id: string
  user_id: string
  workspace_id: string
  captured_through_at: string | null
  last_capture_at: string | null
}

/** The start of the catch-up window: CATCHUP_ACTIVE_HOURS before `now`. */
function windowStart(now: Date): string {
  return new Date(now.getTime() - CATCHUP_ACTIVE_HOURS * 60 * 60 * 1000).toISOString()
}

/**
 * The sessions worth catching up, never-captured (including no epoch at all)
 * and longest-ago first. Exported for tests.
 */
export async function catchupCandidates(
  supabase: SupabaseClient,
  now: Date,
): Promise<Array<{ conversation: ConversationRow; epoch: EpochRow | null }>> {
  const since = windowStart(now)
  const { data: convRows, error } = await supabase
    .from('chat_conversations')
    .select('id, user_id, workspace_id, eve_session_id, updated_at')
    .not('eve_session_id', 'is', null)
    .not('workspace_id', 'is', null)
    .is('ai_team_member_id', null)
    .is('agent_teammate_id', null)
    // A guest's thread (guest access) never feeds the owner's memory.
    .is('agent_guest_id', null)
    .neq('title', DEVICE_ASK_CONVERSATION_TITLE)
    .gte('updated_at', since)
    .order('updated_at', { ascending: false })
    .limit(CONVERSATIONS_READ_MAX)
  if (error) throw new Error(`conversations read: ${error.message}`)
  const conversations = ((convRows ?? []) as ConversationRow[]).filter((c) => c.eve_session_id && c.workspace_id)
  if (conversations.length === 0) return []

  const { data: epochRows, error: epochError } = await supabase
    .from('chat_memory_epoch')
    .select('session_id, user_id, workspace_id, captured_through_at, last_capture_at')
    .in('session_id', conversations.map((c) => c.eve_session_id as string))
  if (epochError) throw new Error(`epochs read: ${epochError.message}`)
  const bySession = new Map(((epochRows ?? []) as EpochRow[]).map((e) => [e.session_id, e]))

  const out: Array<{ conversation: ConversationRow; epoch: EpochRow | null }> = []
  for (const conversation of conversations) {
    const epoch = bySession.get(conversation.eve_session_id as string) ?? null
    // No epoch: never captured (queueProfileCapture makes one). An epoch for another person or workspace: never.
    if (epoch && (epoch.user_id !== conversation.user_id || epoch.workspace_id !== conversation.workspace_id)) continue
    if (epoch?.last_capture_at && conversation.updated_at && conversation.updated_at <= epoch.last_capture_at) continue
    out.push({ conversation, epoch })
  }
  return out.sort((a, b) => (a.epoch?.last_capture_at ?? '').localeCompare(b.epoch?.last_capture_at ?? ''))
}

export async function runCaptureCatchup(supabase: SupabaseClient, send: SendCaptureEvent, opts: CatchupOptions = {}): Promise<CatchupSummary> {
  const now = opts.now ?? new Date()
  const maxSessions = opts.maxSessions ?? CATCHUP_MAX_SESSIONS
  const minNewTurns = opts.minNewTurns ?? CATCHUP_MIN_NEW_TURNS
  const started = Date.now()
  const since = windowStart(now)
  const candidates = await catchupCandidates(supabase, now)
  const summary: CatchupSummary = { candidates: candidates.length, considered: 0, queued: 0, outcomes: [], stoppedBy: 'done' }

  for (const { conversation, epoch } of candidates) {
    if (summary.queued >= maxSessions) {
      summary.stoppedBy = 'max_sessions'
      break
    }
    if (opts.deadlineMs !== undefined && Date.now() - started > opts.deadlineMs) {
      summary.stoppedBy = 'deadline'
      break
    }
    summary.considered += 1
    const sessionId = conversation.eve_session_id as string
    let outcome: CatchupOutcome
    try {
      let read = supabase
        .from('chat_messages')
        .select('role, ui_message, created_at')
        .eq('conversation_id', conversation.id)
        .eq('user_id', conversation.user_id)
      // After the last capture; never captured: the window's messages only (never a whole long history).
      read = read.gt('created_at', epoch?.captured_through_at ?? since)
      const { data, error } = await read.order('created_at', { ascending: false }).limit(MESSAGES_READ_MAX)
      if (error) throw new Error(error.message)
      const rows = ((data ?? []) as Array<{ role: string; ui_message: unknown; created_at: string }>).reverse()
      const slice = sliceFromUiMessages(rows)
      const personTurns = slice.filter((m) => m.role === 'user').length
      if (personTurns < minNewTurns || !sliceHasPersonText(slice)) {
        outcome = 'too_few_turns'
      } else {
        const newestAt = rows[rows.length - 1].created_at
        const result = await queueProfileCapture(
          supabase,
          {
            userId: conversation.user_id,
            workspaceId: conversation.workspace_id as string,
            conversationId: conversation.id,
            sessionId,
            operationId: `nightly:${sessionId}:${Date.parse(newestAt)}`,
            phase: 'nightly',
            sequence: null,
            capturedThroughAt: newestAt,
            slice,
          },
          send,
        )
        outcome = !result.ok ? 'refused' : result.replayed ? 'replayed' : result.queued ? 'queued' : 'too_few_turns'
      }
    } catch (err) {
      console.error(`[capture-catchup] session skipped: ${err instanceof Error ? err.message : String(err)}`)
      outcome = 'failed'
    }
    if (outcome === 'queued') summary.queued += 1
    summary.outcomes.push({ sessionId, outcome })
  }
  return summary
}
