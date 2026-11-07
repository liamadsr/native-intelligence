/**
 * A DM from a person's linked Slack account (src/lib/slack/inbound.ts decided
 * who it is): either the answer to one of their pending approvals, named by
 * its code ("yes K7Q4", caller.ts bindReplyToApproval), settled as their own
 * click; or anything else, which becomes a turn in their home thread
 * (./turn.ts deliverSlackDm). A stray "yes" names nothing, so it goes to the
 * agent like any message and approves nothing.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { approvalNamedByReply, settleApprovalFromSlack, settleLine } from './approvals'
import { slackTextToPlain, type SlackInbound } from './events'
import { memberIdOf, type SlackInstallation, type SlackUserLink } from './store'
import { deliverSlackDm, type DeliverOutcome, type SlackTurnSlack } from './turn'

type Dm = Extract<SlackInbound, { kind: 'dm' }>

export type PersonDmOutcome = DeliverOutcome | 'approval_answered' | 'approval_refused'

export async function handlePersonDm(
  supabase: SupabaseClient,
  input: { dm: Dm; installation: SlackInstallation; link: SlackUserLink },
  slack: SlackTurnSlack,
  deps: { deliver?: typeof deliverSlackDm; settle?: typeof settleApprovalFromSlack } = {},
): Promise<PersonDmOutcome> {
  const { dm, installation, link } = input
  const named = await approvalNamedByReply(supabase, { userId: link.user_id, text: slackTextToPlain(dm.text, { botUserId: installation.bot_user_id }) })
  if (named) {
    const memberId = await memberIdOf(supabase, named.workspaceId, link.user_id).catch(() => null)
    const outcome = memberId
      ? await (deps.settle ?? settleApprovalFromSlack)(supabase, { userId: link.user_id, memberId, cardId: named.cardId, decision: named.decision })
      : ({ ok: false, code: 'NOT_FOUND', error: 'not a member' } as const)
    await slack.post({ channel: dm.channel, text: settleLine(outcome) })
    return outcome.ok ? 'approval_answered' : 'approval_refused'
  }
  return (deps.deliver ?? deliverSlackDm)(supabase, input, slack)
}
