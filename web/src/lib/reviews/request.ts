/**
 * The review request (roadmap D3): after a customer's job is done, the
 * business's Google review link goes to them, once per job.
 *
 *   1. The link must be set (./link.ts); none: nothing happens, and nothing
 *      is recorded, so the jobs done before the owner sets it never send.
 *   2. The customer: a CRM contact in the workspace, not merged away. On the
 *      opt-out list: recorded as skipped, never sent. Tagged unsubscribed
 *      (an import's 'unsubscribed email' / 'unsubscribed sms',
 *      src/lib/outreach/opt-out.ts): never on that channel.
 *   3. The channel (pickReviewChannel): a text once the business has its own
 *      number (roadmap track B), else email from the mailbox of whoever set
 *      the link. No address for either: nothing sends.
 *   4. One ask a month: a customer sent a review request in the last
 *      REVIEW_REQUEST_COOLDOWN_DAYS is not asked again (recorded as skipped):
 *      a job marked done and then paid arrives under two refs, and a repeat
 *      customer shouldn't hear it after every visit.
 *   5. The claim: a review_request row keyed (workspace, contact, job type,
 *      job id), inserted BEFORE anything sends. A duplicate key means this
 *      job already had its request: nothing sends again. A send that throws
 *      marks the row failed and is never retried (at-most-once, the
 *      sequences engine's bias).
 *   6. The contact's timeline gets a 'review_request' interaction.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { sendEmail } from '@/lib/crm/email-client'
import type { JobType } from '@/lib/jobs/events'
import { optedOutByTag } from '@/lib/outreach/opt-out'
import { readReviewSettings } from './link'

export type ReviewChannel = 'email' | 'sms'

/** A customer asked within this many days is not asked again, whatever the job. */
export const REVIEW_REQUEST_COOLDOWN_DAYS = 30

export type ReviewRequestOutcome =
  | { outcome: 'sent'; channel: ReviewChannel; recipient: string }
  | { outcome: 'already_requested' }
  | { outcome: 'no_link' | 'no_contact' | 'no_address' | 'opted_out' | 'no_mailbox' | 'recently_asked' }
  | { outcome: 'failed'; error: string }

/** Which job, for which customer: what one review request is keyed on. */
export interface ReviewRequestJob {
  workspaceId: string
  contactId: string
  jobRef: { type: JobType; id: string }
}

/**
 * Text when the business has its own number and the customer a phone; else
 * email when they have an address; else none. Pure.
 */
export function pickReviewChannel(args: { businessNumber: string | null; phone: string | null; email: string | null }): ReviewChannel | null {
  if (args.businessNumber && args.phone?.trim()) return 'sms'
  if (args.email?.trim()) return 'email'
  return null
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** The email: short, plain, the link on its own line. Pure. */
export function reviewEmail(args: { firstName: string | null; businessName: string; url: string; senderName: string | null }): { subject: string; html: string; text: string } {
  const hi = args.firstName?.trim() ? `Hi ${args.firstName.trim()},` : 'Hi,'
  const sign = args.senderName?.trim() || args.businessName
  const lines = [
    hi,
    `Thank you for choosing ${args.businessName}. If you have a minute, a quick Google review would mean a lot to us:`,
    args.url,
    `Thanks again,\n${sign}`,
  ]
  const text = lines.join('\n\n')
  const html = [
    `<p>${escapeHtml(hi)}</p>`,
    `<p>${escapeHtml(lines[1])}</p>`,
    `<p><a href="${escapeHtml(args.url)}">${escapeHtml(args.url)}</a></p>`,
    `<p>Thanks again,<br>${escapeHtml(sign)}</p>`,
  ].join('\n')
  return { subject: `Thank you from ${args.businessName}`, html, text }
}

export interface ReviewRequestDeps {
  sendEmail?: typeof sendEmail
  /** The business's own texting number (roadmap track B); null until it lands, so reviews go by email. */
  businessNumber?: (supabase: SupabaseClient, workspaceId: string) => Promise<string | null>
  /** Sends the review text from the business's number (track B wires it with the number). */
  sendText?: (args: { workspaceId: string; to: string; body: string }) => Promise<void>
  now?: () => number
}

/** No per-business number exists yet (roadmap track B adds it). */
async function noBusinessNumber(): Promise<string | null> {
  return null
}

/** Send one customer the review link for one finished job, at most once. Service role. Throws only on a failed read. */
export async function sendReviewRequest(
  supabase: SupabaseClient,
  event: ReviewRequestJob,
  deps: ReviewRequestDeps = {},
): Promise<ReviewRequestOutcome> {
  const { workspaceId, contactId, jobRef: job } = event
  const { businessName, link } = await readReviewSettings(supabase, workspaceId)
  if (!link) return { outcome: 'no_link' }

  const { data: contactRow, error: contactError } = await supabase
    .from('contact')
    .select('id, first_name, full_name, email, phone, tags')
    .eq('id', contactId)
    .eq('workspace_id', workspaceId)
    .is('merged_into_contact_id', null)
    .maybeSingle()
  if (contactError) throw new Error(`contact read failed: ${contactError.message}`)
  const contact = contactRow as { id: string; first_name: string | null; full_name: string | null; email: string | null; phone: string | null; tags?: unknown } | null
  if (!contact) return { outcome: 'no_contact' }
  // A channel they unsubscribed from (an import's tag) is no channel at all.
  const reachable = {
    phone: optedOutByTag(contact.tags, 'sms') ? null : contact.phone,
    email: optedOutByTag(contact.tags, 'email') ? null : contact.email,
  }
  if (!reachable.phone?.trim() && !reachable.email?.trim() && (contact.phone?.trim() || contact.email?.trim())) {
    return { outcome: 'opted_out' }
  }

  const businessNumber = await (deps.businessNumber ?? noBusinessNumber)(supabase, workspaceId)
  let channel = pickReviewChannel({ businessNumber, phone: reachable.phone, email: reachable.email })
  // A number with nothing wired to text from it yet: email, when there is an address.
  if (channel === 'sms' && !deps.sendText) channel = reachable.email?.trim() ? 'email' : null
  if (!channel) return { outcome: 'no_address' }
  const useSms = channel === 'sms'
  const recipient = useSms ? (reachable.phone as string).trim() : (reachable.email as string).trim()

  const nowIso = new Date((deps.now ?? Date.now)()).toISOString()
  const claim = {
    workspace_id: workspaceId,
    contact_id: contact.id,
    job_type: job.type,
    job_id: job.id,
    channel: useSms ? 'sms' : 'email',
    recipient,
    review_url: link.url,
  }

  // The opt-out list: recorded, never sent (and never asked again for this job).
  if (contact.email?.trim()) {
    const { data: suppressed, error: suppressionError } = await supabase
      .from('outreach_suppression')
      .select('id')
      .eq('workspace_id', workspaceId)
      .ilike('email', contact.email.trim().replace(/[\\%_]/g, '\\$&'))
      .limit(1)
    if (suppressionError) throw new Error(`opt-out read failed: ${suppressionError.message}`)
    if ((suppressed ?? []).length > 0) {
      const { error } = await supabase.from('review_request').insert({ ...claim, status: 'skipped', reason: 'opted_out' })
      if (error && error.code === '23505') return { outcome: 'already_requested' }
      return { outcome: 'opted_out' }
    }
  }

  // One ask a month, whatever the job (done, then paid, is one job under two refs).
  const since = new Date((deps.now ?? Date.now)() - REVIEW_REQUEST_COOLDOWN_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const { data: recent, error: recentError } = await supabase
    .from('review_request')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('contact_id', contact.id)
    .eq('status', 'sent')
    .gte('sent_at', since)
    .limit(1)
  if (recentError) throw new Error(`recent review requests read failed: ${recentError.message}`)
  if ((recent ?? []).length > 0) {
    const { error } = await supabase.from('review_request').insert({ ...claim, status: 'skipped', reason: 'recently_asked' })
    if (error && error.code === '23505') return { outcome: 'already_requested' }
    return { outcome: 'recently_asked' }
  }

  // The claim, before anything sends: one per customer per job.
  const { data: claimed, error: claimError } = await supabase.from('review_request').insert({ ...claim, status: 'claimed' }).select('id').single()
  if (claimError) {
    if (claimError.code === '23505') return { outcome: 'already_requested' }
    throw new Error(`review request claim failed: ${claimError.message}`)
  }
  const requestId = (claimed as { id: string }).id

  const { data: sender } = await supabase
    .from('member')
    .select('display_name')
    .eq('workspace_id', workspaceId)
    .eq('user_id', link.set_by)
    .maybeSingle()
  const senderName = (sender as { display_name?: string | null } | null)?.display_name ?? null
  if (!sender) {
    // Whoever set the link left the workspace: their mailbox no longer speaks for it.
    await supabase.from('review_request').update({ status: 'skipped', reason: 'link_owner_left' }).eq('id', requestId)
    return { outcome: 'no_mailbox' }
  }
  const message = reviewEmail({ firstName: contact.first_name, businessName, url: link.url, senderName })

  let threadId: string | null = null
  try {
    if (useSms) {
      await deps.sendText!({ workspaceId, to: recipient, body: `${message.text.split('\n\n').slice(0, 3).join(' ')} Reply STOP to opt out.` })
    } else {
      const sent = await (deps.sendEmail ?? sendEmail)(link.set_by, workspaceId, {
        to: [recipient],
        subject: message.subject,
        body_html: message.html,
        body_text: message.text,
        // The ledger and the interaction below are this request's own record.
        skip_interaction_log: true,
      })
      threadId = sent.thread_id
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    await supabase.from('review_request').update({ status: 'failed', reason: error.slice(0, 500) }).eq('id', requestId)
    if (/No email integration connected/i.test(error)) return { outcome: 'no_mailbox' }
    return { outcome: 'failed', error }
  }

  await supabase.from('review_request').update({ status: 'sent', sent_at: nowIso }).eq('id', requestId)
  const { error: logError } = await supabase.from('contact_interaction').insert({
    workspace_id: workspaceId,
    contact_id: contact.id,
    interaction_type: 'review_request',
    reference_type: threadId ? 'email_thread' : null,
    reference_id: threadId,
    title: useSms ? 'Review request texted' : 'Review request emailed',
    occurred_at: nowIso,
    metadata: { job_type: job.type, job_id: job.id, review_request_id: requestId },
  })
  if (logError) console.error('[reviews] interaction log failed:', logError.message)
  else {
    const { error: statsError } = await supabase.rpc('update_contact_interaction_stats', { p_contact_id: contact.id, p_occurred_at: nowIso })
    if (statsError) console.error('[reviews] interaction stats update failed:', statsError.message)
  }
  return { outcome: 'sent', channel: useSms ? 'sms' : 'email', recipient }
}
