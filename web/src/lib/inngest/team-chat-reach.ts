import type { GetStepTools } from 'inngest'
import { getServiceClient } from '@/lib/admin'
import { inngest } from './client'
import { isUuid } from '@/lib/team-chat/types'
import { notifyTeamChatMessage, TEAM_CHAT_NOTIFY_EVENT } from '@/lib/team-chat/notify'
import {
  liveTeamChatEmailDeps,
  parseTeamChatEmailRequest,
  planTeamChatEmail,
  TEAM_CHAT_EMAIL_EVENT,
  TEAM_CHAT_EMAIL_RECHECK,
  TEAM_CHAT_EMAIL_RECHECKS,
  TEAM_CHAT_EMAIL_WAIT,
  TEAM_CHAT_EMAIL_WAIT_MAX,
  teamChatEmailEvent,
  type TeamChatEmailDecision,
} from '@/lib/team-chat/email'

/**
 * team-chat/notify.requested → a new message's notifications
 * (src/lib/team-chat/notify.ts): one `notify` step writes them (ids and counts
 * out), then each person told is handed to the email batcher below (once
 * each, however many workspaces or conversations: their email is one). The
 * event's id is the message's, so a retried send never notifies twice (and
 * the database holds it to one per message per person anyway). One
 * `[team-chat-notify]` line per run.
 */
export const teamChatNotify = inngest.createFunction(
  {
    id: 'team-chat-notify',
    retries: 2,
    concurrency: [{ limit: 5 }],
    triggers: [{ event: TEAM_CHAT_NOTIFY_EVENT }],
  },
  async ({ event, step }) => {
    const messageId = (event.data as { messageId?: unknown } | undefined)?.messageId
    if (!isUuid(messageId)) {
      console.info('[team-chat-notify] message=- outcome=bad_event')
      return { status: 'skipped', reason: 'bad_event' }
    }
    const result = await step.run('notify', () => notifyTeamChatMessage(getServiceClient(), messageId))
    const people = [...new Map(result.notified.map((n) => [n.userId, n])).values()]
    if (people.length > 0) {
      await step.sendEvent(
        'email',
        people.map((n) => teamChatEmailEvent({ userId: n.userId, workspaceId: n.workspaceId })),
      )
    }
    console.info(`[team-chat-notify] message=${messageId} outcome=${result.outcome} notified=${result.notified.length}`)
    return { status: 'done', outcome: result.outcome, notified: result.notified.length }
  },
)

/** The most rounds one email run plans: its rechecks at an app, two quiet-hour waits, and the send. */
export const TEAM_CHAT_EMAIL_MAX_ROUNDS = TEAM_CHAT_EMAIL_RECHECKS + 4

export interface TeamChatEmailRunContext {
  event: { data: unknown }
  step: GetStepTools<typeof inngest>
}

/**
 * team-chat/email.requested → one email per person for what is still unread
 * in team chat, while they are away (src/lib/team-chat/email.ts). Debounced
 * on the person (`data.key`), so a burst is one run that starts once team
 * chat has been quiet for them for TEAM_CHAT_EMAIL_WAIT; a newer request
 * cancels a run that is waiting (the newer run reads it all again). A
 * conversation they read meanwhile simply has nothing unread left: it drops
 * out, and with nothing left no email goes. Each round is one `plan-<n>` step:
 *   done     stop
 *   present  at an app: sleep TEAM_CHAT_EMAIL_RECHECK and look again, at most
 *            TEAM_CHAT_EMAIL_RECHECKS times (then the in-app notice was all)
 *   wait     quiet hours: sleep until they end, then look again (twice at most)
 * One `[team-chat-email]` line per run, ids and outcomes only.
 */
export async function runTeamChatEmail({ event, step }: TeamChatEmailRunContext) {
  const req = parseTeamChatEmailRequest(event.data)
  if (!req) {
    console.info('[team-chat-email] key=- outcome=bad_event')
    return { status: 'skipped', reason: 'bad_event' }
  }
  let rechecks = 0
  let waits = 0
  let outcome = 'max_rounds'
  let messages = 0
  for (let n = 0; n < TEAM_CHAT_EMAIL_MAX_ROUNDS; n++) {
    const decision = (await step.run(`plan-${n}`, () => planTeamChatEmail(req, liveTeamChatEmailDeps(getServiceClient())))) as TeamChatEmailDecision
    messages = decision.messages
    if (decision.kind === 'done') {
      outcome = decision.outcome
      break
    }
    if (decision.kind === 'present') {
      if (rechecks >= TEAM_CHAT_EMAIL_RECHECKS) {
        outcome = 'present_unread'
        break
      }
      rechecks++
      await step.sleep(`recheck-${rechecks}`, TEAM_CHAT_EMAIL_RECHECK)
      continue
    }
    if (waits >= 2) {
      outcome = 'waited'
      break
    }
    waits++
    await step.sleepUntil(`quiet-${waits}`, new Date(decision.untilMs))
  }
  console.info(`[team-chat-email] user=${req.userId} outcome=${outcome} messages=${messages}`)
  return { status: 'done', outcome, messages }
}

export const teamChatEmail = inngest.createFunction(
  {
    id: 'team-chat-email',
    retries: 1,
    debounce: { key: 'event.data.key', period: TEAM_CHAT_EMAIL_WAIT, timeout: TEAM_CHAT_EMAIL_WAIT_MAX },
    concurrency: [{ limit: 1, key: 'event.data.key' }],
    cancelOn: [{ event: TEAM_CHAT_EMAIL_EVENT, match: 'data.key' }],
    triggers: [{ event: TEAM_CHAT_EMAIL_EVENT }],
  },
  runTeamChatEmail,
)
