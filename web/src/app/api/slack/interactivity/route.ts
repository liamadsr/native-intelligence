/**
 * POST /api/slack/interactivity
 *
 * Our Slack app's Interactivity request URL: the Approve / Decline buttons
 * on a Native Intelligence approval posted in Slack (src/lib/slack/approvals.ts).
 * Slack posts `payload=<json>` (form-encoded), type `block_actions`.
 *
 * ── The security boundaries this route owns ─────────────────────────────
 * 1. AUTH: Slack's own signature (X-Slack-Signature over the RAW body, with
 *    SLACK_SIGNING_SECRET; the timestamp within five minutes,
 *    src/lib/slack/signature.ts), checked before the body is parsed. Nothing
 *    else is accepted: no signature, a wrong one or a stale one is 401, and
 *    nothing is read.
 * 2. APP: api_app_id must be ours.
 * 3. WHO: the clicker is mapped to a Native Intelligence user only through their link in
 *    that Slack team, in a live installation; a Slack Connect outsider never
 *    is. The card is then settled as that person's own click
 *    (settleAttentionCard, actor 'person', channel 'slack'), fenced on their
 *    own member row: a button on someone else's card finds nothing, and
 *    mayApprove re-checks the owner.
 * 4. SPEED: answered at once; the settle (it may run the held call) and the
 *    message update run after the response, through Slack's response_url
 *    (only a hooks.slack.com URL is ever posted to).
 */
import { after } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { apiError, badRequest, unauthorized } from '@/lib/api-errors'
import { APPROVE_ACTION, parseButtonClick, settleApprovalFromSlack, settleLine, settledBlocks, type SlackButtonClick } from '@/lib/slack/approvals'
import { slackAppId, slackConfigured } from '@/lib/slack/config'
import { verifySlackSignature } from '@/lib/slack/signature'
import { getInstallation, linkForSlackUser, memberIdOf } from '@/lib/slack/store'

export const maxDuration = 60

const MAX_BODY_BYTES = 256 * 1024

export async function POST(request: Request) {
  const appId = slackAppId()
  if (!appId || !slackConfigured()) return apiError('Slack is not set up on this deployment', { status: 503, code: 'SLACK_NOT_CONFIGURED' })

  const body = await request.text()
  if (body.length > MAX_BODY_BYTES) return apiError('Payload too large', { status: 413, code: 'PAYLOAD_TOO_LARGE' })

  // Slack's signature over the raw body, before anything in it is read.
  if (!verifySlackSignature(request.headers, body)) return unauthorized()

  let raw: unknown
  try {
    const form = new URLSearchParams(body)
    raw = JSON.parse(form.get('payload') ?? '')
  } catch {
    return badRequest('Expected a Slack interaction payload')
  }
  const click = parseButtonClick(raw, appId)
  if (!click) return new Response(null, { status: 200 })

  after(async () => {
    const line = await settleClick(click)
    console.log('[slack/interactivity]', { teamId: click.teamId, action: click.action, line })
    if (click.responseUrl) {
      await fetch(click.responseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ replace_original: true, ...settledBlocks(click.title, line) }),
        signal: AbortSignal.timeout(8_000),
      }).catch(() => null)
    }
  })
  return new Response(null, { status: 200 })
}

/** Map the clicker to their Native Intelligence user, then settle the card as theirs. Returns the line to show. Never throws. */
async function settleClick(click: SlackButtonClick): Promise<string> {
  const svc = getServiceClient()
  try {
    if (click.userTeamId !== click.teamId) return 'Only the person this is waiting for can answer it.'
    const installation = await getInstallation(svc, click.teamId)
    if (!installation || installation.status !== 'active') return 'This Slack workspace is no longer connected to Native Intelligence.'
    const link = await linkForSlackUser(svc, click.teamId, click.userId)
    if (!link) return 'Only the person this is waiting for can answer it.'
    const memberId = await memberIdOf(svc, installation.workspace_id, link.user_id)
    if (!memberId) return 'Only the person this is waiting for can answer it.'
    const outcome = await settleApprovalFromSlack(svc, {
      userId: link.user_id,
      memberId,
      cardId: click.cardId,
      decision: click.action === APPROVE_ACTION ? 'approve' : 'decline',
    })
    return settleLine(outcome)
  } catch {
    return "That didn't work. Try again in Native Intelligence."
  }
}
