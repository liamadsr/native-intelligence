/**
 * The look-ahead's runs (docs/plans/look-ahead-heartbeat.md;
 * src/lib/look-ahead/run.ts), requested by the hourly member scan
 * (./agent-events.ts agentEventDigest) at 19:00 local (tomorrow morning) and
 * 08:00 (later today).
 *
 * lookAheadRun, one per person and slot. Steps: the usage gate (live people
 * only, before any model work); the deliver (calendar, mail, model, checks
 * and the write in ONE step whose output holds only the row id, the
 * departures' calendar keys and counts: no mail-derived words in a stored
 * step output); the route (`route`: the router, src/lib/reach/route.ts,
 * takes the message's text to the person when they are away from the app,
 * outside quiet hours, once per person, slot and date); then each
 * departure's heads-up, scheduled for about 3 hours before it.
 *
 * lookAheadTravel, one per departure, at its time: the calendar read again
 * (a moved or cancelled trip says nothing), then the heads-up's message and
 * notice, and its route.
 */
import { getServiceClient } from '@/lib/admin'
import { logUsage } from '@/lib/ai/auth'
import { usageProviderLabel } from '@/lib/ai/models'
import { usageCacheMetadata } from '@/lib/chat/eve-usage'
import { runUtilityTask } from '@/lib/eve/utility/run-utility'
import { LookAheadExtractSchema } from '@/lib/look-ahead/facts'
import { writeLookAhead } from '@/lib/look-ahead/message'
import { routeRequestEvent } from '@/lib/reach/route'
import {
  LOOK_AHEAD_REQUESTED_EVENT,
  LOOK_AHEAD_TRAVEL_EVENT,
  deliverLookAhead,
  lookAheadLive,
  readDepartureLine,
  travelEvents,
  type LookAheadRequestData,
  type LookAheadTravelData,
} from '@/lib/look-ahead/run'
import { inngest } from './client'
import { guardBackgroundUsageOnPlan } from './usage-guard'

export const lookAheadRun = inngest.createFunction(
  {
    id: 'look-ahead-run',
    retries: 1,
    // One at a time per person; the plan's limit (5) overall.
    concurrency: [{ limit: 1, key: 'event.data.userId' }, { limit: 5 }],
    triggers: [{ event: LOOK_AHEAD_REQUESTED_EVENT }],
  },
  async ({ event, step }) => {
    const data = event.data as LookAheadRequestData
    const live = lookAheadLive(data.userId)
    // A live run spends money: the usage gate first, in a step (a replay doesn't re-check).
    const { chatgptPlan } = live ? await step.run('guard', () => guardBackgroundUsageOnPlan(data.userId)) : { chatgptPlan: false }

    const delivered = await step.run('deliver', async () => {
      const supabase = getServiceClient()
      return deliverLookAhead(supabase, data, {
        extract: async ({ message }) => {
          const result = await runUtilityTask({
            kind: 'look_ahead_extract',
            supabase,
            workspaceId: data.workspaceId,
            userId: data.userId,
            chatgptPlan,
            outputSchema: LookAheadExtractSchema,
            message,
          })
          await logUsage(data.userId, {
            provider: usageProviderLabel(result.model),
            model: result.model,
            feature: 'look_ahead.extract',
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            durationMs: 0,
            costUsd: result.usage.costUsd ?? undefined,
            idempotencyKey: `look-ahead:${data.conversationId}:${data.date}:${data.slot}`,
            metadata: { workspace_id: data.workspaceId, ...usageCacheMetadata(result.usage) },
          })
          return LookAheadExtractSchema.parse(result.object)
        },
      })
    })

    if (delivered.status === 'shadow') {
      console.info(delivered.line)
      return { status: 'shadow', candidates: delivered.candidates }
    }
    if (delivered.status !== 'sent') return { status: delivered.status }

    // Whether this try wrote the row or an earlier one did: the router's claim keeps it to one text.
    await step.sendEvent('route', routeRequestEvent({ userId: data.userId, workspaceId: data.workspaceId, conversationId: data.conversationId }, `look-ahead:${delivered.rowId}`))
    const travel = travelEvents(data, delivered.departures, Date.now())
    if (travel.length) await step.sendEvent('schedule-departures', travel)
    console.info(
      `[look-ahead] live user=${data.userId} slot=${data.slot} date=${delivered.date} candidates=${delivered.candidates} bookings=${delivered.bookings} sent=${delivered.lines} extracted=${delivered.extracted} first=${delivered.first} routed=true departures=${travel.length}`,
    )
    return { status: 'sent', lines: delivered.lines, routed: true, departures: travel.length }
  },
)

export const lookAheadTravel = inngest.createFunction(
  {
    id: 'look-ahead-travel',
    retries: 1,
    concurrency: [{ limit: 1, key: 'event.data.userId' }, { limit: 5 }],
    triggers: [{ event: LOOK_AHEAD_TRAVEL_EVENT }],
  },
  async ({ event, step }) => {
    const data = event.data as LookAheadTravelData
    // Still live, and the kill switch still on (fails closed): a heads-up is an unasked message.
    if (!lookAheadLive(data.userId)) return { status: 'shadow' }
    const line = await step.run('read', async () => {
      const supabase = getServiceClient()
      const { readAgentPausedState } = await import('@/lib/work/agent-paused')
      const state = await readAgentPausedState(supabase, data.workspaceId).catch(() => 'unknown' as const)
      return state === 'active' ? readDepartureLine(supabase, data) : null
    })
    if (!line) return { status: 'gone' }
    const of = { travel: { meetingKey: data.meetingKey, startIso: data.startIso } }
    const written = await step.run('write', () =>
      writeLookAhead(getServiceClient(), { workspaceId: data.workspaceId, userId: data.userId, memberId: data.memberId, conversationId: data.conversationId, of, lines: [line], timeZone: data.timeZone }),
    )
    if (!written) return { status: 'not_written' }
    await step.sendEvent('route', routeRequestEvent({ userId: data.userId, workspaceId: data.workspaceId, conversationId: data.conversationId }, `look-ahead:${written.rowId}`))
    return { status: 'sent', first: written.first, routed: true }
  },
)
