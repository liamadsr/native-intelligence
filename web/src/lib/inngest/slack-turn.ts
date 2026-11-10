import type { SupabaseClient } from '@supabase/supabase-js'
import { getServiceClient } from '@/lib/admin'
import { inngest } from './client'
import { parseHomeTurnRequested, type HomeTurnRequestedData } from '@/lib/chat/home-turn'
import {
  HOME_TURN_MAX_READ_STEPS,
  claimHomeTurn,
  continueHomeTurn,
  homeTurnLogLine,
  planHomeTurn,
  recordSkippedHomeTurn,
  sendHomeTurn,
  type HomeTurnClaim,
  type HomeTurnPlan,
  type HomeTurnPlanResult,
  type HomeTurnReadState,
  type HomeTurnRow,
  type HomeTurnStepResult,
} from '@/lib/chat/home-turn-server'
import { openSlackDm, slackTurnSlack } from '@/lib/slack/deps'
import {
  SLACK_TURN_REQUESTED_EVENT,
  hydrateChannelPlan,
  noticeToPerson,
  plannedMessageIds,
  redactChannelPlan,
  guestSlackTurnSkipNotice,
  replyOrigin,
  settleSlackTurn,
  slackTurnSkipNotice,
  type SlackOrigin,
  type SlackTurnSettled,
} from '@/lib/slack/turn'

/**
 * A short debounce per conversation: a few messages sent in a row become one
 * turn (the plan gathers every message no earlier turn carried, whichever
 * event the debounce kept), without making a single message wait long.
 */
export const SLACK_TURN_DEBOUNCE_PERIOD = '3s'
export const SLACK_TURN_DEBOUNCE_TIMEOUT = '20s'
/** How long a Slack turn waits for another home turn's lease, and how many times (10 min in all). */
export const SLACK_TURN_LEASE_WAIT = '20s'
export const SLACK_TURN_LEASE_WAITS = 30

/** What the send and read steps return: still reading (the cursor), settled (outcomes only), or failed. */
export type SlackTurnStep =
  | { kind: 'reading'; state: HomeTurnReadState }
  | { kind: 'settled'; settled: SlackTurnSettled }
  | { kind: 'failed'; error: string }

/**
 * Send (or read on) and, once the turn is read to its end, settle it in the
 * SAME step (finish, then post the reply back): so the reply's words never
 * become a step output. Only a turn still running at a step's budget hands on
 * its read state.
 */
export async function slackTurnStep(
  supabase: SupabaseClient,
  data: HomeTurnRequestedData,
  plan: HomeTurnPlan,
  row: HomeTurnRow,
  origin: SlackOrigin | null,
  run: (plan: HomeTurnPlan) => Promise<HomeTurnStepResult>,
  lastStep: boolean,
): Promise<SlackTurnStep> {
  const result = await run(plan)
  if (result.kind === 'failed') return { kind: 'failed', error: result.error }
  if (!result.result.done && !lastStep) return { kind: 'reading', state: result.result.state }
  const slack = origin ? slackTurnSlack(origin.installation_id) : null
  return { kind: 'settled', settled: await settleSlackTurn(supabase, data, row, result.result, origin && slack ? { origin, slack } : null) }
}

/**
 * slack/turn.requested → one Slack turn in the person's home thread
 * (docs/plans/slack-connect.md §4 piece 5): the intake (src/lib/slack/turn.ts
 * deliverSlackDm) wrote the person's DM into the thread and sent the event;
 * this runs the home-turn steps with reason 'slack'
 * (src/lib/chat/home-turn-server.ts) as the `channel_turn` principal (surface
 * `slack`), then posts the reply back to the DM.
 *
 * Its own function, not home/turn.requested: no 90 s debounce (a person is
 * waiting in Slack) and its own lease wait. It still takes the home thread's
 * lease (claimHomeTurn), so it never runs over a digest or a helper's report
 * in the same thread; while one holds it, the message waits.
 *
 * Steps: plan (ids only: the messages' words, and a fresh session's primer,
 * never ride a step output) → claim → origin (where to answer: the person's
 * own DM in a team bound to this workspace, rebuilt from the server's rows,
 * never the message row's word, src/lib/slack/turn.ts replyOrigin) →
 * send (the words read back inside; settles in the same step when the turn
 * ends inside it) → read-1…n (likewise). Settling writes the reply unless it
 * is empty and posts it back, claimed on the row so a retry never posts
 * twice; a failed turn with nothing to say posts a short notice. A skip the
 * person should hear about (a question waits for them in the app, over their
 * limit) records its `skipped` row, which carries the messages (never
 * replayed later), and posts one notice. One `[slack-turn]` line per run.
 */
export const slackTurn = inngest.createFunction(
  {
    id: 'slack-turn',
    retries: 2,
    debounce: { key: 'event.data.conversationId', period: SLACK_TURN_DEBOUNCE_PERIOD, timeout: SLACK_TURN_DEBOUNCE_TIMEOUT },
    concurrency: [{ limit: 1, key: 'event.data.conversationId' }],
    triggers: [{ event: SLACK_TURN_REQUESTED_EVENT }],
  },
  async ({ event, step }) => {
    const data = parseHomeTurnRequested(event.data)
    if (!data || data.reason !== 'slack') {
      console.info(slackTurnLogLine({ conversationId: '-', outcome: 'bad_event' }))
      return { status: 'skipped', reason: 'bad_event' }
    }
    const notify = async (reason: Parameters<typeof slackTurnSkipNotice>[0], origin: SlackOrigin | null) => {
      // A guest (guest access) is told in their own words: they have no Native Intelligence to look in.
      const notice = data.guestId ? guestSlackTurnSkipNotice(reason) : slackTurnSkipNotice(reason)
      if (!notice || !origin) return
      // In a channel thread, only the person sees it (it concerns no one else).
      await step.run('notice', () => noticeToPerson(origin, slackTurnSlack(origin.installation_id), notice))
    }
    const originOf = (ids: string[], suffix = '') =>
      step.run(`origin${suffix}`, () => replyOrigin(getServiceClient(), data, ids, { openDm: openSlackDm })) as Promise<SlackOrigin | null>

    let plan: Extract<HomeTurnPlanResult, { ok: true }> | null = null
    let row: HomeTurnRow | null = null
    for (let attempt = 0; ; attempt++) {
      const suffix = attempt === 0 ? '' : `-${attempt}`
      const planned = (await step.run(`plan${suffix}`, async () => redactChannelPlan(await planHomeTurn(getServiceClient(), data)))) as HomeTurnPlanResult
      if (!planned.ok) {
        const record = planned.record
        if (record) await step.run(`record-skip${suffix}`, () => recordSkippedHomeTurn(getServiceClient(), data, { reason: planned.reason, record }))
        console.info(slackTurnLogLine({ conversationId: data.conversationId, messages: record?.channelMessages?.length, outcome: planned.reason }))
        const ids = plannedMessageIds(planned)
        if (ids.length) await notify(planned.reason, await originOf(ids, suffix))
        return { status: 'skipped', reason: planned.reason }
      }
      const claim = (await step.run(`claim${suffix}`, () => claimHomeTurn(getServiceClient(), data, planned))) as HomeTurnClaim
      if (claim.kind === 'duplicate') {
        console.info(slackTurnLogLine({ conversationId: data.conversationId, messages: planned.channelMessages?.length, outcome: 'duplicate' }))
        return { status: 'skipped', reason: 'duplicate' }
      }
      if (claim.kind === 'busy') {
        if (attempt >= SLACK_TURN_LEASE_WAITS) {
          console.info(slackTurnLogLine({ conversationId: data.conversationId, messages: planned.channelMessages?.length, outcome: 'busy' }))
          await notify('busy', await originOf(plannedMessageIds(planned), suffix))
          return { status: 'skipped', reason: 'busy' }
        }
        await step.sleep(`lease-wait-${attempt + 1}`, SLACK_TURN_LEASE_WAIT)
        continue
      }
      plan = planned
      row = claim.row
      break
    }

    if (!plan || !row) return { status: 'skipped', reason: 'busy' }
    const turnPlan = plan
    const turnRow = row
    const messages = turnPlan.channelMessages?.length
    const origin = await originOf(plannedMessageIds(turnPlan), '-turn')
    if (!origin) {
      // Nowhere to answer (the message row lost its origin): the turn still
      // runs, and the reply stays in the home thread.
      console.warn(slackTurnLogLine({ conversationId: data.conversationId, rowId: turnRow.id, messages, outcome: 'no_origin' }))
    }
    let step_ = (await step.run('send', async () => {
      const supabase = getServiceClient()
      const hydrated = await hydrateChannelPlan(supabase, data, turnPlan)
      return slackTurnStep(supabase, data, hydrated, turnRow, origin, (p) => sendHomeTurn(supabase, data, p, turnRow), false)
    })) as SlackTurnStep
    for (let n = 1; n <= HOME_TURN_MAX_READ_STEPS && step_.kind === 'reading'; n++) {
      const state = step_.state
      step_ = (await step.run(`read-${n}`, async () => {
        const supabase = getServiceClient()
        return slackTurnStep(supabase, data, turnPlan, turnRow, origin, (p) => continueHomeTurn(supabase, data, p, turnRow, state), n === HOME_TURN_MAX_READ_STEPS)
      })) as SlackTurnStep
    }
    if (step_.kind === 'failed') {
      console.info(slackTurnLogLine({ conversationId: data.conversationId, rowId: turnRow.id, messages, outcome: step_.error }))
      await notify('failed', origin)
      return { status: 'failed', reason: step_.error, rowId: turnRow.id }
    }
    if (step_.kind !== 'settled') return { status: 'failed', reason: 'unsettled', rowId: turnRow.id }
    const { settled } = step_
    const outcome = settled.posted ? `${settled.outcome}:posted` : settled.notice ? `${settled.outcome}:notice_${settled.notice}` : `${settled.outcome}${settled.postReason ? `:${settled.postReason}` : ''}`
    console.info(slackTurnLogLine({ conversationId: data.conversationId, rowId: turnRow.id, messages, outcome }))
    return { status: 'done', outcome: settled.outcome, rowId: turnRow.id, written: settled.written, posted: settled.posted }
  },
)

/** The one log line per run. Counts and ids only (never a word of a message). */
export function slackTurnLogLine(args: { conversationId: string; rowId?: string; messages?: number; outcome: string }): string {
  return homeTurnLogLine({ conversationId: args.conversationId, rowId: args.rowId, reports: args.messages, outcome: args.outcome })
    .replace('[home-turn]', '[slack-turn]')
    .replace(' reports=', ' messages=')
}
