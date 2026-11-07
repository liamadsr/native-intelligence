/**
 * Stale lines (A6 review): an inbox row says what was true when it was
 * written. By the time "while you were away", the digest or an event turn
 * reads it, the person may have sent the draft, answered the question or
 * settled the approval. Each reader asks this module which rows have SETTLED
 * since, from the current state of what they point at, and drops those:
 *
 *   email.drafted      the draft is no longer open (pending_review, edited or
 *                      approved): sent, sending, dismissed, or gone;
 *   email.needs_reply  the thread no longer needs a reply, or it has an open
 *                      draft now (its own email.drafted row speaks for it);
 *   work.needs_input   the work item is no longer waiting on that status
 *   work.needs_review  (answered, reviewed, canceled, finished);
 *   work.failed        the item is no longer failed (retried);
 *   work.approval      the approval is no longer pending, or has expired;
 *   mention, activity  the notification it stands behind was read (its banner
 *                      clicked);
 *   connection.needs_reconnect  the app's sign-in is no longer marked expired
 *                      (reconnected), or the app is gone (disconnected).
 *
 * Anything else (a finish, a processed meeting, a meeting soon: its expiry
 * handles it, a reminder, a follow-up, a sequence's failure) is never settled
 * here. A failed read settles nothing
 * (the line shows once more, the safe side). Pointers only: ids and statuses,
 * never a body.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AgentEventKind } from './types'

export interface FreshnessRow {
  id: string
  kind: AgentEventKind
  ref_type: string | null
  ref_id: string | null
}

/** What `delivered_key` a settled row is marked with, so no reader reads it again. */
export const SETTLED_DELIVERED_KEY = 'settled'

const OPEN_DRAFT_STATUSES: ReadonlySet<string> = new Set(['pending_review', 'edited', 'approved'])
const WORK_STATUS_FOR: Partial<Record<AgentEventKind, string>> = {
  'work.needs_input': 'needs_input',
  'work.needs_review': 'needs_review',
  'work.failed': 'failed',
}

/** The notices' kinds a read notification settles (a reminder or a failure is told even when its banner was seen). */
const READ_SETTLES_KINDS: readonly AgentEventKind[] = ['mention', 'activity']

function refsOf(rows: readonly FreshnessRow[], kinds: readonly AgentEventKind[], refType: string): string[] {
  return [...new Set(rows.filter((r) => kinds.includes(r.kind) && r.ref_type === refType && r.ref_id).map((r) => r.ref_id as string))]
}

/**
 * The ids of `rows` whose subject has settled since (see the header). Never
 * throws.
 */
export async function settledEventIds(
  supabase: SupabaseClient,
  scope: { workspaceId: string; userId: string },
  rows: readonly FreshnessRow[],
  nowMs: number = Date.now(),
): Promise<Set<string>> {
  const settled = new Set<string>()
  if (!rows.length) return settled

  // Drafts: open or not.
  const draftIds = refsOf(rows, ['email.drafted'], 'email_draft')
  if (draftIds.length) {
    try {
      const { data, error } = await supabase.from('email_draft').select('id, status').eq('workspace_id', scope.workspaceId).in('id', draftIds)
      if (!error) {
        const open = new Set(
          ((data as Array<{ id?: unknown; status?: unknown }> | null) ?? []).filter((d) => typeof d.status === 'string' && OPEN_DRAFT_STATUSES.has(d.status)).map((d) => d.id),
        )
        for (const r of rows) if (r.kind === 'email.drafted' && r.ref_type === 'email_draft' && r.ref_id && !open.has(r.ref_id)) settled.add(r.id)
      }
    } catch {
      // Unknown: shown once more.
    }
  }

  // Threads: still needing a reply, with no open draft.
  const threadIds = refsOf(rows, ['email.needs_reply'], 'email_thread')
  if (threadIds.length) {
    try {
      const { data, error } = await supabase
        .from('email_thread_index')
        .select('id, provider_thread_id, needs_reply')
        .eq('workspace_id', scope.workspaceId)
        .eq('user_id', scope.userId)
        .in('provider_thread_id', threadIds)
      if (!error) {
        const index = (data as Array<{ id?: unknown; provider_thread_id?: unknown; needs_reply?: unknown }> | null) ?? []
        const waiting = new Map<string, string>()
        for (const t of index) if (t.needs_reply === true && typeof t.provider_thread_id === 'string' && typeof t.id === 'string') waiting.set(t.provider_thread_id, t.id)
        let drafted = new Set<unknown>()
        if (waiting.size) {
          const { data: drafts, error: draftError } = await supabase
            .from('email_draft')
            .select('email_thread_id')
            .in('email_thread_id', [...waiting.values()])
            .in('status', [...OPEN_DRAFT_STATUSES])
          if (!draftError) drafted = new Set(((drafts as Array<{ email_thread_id?: unknown }> | null) ?? []).map((d) => d.email_thread_id))
        }
        for (const r of rows) {
          if (r.kind !== 'email.needs_reply' || r.ref_type !== 'email_thread' || !r.ref_id) continue
          const indexId = waiting.get(r.ref_id)
          if (!indexId || drafted.has(indexId)) settled.add(r.id)
        }
      }
    } catch {
      // Unknown: shown once more.
    }
  }

  // Work items: still in the status the row was about.
  const workIds = refsOf(rows, ['work.needs_input', 'work.needs_review', 'work.failed'], 'work_item')
  if (workIds.length) {
    try {
      const { data, error } = await supabase.from('tracked_job').select('id, status').eq('workspace_id', scope.workspaceId).in('id', workIds)
      if (!error) {
        const status = new Map(((data as Array<{ id?: unknown; status?: unknown }> | null) ?? []).map((j) => [j.id, j.status]))
        for (const r of rows) {
          const want = WORK_STATUS_FOR[r.kind]
          if (!want || r.ref_type !== 'work_item' || !r.ref_id) continue
          if (status.get(r.ref_id) !== want) settled.add(r.id)
        }
      }
    } catch {
      // Unknown: shown once more.
    }
  }

  // Approvals: still pending and not expired.
  const approvalIds = refsOf(rows, ['work.approval'], 'tool_approval')
  if (approvalIds.length) {
    try {
      const { data, error } = await supabase.from('tool_approval').select('id, status, expires_at').eq('user_id', scope.userId).in('id', approvalIds)
      if (!error) {
        const live = new Set(
          ((data as Array<{ id?: unknown; status?: unknown; expires_at?: unknown }> | null) ?? [])
            .filter((a) => a.status === 'pending' && !(typeof a.expires_at === 'string' && Date.parse(a.expires_at) <= nowMs))
            .map((a) => a.id),
        )
        for (const r of rows) if (r.kind === 'work.approval' && r.ref_type === 'tool_approval' && r.ref_id && !live.has(r.ref_id)) settled.add(r.id)
      }
    } catch {
      // Unknown: shown once more.
    }
  }

  // A teammate's mention or update: the person read its notification (a banner clicked).
  const noticeIds = refsOf(rows, READ_SETTLES_KINDS, 'notification')
  if (noticeIds.length) {
    try {
      const { data, error } = await supabase.from('notification').select('id, is_read').eq('workspace_id', scope.workspaceId).in('id', noticeIds)
      if (!error) {
        const read = new Set(((data as Array<{ id?: unknown; is_read?: unknown }> | null) ?? []).filter((n) => n.is_read === true).map((n) => n.id))
        for (const r of rows) if (READ_SETTLES_KINDS.includes(r.kind) && r.ref_type === 'notification' && r.ref_id && read.has(r.ref_id)) settled.add(r.id)
      }
    } catch {
      // Unknown: shown once more.
    }
  }

  // A connected app's expired sign-in: still marked (migration 451).
  const appIds = refsOf(rows, ['connection.needs_reconnect'], 'connected_mcp_server')
  if (appIds.length) {
    try {
      const { data, error } = await supabase.from('connected_mcp_server').select('id, reauth_required_at').eq('user_id', scope.userId).in('id', appIds)
      if (!error) {
        const marked = new Set(((data as Array<{ id?: unknown; reauth_required_at?: unknown }> | null) ?? []).filter((a) => typeof a.reauth_required_at === 'string').map((a) => a.id))
        for (const r of rows) if (r.kind === 'connection.needs_reconnect' && r.ref_type === 'connected_mcp_server' && r.ref_id && !marked.has(r.ref_id)) settled.add(r.id)
      }
    } catch {
      // Unknown: shown once more.
    }
  }
  return settled
}


/**
 * Mark settled rows delivered (`delivered_key = 'settled'`), fenced on not
 * delivered yet, so no reader shows them again. Never throws.
 */
export async function markSettledEvents(supabase: SupabaseClient, ids: Iterable<string>, nowMs: number = Date.now()): Promise<void> {
  const list = [...ids]
  if (!list.length) return
  try {
    const { error } = await supabase
      .from('agent_event')
      .update({ state: 'delivered', delivered_at: new Date(nowMs).toISOString(), delivered_key: SETTLED_DELIVERED_KEY })
      .in('id', list)
      .is('delivered_at', null)
    if (error) console.warn('[agent-event] settled mark skipped:', error.message)
  } catch (err) {
    console.warn('[agent-event] settled mark skipped:', err instanceof Error ? err.message : err)
  }
}
