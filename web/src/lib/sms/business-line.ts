/**
 * A business's own account on a phone whose Native Intelligence line is another account's
 * (migration 464, one phone, two accounts; Liam, 2026-11-01: "I wanna treat
 * it as a completely separate workspace. I should still be able to connect my
 * phone number to that workspace's agent"). Linking a phone
 * (./phone-verification.ts) adds it as the business's line, beside the other
 * account's Native Intelligence line, when the account linking it is a business's and the
 * NI-line account can be told (it has an email). This module holds what
 * that needs:
 *
 *   - isBusinessWorkspace: the workspace has a business profile or a live
 *     business number (roadmap B2, migration 458);
 *   - accountEmail: an account's deliverable email, or null (a phone-only
 *     account, made by a text sign-up). The recycled-number safeguard: a
 *     NI-line account with none can't be told its number was added
 *     elsewhere, so the number moves instead, as before 464. A text
 *     sign-up's release (./signup-account.ts) uses it too;
 *   - the welcome, texted from the business's own number (the Native Intelligence number's
 *     welcome would point them at the other account's agent);
 *   - the notice emailed to the NI-line account: what happened, that
 *     nothing is needed if it was them, and how to take the number back in
 *     Settings › Phone if it wasn't. It never names the other account (the
 *     number may have changed hands). Best effort.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { activeBusinessNumber } from '@/lib/customers/numbers'
import { FROM_EMAIL, getResend } from '@/lib/email'
import { escapeHtml } from '@/lib/email/plain-text-to-html'
import { appOrigin } from '@/lib/twilio/config'
import { maskPhone } from '@/lib/twilio/phone'

/** True when `workspaceId` is a business's: it has a business profile or a live business number. Throws on a failed read. */
export async function isBusinessWorkspace(supabase: SupabaseClient, workspaceId: string): Promise<boolean> {
  const { data, error } = await supabase.from('business_profile').select('workspace_id').eq('workspace_id', workspaceId).maybeSingle<{ workspace_id: string }>()
  if (error) throw new Error(`business_profile read failed: ${error.message}`)
  if (data) return true
  return (await activeBusinessNumber(supabase, workspaceId)) !== null
}

/** Whether `email` can be written to: a real address, never a placeholder. Pure. */
export function isDeliverableEmail(email: string | null | undefined): email is string {
  return typeof email === 'string' && /^[^@\s]+@[^@\s]+$/.test(email.trim()) && !email.trim().endsWith('@unknown')
}

/**
 * The account's deliverable email, or null for a phone-only account (or one
 * whose user is gone). Throws on a failed read, so nothing is decided on it.
 */
export async function accountEmail(supabase: SupabaseClient, userId: string): Promise<string | null> {
  const { data, error } = await supabase.auth.admin.getUserById(userId)
  if (error) {
    if (error.status === 404) return null
    throw new Error(`auth user read failed: ${error.message}`)
  }
  const email = data?.user?.email
  return isDeliverableEmail(email) ? email.trim() : null
}

/** The welcome a business line's first link texts, from the business's own number. */
export function businessLineWelcomeText(business: string): string {
  return (
    `You're set up to text ${business}'s Dial8 AI agent: this number. Text it like you'd text an assistant, and it answers and acts for the business. ` +
    'Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help.'
  )
}

/** The notice's words. Pure. */
export function businessLineNoticeEmail(args: { maskedPhone: string; origin: string }): { subject: string; text: string } {
  const settings = `${args.origin}/account/settings/phone`
  return {
    subject: 'Your phone number was added to another Native Intelligence account',
    text:
      `Your phone number ${args.maskedPhone} was just verified on another Native Intelligence account, with a code texted to it, as that account's business line. ` +
      "That account's agent can now text this number from its own business number, and answers texts sent to that number. " +
      'Your own Native Intelligence agent is unchanged: it still answers on the Native Intelligence number.\n\n' +
      'If you did this yourself, for a business you run, there is nothing to do.\n\n' +
      "If you didn't, someone else may have this number now. If it is no longer yours, remove it in Settings › Phone and add your new one: " +
      `${settings} . If it is still yours, remove it there and add it again: verifying it again with a new code takes it off every other Native Intelligence account.`,
  }
}

/**
 * Email `to` (the NI-line account's address) that `phone` was also added
 * as another account's business line. Best effort: returns whether Resend
 * took it.
 */
export async function sendBusinessLineNotice(args: { to: string; phone: string }): Promise<boolean> {
  if (!process.env.RESEND_API_KEY || !isDeliverableEmail(args.to)) return false
  const { subject, text } = businessLineNoticeEmail({ maskedPhone: maskPhone(args.phone), origin: appOrigin() })
  const html = text
    .split('\n\n')
    .map((p) => `<p style="color: #333; line-height: 1.6;">${escapeHtml(p)}</p>`)
    .join('')
  const { error } = await getResend().emails.send({
    from: FROM_EMAIL,
    to: args.to,
    subject,
    text,
    html: `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">${html}</div>`,
  })
  return !error
}
