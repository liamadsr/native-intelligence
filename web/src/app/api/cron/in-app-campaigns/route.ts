import { NextResponse } from 'next/server'
import { getServiceClient, listAllAuthUsers } from '@/lib/admin'
import { getPostHogServerClient, serverDefaultProperties } from '@/lib/posthog'
import { requireCronSecret } from '@/lib/api-auth'

// ---------------------------------------------------------------------------
// In-app campaign delivery (hourly cron)
//
// Drives two kinds of scheduled in-app delivery, both writing into
// `in_app_messages` with status 'pending' so the user-side toast→popup channel
// (in-app-message-*.tsx) picks them up on its next poll.
//
//   1. STEP DRIP (the one the campaign UI builds): a campaign with ordered
//      `campaign_steps`, each with a `delay_days` offset. We send the next
//      in-app step whose delay has elapsed since the user's anchor time
//      (signup for auth_users, invited_at for early_access). This mirrors the
//      email drip (`/api/cron/drip-campaign`) but for the in-app channel and
//      for the auth_users audience.
//
//   2. LEGACY SINGLE-SHOT: a campaign with no steps but a campaign-level
//      `schedule_trigger = 'days_after_signup:N'` sends one message N days
//      after signup. Kept so older campaigns keep working.
//
// "Already sent" is derived from the `in_app_messages` ledger itself
// (campaign_id [+ step_id]); there is no separate per-user enrollment table.
// ---------------------------------------------------------------------------

interface CampaignStep {
  id: string
  step_order: number
  delivery_channel: string
  delay_days: number
  is_active: boolean
  message_title: string | null
  message_body: string | null
  message_type: string | null
  cta_text: string | null
  cta_action: string | null
  cta_url: string | null
  priority: string | null
  expires_after_days: number | null
}

interface Campaign {
  id: string
  title: string
  audience_source: string | null
  schedule_trigger: string | null
  // Campaign-level in-app content (used by the legacy single-shot path).
  message_title: string | null
  message_body: string | null
  message_type: string | null
  cta_text: string | null
  cta_action: string | null
  cta_url: string | null
  priority: string | null
  expires_after_days: number | null
  campaign_steps: CampaignStep[]
}

/** A recipient with the anchor time the drip clock counts from. */
interface Recipient {
  id: string
  email: string | null
  anchor: string // ISO timestamp
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Has `delayDays` elapsed since the anchor time? */
function isDue(anchor: string, delayDays: number, now: number): boolean {
  return now >= new Date(anchor).getTime() + delayDays * DAY_MS
}

/** PostgREST caps one response at 1000 rows; ledger/recipient reads page past it. */
const PAGE_SIZE = 1000

/** Read every row of a query by paging with `.range()` until a short page. */
async function readAllPages<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<{ data: T[]; error: { message: string } | null }> {
  const out: T[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await page(from, from + PAGE_SIZE - 1)
    if (error) return { data: out, error }
    out.push(...(data ?? []))
    if (!data || data.length < PAGE_SIZE) return { data: out, error: null }
  }
}

function expiresAtFor(expiresAfterDays: number | null, now: number): string | null {
  return expiresAfterDays ? new Date(now + expiresAfterDays * DAY_MS).toISOString() : null
}

export async function GET(request: Request) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const supabase = getServiceClient()
  const posthog = getPostHogServerClient()
  const now = Date.now()

  // Active campaigns that schedule in-app delivery: either a step drip
  // (trigger_type='cron' with steps) or a legacy campaign-level schedule.
  const { data: campaigns, error: campaignError } = await supabase
    .from('campaigns')
    .select(`
      id, title, audience_source, schedule_trigger,
      message_title, message_body, message_type, cta_text, cta_action, cta_url, priority, expires_after_days,
      campaign_steps (
        id, step_order, delivery_channel, delay_days, is_active,
        message_title, message_body, message_type, cta_text, cta_action, cta_url, priority, expires_after_days
      )
    `)
    .eq('is_active', true)

  if (campaignError) {
    console.error('Failed to fetch campaigns:', campaignError.message)
    return NextResponse.json({ error: 'Database query failed' }, { status: 500 })
  }

  if (!campaigns || campaigns.length === 0) {
    return NextResponse.json({ message: 'No active campaigns to process', sent: 0 })
  }

  let totalSent = 0
  let totalSkipped = 0
  let totalFailed = 0

  // Resolve the recipient pool for a campaign's audience, each tagged with the
  // anchor time the drip clock counts from.
  async function resolveRecipients(audience: string | null): Promise<Recipient[]> {
    if (audience === 'early_access') {
      const { data: rows, error } = await readAllPages((from, to) =>
        supabase
          .from('early_access')
          .select('id, user_id, email, invited_at')
          .eq('unsubscribed', false)
          .not('invited_at', 'is', null)
          .not('user_id', 'is', null)
          .order('id', { ascending: true })
          .range(from, to),
      )
      if (error) {
        console.error('Failed to fetch early_access users:', error?.message)
        return []
      }
      return rows
        .filter((r) => r.user_id && r.invited_at)
        .map((r) => ({ id: r.user_id as string, email: r.email, anchor: r.invited_at as string }))
    }

    // Default: auth_users — anchor on account creation, only users who've
    // signed in at least once (avoids messaging dormant signups).
    const all = await listAllAuthUsers(supabase)
    return all
      .filter((u) => u.last_sign_in_at && u.created_at)
      .map((u) => ({ id: u.id, email: u.email ?? null, anchor: u.created_at }))
  }

  async function insertMessage(
    userId: string,
    email: string | null,
    campaign: Campaign,
    stepId: string | null,
    content: {
      message_title: string | null
      message_body: string | null
      message_type: string | null
      cta_text: string | null
      cta_action: string | null
      cta_url: string | null
      priority: string | null
      expires_after_days: number | null
    },
  ): Promise<'sent' | 'skipped' | 'failed'> {
    if (!content.message_title || !content.message_body) {
      // Nothing to deliver — a content-less / email-only step. This is a
      // configuration gap, not a delivery failure, so report it as skipped.
      return 'skipped'
    }
    const { error } = await supabase.from('in_app_messages').insert({
      user_id: userId,
      campaign_id: campaign.id,
      step_id: stepId,
      message_title: content.message_title,
      message_body: content.message_body,
      message_type: content.message_type ?? 'announcement',
      cta_text: content.cta_text,
      cta_action: content.cta_action,
      cta_url: content.cta_url,
      priority: content.priority ?? 'normal',
      expires_at: expiresAtFor(content.expires_after_days, now),
      status: 'pending',
    })
    if (error) {
      console.error(`Failed to insert in-app message for ${email ?? userId}:`, error.message)
      return 'failed'
    }
    posthog?.capture({
      distinctId: email ?? userId,
      event: 'in_app_campaign_message_created',
      properties: {
        campaign_id: campaign.id,
        campaign_title: campaign.title,
        step_id: stepId,
        ...serverDefaultProperties,
      },
    })
    return 'sent'
  }

  function tally(result: 'sent' | 'skipped' | 'failed') {
    if (result === 'sent') totalSent++
    else if (result === 'skipped') totalSkipped++
    else totalFailed++
  }

  for (const raw of campaigns as Campaign[]) {
    const campaign = raw
    const inAppSteps = (campaign.campaign_steps ?? [])
      .filter(
        (s) => s.is_active && (s.delivery_channel === 'in_app' || s.delivery_channel === 'both'),
      )
      .sort((a, b) => a.step_order - b.step_order)

    const hasStepDrip = inAppSteps.length > 0
    const hasLegacySchedule = campaign.schedule_trigger?.startsWith('days_after_signup:')

    // Nothing in-app-scheduled about this campaign — skip (it may be a
    // manual-send or email-only campaign).
    if (!hasStepDrip && !hasLegacySchedule) {
      totalSkipped++
      continue
    }

    const recipients = await resolveRecipients(campaign.audience_source)
    if (recipients.length === 0) continue

    // Which steps / campaign has each user already received? (the ledger)
    // Paged: a truncated ledger makes delivered users look unsent, and they
    // would get the same message again every hour.
    const { data: sent, error: ledgerError } = await readAllPages((from, to) =>
      supabase
        .from('in_app_messages')
        .select('user_id, step_id')
        .eq('campaign_id', campaign.id)
        .order('id', { ascending: true })
        .range(from, to),
    )
    if (ledgerError) {
      // An unreadable ledger must not be treated as "nothing sent".
      console.error(`Failed to read in-app ledger for campaign ${campaign.id}:`, ledgerError.message)
      totalFailed++
      continue
    }

    // user_id -> set of step_ids delivered (null step_id => '' sentinel).
    const sentByUser = new Map<string, Set<string>>()
    for (const row of sent) {
      const set = sentByUser.get(row.user_id) ?? new Set<string>()
      set.add(row.step_id ?? '')
      sentByUser.set(row.user_id, set)
    }

    if (hasStepDrip) {
      // STEP DRIP: send the next not-yet-sent step whose delay has elapsed.
      for (const r of recipients) {
        const already = sentByUser.get(r.id) ?? new Set<string>()
        const nextStep = inAppSteps.find((s) => !already.has(s.id))
        if (!nextStep) {
          totalSkipped++
          continue
        }
        if (!isDue(r.anchor, nextStep.delay_days, now)) {
          totalSkipped++
          continue
        }
        tally(await insertMessage(r.id, r.email, campaign, nextStep.id, nextStep))
      }
    } else {
      // LEGACY SINGLE-SHOT: one message N days after signup, once per user.
      const daysAfter = parseInt(campaign.schedule_trigger!.split(':')[1] ?? '', 10)
      if (isNaN(daysAfter)) {
        totalSkipped++
        continue
      }
      for (const r of recipients) {
        if ((sentByUser.get(r.id)?.size ?? 0) > 0) {
          totalSkipped++
          continue
        }
        if (!isDue(r.anchor, daysAfter, now)) {
          totalSkipped++
          continue
        }
        tally(await insertMessage(r.id, r.email, campaign, null, campaign))
      }
    }
  }

  return NextResponse.json({
    message: 'In-app campaigns processed',
    campaigns: campaigns.length,
    sent: totalSent,
    skipped: totalSkipped,
    failed: totalFailed,
  })
}
