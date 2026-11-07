import type { GetStepTools } from 'inngest'
import { getServiceClient } from '@/lib/admin'
import { inngest } from './client'
import {
  HOME_TURN_DEBOUNCE_PERIOD,
  HOME_TURN_DEBOUNCE_TIMEOUT,
  HOME_TURN_REQUESTED_EVENT,
  parseHomeTurnRequested,
} from '@/lib/chat/home-turn'
import {
  HOME_TURN_MAX_READ_STEPS,
  channelOfReason,
  claimHomeTurn,
  continueHomeTurn,
  finishHomeTurn,
  homeTurnLabel,
  homeTurnLogLine,
  planHomeTurn,
  recordSkippedHomeTurn,
  sendHomeTurn,
  type HomeTurnClaim,
  type HomeTurnPlanResult,
  type HomeTurnRow,
  type HomeTurnStepResult,
} from '@/lib/chat/home-turn-server'
import { markDigestDelivered, sendDigestNotice } from '@/lib/agent-events/digest'
import { markEventsDelivered, markWorkEventsDelivered } from '@/lib/agent-events/event-turn'
import { markGuestAsksDelivered } from '@/lib/guests/guest-asks'
import { markAgentAnswersDelivered } from '@/lib/agent-links/exchange'
import { markApprovalsCarried } from '@/lib/safety/approval-turn'
import { sendCheckInNotice } from '@/lib/now/check-in'
import { routeRequestEvent } from '@/lib/reach/route'
import { ROUTED_HOME_TURN_REASONS } from '@/lib/reach/route-policy'

/**
 * The debounce key: one per conversation AND reason, so a digest and a
 * helper's report arriving inside one 90 s window are two turns (the debounce
 * keeps only the last event of a key). They still run one at a time per
 * conversation (the concurrency key).
 */
export const HOME_TURN_DEBOUNCE_KEY = 'event.data.conversationId + ":" + event.data.reason'

/** How long a turn waits for another home turn's lease in the same conversation, and how many times. */
export const HOME_TURN_LEASE_WAIT = '2m'
export const HOME_TURN_LEASE_WAITS = 15

/**
 * Whether a finished turn delivered what it carried: it spoke, or judged it
 * handled (no_reply). One cut off, or that wrote nothing it meant to, did not.
 */
function turnDelivered(finished: { outcome: string; written: boolean }): boolean {
  return finished.written || finished.outcome === 'quiet' || finished.outcome === 'steered_quiet'
}

/** The context a home turn's run gets (its event and Inngest's step tools). */
export interface HomeTurnRunContext {
  event: { data: unknown }
  step: GetStepTools<typeof inngest>
}

/**
 * home/turn.requested → (debounced 90 s per conversation, one at a time) →
 * one batched server turn in the home thread (A4 slice 5,
 * docs/plans/always-on-agent.md §2, §4; src/lib/chat/home-turn-server.ts).
 *
 * The work recorder sends the event when a background helper's report lands
 * in a home thread (A4 slice 4); the daily digest cron (A6 slice 4) sends it
 * with reason 'digest': the same steps, plus, when a reply was written,
 * `deliver-digest` (its rows marked delivered) and `digest-notice` (one
 * `agent_digest` bubble on the face). The router sends it with reason
 * 'event' (its turn rows); the event turn marks them delivered
 * (`deliver-events`; a quiet one all but what waits on the person or was
 * asked for, UNSEEN_WAITING_KINDS; one that wrote nothing it meant to, none).
 * A helper's report turn marks the work items' inbox rows delivered
 * (`deliver-work-events`; a quiet one all but a question, a failure or an
 * approval; one that wrote nothing it meant to, none), and a guest's asks
 * (reason 'guest_ask', src/lib/guests/guest-asks.ts) are marked carried
 * (`deliver-guest-asks`), as are an approval turn's calls (inside `finish`,
 * which frees the lease: src/lib/safety/approval-turn.ts): the report chip is in the
 * thread and the agent has read it, so "while you were away" and the digest
 * don't tell the person a third time, and nothing waiting goes unseen. The
 * Now file's check-in (reason 'check_in', its own fresh session) marks the
 * events it carried (`deliver-check-in`) and sends one `agent_check_in`
 * notice (`check-in-notice`) only when it wrote a reply. Every written turn
 * of a routed reason (ROUTED_HOME_TURN_REASONS) then asks the router
 * (`route`, src/lib/reach/route.ts) to take its message to the person: a
 * banner when they are at an app, a text or Slack when they are away. A claim refused as `busy` (another home
 * turn in the conversation holds the lease) sleeps HOME_TURN_LEASE_WAIT and
 * plans again, up to HOME_TURN_LEASE_WAITS times. The debounce keeps the LAST event, so the run never trusts its
 * payload for what to deliver: the plan step gathers every report no earlier
 * home turn carried. `timeout` bounds how long a steady stream of reports can
 * hold the turn back. One run per conversation at a time (concurrency), so a
 * second batch waits for the first turn to be read to its end.
 *
 * Steps: plan (the database, then the session's tail: its index, and whether
 * a question waits on the person) → claim (the home_turn row, before anything
 * is sent) → send (claimed → sent with the start index, once; then a budgeted
 * read) → read-1…n (re-attaching from the cursor the previous step reached,
 * touching the row) → finish (write the reply unless the turn ended on
 * no_reply or is empty, settle the row). Retries are safe: the claim is unique per
 * conversation and dedupe key, another run's live row is a duplicate, and
 * only the attempt that moves the row to `sent` ever sends. Every expected stop
 * returns `{ status: 'skipped', reason }`. One `[home-turn]` line per run.
 *
 * The steps live in runHomeTurn, which `homeTurn` (this event, 90 s debounce)
 * and `approvalTurn` (src/lib/inngest/approval-turn.ts: a few seconds, since
 * the person just approved and waits for the agent) both run.
 */
export async function runHomeTurn({ event, step }: HomeTurnRunContext) {
  const data = parseHomeTurnRequested(event.data)
  if (!data) {
    console.info(homeTurnLogLine({ conversationId: '-', outcome: 'bad_event' }))
    return { status: 'skipped', reason: 'bad_event' }
  }
  // A channel turn has its own consumer (src/lib/inngest/slack-turn.ts), which posts the reply back.
  if (channelOfReason(data.reason)) {
    console.info(homeTurnLogLine({ conversationId: data.conversationId, outcome: 'unsupported_reason' }))
    return { status: 'skipped', reason: 'unsupported_reason' }
  }

  // Plan, then claim. While another home turn in this conversation holds the
  // lease (a digest and a report never overlap: Inngest's concurrency key
  // limits steps, not runs), wait and plan again (the tail has moved).
  let plan: Extract<HomeTurnPlanResult, { ok: true }> | null = null
  let row: HomeTurnRow | null = null
  for (let attempt = 0; ; attempt++) {
    const suffix = attempt === 0 ? '' : `-${attempt}`
    const planned = (await step.run(`plan${suffix}`, () => planHomeTurn(getServiceClient(), data))) as HomeTurnPlanResult
    if (!planned.ok) {
      const record = planned.record
      if (record) await step.run(`record-skip${suffix}`, () => recordSkippedHomeTurn(getServiceClient(), data, { reason: planned.reason, record }))
      console.info(homeTurnLogLine({ conversationId: data.conversationId, reports: record?.reports.length, outcome: planned.reason }))
      return { status: 'skipped', reason: planned.reason }
    }
    const claim = (await step.run(`claim${suffix}`, () => claimHomeTurn(getServiceClient(), data, planned))) as HomeTurnClaim
    if (claim.kind === 'duplicate') {
      console.info(homeTurnLogLine({ conversationId: data.conversationId, reports: planned.reports.length, outcome: 'duplicate' }))
      return { status: 'skipped', reason: 'duplicate' }
    }
    if (claim.kind === 'busy') {
      if (attempt >= HOME_TURN_LEASE_WAITS) {
        // What it carried waits for the next turn (reports, the away section).
        console.info(homeTurnLogLine({ conversationId: data.conversationId, reports: planned.reports.length, outcome: 'busy' }))
        return { status: 'skipped', reason: 'busy' }
      }
      await step.sleep(`lease-wait-${attempt + 1}`, HOME_TURN_LEASE_WAIT)
      continue
    }
    plan = planned
    row = claim.row
    break
  }

  if (!plan || !row) return { status: 'skipped', reason: 'busy' }
  const turnPlan = plan
  const turnRow = row
  let step_ = (await step.run('send', () => sendHomeTurn(getServiceClient(), data, turnPlan, turnRow))) as HomeTurnStepResult
  const digest = turnPlan.digest
  for (let n = 1; n <= HOME_TURN_MAX_READ_STEPS && step_.kind === 'read' && !step_.result.done; n++) {
    const state = step_.result.state
    step_ = (await step.run(`read-${n}`, () => continueHomeTurn(getServiceClient(), data, turnPlan, turnRow, state))) as HomeTurnStepResult
  }
  if (step_.kind === 'failed') {
    console.info(homeTurnLogLine({ conversationId: data.conversationId, rowId: turnRow.id, reports: turnPlan.reports.length, outcome: step_.error }))
    return { status: 'failed', reason: step_.error, rowId: turnRow.id }
  }

  const read = step_.result
  const approvals = turnPlan.approvals
  // A report that is only meeting preps is a banner, never a text (src/lib/reach/route-policy.ts).
  const prepOnly = data.reason === 'helper_report' && turnPlan.reports.length > 0 && turnPlan.reports.every((r) => !!r.report.meeting)
  const finished = await step.run('finish', async () => {
    const done = await finishHomeTurn(getServiceClient(), data, turnRow, read, homeTurnLabel(turnPlan, data.reason), { prepOnly })
    // An approval turn's calls are carried in the step that frees the lease
    // (the row is now done), so a run waiting on it never names them again.
    if (approvals && turnDelivered(done)) await markApprovalsCarried(getServiceClient(), { approvalIds: approvals.approvalIds, homeTurnId: turnRow.id })
    return done
  })
  // A WRITTEN digest delivers its rows (they won't come round again in "while
  // you were away" or tomorrow) and puts one bubble on the face. A quiet one
  // says nothing, so its rows stay for the person's next visit.
  if (digest && finished.written) {
    await step.run('deliver-digest', () =>
      markDigestDelivered(getServiceClient(), {
        workspaceId: data.workspaceId,
        userId: data.userId,
        eventIds: digest.eventIds,
        date: digest.date,
        homeTurnId: turnRow.id,
      }),
    )
    await step.run('digest-notice', () =>
      sendDigestNotice(getServiceClient(), {
        workspaceId: data.workspaceId,
        userId: data.userId,
        conversationId: data.conversationId,
        homeTurnId: turnRow.id,
        digest,
      }),
    )
  }
  // An event turn delivers its rows: all of them when it spoke; when it
  // judged them handled ([quiet]), all but what still waits on the person
  // or was asked for (a question, a failure, an approval, a reminder:
  // UNSEEN_WAITING_KINDS), so a quiet item isn't brought back with the next
  // mail. A turn that wrote nothing it meant to (cut off at the read cap, a
  // refused write) delivers nothing: its rows stay for "while you were
  // away" and the digest (retire-notifications-page review: a mention has
  // no page to fall back on).
  const events = turnPlan.events
  const exceptWaiting = !finished.written
  const delivered = turnDelivered(finished)
  if (events && delivered) {
    await step.run('deliver-events', () =>
      markEventsDelivered(getServiceClient(), { workspaceId: data.workspaceId, userId: data.userId, eventIds: events.eventIds, homeTurnId: turnRow.id, exceptWaiting }),
    )
  }
  // A report turn covered its work items (the chip stands). A quiet one
  // leaves a question, a failure or an approval for the away section.
  if (data.reason === 'helper_report' && turnPlan.workItemIds.length && delivered) {
    await step.run('deliver-work-events', () =>
      markWorkEventsDelivered(getServiceClient(), { workspaceId: data.workspaceId, userId: data.userId, workItemIds: turnPlan.workItemIds, homeTurnId: turnRow.id, exceptWaiting }),
    )
  }
  // A guest_ask turn carried its asks (guest access): the agent answered
  // them (answer_guest), told the owner, or left them; they aren't sent
  // again. One that wrote nothing it meant to carries them to the next.
  const guestAsks = turnPlan.guestAsks
  if (guestAsks && delivered) {
    await step.run('deliver-guest-asks', () =>
      markGuestAsksDelivered(getServiceClient(), { workspaceId: data.workspaceId, userId: data.userId, askIds: guestAsks.askIds, homeTurnId: turnRow.id }),
    )
  }
  // An agent_answer turn carried the linked agents' answers (agent links):
  // the agent told the person or followed up; they aren't carried again.
  const agentAnswers = turnPlan.agentAnswers
  if (agentAnswers && delivered) {
    await step.run('deliver-agent-answers', () => markAgentAnswersDelivered(getServiceClient(), { messageIds: agentAnswers.messageIds, homeTurnId: turnRow.id }))
  }
  // A check-in that told the person something (docs/plans/now-file.md):
  // the events it carried are delivered, as a written event turn's are, so
  // "while you were away" and the digest don't say them again, and one
  // `agent_check_in` notice goes out. One that called no_reply marks
  // nothing and sends nothing: those events still show there.
  const checkIn = turnPlan.checkIn
  if (checkIn && finished.written) {
    await step.run('deliver-check-in', () =>
      markEventsDelivered(getServiceClient(), { workspaceId: data.workspaceId, userId: data.userId, eventIds: checkIn.eventIds, homeTurnId: turnRow.id }),
    )
    await step.run('check-in-notice', () =>
      sendCheckInNotice(getServiceClient(), {
        workspaceId: data.workspaceId,
        userId: data.userId,
        conversationId: data.conversationId,
        homeTurnId: turnRow.id,
        date: checkIn.date,
        hour: checkIn.hour,
      }),
    )
  }
  // The agent spoke on its own: the router takes the message to the person
  // wherever they are (src/lib/reach/route.ts). Ids only; the router reads
  // the words back. The system picks the channel, never the agent.
  if (finished.written && ROUTED_HOME_TURN_REASONS.has(data.reason)) {
    await step.sendEvent('route', routeRequestEvent({ userId: data.userId, workspaceId: data.workspaceId, conversationId: data.conversationId }, `home-turn:${turnRow.id}`))
  }
  const outcome = read.done && read.end !== 'completed' ? `${finished.outcome}:${read.end}` : finished.outcome
  console.info(
    homeTurnLogLine({ conversationId: data.conversationId, rowId: turnRow.id, reports: turnPlan.reports.length, outcome, narrationChars: finished.narrationChars }),
  )
  return { status: 'done', outcome, rowId: turnRow.id, written: finished.written }
}

export const homeTurn = inngest.createFunction(
  {
    id: 'home-turn',
    retries: 2,
    debounce: { key: HOME_TURN_DEBOUNCE_KEY, period: HOME_TURN_DEBOUNCE_PERIOD, timeout: HOME_TURN_DEBOUNCE_TIMEOUT },
    concurrency: [{ limit: 1, key: 'event.data.conversationId' }],
    triggers: [{ event: HOME_TURN_REQUESTED_EVENT }],
  },
  runHomeTurn,
)
