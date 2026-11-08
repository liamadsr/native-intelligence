import { NextResponse } from 'next/server'
import { requireAdmin, getAdminServiceClient } from '@/lib/admin'
import { sendEmail, getUnsubscribeUrl, getEmailTemplate, getEmailCampaignBySlug, BASE_URL } from '@/lib/email'

export async function POST(request: Request) {
  try {
    await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json()
  const batchSize = Math.min(Math.max(body.batchSize ?? 10, 1), 100)

  const supabase = await getAdminServiceClient()

  // Look up the early-access campaign and its first email step for the template
  console.log('[send-invites] Looking up early-access campaign...')
  const campaign = await getEmailCampaignBySlug('early-access', supabase)
  console.log('[send-invites] Campaign:', campaign)

  if (!campaign) {
    return NextResponse.json(
      { error: 'Early-access campaign not found. Create a campaign with slug "early-access".' },
      { status: 400 },
    )
  }

  // Find the first email step in this campaign to get the template slug
  const { data: inviteStep, error: stepError } = await supabase
    .from('campaign_steps')
    .select('template_slug')
    .eq('campaign_id', campaign.id)
    .in('delivery_channel', ['email', 'both'])
    .order('step_order', { ascending: true })
    .limit(1)
    .single()

  console.log('[send-invites] Invite step:', inviteStep, 'Step error:', stepError)

  const templateSlug = inviteStep?.template_slug
  if (!templateSlug) {
    return NextResponse.json(
      { error: 'No email step with a template found in the early-access campaign. Add an email step and assign a template.' },
      { status: 400 },
    )
  }

  console.log('[send-invites] Using template slug:', templateSlug)

  const { data: users, error } = await supabase
    .from('early_access')
    .select('*')
    .eq('status', 'waitlisted')
    .eq('unsubscribed', false)
    .order('created_at', { ascending: true })
    .limit(batchSize)

  if (error) {
    console.error('[send-invites] DB query failed:', error)
    return NextResponse.json({ error: 'Database query failed' }, { status: 500 })
  }

  console.log('[send-invites] Waitlisted users found:', users?.length ?? 0)

  if (!users || users.length === 0) {
    return NextResponse.json({ sent: 0, failed: 0, message: 'No waitlisted users' })
  }

  let sent = 0
  let failed = 0

  for (const user of users) {
    try {
      const unsubscribeUrl = getUnsubscribeUrl(user.email)
      const downloadUrl = `${BASE_URL}/api/download`

      const template = await getEmailTemplate(templateSlug, {
        unsubscribe_url: unsubscribeUrl,
        download_url: downloadUrl,
      }, supabase)

      if (!template) {
        console.error(`[send-invites] Template "${templateSlug}" not found in DB`)
        failed++
        continue
      }

      console.log(`[send-invites] Sending to ${user.email} via Resend...`)
      const { data, error: sendError } = await sendEmail({
        to: user.email,
        subject: template.subject,
        html: template.html,
      })

      if (sendError) {
        console.error(`[send-invites] Resend error for ${user.email}:`, JSON.stringify(sendError))
        failed++
        continue
      }
      console.log(`[send-invites] Resend success for ${user.email}, id:`, data?.id)

      const now = new Date().toISOString()
      await supabase
        .from('early_access')
        .update({
          status: 'invited',
          invited_at: now,
          last_email_step: templateSlug,
          last_email_sent_at: now,
        })
        .eq('id', user.id)

      await supabase.from('email_campaign_log').insert({
        early_access_id: user.id,
        email: user.email,
        campaign_step: templateSlug,
        campaign_id: campaign.id,
        resend_id: data?.id ?? null,
      })

      sent++
      await new Promise((resolve) => setTimeout(resolve, 100))
    } catch (err) {
      console.error(`Failed to process invite for ${user.email}:`, err)
      failed++
    }
  }

  return NextResponse.json({ sent, failed })
}
