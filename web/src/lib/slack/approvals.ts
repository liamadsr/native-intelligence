/**
 * Dial8 approvals in Slack (docs/plans/slack-connect.md §2, §4 piece 6). A
 * Slack turn that holds a call (the outward gate, the reviewer) raises the
 * person's ordinary approval card (src/lib/safety/approvals.ts). After the
 * reply, the card is posted to the DM as Slack blocks: what it would do, and
 * Approve / Decline buttons. Two ways to answer it from Slack, both settled
 * through the SAME path as the card's click in the app (settleAttentionCard,
 * actor 'person', channel 'slack'), so every re-check holds:
 *
 *   - a button: the interactivity route verifies the request, maps the
 *     clicker to their linked Dial8 user, and settles the card the button
 *     names, fenced on that user's own member row (someone else's card is
 *     never found);
 *   - a reply naming one approval by its code ("yes K7Q4"), bound by
 *     caller.ts bindReplyToApproval: a stray "yes" approves nothing.
 *
 * Only the owner approves (caller.ts mayApprove): the card's own member fence
 * plus the approver built from the verified Slack user. What every channel
 * shares (finding the held calls, binding a code, settling, the answer's
 * line) is src/lib/attention/channel-approvals.ts; this file is Slack's
 * blocks and buttons.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  CHANNEL_APPROVALS_PER_TURN,
  approvalNamedByChannelReply,
  channelApprovalsRaisedSince,
  settleApprovalFromChannel,
  settleLine,
  type ChannelApproval,
  type ChannelSettleOutcome,
} from '@/lib/attention/channel-approvals'
import type { settleAttentionCard } from '@/lib/attention/settle-card'
import { serverReplyCode } from '@/lib/safety/reply-code'

/** The action ids our buttons carry. */
export const APPROVE_ACTION = 'dial8_approve'
export const DECLINE_ACTION = 'dial8_decline'

/** The most cards one turn posts (a pile belongs in the app). */
export const SLACK_APPROVALS_PER_TURN = CHANNEL_APPROVALS_PER_TURN

/** A held call to show in Slack. */
export type SlackApproval = ChannelApproval

/** The pending approvals a Slack turn raised in this conversation since it began. Never throws. */
export function approvalsRaisedSince(supabase: SupabaseClient, scope: { userId: string; conversationId: string; since: string }): Promise<SlackApproval[]> {
  return channelApprovalsRaisedSince(supabase, { ...scope, surface: 'slack' })
}

/** Slack's own escapes for text we put in a block. */
function slackText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** The blocks of one approval: what it would do, the buttons, and the reply code. */
export function approvalBlocks(approval: SlackApproval): { text: string; blocks: unknown[] } {
  const code = serverReplyCode(approval.approvalId)
  const title = slackText(approval.title).slice(0, 200)
  const why = slackText(approval.why).slice(0, 500)
  return {
    text: `Waiting for your approval: ${approval.title}`.slice(0, 300),
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*${title}*${why ? `\n${why}` : ''}` } },
      {
        type: 'actions',
        block_id: `dial8_approval:${approval.cardId}`,
        elements: [
          { type: 'button', action_id: APPROVE_ACTION, style: 'primary', text: { type: 'plain_text', text: 'Approve' }, value: approval.cardId },
          { type: 'button', action_id: DECLINE_ACTION, style: 'danger', text: { type: 'plain_text', text: 'Decline' }, value: approval.cardId },
        ],
      },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `Or reply \`yes ${code}\` or \`no ${code}\`. It's also waiting in Dial8.` }] },
    ],
  }
}

/** The block that replaces an answered approval's buttons. */
export function settledBlocks(title: string, line: string): { text: string; blocks: unknown[] } {
  return {
    text: line,
    blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `*${slackText(title).slice(0, 200)}*\n${slackText(line)}` } }],
  }
}

export type SlackSettleOutcome = ChannelSettleOutcome

/**
 * Settle an approval card as the person, from Slack (settleApprovalFromChannel).
 * `memberId` is their own member row in the card's workspace. Never throws.
 */
export function settleApprovalFromSlack(
  supabase: SupabaseClient,
  input: { userId: string; memberId: string; cardId: string; decision: 'approve' | 'decline' },
  deps: { settle?: typeof settleAttentionCard } = {},
): Promise<SlackSettleOutcome> {
  // A card's own button in their Slack DM, or "yes CODE" there: never a plain answer.
  return settleApprovalFromChannel(supabase, { ...input, channel: 'slack', proof: 'button' }, deps)
}

/** A DM that answers one pending approval by its code ("yes K7Q4"); null when it names none. Never throws. */
export function approvalNamedByReply(
  supabase: SupabaseClient,
  input: { userId: string; text: string },
): Promise<{ approvalId: string; cardId: string; workspaceId: string; decision: 'approve' | 'decline' } | null> {
  // A message from the person's linked Slack account is the person (caller.ts channelCaller).
  return approvalNamedByChannelReply(supabase, { ...input, callerClass: 'person' })
}

export { settleLine }

/** One click on one of our buttons, as Dial8 reads it. */
export interface SlackButtonClick {
  teamId: string
  userId: string
  /** The clicker's own team: another team's id means a Slack Connect outsider. */
  userTeamId: string
  action: typeof APPROVE_ACTION | typeof DECLINE_ACTION
  cardId: string
  /** The approval's title, as the message showed it (for the answered message). */
  title: string
  /** Slack's response_url, only when it is a hooks.slack.com URL. */
  responseUrl: string | null
}

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** Read a block_actions payload for one of our buttons; null for anything else. Pure. */
export function parseButtonClick(raw: unknown, appId: string): SlackButtonClick | null {
  const p = rec(raw)
  if (p.type !== 'block_actions' || p.api_app_id !== appId) return null
  const teamId = str(rec(p.team).id)
  const user = rec(p.user)
  const userId = str(user.id)
  if (!/^T[A-Z0-9]{2,30}$/.test(teamId) || !/^[UW][A-Z0-9]{2,30}$/.test(userId)) return null
  const action = rec(Array.isArray(p.actions) ? p.actions[0] : null)
  const actionId = action.action_id
  if ((actionId !== APPROVE_ACTION && actionId !== DECLINE_ACTION) || typeof action.value !== 'string') return null
  const responseUrl = /^https:\/\/hooks\.slack\.com\//.test(str(p.response_url)) ? str(p.response_url) : null
  // The title is the section above the buttons, as approvalBlocks wrote it.
  const blocks = rec(p.message).blocks
  const section = rec(Array.isArray(blocks) ? blocks.find((b) => rec(b).type === 'section') : null)
  const sectionText = str(rec(section.text).text)
  const title = sectionText ? sectionText.split('\n')[0].replace(/^\*|\*$/g, '') : 'Approval'
  return {
    teamId,
    userId,
    userTeamId: str(user.team_id) || teamId,
    action: actionId,
    cardId: action.value,
    title,
    responseUrl,
  }
}
