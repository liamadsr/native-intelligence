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
import { hydrateChannelPlan, redactChannelPlan } from '@/lib/chat/channel-turn-server'
import { AGENT_LINK_TURN_REQUESTED_EVENT } from '@/lib/agent-links/exchange'
import { sendLinkTurnNotice, settleAgentLinkTurn, type LinkTurnSettled } from '@/lib/agent-links/link-turn-server'

/** A few messages from the other agent in a row become one turn, as a few texts do. */
export const AGENT_LINK_TURN_DEBOUNCE_PERIOD = '3s'
export const AGENT_LINK_TURN_DEBOUNCE_TIMEOUT = '20s'
/** How long the turn waits for another turn's lease in the same thread, and how many times (10 min in all). */
export const AGENT_LINK_TURN_LEASE_WAIT = '20s'
export const AGENT_LINK_TURN_LEASE_WAITS = 30

/** What the send and read steps return: still reading (the cursor), settled (outcomes only), or failed. */
export type AgentLinkTurnStep =
  | { kind: 'reading'; state: HomeTurnReadState }
  | { kind: 'settled'; settled: LinkTurnSettled }
  | { kind: 'failed'; error: string }

/** Send (or read on) and, once the turn is read to its end, settle it in the SAME step, so the reply never becomes a step output. */
export async function agentLinkTurnStep(
  supabase: SupabaseClient,
  data: HomeTurnRequestedData,
  plan: HomeTurnPlan,
  row: HomeTurnRow,
  run: (plan: HomeTurnPlan) => Promise<HomeTurnStepResult>,
  lastStep: boolean,
): Promise<AgentLinkTurnStep> {
  const result = await run(plan)
  if (result.kind === 'failed') return { kind: 'failed', error: result.error }
  if (!result.result.done && !lastStep) return { kind: 'reading', state: result.result.state }
  return { kind: 'settled', settled: await settleAgentLinkTurn(supabase, data, row, result.result) }
}

/**
 * agent-link/turn.requested → one turn of the agent an owner set up for
 * another Native Intelligence user, answering that user's agent (agent links, migration
 * 435; src/lib/agent-links/exchange.ts askAgent wrote the message into the
 * half's thread and sent the event). The home-turn steps with reason
 * 'agent_ask' as a guest's `channel_turn` (surface 'dial8', the half's
 * `guestId`), billed to this owner (decision 8), then the reply goes back
 * over the link (src/lib/agent-links/link-turn-server.ts).
 *
 * Steps as the text turn's (src/lib/inngest/text-turn.ts): plan (ids only) →
 * claim (the thread's lease, waiting while another turn holds it) → send →
 * read-1…n, settling in the step the turn ends in. A skip the asking agent
 * should hear about sends it a short note over the link. One
 * `[agent-link-turn]` line per run.
 */
export const agentLinkTurn = inngest.createFunction(
  {
    id: 'agent-link-turn',
    retries: 2,
    debounce: { key: 'event.data.conversationId', period: AGENT_LINK_TURN_DEBOUNCE_PERIOD, timeout: AGENT_LINK_TURN_DEBOUNCE_TIMEOUT },
    concurrency: [{ limit: 1, key: 'event.data.conversationId' }],
    triggers: [{ event: AGENT_LINK_TURN_REQUESTED_EVENT }],
  },
  async ({ event, step }) => {
    const data = parseHomeTurnRequested(event.data)
    if (!data || data.reason !== 'agent_ask' || !data.guestId) {
      console.info(agentLinkTurnLogLine({ conversationId: '-', outcome: 'bad_event' }))
      return { status: 'skipped', reason: 'bad_event' }
    }
    const notify = async (reason: Parameters<typeof sendLinkTurnNotice>[2]) => {
      await step.run('notice', () => sendLinkTurnNotice(getServiceClient(), data, reason, `skip:${event.id ?? data.conversationId}:${reason}`))
    }

    let plan: Extract<HomeTurnPlanResult, { ok: true }> | null = null
    let row: HomeTurnRow | null = null
    for (let attempt = 0; ; attempt++) {
      const suffix = attempt === 0 ? '' : `-${attempt}`
      const planned = (await step.run(`plan${suffix}`, async () => redactChannelPlan(await planHomeTurn(getServiceClient(), data)))) as HomeTurnPlanResult
      if (!planned.ok) {
        const record = planned.record
        if (record) await step.run(`record-skip${suffix}`, () => recordSkippedHomeTurn(getServiceClient(), data, { reason: planned.reason, record }))
        console.info(agentLinkTurnLogLine({ conversationId: data.conversationId, messages: record?.channelMessages?.length, outcome: planned.reason }))
        await notify(planned.reason)
        return { status: 'skipped', reason: planned.reason }
      }
      const claim = (await step.run(`claim${suffix}`, () => claimHomeTurn(getServiceClient(), data, planned))) as HomeTurnClaim
      if (claim.kind === 'duplicate') {
        console.info(agentLinkTurnLogLine({ conversationId: data.conversationId, messages: planned.channelMessages?.length, outcome: 'duplicate' }))
        return { status: 'skipped', reason: 'duplicate' }
      }
      if (claim.kind === 'busy') {
        if (attempt >= AGENT_LINK_TURN_LEASE_WAITS) {
          console.info(agentLinkTurnLogLine({ conversationId: data.conversationId, messages: planned.channelMessages?.length, outcome: 'busy' }))
          await notify('busy')
          return { status: 'skipped', reason: 'busy' }
        }
        await step.sleep(`lease-wait-${attempt + 1}`, AGENT_LINK_TURN_LEASE_WAIT)
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
    let step_ = (await step.run('send', async () => {
      const supabase = getServiceClient()
      const hydrated = await hydrateChannelPlan(supabase, data, turnPlan)
      return agentLinkTurnStep(supabase, data, hydrated, turnRow, (p) => sendHomeTurn(supabase, data, p, turnRow), false)
    })) as AgentLinkTurnStep
    for (let n = 1; n <= HOME_TURN_MAX_READ_STEPS && step_.kind === 'reading'; n++) {
      const state = step_.state
      step_ = (await step.run(`read-${n}`, async () => {
        const supabase = getServiceClient()
        return agentLinkTurnStep(supabase, data, turnPlan, turnRow, (p) => continueHomeTurn(supabase, data, p, turnRow, state), n === HOME_TURN_MAX_READ_STEPS)
      })) as AgentLinkTurnStep
    }
    if (step_.kind === 'failed') {
      console.info(agentLinkTurnLogLine({ conversationId: data.conversationId, rowId: turnRow.id, messages, outcome: step_.error }))
      await notify('failed')
      return { status: 'failed', reason: step_.error, rowId: turnRow.id }
    }
    if (step_.kind !== 'settled') return { status: 'failed', reason: 'unsettled', rowId: turnRow.id }
    const { settled } = step_
    const outcome = settled.replied ? `${settled.outcome}:answered` : settled.note ? `${settled.outcome}:note_${settled.note}` : settled.outcome
    console.info(agentLinkTurnLogLine({ conversationId: data.conversationId, rowId: turnRow.id, messages, outcome }))
    return { status: 'done', outcome: settled.outcome, rowId: turnRow.id, written: settled.written, replied: settled.replied }
  },
)

/** The one log line per run. Counts and ids only (never a word of a message). */
export function agentLinkTurnLogLine(args: { conversationId: string; rowId?: string; messages?: number; outcome: string }): string {
  return homeTurnLogLine({ conversationId: args.conversationId, rowId: args.rowId, reports: args.messages, outcome: args.outcome }).replace('[home-turn]', '[agent-link-turn]').replace(' reports=', ' messages=')
}
