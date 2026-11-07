/**
 * The owner's launch card (roadmap D1/D2): how the agent launches outreach.
 *
 * launch_sequence and launch_campaign never send on a call. Each raises ONE
 * approval card (src/lib/safety/approvals.ts) that shows the emails, the
 * schedule, the mailbox they go from and the people they go to, and sends
 * only when the person says yes: the card's own click in the app, or
 * "yes CODE" by text (src/lib/sms/approvals.ts; a text turn's card is texted
 * with its code after the reply). The yes replays the tool with
 * `approvedCall.outreach`, which this module checks:
 *
 *   - the copy and schedule must still hash to what the card showed
 *     (outreachContentHash); an edit since refuses, and the agent asks again;
 *   - only the people the card named are sent to (recipient_ids); anyone
 *     enrolled or matched since waits for a card of their own.
 *
 * Everything else a launch keeps is the engine's: a reply stops a contact's
 * emails, the opt-out list is checked at enrollment and again at every send,
 * and sends go out only inside the send window.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ApprovalContext } from '@/lib/safety/approvals'
import type { ApprovedCall, OutreachApprovalContext } from '@/lib/safety/approved-call'
import { normalizeWindow } from './schedule'
import type { LaunchPlan, LaunchStep } from './launch'

/**
 * The most people one card sends to, every one of them listed on it by name
 * (the input must fit on the card): a bigger audience goes out over more
 * cards (a sequence's next launch, a rolling campaign's next week).
 */
export const LAUNCH_RECIPIENTS_MAX = 100
/** The card lists every recipient it sends to. */
export const LAUNCH_CARD_RECIPIENTS_SHOWN = LAUNCH_RECIPIENTS_MAX

export interface LaunchRecipient {
  /** The enrollment id (a sequence's card) or the contact id (a campaign's). */
  id: string
  name: string | null
  email: string
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`
}

/** "Mon–Fri 09:00–16:00 America/Los_Angeles". Pure. */
export function describeSendWindow(sequence: Pick<LaunchPlan['sequence'], 'send_window' | 'timezone'>): string {
  const window = normalizeWindow(sequence.send_window)
  const days = [...window.days].sort((a, b) => a - b)
  const contiguous = days.every((d, i) => i === 0 || d === days[i - 1] + 1)
  const dayText =
    days.length === 7
      ? 'Every day'
      : contiguous && days.length > 2
        ? `${DAY_NAMES[days[0] - 1]}–${DAY_NAMES[days[days.length - 1] - 1]}`
        : days.map((d) => DAY_NAMES[d - 1]).join(', ')
  return `${dayText} ${hourLabel(window.start_hour)}–${hourLabel(window.end_hour)} ${sequence.timezone}`
}

/** When each step goes, in words: step 1 at launch, each later one its delay after the one before, unless they reply. Pure. */
export function stepTiming(step: Pick<LaunchStep, 'step_order' | 'delay_days'>, index: number, delayUnit: 'business' | 'calendar'): string {
  if (index === 0) return 'at launch, in the next send window'
  const unit = delayUnit === 'calendar' ? 'day' : 'business day'
  const days = step.delay_days === 1 ? `1 ${unit}` : `${step.delay_days} ${unit}s`
  return `${days} after the previous email, unless they reply`
}

function recipientLine(r: LaunchRecipient): string {
  return r.name && r.name.trim() && r.name.trim().toLowerCase() !== r.email.toLowerCase() ? `${r.name.trim()} <${r.email}>` : r.email
}

/**
 * What the card shows (the approval's stored input): the id the replay acts
 * on, then everything the person reads before saying yes, as text the card
 * shows whole (src/lib/attention/approval-input.ts): the recipients one per
 * line, and each email as its own field (`email_01`, `email_02`…) with when
 * it goes, its subject and its body. The replay's schema keeps only the id;
 * `content_hash` makes a re-ask after an edit a new card, never this one.
 * Pure.
 */
export function launchCardInput(args: {
  idKey: 'sequence_id' | 'campaign_id'
  id: string
  plan: LaunchPlan
  recipients: readonly LaunchRecipient[]
  contentHash: string
  campaignName?: string
  /** Matches beyond this card (a campaign bigger than LAUNCH_RECIPIENTS_MAX). */
  notThisCard?: number
}): Record<string, unknown> {
  const { plan, recipients } = args
  const shown = recipients.slice(0, LAUNCH_CARD_RECIPIENTS_SHOWN).map(recipientLine)
  const more = recipients.length - shown.length
  const emails = Object.fromEntries(
    plan.steps.map((step, i) => [
      `email_${String(i + 1).padStart(2, '0')}`,
      `${stepTiming(step, i, plan.sequence.delay_unit)}\nSubject: ${step.subject ?? '(a reply in the same thread)'}\n\n${step.body}`,
    ]),
  )
  return {
    [args.idKey]: args.id,
    ...(args.campaignName ? { campaign: args.campaignName } : {}),
    sequence: plan.sequence.name,
    sends_from: plan.account.account_email ?? 'your connected mailbox',
    recipient_count: recipients.length,
    recipients: [...shown, ...(more > 0 ? [`…and ${more} more`] : [])].join('\n'),
    ...(args.notThisCard ? { not_on_this_card: `${args.notThisCard} more match and wait for a later card` } : {}),
    ...emails,
    send_window: describeSendWindow(plan.sequence),
    stops: 'A reply stops that person’s emails; anyone on the opt-out list is skipped.',
    content_hash: args.contentHash,
  }
}

function clip(text: string, n: number): string {
  const t = text.trim().replace(/\s+/g, ' ')
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t
}

/**
 * The card's title and why. Both also make the text that asks by SMS
 * (src/lib/sms/approvals.ts approvalPromptText: each cut at 120 characters,
 * anything domain-like masked), so they carry no address and no merge
 * field: the card's inputs, and the agent's own reply, say the rest. Pure.
 */
export function launchCardCopy(args: { plan: LaunchPlan; recipients: readonly LaunchRecipient[]; campaignName?: string }): { title: string; why: string } {
  const { plan, recipients } = args
  const n = recipients.length
  const people = n === 1 ? '1 person' : `${n} people`
  const what = `“${clip(args.campaignName ?? plan.sequence.name, 60)}”`
  const emails = plan.steps.length === 1 ? '1 email' : `${plan.steps.length} emails`
  return {
    title: `Send ${what} to ${people}?`,
    why: `${emails} from your mailbox, starting in the next send window. A reply stops them.`,
  }
}

/** The one-line summary the agent relays (a text turn's reply carries it to the person's phone). Pure. */
export function launchSummary(args: { plan: LaunchPlan; recipients: readonly LaunchRecipient[] }): string {
  const { plan, recipients } = args
  const names = recipients.slice(0, 5).map((r) => r.name?.trim() || r.email)
  const others = recipients.length - names.length
  const who = `${names.join(', ')}${others > 0 ? ` and ${others} more` : ''}`
  const steps = plan.steps
    .map((s, i) => `${i + 1}) ${s.subject ? `“${clip(s.subject, 60)}”` : 'a follow-up in the same thread'} ${i === 0 ? 'right away' : `${s.delay_days} ${plan.sequence.delay_unit === 'calendar' ? 'days' : 'business days'} later`}`)
    .join('; ')
  return `${recipients.length} ${recipients.length === 1 ? 'person' : 'people'} (${who}), from ${plan.account.account_email ?? 'your mailbox'}: ${steps}. Sends ${describeSendWindow(plan.sequence)}.`
}

/** The approved outreach card for this tool, kind and id, or null (approved-call.ts). */
export function approvedOutreach(
  approved: ApprovedCall | undefined,
  tool: 'launch_sequence' | 'launch_campaign',
  kind: OutreachApprovalContext['kind'],
  id: string,
): OutreachApprovalContext | null {
  if (!approved || approved.tool !== tool || !approved.outreach) return null
  const card = approved.outreach
  return card.kind === kind && card.id === id && typeof card.content_hash === 'string' && Array.isArray(card.recipient_ids) ? card : null
}

/** Where a tool's card is raised from: the chat it renders in, and the door's re-check context. */
export interface LaunchCardOrigin {
  /** The chat conversation (the card renders inline after the agent's message; a text turn texts its code). Null: the home thread. */
  conversationId?: string | null
  /** The chat door's own context (agent, surface, teammate fence), stored for the accept-time re-check. */
  approvalContext?: Omit<ApprovalContext, 'flow' | 'connection' | 'bots' | 'document' | 'outreach'>
}

/**
 * Hold the launch as the person's card. Service role. Loaded lazily: the
 * approvals module imports createTools, which imports the tools that call
 * this.
 */
export async function raiseLaunchCard(
  service: SupabaseClient,
  request: {
    userId: string
    workspaceId: string
    toolName: 'launch_sequence' | 'launch_campaign'
    input: Record<string, unknown>
    card: { title: string; why: string }
    outreach: OutreachApprovalContext
    origin: LaunchCardOrigin
  },
): Promise<{ ok: true; approval_id: string; reused: boolean } | { ok: false; code: string; error: string }> {
  const { createToolApproval } = await import('@/lib/safety/approvals')
  const held = await createToolApproval(service, {
    door: 'chat',
    userId: request.userId,
    workspaceId: request.workspaceId,
    toolName: request.toolName,
    sideEffect: 'external-write',
    input: request.input,
    conversationId: request.origin.conversationId ?? null,
    context: { ...(request.origin.approvalContext ?? {}), outreach: request.outreach },
    reason: `outreach_${request.outreach.kind}_launch`,
    card: request.card,
  })
  return held.ok ? { ok: true, approval_id: held.approvalId, reused: held.reused === true } : { ok: false, code: held.code, error: held.error }
}
