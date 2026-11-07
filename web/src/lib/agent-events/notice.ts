/**
 * The notice tap (A6 slice 1, widened by docs/plans/retire-notifications-page.md
 * phase 1): every notification a person should hear about through the agent
 * becomes one event in its inbox, so the notifications page is not the only
 * place it lives.
 *
 * Tapped in createNotification (src/lib/notifications.ts) for the types in
 * NOTICE_EVENT_KIND (./types.ts), and called directly by the two producers
 * that insert their rows themselves: the reminder pass (a reminder coming due)
 * and the sequence engine (a sequence that failed, `kind: 'sequence.failed'`,
 * since its notification type is the shared `flow_run_output`).
 *
 * Each becomes one event for the recipient, keyed on the notification's id
 * (a mention keeps its `mention:` key), with the notification as its ref: the
 * banner already went out, so the router records that notice and never sends
 * another (router.ts, NOTICE_KINDS). What it points at rides in the facts, so
 * the agent can open it.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { memberUserId } from '@/lib/log/agent-log'
import { recordAgentEvents, type RecordAgentEventsDeps } from './record'
import { agentEventKey, noticeEventKind, type AgentEventKind } from './types'

/** How pressing each notice's kind is (0 is never put to Jev's shadow). */
const NOTICE_PRIORITY: Partial<Record<AgentEventKind, number>> = {
  mention: 1,
  activity: 0,
  'reminder.due': 2,
  'contact.followup_due': 0,
  'sequence.failed': 2,
}

export interface Notice {
  notificationId: string
  workspaceId: string
  /** The recipient member (notification.recipient_id). */
  recipientMemberId: string
  type: string
  /** The kind, when the type alone doesn't say it (a sequence's failure is a `flow_run_output`). */
  kind?: AgentEventKind
  /** The notice's line (app-templated, may hold a member-written title): clipped. A reminder passes what it is about. */
  title: string
  targetType?: string | null
  targetId?: string | null
  at?: string | null
}

/** Record one event for the notice's recipient. Never throws; the count of rows that landed. */
export async function recordNoticeEvent(notice: Notice, supabase: SupabaseClient, deps: RecordAgentEventsDeps = {}): Promise<number> {
  try {
    const kind = notice.kind ?? noticeEventKind(notice.type)
    if (!kind || !notice.notificationId) return 0
    const userId = await memberUserId(supabase, notice.workspaceId, notice.recipientMemberId)
    if (!userId) return 0
    return await recordAgentEvents(
      [
        {
          workspaceId: notice.workspaceId,
          userId,
          kind,
          priority: NOTICE_PRIORITY[kind] ?? 1,
          occursAt: notice.at ?? null,
          refType: 'notification',
          refId: notice.notificationId,
          facts: {
            title: notice.title,
            notificationType: notice.type,
            ...(notice.targetType && notice.targetId ? { targetType: notice.targetType, targetId: notice.targetId } : {}),
          },
          dedupeKey: kind === 'mention' ? agentEventKey.mention(notice.notificationId) : agentEventKey.notice(notice.notificationId),
        },
      ],
      supabase,
      deps,
    )
  } catch (err) {
    console.warn('[agent-event] notice skipped:', err instanceof Error ? err.message : err)
    return 0
  }
}
