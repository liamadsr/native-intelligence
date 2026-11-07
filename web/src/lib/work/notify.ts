/**
 * Notifications as a side effect of status (ACTIVITY-AND-REVIEW-DESIGN §3.2,
 * §4.5). The recorder calls these on the transitions that need a human;
 * producers never call createNotification for work themselves.
 *
 *   needs_input / needs_review → `work_needs_you`, target work_item — one per
 *                                item (createNotification's own (recipient,
 *                                type, target) window absorbs a park→resume→
 *                                park flap)
 *   failed                     → `work_failed`, target work_item — grouped: at
 *                                most one per (workspace, kind) per UTC day,
 *                                the notifyFailedSkillRun posture generalized
 *
 * Routine `done` is silent (NORTH-STAR invariant 4). Best-effort: the row is
 * already written when these run; a lost push is a missed nudge, never a
 * failed transition.
 *
 * Whose notice it is: the row's teammate; with none, its workspace's
 * Assistant (withNoticeBot: work with no bot is the Assistant's, Liam
 * 2026-10-08), so the notice lands in that bot's Notices and lights its dot.
 * Sequence sends keep no bot: their notices stay plain (the agent hears of a
 * sequence's failure through agent-events/notice.ts).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createNotification } from '@/lib/notifications'
import { botNoticeCopy, botNoticeMetadata, noticeTeammateName } from '@/lib/bots/bot-notice'
import { workNoticeLine } from '@/lib/bots/narration'
import { reviewLine } from './presentation'
import { KINDS_WITHOUT_BOT } from './bot-owner'
import { areaTeammateId } from './system-teammates'
import { isAreaKey } from '@/lib/packs/registry'
import type { WorkDeliverable, WorkNeeds } from './types'

export interface WorkNotifyRow {
  id: string
  workspace_id: string
  member_id: string
  kind: string
  title: string
  needs: WorkNeeds | null
  deliverables: WorkDeliverable[]
  result_summary: string | null
  error_message: string | null
  /** The teammate doing the work: named on the notice with its bot's sentence (bots v3 1a). */
  ai_team_member_id?: string | null
  /** The work's area (migration 318): on the notice too, so its face can be picked from it. */
  area?: string | null
}

/**
 * The bot keys a work notice carries when its row has a teammate
 * (bot-notice.ts): the teammate, its name when `supabase` can read it, the
 * line its bubble says about the row, and the row. Empty with no teammate, so
 * such a notice is exactly what it was.
 */
export async function workNoticeMetadata(
  row: WorkNotifyRow,
  status: 'needs_input' | 'needs_review' | 'failed',
  supabase?: SupabaseClient,
): Promise<Record<string, unknown>> {
  const teammateId = row.ai_team_member_id ?? null
  if (!teammateId) return {}
  return botNoticeMetadata({
    teammateId,
    teammateName: supabase ? await noticeTeammateName(supabase, row.workspace_id, teammateId) : null,
    sentence: workNoticeLine({
      kind: row.kind,
      status,
      title: row.title,
      needs: row.needs,
      deliverables: row.deliverables,
      result_summary: row.result_summary,
      error_message: row.error_message,
    }),
    workItemId: row.id,
    area: row.area ?? null,
  })
}

/**
 * The row with the bot its notice comes from: its own teammate; else, but for
 * a sequence send (lib/work/bot-owner.ts KINDS_WITHOUT_BOT), its area's face,
 * else its workspace's Assistant, read with `supabase` (system-teammates.ts
 * areaTeammateId). The row itself when it names a teammate, there's no client
 * to read with, or no face can be read (then the notice is plain, as before).
 * Never throws.
 */
export async function withNoticeBot(row: WorkNotifyRow, supabase?: SupabaseClient): Promise<WorkNotifyRow> {
  if (row.ai_team_member_id || !supabase || KINDS_WITHOUT_BOT.has(row.kind)) return row
  const face = await areaTeammateId(supabase, row.workspace_id, isAreaKey(row.area) ? row.area : null)
  return face ? { ...row, ai_team_member_id: face } : row
}

const USAGE_LIMIT_RE = /usage limit/i
export const USAGE_LIMIT_BODY =
  'AI usage limit reached — loops are paused until the limit resets or is raised'
const BODY_MAX = 500
const FAILURE_BODY_MAX = 160

function logError(op: string, err: unknown) {
  console.error(`[work] ${op} failed:`, err instanceof Error ? err.message : err)
}

/** The first question's text, whatever shape the asker used. */
export function questionText(needs: WorkNeeds | null): string {
  if (needs?.kind !== 'input') return ''
  const q = needs.questions[0] as unknown
  if (typeof q === 'string') return q
  if (q && typeof q === 'object') {
    const o = q as Record<string, unknown>
    for (const key of ['question', 'prompt', 'text', 'title']) {
      const v = o[key]
      if (typeof v === 'string' && v.trim()) return v.trim()
    }
  }
  return ''
}

/** The copy for a parked or waiting item. */
export function needsYouCopy(row: WorkNotifyRow, status: 'needs_input' | 'needs_review'): { title: string; body: string } {
  if (status === 'needs_input') {
    return { title: `${row.title} — needs your answer`, body: questionText(row.needs).slice(0, BODY_MAX) }
  }
  const body = [reviewLine(row), row.result_summary].filter(Boolean).join(' · ')
  return { title: `${row.title} — ready to review`, body: body.slice(0, BODY_MAX) }
}

/** The copy for a failure; the usage-limit block reads as "paused". */
export function failedCopy(row: WorkNotifyRow): { title: string; body: string } {
  const err = (row.error_message ?? '').trim()
  const body = USAGE_LIMIT_RE.test(err)
    ? USAGE_LIMIT_BODY
    : err || 'The run failed. Open it to see what happened.'
  return { title: `${row.title} couldn't run`, body: body.slice(0, FAILURE_BODY_MAX) }
}

/**
 * A failure's group: one notice per (workspace, kind, teammate) per day. Per
 * teammate (bots-v4 Phase 4c): an unread failed run lights its own bot's dot
 * and sits in that bot's Notices, so a second bot's failure of the same kind
 * that day gets a notice of its own instead of riding the first bot's. Still
 * one per bot per kind per day, so the banners stay few. A run with no
 * teammate keeps the group it had (one a day per kind).
 */
export function failedGroupKey(row: Pick<WorkNotifyRow, 'workspace_id' | 'kind' | 'ai_team_member_id'>, nowIso: string): string {
  const teammate = row.ai_team_member_id ? `:${row.ai_team_member_id}` : ''
  return `work_failed:${row.workspace_id}:${row.kind}${teammate}:${nowIso.slice(0, 10)}`
}

/** needs_input / needs_review → one `work_needs_you` for the owning member.
 *  `supabase` (the recorder's client) reads the teammate's name for the bot
 *  keys; without it they go out unsigned. */
export async function notifyWorkNeedsYou(
  given: WorkNotifyRow,
  status: 'needs_input' | 'needs_review',
  supabase?: SupabaseClient,
): Promise<boolean> {
  try {
    const row = await withNoticeBot(given, supabase)
    const bot = await workNoticeMetadata(row, status, supabase)
    // With a teammate, it speaks as the bot (its name, its sentence).
    const copy = botNoticeCopy(bot, needsYouCopy(row, status))
    await createNotification({
      workspaceId: row.workspace_id,
      recipientId: row.member_id,
      type: 'work_needs_you',
      title: copy.title,
      body: copy.body,
      targetType: 'work_item',
      targetId: row.id,
      groupKey: `work_needs_you:${row.id}`,
      metadata: { kind: row.kind, status, ...bot },
    })
    return true
  } catch (err) {
    logError('notifyWorkNeedsYou', err)
    return false
  }
}

/** failed → `work_failed`, at most one per (workspace, kind, teammate) per day (failedGroupKey). Returns
 *  whether a notification was sent (false when the day's group already has one). */
export async function notifyWorkFailed(
  supabase: SupabaseClient,
  given: WorkNotifyRow,
  opts: { nowIso?: string } = {},
): Promise<boolean> {
  try {
    const row = await withNoticeBot(given, supabase)
    const nowIso = opts.nowIso ?? new Date().toISOString()
    const groupKey = failedGroupKey(row, nowIso)
    const { data: existing } = await supabase
      .from('notification')
      .select('id')
      .eq('recipient_id', row.member_id)
      .eq('type', 'work_failed')
      .eq('group_key', groupKey)
      .limit(1)
    if (Array.isArray(existing) && existing.length > 0) return false
    const bot = await workNoticeMetadata(row, 'failed', supabase)
    const copy = botNoticeCopy(bot, failedCopy(row))
    await createNotification({
      workspaceId: row.workspace_id,
      recipientId: row.member_id,
      type: 'work_failed',
      title: copy.title,
      body: copy.body,
      targetType: 'work_item',
      targetId: row.id,
      groupKey,
      metadata: { kind: row.kind, ...bot },
    })
    return true
  } catch (err) {
    logError('notifyWorkFailed', err)
    return false
  }
}
