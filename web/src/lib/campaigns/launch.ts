/**
 * Launching a campaign (roadmap D2): its audience, through its sequence, on
 * the person's yes.
 *
 *   prepareCampaignLaunch  who the audience reaches today (eligibleRecipients:
 *                          the opt-out list, people already in the sequence or
 *                          another one left out), the sequence's launch checks
 *                          (src/lib/sequences/launch.ts) and the emails
 *                          rendered for each of them. Sends nothing.
 *   raiseCampaignCard      the person's card for it (launch-card.ts): the
 *                          emails and every recipient. Nothing sends until
 *                          their yes.
 *   executeCampaignLaunch  the replay of that yes: only the people the card
 *                          named who still match and are still eligible are
 *                          enrolled, and only they are armed; the copy must
 *                          still be what the card showed.
 *   refreshRollingCampaign a rolling campaign's weekly pass: newly matching
 *                          people get one card of their own (at most one
 *                          waiting per campaign).
 *
 * The engine keeps the rest: a reply stops a person's emails, the opt-out
 * list is checked again at every send, and sends stay inside the window.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { enrollContacts } from '@/lib/sequences/mutations'
import {
  armLaunch,
  isStaged,
  loadLaunchPlan,
  loadSequenceForLaunch,
  outreachContentHash,
  renderFailures,
  type LaunchEnrollment,
  type LaunchPlan,
} from '@/lib/sequences/launch'
import {
  LAUNCH_RECIPIENTS_MAX,
  launchCardCopy,
  launchCardInput,
  raiseLaunchCard,
  type LaunchCardOrigin,
  type LaunchRecipient,
} from '@/lib/sequences/launch-card'
import type { OutreachApprovalContext } from '@/lib/safety/approved-call'
import { eligibleRecipients, matchAudience, type AudienceContact, type AudienceSkips } from './audience'
import { describeAudience, parseAudience, type CampaignAudience, type CampaignStats } from './shape'

/** The campaign columns a launch reads. */
export const CAMPAIGN_LAUNCH_COLUMNS = 'id, workspace_id, name, status, sequence_id, audience, rolling, stats, launched_at, launched_by'

export interface CampaignForLaunch {
  id: string
  workspace_id: string
  name: string
  status: string
  sequence_id: string | null
  audience: unknown
  rolling: boolean
  stats: CampaignStats | null
  launched_at: string | null
  launched_by: string | null
}

export interface CampaignLaunchRefusal {
  ok: false
  code: string
  error: string
  failures?: Array<{ contact_id: string; email: string; step_order: number; tokens: string[] }>
}

export interface CampaignLaunchPrep {
  ok: true
  campaign: CampaignForLaunch
  audience: CampaignAudience
  plan: LaunchPlan
  /** Everyone eligible today, in match order. */
  eligible: AudienceContact[]
  /** The first LAUNCH_RECIPIENTS_MAX of them: who a card names. */
  recipients: LaunchRecipient[]
  matched: number
  skipped: AudienceSkips
  contentHash: string
}

/** A would-be recipient in the shape the launch renders (no enrollment yet: no overrides, no thread). */
function asRenderable(contact: AudienceContact): Pick<LaunchEnrollment, 'id' | 'contact_email' | 'overrides' | 'thread_subject' | 'provider_thread_id' | 'contact'> {
  return {
    id: contact.id,
    contact_email: contact.email,
    overrides: null,
    thread_subject: null,
    provider_thread_id: null,
    contact: {
      first_name: contact.first_name,
      last_name: contact.last_name,
      full_name: contact.full_name,
      email: contact.email,
      company: contact.company,
    },
  }
}

/** Load a campaign for a launch, fenced to its workspace. */
export async function loadCampaignForLaunch(
  supabase: SupabaseClient,
  args: { workspaceId: string; campaignId: string },
): Promise<CampaignForLaunch | null> {
  const { data, error } = await supabase
    .from('campaign')
    .select(CAMPAIGN_LAUNCH_COLUMNS)
    .eq('id', args.campaignId)
    .eq('workspace_id', args.workspaceId)
    .maybeSingle()
  if (error) throw new Error(`campaign read failed: ${error.message}`)
  return (data as CampaignForLaunch | null) ?? null
}

/** Who the campaign reaches today and what they'd get, checked as a launch checks. Sends nothing. */
export async function prepareCampaignLaunch(
  supabase: SupabaseClient,
  args: { workspaceId: string; campaign: CampaignForLaunch; userId: string; now?: number },
): Promise<CampaignLaunchPrep | CampaignLaunchRefusal> {
  const { campaign, workspaceId } = args
  if (campaign.status === 'archived' || campaign.status === 'completed') {
    return { ok: false, code: 'CAMPAIGN_CLOSED', error: `This campaign is ${campaign.status}; set it active (update_campaign) before it sends again.` }
  }
  if (!campaign.sequence_id) {
    return { ok: false, code: 'NO_SEQUENCE', error: 'This campaign has no sequence to send. Write one with create_sequence, then attach it with update_campaign sequence_id.' }
  }
  const parsedAudience = parseAudience(campaign.audience)
  if (!parsedAudience.ok) {
    return { ok: false, code: 'NO_AUDIENCE', error: 'This campaign has no audience yet. Set one with update_campaign audience (a CRM filter or group).' }
  }
  const audience = parsedAudience.audience

  const loaded = await loadSequenceForLaunch(supabase, { workspaceId, sequenceId: campaign.sequence_id })
  if (!loaded.ok) return { ok: false, code: loaded.extras?.code ?? 'SEQUENCE_UNAVAILABLE', error: loaded.message }
  if (loaded.sequence.status === 'paused') {
    return { ok: false, code: 'SEQUENCE_PAUSED', error: 'The campaign\'s sequence is paused. Resume it first (update_sequence status resume, on the person\'s yes).' }
  }
  const planned = await loadLaunchPlan(supabase, { workspaceId, sequence: loaded.sequence, launcherUserId: args.userId, requireEnrollments: false })
  if (!planned.ok) return { ok: false, code: planned.extras?.code ?? 'LAUNCH_CHECK_FAILED', error: planned.message }

  let matches: AudienceContact[]
  let eligible: { eligible: AudienceContact[]; skipped: AudienceSkips }
  try {
    matches = await matchAudience(supabase, { workspaceId, userId: args.userId, audience, now: args.now })
    eligible = await eligibleRecipients(supabase, { workspaceId, sequenceId: campaign.sequence_id, contacts: matches })
  } catch (err) {
    return { ok: false, code: 'READ_FAILED', error: `Could not read the audience, so nothing was prepared: ${err instanceof Error ? err.message : String(err)}` }
  }

  const onCard = eligible.eligible.slice(0, LAUNCH_RECIPIENTS_MAX)
  const failures = renderFailures(planned.plan, onCard.map(asRenderable))
  if (failures.length > 0) {
    const emailOf = new Map(onCard.map((c) => [c.id, c.email]))
    return {
      ok: false,
      code: 'unresolved_tokens',
      error: 'Some emails would go out with an empty merge field. Give the field a fallback ({{first_name|there}}) with update_sequence, then ask again.',
      failures: failures.slice(0, 20).map((f) => ({ contact_id: f.enrollment_id, email: emailOf.get(f.enrollment_id) ?? '', step_order: f.step_order, tokens: f.tokens })),
    }
  }

  return {
    ok: true,
    campaign,
    audience,
    plan: planned.plan,
    eligible: eligible.eligible,
    recipients: onCard.map((c) => ({ id: c.id, name: c.full_name, email: c.email })),
    matched: matches.length,
    skipped: eligible.skipped,
    contentHash: outreachContentHash(planned.plan),
  }
}

/** The person's card for a prepared launch (nobody to send to: no card). */
export async function raiseCampaignCard(
  service: SupabaseClient,
  args: { prep: CampaignLaunchPrep; userId: string; origin: LaunchCardOrigin },
): Promise<{ ok: true; approval_id: string; reused: boolean } | { ok: false; code: string; error: string }> {
  const { prep } = args
  const notThisCard = prep.eligible.length - prep.recipients.length
  const input = {
    ...launchCardInput({
      idKey: 'campaign_id',
      id: prep.campaign.id,
      plan: prep.plan,
      recipients: prep.recipients,
      contentHash: prep.contentHash,
      campaignName: prep.campaign.name,
      notThisCard,
    }),
    audience: describeAudience(prep.audience),
  }
  const outreach: OutreachApprovalContext = {
    kind: 'campaign',
    id: prep.campaign.id,
    content_hash: prep.contentHash,
    recipient_ids: prep.recipients.map((r) => r.id),
    recipient_emails: prep.recipients.map((r) => r.email.toLowerCase()),
  }
  return raiseLaunchCard(service, {
    userId: args.userId,
    workspaceId: prep.campaign.workspace_id,
    toolName: 'launch_campaign',
    input,
    card: launchCardCopy({ plan: prep.plan, recipients: prep.recipients, campaignName: prep.campaign.name }),
    outreach,
    origin: args.origin,
  })
}

export type CampaignLaunchOutcome =
  | { ok: true; armed: number; enrolled: number; skipped: Array<{ contact_id: string; reason: string }> }
  | CampaignLaunchRefusal

/** The person said yes on the card: enroll and arm exactly the people it named who still qualify. */
export async function executeCampaignLaunch(
  supabase: SupabaseClient,
  args: { workspaceId: string; campaign: CampaignForLaunch; userId: string; approved: OutreachApprovalContext; now?: number },
): Promise<CampaignLaunchOutcome> {
  const prep = await prepareCampaignLaunch(supabase, args)
  if (!prep.ok) return prep
  if (prep.contentHash !== args.approved.content_hash) {
    return {
      ok: false,
      code: 'CAMPAIGN_CHANGED',
      error: 'The emails, schedule or sending mailbox changed after the card was made, so nothing was sent. Call launch_campaign again for a new card.',
    }
  }
  // Each named contact at the address the card showed: one whose address
  // changed since (edited, merged) is not sent to. No addresses: fail closed.
  const shownEmails = args.approved.recipient_emails ?? []
  if (shownEmails.length !== args.approved.recipient_ids.length) {
    return { ok: false, code: 'CARD_INCOMPLETE', error: 'The card did not record the addresses it showed, so nothing was sent. Call launch_campaign again.' }
  }
  const named = new Map(args.approved.recipient_ids.map((id, i) => [id, shownEmails[i]]))
  const targets = prep.eligible.filter((c) => named.get(c.id) === c.email.toLowerCase())
  if (targets.length === 0) {
    return { ok: false, code: 'NOTHING_TO_SEND', error: 'Nobody on the card still qualifies (opted out, already contacted or moved to another sequence), so nothing was sent.' }
  }
  const sequenceId = prep.campaign.sequence_id as string

  const enrolled = await enrollContacts(supabase, { workspaceId: args.workspaceId, sequenceId, enrolledBy: args.userId, contactIds: targets.map((c) => c.id) })
  if (!enrolled.ok) return { ok: false, code: enrolled.code, error: 'Could not enroll the campaign\'s people, so nothing was sent.' }
  const enrolledIds = new Set(enrolled.enrolled)

  // The enrollments now exist: read the plan again and arm only them.
  const reloaded = await loadLaunchPlan(supabase, { workspaceId: args.workspaceId, sequence: prep.plan.sequence, launcherUserId: args.userId, requireEnrollments: false })
  if (!reloaded.ok) return { ok: false, code: reloaded.extras?.code ?? 'LAUNCH_CHECK_FAILED', error: reloaded.message }
  const fresh = reloaded.plan.enrollments.filter((e) => isStaged(e) && e.contact_id !== null && enrolledIds.has(e.contact_id))
  const failures = renderFailures(reloaded.plan, fresh)
  if (failures.length > 0) {
    return { ok: false, code: 'unresolved_tokens', error: 'A merge field has no value for some recipients, so nothing was sent; they stay staged.' }
  }
  const armed = fresh.length > 0
    ? await armLaunch(supabase, {
        workspaceId: args.workspaceId,
        plan: reloaded.plan,
        launcherUserId: args.userId,
        only: (e) => e.contact_id !== null && enrolledIds.has(e.contact_id),
      })
    : { ok: true as const, armed: 0, armedEnrollmentIds: [] }
  if (!armed.ok) return { ok: false, code: armed.extras?.code ?? 'ARM_FAILED', error: armed.message }

  const nowIso = new Date(args.now ?? Date.now()).toISOString()
  const stats: CampaignStats = {
    ...(prep.campaign.stats ?? {}),
    // The audience's people on the opt-out list as of this launch (a snapshot, not a running total).
    skipped_opted_out: prep.skipped.opted_out + enrolled.skipped.filter((s) => s.reason === 'suppressed').length,
    skipped_no_email: enrolled.skipped.filter((s) => s.reason === 'no_email').length,
    skipped_already_active: prep.skipped.in_another_sequence + enrolled.skipped.filter((s) => s.reason === 'already_active').length,
    launches: (prep.campaign.stats?.launches ?? 0) + 1,
  }
  const { error: campaignError } = await supabase
    .from('campaign')
    .update({
      status: 'active',
      launched_at: prep.campaign.launched_at ?? nowIso,
      launched_by: args.userId,
      refreshed_at: nowIso,
      stats,
      updated_at: nowIso,
    })
    .eq('id', prep.campaign.id)
    .eq('workspace_id', args.workspaceId)
  if (campaignError) console.error('[campaigns] launch bookkeeping failed:', campaignError.message)

  return { ok: true, armed: armed.armed, enrolled: enrolled.enrolled.length, skipped: enrolled.skipped }
}

/** True when a launch card for this campaign already waits (a rolling pass raises at most one). Throws on a failed read. */
export async function campaignCardWaiting(service: SupabaseClient, args: { userId: string; campaignId: string }): Promise<boolean> {
  const { data, error } = await service
    .from('tool_approval')
    .select('id')
    .eq('user_id', args.userId)
    .eq('tool', 'launch_campaign')
    .eq('status', 'pending')
    .eq('context->outreach->>id', args.campaignId)
    .gt('expires_at', new Date().toISOString())
    .limit(1)
  if (error) throw new Error(`pending card read failed: ${error.message}`)
  return (data ?? []).length > 0
}

export type RollingOutcome = 'card' | 'nobody_new' | 'card_waiting' | 'not_ready' | 'refused'

/**
 * A rolling campaign's weekly pass, as the person who last launched it: the
 * people newly matching get one card in their home thread (the router takes
 * it to them; by text, with its code). Service role.
 */
export async function refreshRollingCampaign(
  service: SupabaseClient,
  campaign: CampaignForLaunch,
  deps: { now?: number; raise?: typeof raiseCampaignCard } = {},
): Promise<{ outcome: RollingOutcome; approval_id?: string; recipients?: number; error?: string }> {
  const userId = campaign.launched_by
  if (!campaign.rolling || campaign.status !== 'active' || !userId || !campaign.sequence_id) return { outcome: 'not_ready' }
  if (await campaignCardWaiting(service, { userId, campaignId: campaign.id })) return { outcome: 'card_waiting' }
  const prep = await prepareCampaignLaunch(service, { workspaceId: campaign.workspace_id, campaign, userId, now: deps.now })
  const nowIso = new Date(deps.now ?? Date.now()).toISOString()
  await service.from('campaign').update({ refreshed_at: nowIso }).eq('id', campaign.id).eq('workspace_id', campaign.workspace_id)
  if (!prep.ok) return { outcome: 'refused', error: prep.error }
  if (prep.recipients.length === 0) return { outcome: 'nobody_new' }
  const held = await (deps.raise ?? raiseCampaignCard)(service, { prep, userId, origin: { conversationId: null } })
  if (!held.ok) return { outcome: 'refused', error: held.error }
  return { outcome: 'card', approval_id: held.approval_id, recipients: prep.recipients.length }
}
