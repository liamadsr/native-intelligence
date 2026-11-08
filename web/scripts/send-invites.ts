/**
 * CLI script to send invite emails to waitlisted early access users.
 *
 * Usage:
 *   npm run invite -- --batch=50
 *   npx tsx scripts/send-invites.ts --batch=10
 *
 * Required env vars:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   RESEND_API_KEY
 *   UNSUBSCRIBE_SECRET
 *
 * Optional:
 *   INVITE_BASE_URL  link origin in the emails (default https://dial8.ai;
 *                    set http://localhost:3000 only for a local test send)
 */

import { createClient } from '@supabase/supabase-js'
import { Resend } from 'resend'
import crypto from 'crypto'

// Load env from .env.local if available
import { config } from 'dotenv'
config({ path: '.env.local' })

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const RESEND_API_KEY = process.env.RESEND_API_KEY!
const UNSUBSCRIBE_SECRET = process.env.UNSUBSCRIBE_SECRET!
// Default to prod: these emails go to real people, so a localhost link must be an explicit opt-in.
const BASE_URL = (process.env.INVITE_BASE_URL || 'https://dial8.ai').replace(/\/+$/, '')
const FROM_EMAIL = 'Liam from Native Intelligence <liam@dial8.ai>'

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !RESEND_API_KEY || !UNSUBSCRIBE_SECRET) {
  console.error('Missing required environment variables. Check .env.local')
  console.error('Required: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY, UNSUBSCRIBE_SECRET')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
const resend = new Resend(RESEND_API_KEY)

function generateUnsubscribeToken(email: string): string {
  const hmac = crypto.createHmac('sha256', UNSUBSCRIBE_SECRET)
  hmac.update(email)
  return hmac.digest('hex')
}

function getUnsubscribeUrl(email: string): string {
  const token = generateUnsubscribeToken(email)
  return `${BASE_URL}/api/email/unsubscribe?email=${encodeURIComponent(email)}&token=${token}`
}

// Parse --batch=N argument
function parseBatchSize(): number {
  const batchArg = process.argv.find((arg) => arg.startsWith('--batch='))
  if (batchArg) {
    const size = parseInt(batchArg.split('=')[1], 10)
    if (size > 0) return size
  }
  return 10 // default
}

async function main() {
  const batchSize = parseBatchSize()
  console.log(`\nSending invites to up to ${batchSize} waitlisted users...\n`)

  // Fetch the invite template from DB
  const { data: template, error: templateError } = await supabase
    .from('email_templates')
    .select('subject, html')
    .eq('slug', 'invite')
    .single()

  if (templateError || !template) {
    console.error('Invite email template not found in database. Create one in the admin console first.')
    process.exit(1)
  }

  // Look up the early-access campaign for logging
  const { data: campaign } = await supabase
    .from('campaigns')
    .select('id')
    .eq('slug', 'early-access')
    .single()

  // Fetch waitlisted users
  const { data: users, error } = await supabase
    .from('early_access')
    .select('*')
    .eq('status', 'waitlisted')
    .eq('unsubscribed', false)
    .order('created_at', { ascending: true })
    .limit(batchSize)

  if (error) {
    console.error('Failed to fetch users:', error.message)
    process.exit(1)
  }

  if (!users || users.length === 0) {
    console.log('No waitlisted users to invite.')
    process.exit(0)
  }

  console.log(`Found ${users.length} users to invite.\n`)

  let sent = 0
  let failed = 0

  for (const user of users) {
    try {
      const unsubscribeUrl = getUnsubscribeUrl(user.email)
      const downloadUrl = `${BASE_URL}/api/download`

      // Replace template variables
      const html = template.html
        .replaceAll('{{unsubscribe_url}}', unsubscribeUrl)
        .replaceAll('{{download_url}}', downloadUrl)
      const subject = template.subject
        .replaceAll('{{unsubscribe_url}}', unsubscribeUrl)
        .replaceAll('{{download_url}}', downloadUrl)

      const { data, error: sendError } = await resend.emails.send({
        from: FROM_EMAIL,
        to: user.email,
        subject,
        html,
      })

      if (sendError) {
        console.error(`  ✗ ${user.email}: ${sendError.message}`)
        failed++
        continue
      }

      // Update early_access record
      const now = new Date().toISOString()
      const { error: updateError } = await supabase
        .from('early_access')
        .update({
          status: 'invited',
          invited_at: now,
          last_email_step: 'invite',
          last_email_sent_at: now,
        })
        .eq('id', user.id)
      if (updateError) {
        // The email went out but the row is still waitlisted, so a re-run would send it again.
        console.error(`  ! ${user.email}: sent, but marking invited failed: ${updateError.message}`)
      }

      // Log the send
      const { error: logError } = await supabase.from('email_campaign_log').insert({
        early_access_id: user.id,
        email: user.email,
        campaign_step: 'invite',
        campaign_id: campaign?.id ?? null,
        resend_id: data?.id ?? null,
      })
      if (logError) console.error(`  ! ${user.email}: sent, but the campaign log insert failed: ${logError.message}`)

      console.log(`  ✓ ${user.email}`)
      sent++

      // Small delay to avoid rate limits
      await new Promise((resolve) => setTimeout(resolve, 100))
    } catch (err) {
      console.error(`  ✗ ${user.email}: ${err instanceof Error ? err.message : err}`)
      failed++
    }
  }

  console.log(`\nDone! Sent: ${sent}, Failed: ${failed}`)
}

main().catch((err) => {
  console.error('Unexpected error:', err)
  process.exit(1)
})
