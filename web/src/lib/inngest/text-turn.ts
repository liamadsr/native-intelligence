import type { SupabaseClient } from '@supabase/supabase-js'
import { getServiceClient } from '@/lib/admin'
import { inngest } from './client'
import { parseHomeTurnRequested, type HomeTurnRequestedData } from '@/lib/chat/home-turn'
import { TEXT_TURN_REQUESTED_EVENT } from '@/lib/chat/text-turn'
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
import { hydrateChannelPlan, redactChannelPlan, settleTextTurn, textTurnNotice, textTurnSkipNotice, type TextTurnSettled } from '@/lib/chat/text-turn-server'

/**
 * A short debounce per conversation: a few texts sent in a row become one
 * turn (the plan gathers every text no earlier turn carried, whichever event
 * the debounce kept), without making a single text wait long.
 */
export const TEXT_TURN_DEBOUNCE_PERIOD = '3s'
export const TEXT_TURN_DEBOUNCE_TIMEOUT = '20s'
/** How long a text turn waits for another home turn's lease, and how many times (10 min in all). */
export const TEXT_TURN_LEASE_WAIT = '20s'
export const TEXT_TURN_LEASE_WAITS = 30

/** What the send and read steps return: still reading (the cursor), settled (outcomes only), or failed. */
export type TextTurnStep =
  | { kind: 'reading'; state: HomeTurnReadState }
  | { kind: 'settled'; settled: TextTurnSettled }
  | { kind: 'failed'; error: string }

/**
 * Send (or read on) and, once the turn is read to its end, settle it in the
 * SAME step (finish, then text the reply back): so the reply's words never
 * become a step output. Only a turn still running at a step's budget hands on
 * its read state.
 */
export async function textTurnStep(
  supabase: SupabaseClient,
  data: HomeTurnRequestedData,
  plan: HomeTurnPlan,
  row: HomeTurnRow,
  run: (plan: HomeTurnPlan) => Promise<HomeTurnStepResult>,
  lastStep: boolean,
): Promise<TextTurnStep> {
  const result = await run(plan)
  if (result.kind === 'failed') return { kind: 'failed', error: result.error }
  if (!result.result.done && !lastStep) return { kind: 'reading', state: result.result.state }
  return { kind: 'settled', settled: await settleTextTurn(supabase, data, row, result.result) }
}

/**
 * text/turn.requested → one text turn in the person's home thread
 * (docs/plans/text-and-calling.md, Phase 1): the webhook
 * (src/app/api/twilio/sms/route.ts) wrote the person's text into the thread
 * and sent the event; this runs the home-turn steps with reason 'text'
 * (src/lib/chat/home-turn-server.ts) as the `channel_turn` principal (surface
 * `sms`), then texts the reply back (src/lib/chat/text-turn-server.ts).
 *
 * Its own function, not home/turn.requested: no 90 s debounce (a person is
 * waiting on their phone) and its own lease wait. It still takes the home
 * thread's lease (claimHomeTurn), so it never runs over a digest or a helper's
 * report in the same thread; while one holds it, the text waits.
 *
 * Steps: plan (ids only: the texts' words never ride a step output) → claim →
 * send (the words read back inside; settles in the same step when the turn
 * ends inside it) → read-1…n (likewise). Settling writes the reply unless it
 * is empty or `[quiet]` and texts it back, claimed on the row so a retry never
 * texts twice; a failed turn with nothing to say texts a short notice. A skip
 * the person should hear about (a question waits for them in the app,
 * autonomy off, over their limit) records its `skipped` row, which carries
 * the texts (never replayed later), and texts one notice. One `[text-turn]`
 * line per run.
 */
export const textTurn = inngest.createFunction(
  {
    id: 'text-turn',
    retries: 2,
    debounce: { key: 'event.data.conversationId', period: TEXT_TURN_DEBOUNCE_PERIOD, timeout: TEXT_TURN_DEBOUNCE_TIMEOUT },
    concurrency: [{ limit: 1, key: 'event.data.conversationId' }],
    triggers: [{ event: TEXT_TURN_REQUESTED_EVENT }],
  },
  async ({ event, step }) => {
    const data = parseHomeTurnRequested(event.data)
    if (!data || data.reason !== 'text') {
      console.info(textTurnLogLine({ conversationId: '-', outcome: 'bad_event' }))
      return { status: 'skipped', reason: 'bad_event' }
    }
    // To whoever the turn answers: the person, or (guest access) the guest, in their own words.
    const notify = async (reason: Parameters<typeof textTurnSkipNotice>[0]) => {
      if (!data.guestId && !textTurnSkipNotice(reason)) return
      await step.run('notice', () => textTurnNotice(getServiceClient(), data, reason))
    }

    let plan: Extract<HomeTurnPlanResult, { ok: true }> | null = null
    let row: HomeTurnRow | null = null
    for (let attempt = 0; ; attempt++) {
      const suffix = attempt === 0 ? '' : `-${attempt}`
      const planned = (await step.run(`plan${suffix}`, async () => redactChannelPlan(await planHomeTurn(getServiceClient(), data)))) as HomeTurnPlanResult
      if (!planned.ok) {
        const record = planned.record
        if (record) await step.run(`record-skip${suffix}`, () => recordSkippedHomeTurn(getServiceClient(), data, { reason: planned.reason, record }))
        console.info(textTurnLogLine({ conversationId: data.conversationId, texts: record?.channelMessages?.length, outcome: planned.reason }))
        await notify(planned.reason)
        return { status: 'skipped', reason: planned.reason }
      }
      const claim = (await step.run(`claim${suffix}`, () => claimHomeTurn(getServiceClient(), data, planned))) as HomeTurnClaim
      if (claim.kind === 'duplicate') {
        console.info(textTurnLogLine({ conversationId: data.conversationId, texts: planned.channelMessages?.length, outcome: 'duplicate' }))
        return { status: 'skipped', reason: 'duplicate' }
      }
      if (claim.kind === 'busy') {
        if (attempt >= TEXT_TURN_LEASE_WAITS) {
          console.info(textTurnLogLine({ conversationId: data.conversationId, texts: planned.channelMessages?.length, outcome: 'busy' }))
          await notify('busy')
          return { status: 'skipped', reason: 'busy' }
        }
        await step.sleep(`lease-wait-${attempt + 1}`, TEXT_TURN_LEASE_WAIT)
        continue
      }
      plan = planned
      row = claim.row
      break
    }

    if (!plan || !row) return { status: 'skipped', reason: 'busy' }
    const turnPlan = plan
    const turnRow = row
    const texts = turnPlan.channelMessages?.length
    let step_ = (await step.run('send', async () => {
      const supabase = getServiceClient()
      const hydrated = await hydrateChannelPlan(supabase, data, turnPlan)
      return textTurnStep(supabase, data, hydrated, turnRow, (p) => sendHomeTurn(supabase, data, p, turnRow), false)
    })) as TextTurnStep
    for (let n = 1; n <= HOME_TURN_MAX_READ_STEPS && step_.kind === 'reading'; n++) {
      const state = step_.state
      step_ = (await step.run(`read-${n}`, async () => {
        const supabase = getServiceClient()
        return textTurnStep(supabase, data, turnPlan, turnRow, (p) => continueHomeTurn(supabase, data, p, turnRow, state), n === HOME_TURN_MAX_READ_STEPS)
      })) as TextTurnStep
    }
    if (step_.kind === 'failed') {
      console.info(textTurnLogLine({ conversationId: data.conversationId, rowId: turnRow.id, texts, outcome: step_.error }))
      await notify('failed')
      return { status: 'failed', reason: step_.error, rowId: turnRow.id }
    }
    if (step_.kind !== 'settled') return { status: 'failed', reason: 'unsettled', rowId: turnRow.id }
    const { settled } = step_
    const outcome = settled.replied ? `${settled.outcome}:texted` : settled.notice ? `${settled.outcome}:notice_${settled.notice}` : settled.outcome
    console.info(textTurnLogLine({ conversationId: data.conversationId, rowId: turnRow.id, texts, outcome }))
    return { status: 'done', outcome: settled.outcome, rowId: turnRow.id, written: settled.written, replied: settled.replied }
  },
)

/** The one log line per run. Counts and ids only (never a number or a word of a text). */
export function textTurnLogLine(args: { conversationId: string; rowId?: string; texts?: number; outcome: string }): string {
  return homeTurnLogLine({ conversationId: args.conversationId, rowId: args.rowId, reports: args.texts, outcome: args.outcome }).replace('[home-turn]', '[text-turn]').replace(' reports=', ' texts=')
}
