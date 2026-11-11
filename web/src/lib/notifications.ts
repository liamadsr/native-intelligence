import { randomUUID } from 'node:crypto'
import { getServiceClient } from '@/lib/admin'
import { deferLogWrite } from '@/lib/log/agent-log'
import { noticeEventKind } from '@/lib/agent-events/types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Runtime list backing the NotificationType union — single source of truth
 * for code that needs the types at runtime. Must stay in sync with the DB
 * CHECK constraint (migration 560 is the latest DROP+ADD; 401 dropped the
 * types nothing writes any more, with their rows, when the notifications page
 * went: docs/plans/retire-notifications-page.md). Which of these reach the
 * agent, and as what: agent-events/types.ts NOTICE_EVENT_KIND.
 */
export const NOTIFICATION_TYPES = [
  'action_assigned',
  'action_unassigned',
  'action_status_changed',
  'capture_shared',
  'comment_added',
  'comment_reply',
  'decision_confirmed',
  'cycle_started',
  'project_status_changed',
  'meeting_starting_soon',
  'contact_followup_due',
  // Loop digests ("Triage: 2 need you", a precondition skip), and the
  // sequence engine's failures. Target the work item (or the sequence); the
  // failed-run and prose-document pushes moved onto the work ledger's own
  // types below.
  'flow_run_output',
  // A user-set "Remind me about this" came due. Self-targeted (no actorId — the
  // actor === recipient filter below would otherwise drop it) and inserted
  // directly by the cron pass, not through createNotification. Deep-links the
  // entity it was set on. Migration 224.
  'reminder',
  // The work ledger (ACTIVITY-AND-REVIEW-DESIGN §4.5, migration 273): a run
  // parked on a question or a deliverable waiting on the user, and a run that
  // failed (grouped per kind per day). Both deep-link the work item
  // (target_type='work_item'); the recorder is their only producer.
  'work_needs_you',
  'work_failed',
  // The agent's daily digest (A6 slice 4, migration 336): one bubble on the
  // face at 8:00 local, beside the digest's home-thread message.
  'agent_digest',
  // Another workspace was merged into this one (migration 407): every member
  // of the destination hears it from the agent, so their open tabs refetch.
  // Sent by src/lib/workspace-merge/notice.ts after merge_workspace commits.
  'workspace_merged',
  // The main agent's check-in spoke in the home thread (migration 443,
  // docs/plans/now-file.md): one bubble on the face per check-in that
  // replied. Sent by src/lib/now/check-in.ts sendCheckInNotice.
  'agent_check_in',
  // The evening look-ahead (migration 452, docs/plans/look-ahead-heartbeat.md):
  // one bubble on the face beside its home-thread message about tomorrow
  // morning. Sent by src/lib/look-ahead/message.ts writeLookAhead.
  'agent_look_ahead',
  // The agent wrote to the person while they were at an app and hadn't read
  // it (migration 454, docs/plans/reach-follows-you.md): one bubble from the
  // Assistant, a native banner on the desktop when no Native Intelligence window is
  // focused; no target, so a click opens the home thread. Sent by the router,
  // src/lib/reach/route.ts.
  'agent_message',
  // A team chat message for this person (migration 560): a DM, a mention, a
  // reply in a thread they are in, a channel they set to all messages, their
  // agent's reply. One per message per person; targets the message
  // (target_type 'team_chat_message', context the channel), grouped by its
  // conversation, read when the conversation is. Written by
  // src/lib/team-chat/notify.ts only (never through createNotification).
  'team_chat_message',
] as const

export type NotificationType = (typeof NOTIFICATION_TYPES)[number]


export interface CreateNotificationParams {
  workspaceId: string
  recipientId: string
  type: NotificationType
  title: string
  body?: string
  actorId?: string
  // Must stay in sync with the notification.target_type CHECK (migration 031,
  // widened by 172, then 197, then 224, then 273, then 560) — an out-of-set value fails the
  // insert, which createNotification swallows, silently dropping the row.
  // 'flow_run'/'flow' deep-link loop notifications to the Loop Activity surface
  // (WS-3b); 'agent_run' deep-links a work_run_ready notification to the run
  // (Loops v3); 'initiative' deep-links a reminder set on an initiative
  // (migration 224); 'work_item' opens a work-ledger item, 'email_draft' a draft
  // in Mail, 'sequence' a sequence (migration 273).
  targetType?:
    | 'action' | 'capture' | 'document' | 'project' | 'contact'
    | 'cycle' | 'comment' | 'decision' | 'share' | 'flow_run' | 'flow'
    | 'agent_run' | 'initiative' | 'work_item' | 'email_draft' | 'sequence'
    | 'team_chat_message'
  targetId?: string
  contextType?: string
  contextId?: string
  groupKey?: string
  metadata?: Record<string, unknown>
  /**
   * Written already read: a notice kept for the record that asks nothing of
   * anyone (a bot's quiet "I skipped it" notice, bots-v4 Phase 4c: it sits in
   * its bot's Notices, muted, never counted as unread and never lighting a dot).
   */
  isRead?: boolean
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Create a single notification. Handles:
 * - Self-notification filtering (actor === recipient)
 * - Deduplication (same type + target within 5 minutes)
 *
 * Uses service role client — call this server-side only.
 */
export async function createNotification(params: CreateNotificationParams): Promise<void> {
  try {
    // 1. Don't notify the actor about their own actions
    if (params.actorId && params.actorId === params.recipientId) {
      return
    }

    const supabaseAdmin = getServiceClient()

    // 2. Check for recent duplicate (same type + target within 5 minutes)
    if (params.targetId) {
      const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()
      const { data: existing } = await supabaseAdmin
        .from('notification')
        .select('id')
        .eq('recipient_id', params.recipientId)
        .eq('type', params.type)
        .eq('target_id', params.targetId)
        .gte('created_at', fiveMinutesAgo)
        .limit(1)

      if (existing && existing.length > 0) {
        return
      }
    }

    // 3. Create the notification. A notice the agent hears about
    // (agent-events/notice.ts, NOTICE_EVENT_KIND) carries an id minted here,
    // so the agent's inbox can key its event on it.
    const noticeId = noticeEventKind(params.type) ? randomUUID() : null
    const { error } = await supabaseAdmin
      .from('notification')
      .insert({
        ...(noticeId ? { id: noticeId } : {}),
        workspace_id: params.workspaceId,
        recipient_id: params.recipientId,
        type: params.type,
        title: params.title,
        body: params.body || null,
        actor_id: params.actorId || null,
        target_type: params.targetType || null,
        target_id: params.targetId || null,
        context_type: params.contextType || null,
        context_id: params.contextId || null,
        group_key: params.groupKey || null,
        metadata: params.metadata || {},
        ...(params.isRead ? { is_read: true, read_at: new Date().toISOString() } : {}),
      })

    if (error) {
      console.error('Failed to create notification:', error)
    } else if (noticeId) {
      // One event for the recipient, off the caller's path.
      deferLogWrite(
        import('@/lib/agent-events/notice').then((m) =>
          m.recordNoticeEvent(
            {
              notificationId: noticeId,
              workspaceId: params.workspaceId,
              recipientMemberId: params.recipientId,
              type: params.type,
              title: params.title,
              targetType: params.targetType ?? null,
              targetId: params.targetId ?? null,
            },
            supabaseAdmin,
          ),
        ),
      )
    }
  } catch (err) {
    // Non-blocking — log and move on
    console.error('Notification creation error:', err)
  }
}

/**
 * Create the same notification for multiple recipients.
 * Runs in parallel but does not block the caller on failure.
 */
export async function createNotificationsForMany(
  recipientIds: string[],
  params: Omit<CreateNotificationParams, 'recipientId'>,
): Promise<void> {
  await Promise.all(
    recipientIds.map((recipientId) =>
      createNotification({ ...params, recipientId }),
    ),
  )
}

// ---------------------------------------------------------------------------
// Helpers for resolving recipients
// ---------------------------------------------------------------------------

/** Get all team members (no exclusion). */
export async function getAllTeamMembers(teamId: string): Promise<string[]> {
  const supabaseAdmin = getServiceClient()
  const { data } = await supabaseAdmin
    .from('team_member')
    .select('member_id')
    .eq('team_id', teamId)

  return (data || []).map((m) => m.member_id)
}

/** Get member ID from user_id + workspace_id. */
export async function getMemberByUserId(
  workspaceId: string,
  userId: string,
): Promise<{ id: string; display_name: string | null } | null> {
  const supabaseAdmin = getServiceClient()
  const { data } = await supabaseAdmin
    .from('member')
    .select('id, display_name')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .single()

  return data
}
