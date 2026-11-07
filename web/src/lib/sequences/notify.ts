/**
 * Grouped operator notifications for sequence engine failures.
 *
 * The engine's failure surface (reaped zombie sends, exhausted dispatch
 * attempts, a paused sequence after its mailbox went away) must produce ONE
 * notification per sequence, never one per enrollment — a 20-contact wave
 * failing must not dump 20 rows into the owner's inbox.
 *
 * Inserted DIRECTLY (the flow-schedule reminder-pass idiom) rather than via
 * createNotification: that helper swallows insert errors and dedupes on
 * type+target within 5 minutes, neither of which fits a grouped operational
 * alert. Grouping here is by group_key `sequence:<id>` with a 24h window
 * (mirrors notifyFailedSkillRun's one-per-flow-per-24h rule).
 *
 * type 'flow_run_output' — the notification.type CHECK (migration 224) has no
 * sequence-specific value and 227 deliberately adds none; 'flow_run_output' is
 * the established "an automation you own needs attention" type. The row
 * targets the sequence itself (target_type 'sequence', migration 273) so the
 * click opens it; the id also rides in group_key + metadata for the grouping.
 *
 * SERVICE-CLIENT ONLY — the engine paths (cron + Inngest) run service-role.
 */
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

const GROUP_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Resolve the notification recipient for a sequence: the creator's member row
 * in the workspace, falling back to the workspace owner (the sequence's
 * created_by is SET NULL on user deletion). Returns null when neither
 * resolves — the caller skips the notification (no inbox to deliver to).
 */
export async function resolveSequenceRecipient(
  supabase: SupabaseClient,
  workspaceId: string,
  createdBy: string | null,
): Promise<string | null> {
  if (createdBy) {
    const { data: m } = await supabase
      .from('member')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('user_id', createdBy)
      .maybeSingle()
    if (m?.id) return m.id as string
  }
  const { data: owner } = await supabase
    .from('member')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('role', 'owner')
    .limit(1)
    .maybeSingle()
  return (owner?.id as string | undefined) ?? null
}

/**
 * Insert one grouped sequence notification, at most once per sequence per 24h
 * (keyed on group_key `sequence:<id>`). Best-effort: failures are logged,
 * never thrown — a notification must not fail a cron tick or a send step.
 */
export async function notifySequenceIssue(
  supabase: SupabaseClient,
  sequence: { id: string; name: string; created_by: string | null },
  workspaceId: string,
  title: string,
  body: string,
): Promise<void> {
  try {
    const recipientId = await resolveSequenceRecipient(
      supabase,
      workspaceId,
      sequence.created_by,
    )
    if (!recipientId) return

    const groupKey = `sequence:${sequence.id}`
    const since = new Date(Date.now() - GROUP_WINDOW_MS).toISOString()
    const { data: existing } = await supabase
      .from('notification')
      .select('id')
      .eq('recipient_id', recipientId)
      .eq('group_key', groupKey)
      .gte('created_at', since)
      .limit(1)
    if (existing && existing.length > 0) return

    // The id is minted here so the agent's event (below) can key on it.
    const notificationId = randomUUID()
    const { error } = await supabase.from('notification').insert({
      id: notificationId,
      workspace_id: workspaceId,
      recipient_id: recipientId,
      type: 'flow_run_output',
      title,
      body: body.slice(0, 240),
      actor_id: null,
      target_type: 'sequence',
      target_id: sequence.id,
      group_key: groupKey,
      metadata: { sequence_id: sequence.id, sequence_name: sequence.name },
    })
    if (error) {
      console.error(
        `[sequences] notification insert failed for sequence ${sequence.id}:`,
        error.message,
      )
      return
    }
    // The agent hears it too (agent-events/notice.ts): sequences keep no bot,
    // so the home thread is where a failure reaches the owner. Never throws.
    await import('@/lib/agent-events/notice')
      .then((m) =>
        m.recordNoticeEvent(
          {
            notificationId,
            workspaceId,
            recipientMemberId: recipientId,
            type: 'flow_run_output',
            kind: 'sequence.failed',
            // The titles are generic ("Sequence send failed"): name the sequence.
            title: `${title}: ${sequence.name}`,
            targetType: 'sequence',
            targetId: sequence.id,
          },
          supabase,
        ),
      )
      .catch(() => 0)
  } catch (e) {
    console.error(`[sequences] notify failed for sequence ${sequence.id}:`, e)
  }
}
