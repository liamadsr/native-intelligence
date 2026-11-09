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
import { hydrateChannelPlan, plannedMessageIds, redactChannelPlan } from '@/lib/chat/channel-turn-server'
import {
  TEAM_CHAT_TURN_REQUESTED_EVENT,
  postAsAgent,
  replyTarget,
  settleTeamChatTurn,
  teamChatTurnSkipNotice,
  type TeamChatTarget,
  type TeamChatTurnSettled,
} from '@/lib/team-chat/agent-turn'

/**
 * A short debounce per conversation: a few mentions in a row become one turn
 * (the plan gathers every mention no earlier turn carried), without making a
 * single one wait long. The same as Slack's.
 */
export const TEAM_CHAT_TURN_DEBOUNCE_PERIOD = '3s'
export const TEAM_CHAT_TURN_DEBOUNCE_TIMEOUT = '20s'
/** How long a team chat turn waits for another turn's lease on the conversation, and how many times (10 min in all). */
export const TEAM_CHAT_TURN_LEASE_WAIT = '20s'
export const TEAM_CHAT_TURN_LEASE_WAITS = 30

/** What the send and read steps return: still reading (the cursor), settled (outcomes only), or failed. */
export type TeamChatTurnStep =
  | { kind: 'reading'; state: HomeTurnReadState }
  | { kind: 'settled'; settled: TeamChatTurnSettled }
  | { kind: 'failed'; error: string }

/**
 * Send (or read on) and, once the turn is read to its end, settle it in the
 * SAME step (finish, then post the reply): the reply's words never become a
 * step output. Only a turn still running at a step's budget hands on its read
 * state.
 */
export async function teamChatTurnStep(
  supabase: SupabaseClient,
  data: HomeTurnRequestedData,
  row: HomeTurnRow,
  target: TeamChatTarget | null,
  run: () => Promise<HomeTurnStepResult>,
  lastStep: boolean,
): Promise<TeamChatTurnStep> {
  const result = await run()
  if (result.kind === 'failed') return { kind: 'failed', error: result.error }
  if (!result.result.done && !lastStep) return { kind: 'reading', state: result.result.state }
  return { kind: 'settled', settled: await settleTeamChatTurn(supabase, data, row, result.result, target) }
}

/**
 * team-chat/turn.requested → one turn of the person's agent in their own
 * conversation for a team chat channel (roadmap #7, migration 474): the
 * intake (src/lib/team-chat/agent-turn.ts deliverTeamChatMention) wrote their
 * @-mention into it and sent the event; this runs the home-turn steps with
 * reason 'team_chat' (src/lib/chat/home-turn-server.ts) as the `channel_turn`
 * principal (surface 'team_chat'), then posts the reply into the channel as
 * their agent.
 *
 * Steps, as Slack's (src/lib/inngest/slack-turn.ts): plan (ids only) → claim
 * (the conversation's lease; while another turn holds it, the mention waits)
 * → target (where to answer, rebuilt from the server's rows) → send → read-1…n,
 * settling in the step the turn ends in. A skip the person should hear about
 * records its `skipped` row and posts one short notice as their agent. One
 * `[team-chat-turn]` line per run.
 */
export const teamChatTurn = inngest.createFunction(
  {
    id: 'team-chat-turn',
    retries: 2,
    debounce: { key: 'event.data.conversationId', period: TEAM_CHAT_TURN_DEBOUNCE_PERIOD, timeout: TEAM_CHAT_TURN_DEBOUNCE_TIMEOUT },
    concurrency: [{ limit: 1, key: 'event.data.conversationId' }],
    triggers: [{ event: TEAM_CHAT_TURN_REQUESTED_EVENT }],
  },
  async ({ event, step }) => {
    const data = parseHomeTurnRequested(event.data)
    if (!data || data.reason !== 'team_chat' || data.guestId) {
      console.info(teamChatTurnLogLine({ conversationId: '-', outcome: 'bad_event' }))
      return { status: 'skipped', reason: 'bad_event' }
    }
    const targetOf = (suffix = '') => step.run(`target${suffix}`, () => replyTarget(getServiceClient(), data)) as Promise<TeamChatTarget | null>
    const notify = async (reason: Parameters<typeof teamChatTurnSkipNotice>[0], target: TeamChatTarget | null, suffix = '') => {
      const notice = teamChatTurnSkipNotice(reason)
      if (!notice || !target) return
      await step.run(`notice${suffix}`, () => postAsAgent(getServiceClient(), target, notice))
    }

    let plan: Extract<HomeTurnPlanResult, { ok: true }> | null = null
    let row: HomeTurnRow | null = null
    for (let attempt = 0; ; attempt++) {
      const suffix = attempt === 0 ? '' : `-${attempt}`
      const planned = (await step.run(`plan${suffix}`, async () => redactChannelPlan(await planHomeTurn(getServiceClient(), data)))) as HomeTurnPlanResult
      if (!planned.ok) {
        const record = planned.record
        if (record) await step.run(`record-skip${suffix}`, () => recordSkippedHomeTurn(getServiceClient(), data, { reason: planned.reason, record }))
        console.info(teamChatTurnLogLine({ conversationId: data.conversationId, messages: record?.channelMessages?.length, outcome: planned.reason }))
        if (plannedMessageIds(planned).length) await notify(planned.reason, await targetOf(suffix), suffix)
        return { status: 'skipped', reason: planned.reason }
      }
      const claim = (await step.run(`claim${suffix}`, () => claimHomeTurn(getServiceClient(), data, planned))) as HomeTurnClaim
      if (claim.kind === 'duplicate') {
        console.info(teamChatTurnLogLine({ conversationId: data.conversationId, messages: planned.channelMessages?.length, outcome: 'duplicate' }))
        return { status: 'skipped', reason: 'duplicate' }
      }
      if (claim.kind === 'busy') {
        if (attempt >= TEAM_CHAT_TURN_LEASE_WAITS) {
          console.info(teamChatTurnLogLine({ conversationId: data.conversationId, messages: planned.channelMessages?.length, outcome: 'busy' }))
          await notify('busy', await targetOf(suffix), suffix)
          return { status: 'skipped', reason: 'busy' }
        }
        await step.sleep(`lease-wait-${attempt + 1}`, TEAM_CHAT_TURN_LEASE_WAIT)
        continue
      }
      plan = planned
      row = claim.row
      break
    }

    if (!plan || !row) return { status: 'skipped', reason: 'busy' }
    const turnPlan: HomeTurnPlan = plan
    const turnRow = row
    const messages = turnPlan.channelMessages?.length
    const target = await targetOf('-turn')
    if (!target) {
      // Nowhere to answer (the channel was archived, or they left it): the
      // turn still runs, and the reply stays in their conversation.
      console.warn(teamChatTurnLogLine({ conversationId: data.conversationId, rowId: turnRow.id, messages, outcome: 'no_target' }))
    }
    let step_ = (await step.run('send', async () => {
      const supabase = getServiceClient()
      const hydrated = await hydrateChannelPlan(supabase, data, turnPlan)
      return teamChatTurnStep(supabase, data, turnRow, target, () => sendHomeTurn(supabase, data, hydrated, turnRow), false)
    })) as TeamChatTurnStep
    for (let n = 1; n <= HOME_TURN_MAX_READ_STEPS && step_.kind === 'reading'; n++) {
      const state = step_.state
      step_ = (await step.run(`read-${n}`, async () => {
        const supabase = getServiceClient()
        return teamChatTurnStep(supabase, data, turnRow, target, () => continueHomeTurn(supabase, data, turnPlan, turnRow, state), n === HOME_TURN_MAX_READ_STEPS)
      })) as TeamChatTurnStep
    }
    if (step_.kind === 'failed') {
      console.info(teamChatTurnLogLine({ conversationId: data.conversationId, rowId: turnRow.id, messages, outcome: step_.error }))
      await notify('failed', target, '-failed')
      return { status: 'failed', reason: step_.error, rowId: turnRow.id }
    }
    if (step_.kind !== 'settled') return { status: 'failed', reason: 'unsettled', rowId: turnRow.id }
    const { settled } = step_
    const outcome = settled.posted ? `${settled.outcome}:posted` : settled.notice ? `${settled.outcome}:notice_${settled.notice}` : `${settled.outcome}${settled.postReason ? `:${settled.postReason}` : ''}`
    console.info(teamChatTurnLogLine({ conversationId: data.conversationId, rowId: turnRow.id, messages, outcome }))
    return { status: 'done', outcome: settled.outcome, rowId: turnRow.id, written: settled.written, posted: settled.posted }
  },
)

/** The one log line per run. Counts and ids only (never a word of a message). */
export function teamChatTurnLogLine(args: { conversationId: string; rowId?: string; messages?: number; outcome: string }): string {
  return homeTurnLogLine({ conversationId: args.conversationId, rowId: args.rowId, reports: args.messages, outcome: args.outcome })
    .replace('[home-turn]', '[team-chat-turn]')
    .replace(' reports=', ' messages=')
}
