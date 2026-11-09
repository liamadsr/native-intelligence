/**
 * The router's real dependencies (./router.ts takes them injected, so its
 * rules test without a database or a model): the three gates, the Jev call
 * and the kinds it is proven on, the face notice for a meeting starting soon,
 * and the lookup of a notice already sent (the recorder's, or the notification
 * a notice's event stands behind).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { NonRetriableError } from 'inngest'
import { createNotification } from '@/lib/notifications'
import { botNoticeCopy, botNoticeMetadata, noticeTeammateName } from '@/lib/bots/bot-notice'
import { areaTeammateId } from '@/lib/work/system-teammates'
import { routerPaused } from '@/lib/work/agent-paused'
import { guardBackgroundUsageOnPlan } from '@/lib/inngest/usage-guard'
import { workspaceIsDormant } from '@/lib/inngest/flow-functions'
import { clipLogText } from '@/lib/log/agent-log'
import {
  EVENT_NEEDS_PERSON_VERSION,
  JEV_DECIDABLE_KINDS,
  JEV_PROVEN_WINDOW_MS,
  jevShadowFrom,
  provenKindsFrom,
  provenSides,
  type JevProven,
  type JevShadow,
  type RouterDeps,
} from './router'
import { NOTICE_KINDS, type AgentEventRow } from './types'
import { HOME_TURN_MAX_DIGEST_EVENTS, HOME_TURN_REQUESTED_EVENT } from '@/lib/chat/home-turn'
import type { EventNeedsPersonInput } from '@/lib/ai/decisions/tasks/event-needs-person'

/**
 * True when the person is over their AI usage limit (the background guard's
 * verdict, as a boolean; fails open). Opted in to the ChatGPT free tier: a
 * person on their own plan is not over it, so their events still reach their
 * agent; the home turns past this gate run on their plan (the turn's rebuild
 * puts them there), and Jev, NI-paid, refuses them on its own
 * (runDecision's usage check) at no cost.
 */
export async function isOverBackgroundUsage(userId: string): Promise<boolean> {
  try {
    await guardBackgroundUsageOnPlan(userId)
    return false
  } catch (err) {
    return err instanceof NonRetriableError
  }
}

/**
 * event.needs_person: what Jev picks, stored on the row. The router applies it
 * only for a kind Jev is proven on (router.ts applyJev); the usage row's
 * `decision_mode` stays 'shadow' and the row's `decided_by` says who decided.
 */
export async function decideEventNeedsPersonShadow(
  input: EventNeedsPersonInput,
  ctx: { userId: string; workspaceId: string; runId: string },
): Promise<JevShadow> {
  const { runDecision } = await import('@/lib/ai/decisions/run-decision')
  const result = await runDecision('event.needs_person', input, { ...ctx, mode: 'shadow' })
  return jevShadowFrom(result)
}

/** How many recent answers the proven check reads (newest first). */
export const JEV_PROVEN_SAMPLE_MAX = 2000
/** How long one process keeps the proven kinds before reading them again. */
export const JEV_PROVEN_CACHE_MS = 10 * 60_000
let provenCache: { at: number; proven: JevProven } | null = null

/** Drop the cached proven kinds (tests). */
export function resetJevProvenCache(): void {
  provenCache = null
}

/**
 * The sides Jev is proven on, per kind: this version's answers on the
 * decidable kinds over the window, across everyone (picks and rule outcomes
 * only, never a row's facts), through provenKindsFrom. Cached per process for
 * JEV_PROVEN_CACHE_MS. A failed read is not cached and proves nothing: the
 * rules decide.
 */
export async function jevProvenKinds(supabase: SupabaseClient, nowMs: number): Promise<JevProven> {
  if (provenCache && nowMs - provenCache.at < JEV_PROVEN_CACHE_MS) return provenCache.proven
  const { data, error } = await supabase
    .from('agent_event')
    .select('kind, jev_shadow')
    .eq('jev_shadow->>version', EVENT_NEEDS_PERSON_VERSION)
    .in('kind', [...JEV_DECIDABLE_KINDS])
    .gte('routed_at', new Date(nowMs - JEV_PROVEN_WINDOW_MS).toISOString())
    .order('routed_at', { ascending: false })
    .limit(JEV_PROVEN_SAMPLE_MAX)
  if (error) throw new Error(`jev proven read failed: ${error.message}`)
  const proven = provenSides(provenKindsFrom((data as Array<{ kind: unknown; jev_shadow: unknown }> | null) ?? []))
  provenCache = { at: nowMs, proven }
  return proven
}

async function memberIdFor(supabase: SupabaseClient, workspaceId: string, userId: string): Promise<string | null> {
  const { data, error } = await supabase.from('member').select('id').eq('workspace_id', workspaceId).eq('user_id', userId).maybeSingle()
  if (error) return null
  const id = (data as { id?: unknown } | null)?.id
  return typeof id === 'string' && id ? id : null
}

/** The group key of the router's own notice for a row: one per event. */
export function meetingNoticeGroupKey(row: Pick<AgentEventRow, 'id'>): string {
  return `agent_event:${row.id}`
}

async function noticeIdByGroup(supabase: SupabaseClient, memberId: string, groupKey: string): Promise<string | null> {
  const { data } = await supabase
    .from('notification')
    .select('id')
    .eq('recipient_id', memberId)
    .eq('group_key', groupKey)
    .order('created_at', { ascending: false })
    .limit(1)
  const id = Array.isArray(data) ? (data[0] as { id?: unknown } | undefined)?.id : null
  return typeof id === 'string' ? id : null
}

/**
 * The copy of a meeting-soon notice: Native Intelligence's sentence around a clipped title,
 * saying the prep is ready only when it is (a plain heads-up otherwise). Pure.
 */
export function meetingNoticeCopy(row: Pick<AgentEventRow, 'facts' | 'occurs_at'>, nowMs: number): { title: string; sentence: string; body: string } {
  const title = clipLogText(row.facts?.title, 80) ?? 'Your meeting'
  const minutes = Math.max(1, Math.round((Date.parse(row.occurs_at) - nowMs) / 60_000))
  const prepReady = row.facts?.prepReady === true
  return {
    title: `“${title}” starts in ${minutes} min`,
    sentence: prepReady ? `“${title}” starts in ${minutes} minutes. Your prep is ready.` : `“${title}” starts in ${minutes} minutes.`,
    body: prepReady ? 'Your prep is ready.' : `Starts in ${minutes} minutes.`,
  }
}

/**
 * One `meeting_starting_soon` notice for a meeting-soon row, from the
 * Calendar face (else the Assistant): the one face (A3 maps it). Sent once
 * per event: a notice already carrying the row's group key is returned, not
 * re-sent. Resolves to the notice id, or null when it could not go out.
 */
export async function sendMeetingNotice(supabase: SupabaseClient, row: AgentEventRow, nowMs = Date.now()): Promise<string | null> {
  const memberId = await memberIdFor(supabase, row.workspace_id, row.user_id)
  if (!memberId) return null
  const groupKey = meetingNoticeGroupKey(row)
  const existing = await noticeIdByGroup(supabase, memberId, groupKey)
  if (existing) return existing
  const face = await areaTeammateId(supabase, row.workspace_id, 'calendar')
  const copy = meetingNoticeCopy(row, nowMs)
  const captureId = row.ref_type === 'capture' ? row.ref_id : null
  const bot = face
    ? botNoticeMetadata({
        teammateId: face,
        teammateName: await noticeTeammateName(supabase, row.workspace_id, face),
        sentence: copy.sentence,
        captureId,
        area: 'calendar',
      })
    : {}
  const said = botNoticeCopy(bot, { title: copy.title, body: copy.body })
  await createNotification({
    workspaceId: row.workspace_id,
    recipientId: memberId,
    type: 'meeting_starting_soon',
    title: said.title,
    body: said.body,
    ...(captureId ? { targetType: 'capture' as const, targetId: captureId } : {}),
    groupKey,
    metadata: { agent_event_id: row.id, scheduled_start: row.occurs_at, prep_ready: row.facts?.prepReady === true, ...bot },
  })
  return noticeIdByGroup(supabase, memberId, groupKey)
}

/**
 * The notice already out for a row: a notice's event's own notification (its
 * ref: a mention, an activity, a reminder…), or the recorder's `work_needs_you` / `work_failed` for a work item. Null
 * when none is found (a grouped failure notice names another item).
 */
export async function findExistingNotice(supabase: SupabaseClient, row: AgentEventRow): Promise<string | null> {
  if (NOTICE_KINDS.has(row.kind)) return row.ref_type === 'notification' && row.ref_id ? row.ref_id : null
  if (row.ref_type !== 'work_item' || !row.ref_id) return null
  const memberId = await memberIdFor(supabase, row.workspace_id, row.user_id)
  if (!memberId) return null
  const { data } = await supabase
    .from('notification')
    .select('id')
    .eq('recipient_id', memberId)
    .eq('target_type', 'work_item')
    .eq('target_id', row.ref_id)
    .in('type', ['work_needs_you', 'work_failed'])
    .order('created_at', { ascending: false })
    .limit(1)
  const id = Array.isArray(data) ? (data[0] as { id?: unknown } | undefined)?.id : null
  return typeof id === 'string' ? id : null
}

/** The Inngest event id of an event turn's request: one per home thread and set of rows (a retried pass sends nothing twice). */
export function eventTurnRequestId(conversationId: string, eventIds: readonly string[]): string {
  return `home-turn-event:${conversationId}:${[...eventIds].sort().join(',')}`.slice(0, 250)
}

/**
 * ONE `home/turn.requested` (reason 'event') for the person's home thread,
 * carrying the pass's turn rows. The consumer debounces 90 s per conversation
 * and reason and re-reads every undelivered turn row itself, so the ids are a
 * hint, never trusted. False when the person has no home thread (the rows
 * wait for "while you were away" and the digest). Throws on a failed read or
 * send (the router logs it).
 */
export async function requestEventTurn(
  supabase: SupabaseClient,
  person: { workspaceId: string; userId: string },
  eventIds: string[],
  deps: { send?: (payload: { id: string; name: string; data: Record<string, unknown> }) => Promise<unknown> } = {},
): Promise<boolean> {
  const { data, error } = await supabase
    .from('chat_conversations')
    .select('id')
    .eq('user_id', person.userId)
    .eq('workspace_id', person.workspaceId)
    .eq('is_home', true)
    .limit(1)
  if (error) throw new Error(`home thread read failed: ${error.message}`)
  const conversationId = (data as Array<{ id?: unknown }> | null)?.[0]?.id
  if (typeof conversationId !== 'string') return false
  const ids = eventIds.filter((id) => /^[0-9]{1,19}$/.test(id)).slice(0, HOME_TURN_MAX_DIGEST_EVENTS)
  const send =
    deps.send ??
    (async (payload: { id: string; name: string; data: Record<string, unknown> }) => {
      const { inngest } = await import('@/lib/inngest/client')
      return inngest.send(payload as never)
    })
  await send({
    id: eventTurnRequestId(conversationId, ids),
    name: HOME_TURN_REQUESTED_EVENT,
    data: { conversationId, userId: person.userId, workspaceId: person.workspaceId, workItemIds: [], reason: 'event', eventIds: ids },
  })
  return true
}

/** The router's production dependencies. */
export function defaultRouterDeps(): RouterDeps {
  return {
    isPaused: routerPaused,
    isDormant: (supabase, workspaceId) => workspaceIsDormant(supabase as Parameters<typeof workspaceIsDormant>[0], workspaceId),
    isOverUsage: isOverBackgroundUsage,
    decide: decideEventNeedsPersonShadow,
    provenKinds: jevProvenKinds,
    sendMeetingNotice: (supabase, row) => sendMeetingNotice(supabase, row),
    findNotice: findExistingNotice,
    requestTurn: (supabase, person, eventIds) => requestEventTurn(supabase, person, eventIds),
  }
}
