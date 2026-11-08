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
  const { action, userIds } = body as { action: string; userIds: string[] }

  if (!action || !Array.isArray(userIds) || userIds.length === 0) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
  }

  if (userIds.length > 50) {
    return NextResponse.json({ error: 'Maximum 50 users per batch' }, { status: 400 })
  }

  const supabase = await getAdminServiceClient()
  let success = 0
  let failed = 0
  let skipped = 0
  // extend-trial: users whose trial was extended but whose email did not go out.
  const emailFailed: string[] = []

  switch (action) {
    case 'send-invite': {
      // Look up the early-access campaign and its first email step for the template
      console.log('[bulk-action/send-invite] Looking up early-access campaign...')
      const eaCampaign = await getEmailCampaignBySlug('early-access', supabase)
      console.log('[bulk-action/send-invite] Campaign:', eaCampaign)
      if (!eaCampaign) {
        return NextResponse.json(
          { error: 'Early-access campaign not found. Create a campaign with slug "early-access".' },
          { status: 400 },
        )
      }

      const { data: inviteStep, error: stepError } = await supabase
        .from('campaign_steps')
        .select('template_slug')
        .eq('campaign_id', eaCampaign.id)
        .in('delivery_channel', ['email', 'both'])
        .order('step_order', { ascending: true })
        .limit(1)
        .single()

      console.log('[bulk-action/send-invite] Invite step:', inviteStep, 'Step error:', stepError)

      const inviteTemplateSlug = inviteStep?.template_slug
      if (!inviteTemplateSlug) {
        return NextResponse.json(
          { error: 'No email step with a template found in the early-access campaign.' },
          { status: 400 },
        )
      }

      console.log('[bulk-action/send-invite] Using template slug:', inviteTemplateSlug)

      for (const userId of userIds) {
        try {
          const { data: user } = await supabase
            .from('early_access')
            .select('*')
            .eq('id', userId)
            .single()

          if (!user || user.status !== 'waitlisted') {
            console.log(`[bulk-action/send-invite] Skipping ${userId}: user=${!!user} status=${user?.status}`)
            skipped++
            continue
          }

          const unsubscribeUrl = getUnsubscribeUrl(user.email)
          const downloadUrl = `${BASE_URL}/api/download`

          const template = await getEmailTemplate(inviteTemplateSlug, {
            unsubscribe_url: unsubscribeUrl,
            download_url: downloadUrl,
          }, supabase)

          if (!template) {
            console.error(`[bulk-action/send-invite] Template "${inviteTemplateSlug}" not found in DB`)
            failed++
            continue
          }

          console.log(`[bulk-action/send-invite] Sending to ${user.email} via Resend...`)
          const { data, error: sendError } = await sendEmail({
            to: user.email,
            subject: template.subject,
            html: template.html,
          })

          if (sendError) {
            console.error(`[bulk-action/send-invite] Resend error for ${user.email}:`, JSON.stringify(sendError))
            failed++
            continue
          }
          console.log(`[bulk-action/send-invite] Resend success for ${user.email}, id:`, data?.id)

          const now = new Date().toISOString()
          await supabase
            .from('early_access')
            .update({
              status: 'invited',
              invited_at: now,
              last_email_step: inviteTemplateSlug,
              last_email_sent_at: now,
            })
            .eq('id', user.id)

          await supabase.from('email_campaign_log').insert({
            early_access_id: user.id,
            email: user.email,
            campaign_step: inviteTemplateSlug,
            campaign_id: eaCampaign.id,
            resend_id: data?.id ?? null,
          })

          success++
          await new Promise((resolve) => setTimeout(resolve, 600))
        } catch {
          failed++
        }
      }
      break
    }

    case 'extend-trial': {
      const { days, sendEmail: emailUsers } = body as { days: number; sendEmail: boolean }

      if (!days || typeof days !== 'number' || days < 1 || days > 365) {
        return NextResponse.json({ error: 'Invalid days (1-365)' }, { status: 400 })
      }

      // Look up the win-back campaign and its first email step (only if sending email)
      let wbTemplateSlug: string | null = null
      let wbCampaignId: string | null = null

      if (emailUsers) {
        const wbCampaign = await getEmailCampaignBySlug('win-back', supabase)
        if (wbCampaign) {
          wbCampaignId = wbCampaign.id
          const { data: wbStep } = await supabase
            .from('campaign_steps')
            .select('template_slug')
            .eq('campaign_id', wbCampaign.id)
            .in('delivery_channel', ['email', 'both'])
            .order('step_order', { ascending: true })
            .limit(1)
            .single()
          wbTemplateSlug = wbStep?.template_slug ?? null
        }
      }

      for (const userId of userIds) {
        try {
          const { data: userData, error: userError } =
            await supabase.auth.admin.getUserById(userId)

          if (userError || !userData?.user) {
            failed++
            continue
          }

          const user = userData.user
          const existingOverride = user.user_metadata?.trial_end_override
            ? new Date(user.user_metadata.trial_end_override as string)
            : null
          const base =
            existingOverride && existingOverride > new Date()
              ? existingOverride
              : new Date()
          const newEndDate = new Date(base)
          newEndDate.setDate(newEndDate.getDate() + days)

          const { error: updateError } = await supabase.auth.admin.updateUserById(
            userId,
            { user_metadata: { trial_end_override: newEndDate.toISOString() } },
          )

          if (updateError) {
            failed++
            continue
          }

          if (emailUsers && user.email && wbTemplateSlug) {
            try {
              const unsubscribeUrl = getUnsubscribeUrl(user.email)
              const downloadUrl = `${BASE_URL}/api/download`
              const endDateFormatted = newEndDate.toLocaleDateString('en-US', {
                month: 'long',
                day: 'numeric',
                year: 'numeric',
              })

              const template = await getEmailTemplate(wbTemplateSlug, {
                unsubscribe_url: unsubscribeUrl,
                download_url: downloadUrl,
                extension_days: String(days),
                extension_end_date: endDateFormatted,
              }, supabase)

              if (template) {
                // The Resend SDK reports a refused send in `error` rather than
                // throwing: no campaign-log row for a mail that never left.
                const { data: sent, error: sendError } = await sendEmail({
                  to: user.email,
                  subject: template.subject,
                  html: template.html,
                })
                if (sendError) throw new Error(sendError.message)

                await supabase.from('email_campaign_log').insert({
                  email: user.email,
                  campaign_step: wbTemplateSlug,
                  campaign_id: wbCampaignId,
                  resend_id: sent?.id ?? null,
                })
              }
            } catch (err) {
              // Email failure doesn't fail the whole operation (the trial is
              // extended), but the admin is told which emails did not go out.
              console.error(`[bulk-action/extend-trial] Email failed for ${user.email}:`, err)
              emailFailed.push(user.email)
            }
          }

          success++
          await new Promise((resolve) => setTimeout(resolve, 600))
        } catch {
          failed++
        }
      }
      break
    }

    case 'reset-status': {
      const { status: targetStatus } = body as { status?: string }
      const allowedStatuses = ['waitlisted', 'invited', 'downloaded', 'setup_complete', 'active']
      if (!targetStatus || !allowedStatuses.includes(targetStatus)) {
        return NextResponse.json({ error: 'Invalid status' }, { status: 400 })
      }

      for (const userId of userIds) {
        try {
          const { error: updateError } = await supabase
            .from('early_access')
            .update({ status: targetStatus })
            .eq('id', userId)

          if (updateError) {
            failed++
          } else {
            success++
          }
        } catch {
          failed++
        }
      }
      break
    }

    default:
      return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  }

  return NextResponse.json({
    success,
    failed,
    skipped,
    ...(emailFailed.length > 0 ? { email_failed: emailFailed } : {}),
  })
}
