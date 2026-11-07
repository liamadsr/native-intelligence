import type { GetStepTools } from 'inngest'
import { getServiceClient } from '@/lib/admin'
import { inngest } from './client'
import {
  REACH_ROUTE_DEBOUNCE_PERIOD,
  REACH_ROUTE_DEBOUNCE_TIMEOUT,
  REACH_ROUTE_EVENT,
  REACH_ROUTE_RECHECK,
  REACH_ROUTE_RECHECKS,
  liveRouteDeps,
  parseRouteRequested,
  planRoute,
  routeLive,
  routeLogLine,
  type RouteChannel,
  type RouteDecision,
  type RouteWould,
} from '@/lib/reach/route'

/** The most rounds one run plans: twelve rechecks, two nights' waits and a few sends, with room to spare. */
export const REACH_ROUTE_MAX_ROUNDS = 24
/** A run waits out quiet hours at most this many times (a wait ends after them, so one is the norm). */
export const REACH_ROUTE_MAX_WAITS = 2

/** The context a route run gets (its event and Inngest's step tools). */
export interface ReachRouteRunContext {
  event: { data: unknown }
  step: GetStepTools<typeof inngest>
}

/**
 * reach/route.requested → the agent's messages in a home thread find the
 * person (src/lib/reach/route.ts). Debounced 2 minutes per conversation (the
 * grace: he may be reading it), one run per person at a time, and a newer
 * request for the same thread cancels a run that is sleeping: the next run
 * reads everything again, so nothing is lost.
 *
 * Each round is one `plan-<n>` step (planRoute: read, decide, and banner or
 * send inside the step, so the words never reach a step output):
 *   done    stop
 *   banner  he is at an app and was told: sleep REACH_ROUTE_RECHECK and look
 *           again, at most REACH_ROUTE_RECHECKS times (2 hours). The last look
 *           settles: still there and never opened, what the banner covered is
 *           claimed on 'banner' and done for good (`present_unread`), so a
 *           later run never texts it; gone by then, it is texted as usual
 *   wait    quiet hours: sleep until 08:05 his time, then look again
 *   sent    look again at once (claimed messages drop out); a round that
 *           claimed nothing stops, so a ledger that can't be written never
 *           loops
 * One `[reach-route]` line per run, ids and outcomes only.
 */
export async function runReachRoute({ event, step }: ReachRouteRunContext) {
  const data = parseRouteRequested(event.data)
  if (!data) {
    console.info(routeLogLine({ data: null, rounds: 0, outcome: 'bad_event' }))
    return { status: 'skipped', reason: 'bad_event' }
  }
  const live = routeLive()
  let rechecks = 0
  let waits = 0
  let sent = 0
  let channel: RouteChannel | null = null
  let outcome = 'max_rounds'
  let would: RouteWould | undefined
  let rounds = 0
  for (let n = 0; n < REACH_ROUTE_MAX_ROUNDS; n++) {
    rounds = n + 1
    const settle = rechecks >= REACH_ROUTE_RECHECKS
    const decision = (await step.run(`plan-${n}`, () => planRoute(data, liveRouteDeps(getServiceClient()), { live, settle }))) as RouteDecision
    if (decision.kind === 'done') {
      outcome = decision.outcome
      would = decision.would
      break
    }
    if (decision.kind === 'banner') {
      if (settle) {
        // planRoute settles on its last look; a banner here would only come from an older plan.
        outcome = 'present_unread'
        break
      }
      rechecks++
      await step.sleep(`recheck-${rechecks}`, REACH_ROUTE_RECHECK)
      continue
    }
    if (decision.kind === 'wait') {
      if (waits >= REACH_ROUTE_MAX_WAITS) {
        outcome = 'waited'
        break
      }
      waits++
      channel = decision.channel
      await step.sleepUntil(`quiet-${waits}`, new Date(decision.untilMs))
      continue
    }
    sent += decision.sent
    channel = decision.channel
    if (decision.sent + decision.failed === 0) {
      outcome = 'stalled'
      break
    }
  }
  console.info(routeLogLine({ data, rounds, outcome, sent, channel, would }))
  return { status: 'done', outcome, sent, rounds, ...(channel ? { channel } : {}) }
}

export const reachRoute = inngest.createFunction(
  {
    id: 'reach-route',
    retries: 2,
    debounce: { key: 'event.data.conversationId', period: REACH_ROUTE_DEBOUNCE_PERIOD, timeout: REACH_ROUTE_DEBOUNCE_TIMEOUT },
    concurrency: [{ limit: 1, key: 'event.data.userId' }],
    cancelOn: [{ event: REACH_ROUTE_EVENT, match: 'data.conversationId' }],
    triggers: [{ event: REACH_ROUTE_EVENT }],
  },
  runReachRoute,
)
