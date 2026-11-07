import { NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { requireCronSecret } from '@/lib/api-auth'
import { fetchAllRows } from '@/lib/supabase/paging'
import {
  sendCampaignEmail,
  getUnsubscribeUrl,
  BASE_URL,
} from '@/lib/email'

interface CampaignStep {
  id: string
  step_order: number
  step_name: string
  delivery_channel: string
  template_slug: string | null
  delay_days: number
  is_active: boolean
  // In-app fields
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
  slug: string
  audience_source: string
  campaign_steps: CampaignStep[]
}

function getNextStepFromDB(
  steps: CampaignStep[],
  lastTemplateSlug: string | null,
): CampaignStep | null {
  if (!lastTemplateSlug) {
    // User has been invited but hasn't received any drip step yet.
    // The first step (invite, step_order=0) was sent manually via SendInvitesForm,
    // so the first drip step is index 1.
    return steps[1] ?? null
  }
  const currentIndex = steps.findIndex((s) => s.template_slug === lastTemplateSlug)
  if (currentIndex === -1 || currentIndex >= steps.length - 1) return null
  return steps[currentIndex + 1]
}

function isDueFromDB(invitedAt: string, delayDays: number): boolean {
  const inviteDate = new Date(invitedAt)
  const dueDate = new Date(inviteDate.getTime() + delayDays * 24 * 60 * 60 * 1000)
  return new Date() >= dueDate
}

export async function GET(request: Request) {
  // Verify cron secret
  const denied = requireCronSecret(request)
  if (denied) return denied

  const supabase = getServiceClient()

  // Fetch all active cron-triggered campaigns with their steps
  const { data: campaigns, error: campaignsError } = await supabase
    .from('campaigns')
    .select(`
      id, slug, audience_source,
      campaign_steps (
        id, step_order, step_name, delivery_channel, template_slug, delay_days, is_active,
        message_title, message_body, message_type, cta_text, cta_action, cta_url, priority, expires_after_days
      )
    `)
    .eq('is_active', true)
    .eq('trigger_type', 'cron')

  if (campaignsError) {
    console.error('Failed to fetch campaigns:', campaignsError.message)
    return NextResponse.json({ error: 'Database query failed' }, { status: 500 })
  }

  if (!campaigns || campaigns.length === 0) {
    return NextResponse.json({ message: 'No active cron campaigns', sent: 0 })
  }

  let totalSent = 0
  let totalSkipped = 0
  let totalFailed = 0

  for (const campaign of campaigns as Campaign[]) {
    // Sort steps by step_order and filter active ones
    const steps = campaign.campaign_steps
      .filter((s) => s.is_active)
      .sort((a, b) => a.step_order - b.step_order)

    if (steps.length === 0) continue

    // For now, only early_access audience is supported for drip campaigns
    if (campaign.audience_source !== 'early_access') continue

    // Filter to email-capable steps only (email or both)
    const emailSteps = steps.filter(
      (s) => s.delivery_channel === 'email' || s.delivery_channel === 'both',
    )
    if (emailSteps.length === 0) continue

    // Fetch eligible users. Paged by id: one response stops at 1000 rows, so
    // the users past it (an arbitrary, shifting set) never got their next step.
    const { data: users, error: usersError } = await fetchAllRows(() =>
      supabase
        .from('early_access')
        .select('*')
        .neq('status', 'waitlisted')
        .eq('unsubscribed', false)
        .not('invited_at', 'is', null),
    )

    if (usersError) {
      console.error(`Failed to fetch users for campaign ${campaign.slug}:`, usersError?.message)
      continue
    }

    for (const user of users) {
      const lastStep = user.last_email_step as string | null
      const nextStep = getNextStepFromDB(emailSteps, lastStep)

      if (!nextStep) {
        totalSkipped++
        continue
      }

      if (!isDueFromDB(user.invited_at, nextStep.delay_days)) {
        totalSkipped++
        continue
      }

      if (!nextStep.template_slug) {
        totalSkipped++
        continue
      }

      const unsubscribeUrl = getUnsubscribeUrl(user.email)

      try {
        await sendCampaignEmail({
          to: user.email,
          earlyAccessId: user.id,
          step: nextStep.template_slug,
          campaignId: campaign.id,
          supabase,
          templateVars: {
            unsubscribe_url: unsubscribeUrl,
            download_url: `${BASE_URL}/api/download`,
            feedback_url: `${BASE_URL}/feedback`,
            pricing_url: `${BASE_URL}/pricing`,
          },
        })
        totalSent++
      } catch (err) {
        console.error(`Failed to send ${nextStep.template_slug} to ${user.email}:`, err)
        totalFailed++
      }

      // Small delay between sends
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  return NextResponse.json({
    message: 'Drip campaign processed',
    sent: totalSent,
    skipped: totalSkipped,
    failed: totalFailed,
  })
}
