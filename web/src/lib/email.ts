import type { SupabaseClient } from '@supabase/supabase-js'
import { Resend } from 'resend'
import { getServiceClient } from '@/lib/admin'
import { getPostHogServerClient, serverDefaultProperties } from '@/lib/posthog'

// --- Resend client (lazy init to avoid build-time errors when key is missing) ---

let _resend: Resend | null = null
export function getResend(): Resend {
  if (!_resend) {
    _resend = new Resend(process.env.RESEND_API_KEY)
  }
  return _resend
}

export const BASE_URL = process.env.NODE_ENV === 'production'
  ? 'https://dial8.ai'
  : 'http://localhost:3000'

export const FROM_EMAIL = 'Liam from Dial8 <liam@dial8.ai>'

// --- Unsubscribe token ---

function generateUnsubscribeToken(email: string): string {
  const crypto = require('crypto')
  const hmac = crypto.createHmac('sha256', process.env.UNSUBSCRIBE_SECRET!)
  hmac.update(email)
  return hmac.digest('hex')
}

export function verifyUnsubscribeToken(email: string, token: string): boolean {
  const expected = generateUnsubscribeToken(email)
  const crypto = require('crypto')
  const expectedBuf = Buffer.from(expected)
  const tokenBuf = Buffer.from(token)
  if (expectedBuf.length !== tokenBuf.length) return false
  return crypto.timingSafeEqual(expectedBuf, tokenBuf)
}

export function getUnsubscribeUrl(email: string): string {
  const token = generateUnsubscribeToken(email)
  return `${BASE_URL}/api/email/unsubscribe?email=${encodeURIComponent(email)}&token=${token}`
}

// --- DB template helper ---

export interface EmailTemplateRow {
  slug: string
  name: string
  subject: string
  html: string
}

/**
 * Fetch an email template from the DB by slug.
 * Replaces placeholder variables in the HTML:
 *   {{unsubscribe_url}}, {{download_url}}, {{extension_days}}, {{extension_end_date}}, etc.
 */
export async function getEmailTemplate(
  slug: string,
  vars?: Record<string, string>,
  supabase?: SupabaseClient,
): Promise<EmailTemplateRow | null> {
  const client = supabase ?? getServiceClient()
  const { data, error } = await client
    .from('email_templates')
    .select('slug, name, subject, html')
    .eq('slug', slug)
    .single()

  if (error || !data) return null

  if (vars) {
    let html = data.html
    let subject = data.subject
    for (const [key, value] of Object.entries(vars)) {
      html = html.replaceAll(`{{${key}}}`, value)
      subject = subject.replaceAll(`{{${key}}}`, value)
    }
    return { ...data, html, subject }
  }

  return data
}

// --- Send + log helper ---

export async function sendCampaignEmail({
  to,
  earlyAccessId,
  step,
  campaignId,
  supabase: supabaseOverride,
  templateVars,
}: {
  to: string
  earlyAccessId?: string
  step: string
  campaignId?: string
  supabase?: SupabaseClient
  templateVars?: Record<string, string>
}) {
  const supabase = supabaseOverride ?? getServiceClient()

  const template = await getEmailTemplate(step, templateVars, supabase)
  if (!template) {
    throw new Error(`Email template "${step}" not found in database`)
  }

  const { data, error: sendError } = await getResend().emails.send({
    from: FROM_EMAIL,
    to,
    subject: template.subject,
    html: template.html,
  })

  if (sendError) {
    console.error(`Failed to send ${step} email to ${to}:`, sendError)
    throw new Error(`Email send failed: ${sendError.message}`)
  }

  // Log the send
  await supabase.from('email_campaign_log').insert({
    early_access_id: earlyAccessId ?? null,
    email: to,
    campaign_step: step,
    campaign_id: campaignId ?? null,
    resend_id: data?.id ?? null,
  })

  // Update early_access tracking (if applicable)
  if (earlyAccessId) {
    await supabase
      .from('early_access')
      .update({
        last_email_step: step,
        last_email_sent_at: new Date().toISOString(),
        ...(step === 'invite' ? { status: 'invited', invited_at: new Date().toISOString() } : {}),
      })
      .eq('id', earlyAccessId)
  }

  // Track in PostHog
  const posthog = getPostHogServerClient()
  posthog?.capture({
    distinctId: to,
    event: 'campaign_email_sent',
    properties: {
      campaign_step: step,
      campaign_id: campaignId ?? null,
      ...serverDefaultProperties,
    },
  })

  return data
}

// --- DB-driven campaign helpers ---

export async function getEmailCampaignBySlug(
  slug: string,
  supabase?: SupabaseClient,
): Promise<{ id: string } | null> {
  const client = supabase ?? getServiceClient()
  const { data } = await client
    .from('campaigns')
    .select('id')
    .eq('slug', slug)
    .single()
  return data
}
