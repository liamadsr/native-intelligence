import { NextResponse } from 'next/server'
import { requireAdmin, getAdminServiceClient } from '@/lib/admin'
import { getResend, getUnsubscribeUrl, getEmailTemplate, getEmailCampaignBySlug, BASE_URL, FROM_EMAIL } from '@/lib/email'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params
  const body = await request.json()
  const { days, sendEmail } = body as { days: number; sendEmail?: boolean }

  if (!days || typeof days !== 'number' || days < 1 || days > 365) {
    return NextResponse.json({ error: 'Invalid days (1-365)' }, { status: 400 })
  }

  const supabase = await getAdminServiceClient()

  // Get the user first
  const { data: userData, error: userError } = await supabase.auth.admin.getUserById(id)
  if (userError || !userData?.user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  const user = userData.user

  // Calculate new trial end date
  const existingOverride = user.user_metadata?.trial_end_override
    ? new Date(user.user_metadata.trial_end_override as string)
    : null
  const base =
    existingOverride && existingOverride > new Date() ? existingOverride : new Date()
  const newEndDate = new Date(base)
  newEndDate.setDate(newEndDate.getDate() + days)

  // Update user metadata with new trial_end_override
  const { error: updateError } = await supabase.auth.admin.updateUserById(id, {
    user_metadata: {
      trial_end_override: newEndDate.toISOString(),
    },
  })

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 })
  }

  // Send win-back email if requested and user has an email
  let emailSent = false
  if (sendEmail && user.email) {
    try {
      const unsubscribeUrl = getUnsubscribeUrl(user.email)
      const downloadUrl = `${BASE_URL}/api/download`
      const endDateFormatted = newEndDate.toLocaleDateString('en-US', {
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      })

      const template = await getEmailTemplate('trial_extended', {
        unsubscribe_url: unsubscribeUrl,
        download_url: downloadUrl,
        extension_days: String(days),
        extension_end_date: endDateFormatted,
      }, supabase)

      if (template) {
        // The Resend SDK reports a refused send in `error` rather than
        // throwing; throw it so the catch below skips the log and email_sent.
        const { data: sent, error: sendError } = await getResend().emails.send({
          from: FROM_EMAIL,
          to: user.email,
          subject: template.subject,
          html: template.html,
        })
        if (sendError) throw new Error(sendError.message)

        // Log to campaign log
        const wbCampaign = await getEmailCampaignBySlug('win-back', supabase)
        await supabase.from('email_campaign_log').insert({
          email: user.email,
          campaign_step: 'trial_extended',
          campaign_id: wbCampaign?.id ?? null,
          resend_id: sent?.id ?? null,
        })

        emailSent = true
      }
    } catch (err) {
      console.error(`Failed to send trial extension email to ${user.email}:`, err)
      // Don't fail the whole operation if email fails
    }
  }

  // Re-fetch user
  const { data: updated } = await supabase.auth.admin.getUserById(id)

  return NextResponse.json({
    user: updated?.user,
    trial_end_override: newEndDate.toISOString(),
    email_sent: emailSent,
  })
}
