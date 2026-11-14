/**
 * POST /api/slack/events
 *
 * Our Slack app's Event Subscriptions request URL: Slack sends each event of
 * the app here, from every Slack workspace the app is in.
 *
 * ── The security boundaries this route owns ─────────────────────────────
 * 1. AUTH: Slack's own signature (X-Slack-Signature over the RAW body, with
 *    SLACK_SIGNING_SECRET; the timestamp within five minutes), checked
 *    before anything in the body is read (src/lib/slack/signature.ts).
 *    Nothing else is accepted. Fails closed: Slack not configured, no event.
 * 2. APP: the payload's api_app_id must be ours (SLACK_APP_ID). Any other
 *    app's event is dropped. Slack's url_verification challenge is answered
 *    only after the signature passed.
 * 3. DEDUPE: Slack retries an event it got no answer to within 3 s, so the
 *    event id is recorded first (slack_event) and a repeat is answered 200
 *    with nothing done. A failed dedupe write answers 500, so it is retried.
 * 4. SPEED: the route answers as soon as the event is recorded; the work
 *    (lookups, Slack replies, a turn) runs after the response.
 *
 * Who is speaking is decided after that, from the team and user Slack put
 * in the event and what Native Intelligence holds (src/lib/slack/inbound.ts). This route
 * adds no trust check of its own beyond the three above.
 */
import { after } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { apiError, badRequest, serverError, unauthorized } from '@/lib/api-errors'
import { slackAppId, slackConfigured } from '@/lib/slack/config'
import { slackInboundDeps, slackTurnSlack } from '@/lib/slack/deps'
import { parseSlackPayload } from '@/lib/slack/events'
import { handleSlackInbound } from '@/lib/slack/inbound'
import { verifySlackSignature } from '@/lib/slack/signature'
import { firstDelivery, linkAttemptsBlocked, purgeOldEvents, recordFailedLinkAttempt } from '@/lib/slack/store'
import { handlePersonDm } from '@/lib/slack/person-dm'
import { handleGuestSlackDm, supabaseGuestSlackDeps } from '@/lib/guests/slack'
import { guestInviteKey } from '@/lib/guests/store'
import { SLACK_TURN_NOTICES, deliverSlackMention } from '@/lib/slack/turn'

export const maxDuration = 60

/** Slack's own event payloads are small; anything this big is not one. */
const MAX_BODY_BYTES = 512 * 1024

export async function POST(request: Request) {
  const appId = slackAppId()
  if (!appId || !slackConfigured()) {
    return apiError('Slack is not set up on this deployment', { status: 503, code: 'SLACK_NOT_CONFIGURED' })
  }

  const body = await request.text()
  if (body.length > MAX_BODY_BYTES) return apiError('Payload too large', { status: 413, code: 'PAYLOAD_TOO_LARGE' })

  // Slack's signature over the raw body, before anything in it is read.
  if (!verifySlackSignature(request.headers, body)) return unauthorized()

  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    return badRequest('Expected a JSON event')
  }

  const inbound = parseSlackPayload(raw, appId)
  if (inbound.kind === 'challenge') return Response.json({ challenge: inbound.challenge })
  if (inbound.kind === 'ignore') return new Response(null, { status: 200 })

  const svc = getServiceClient()
  let first: boolean
  try {
    first = await firstDelivery(svc, inbound.eventId, inbound.teamId)
  } catch (error) {
    console.error('[slack/events] dedupe failed', { teamId: inbound.teamId, error: error instanceof Error ? error.message : String(error) })
    return serverError('Slack event dedupe failed')
  }
  if (!first) return new Response(null, { status: 200 })

  after(async () => {
    const base = slackInboundDeps()
    const outcome = await handleSlackInbound(
      svc,
      inbound,
      slackInboundDeps({
        // A linked person's DM: the answer to one of their approvals, or a
        // turn in their home thread, answered back in the DM. Slack was acked
        // already, so nothing retries a failed intake: the person is told
        // instead of hearing nothing.
        onPersonDm: async ({ dm, installation, link }) => {
          const slack = slackTurnSlack(installation.slack_team_id)
          try {
            const handled = await handlePersonDm(svc, { dm, installation, link }, slack)
            if (handled !== 'queued') console.log('[slack/events] dm handled', { teamId: dm.teamId, handled })
          } catch (error) {
            console.error('[slack/events] dm intake failed', { teamId: dm.teamId, error: error instanceof Error ? error.message : String(error) })
            await slack.post({ channel: dm.channel, text: SLACK_TURN_NOTICES.failed() }).catch(() => null)
          }
        },
        // An unlinked member's DM: a guest's (their own agent, or their
        // invite code binding them), answered by the guests' intake; anything
        // else falls through to the "link your account" reply.
        onUnlinkedDm: async ({ dm, installation, token }) => {
          const slack = slackTurnSlack(installation.slack_team_id)
          try {
            const handled = await handleGuestSlackDm(
              { teamId: dm.teamId, slackUserId: dm.slackUserId, workspaceId: installation.workspace_id, text: dm.text },
              supabaseGuestSlackDeps(svc, {
                dm,
                installation,
                token,
                slack: { userInfo: base.slack.userInfo, post: base.slack.post, react: slack.react },
                attemptsBlocked: (now) => linkAttemptsBlocked(svc, dm.teamId, dm.slackUserId, now),
                recordFailedAttempt: () => recordFailedLinkAttempt(svc, dm.teamId, dm.slackUserId),
                inviteKey: guestInviteKey(),
              }),
            )
            if (handled && handled !== 'guest_queued') console.log('[slack/events] guest dm handled', { teamId: dm.teamId, handled })
            return handled !== null
          } catch (error) {
            console.error('[slack/events] guest dm intake failed', { teamId: dm.teamId, error: error instanceof Error ? error.message : String(error) })
            await slack.post({ channel: dm.channel, text: SLACK_TURN_NOTICES.failed() }).catch(() => null)
            return true
          }
        },
        // A linked person's @mention in a channel thread: a turn in THEIR OWN
        // conversation for that thread, answered in the thread.
        onPersonMention: async ({ mention, installation, link }) => {
          const slack = slackTurnSlack(installation.slack_team_id)
          try {
            const delivered = await deliverSlackMention(svc, { mention, installation, link }, slack)
            if (delivered !== 'queued') console.log('[slack/events] mention not queued', { teamId: mention.teamId, delivered })
          } catch (error) {
            console.error('[slack/events] mention intake failed', { teamId: mention.teamId, error: error instanceof Error ? error.message : String(error) })
            await slack
              .ephemeral({ channel: mention.channel, user: mention.slackUserId, text: SLACK_TURN_NOTICES.failed(), thread_ts: mention.threadTs })
              .catch(() => null)
          }
        },
      }),
    )
    console.log('[slack/events]', { kind: inbound.kind, teamId: inbound.teamId, outcome })
    // Keep the dedupe table small without a cron.
    if (Math.random() < 0.02) await purgeOldEvents(svc).catch(() => {})
  })
  return new Response(null, { status: 200 })
}
