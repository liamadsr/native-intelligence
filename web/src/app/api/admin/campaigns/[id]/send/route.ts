import { NextResponse } from 'next/server'
import { requireAdmin, getAdminServiceClient, listAllAuthUsers } from '@/lib/admin'
import { getPostHogServerClient, serverDefaultProperties } from '@/lib/posthog'
import { sendCampaignEmail, getUnsubscribeUrl, BASE_URL } from '@/lib/email'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let admin
  try {
    admin = await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params
  const body = await request.json().catch(() => ({}))
  const { user_ids, step_id } = body as { user_ids?: string[]; step_id?: string }

  const supabase = await getAdminServiceClient()

  // Fetch campaign
  const { data: campaign, error: campaignError } = await supabase
    .from('campaigns')
    .select('*')
    .eq('id', id)
    .single()

  if (campaignError || !campaign) {
    return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
  }

  if (!campaign.is_active) {
    return NextResponse.json({ error: 'Campaign is inactive' }, { status: 400 })
  }

  // Get step content if step_id provided
  let step: Record<string, unknown> | null = null
  if (step_id) {
    const { data: stepData, error: stepError } = await supabase
      .from('campaign_steps')
      .select('*')
      .eq('id', step_id)
      .eq('campaign_id', id)
      .single()

    if (stepError || !stepData) {
      return NextResponse.json({ error: 'Step not found' }, { status: 404 })
    }
    step = stepData
  }

  // Determine delivery channel
  const deliveryChannel = (step?.delivery_channel as string) ?? campaign.delivery_channel ?? 'in_app'

  // Validate the email template up front: failing after the in-app loop
  // would leave every user with an in-app message and a retry would double it.
  const sendsEmail = deliveryChannel === 'email' || deliveryChannel === 'both'
  const templateSlug = (step?.template_slug as string | null) ?? null
  if (sendsEmail && !templateSlug) {
    return NextResponse.json(
      { error: 'Step has no email template configured' },
      { status: 400 },
    )
  }

  // Determine target users
  let targetUserIds: string[]

  if (user_ids && user_ids.length > 0) {
    targetUserIds = user_ids
  } else {
    try {
      const allUsers = await listAllAuthUsers(supabase)
      targetUserIds = allUsers.filter((u) => u.last_sign_in_at).map((u) => u.id)
    } catch (error) {
      return NextResponse.json({ error: (error as Error).message }, { status: 500 })
    }
  }

  if (targetUserIds.length === 0) {
    return NextResponse.json({ error: 'No target users found' }, { status: 400 })
  }

  let inAppSuccess = 0
  let inAppFailed = 0
  let emailSuccess = 0
  let emailFailed = 0

  // --- In-App delivery ---
  if (deliveryChannel === 'in_app' || deliveryChannel === 'both') {
    const messageTitle = (step?.message_title as string) || campaign.message_title
    const messageBody = (step?.message_body as string) || campaign.message_body
    const messageType = (step?.message_type as string) || campaign.message_type
    const ctaText = (step?.cta_text as string | null) ?? campaign.cta_text
    const ctaAction = (step?.cta_action as string | null) ?? campaign.cta_action
    const ctaUrl = (step?.cta_url as string | null) ?? campaign.cta_url
    const priority = (step?.priority as string) || campaign.priority
    const expiresAfterDays = (step?.expires_after_days as number) ?? campaign.expires_after_days ?? 7

    const expiresAt = new Date()
    expiresAt.setDate(expiresAt.getDate() + expiresAfterDays)

    for (const userId of targetUserIds) {
      try {
        const { error: insertError } = await supabase
          .from('in_app_messages')
          .insert({
            user_id: userId,
            campaign_id: campaign.id,
            step_id: step_id ?? null,
            message_title: messageTitle,
            message_body: messageBody,
            message_type: messageType,
            cta_text: ctaText,
            cta_action: ctaAction,
            cta_url: ctaUrl,
            priority,
            sent_by: admin.email,
            expires_at: expiresAt.toISOString(),
            status: 'pending',
          })

        if (insertError) {
          inAppFailed++
        } else {
          inAppSuccess++
        }
      } catch {
        inAppFailed++
      }
    }
  }

  // --- Email delivery ---
  if (sendsEmail && templateSlug) {
    // Get user emails for email delivery
    const allUsers = await listAllAuthUsers(supabase)
    const userMap = new Map(allUsers.map((u) => [u.id, u.email ?? '']))

    for (const userId of targetUserIds) {
      const email = userMap.get(userId)
      if (!email) {
        emailFailed++
        continue
      }

      try {
        await sendCampaignEmail({
          to: email,
          step: templateSlug,
          campaignId: campaign.id,
          supabase,
          templateVars: {
            unsubscribe_url: getUnsubscribeUrl(email),
            download_url: `${BASE_URL}/api/download`,
          },
        })
        emailSuccess++
      } catch {
        emailFailed++
      }
    }
  }

  const posthog = getPostHogServerClient()
  posthog?.capture({
    distinctId: admin.id,
    event: 'admin_campaign_sent',
    properties: {
      ...serverDefaultProperties,
      campaign_id: id,
      campaign_title: campaign.title,
      step_id: step_id ?? null,
      delivery_channel: deliveryChannel,
      target_count: targetUserIds.length,
      in_app_success: inAppSuccess,
      in_app_failed: inAppFailed,
      email_success: emailSuccess,
      email_failed: emailFailed,
    },
  })

  return NextResponse.json({
    success: inAppSuccess + emailSuccess,
    failed: inAppFailed + emailFailed,
    total: targetUserIds.length,
    details: {
      in_app: { success: inAppSuccess, failed: inAppFailed },
      email: { success: emailSuccess, failed: emailFailed },
    },
  })
}
