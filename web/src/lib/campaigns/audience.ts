/**
 * Who a campaign's audience is today (roadmap D2): the CRM contacts its
 * filter or group matches, then the ones a launch may actually send to.
 *
 *   matchAudience      contacts in the workspace with an email, not merged
 *                      away, matching every part of the audience
 *                      (relationship types, last touch older than N days,
 *                      tags, chosen contacts), longest-quiet first, and only
 *                      the ones the launcher may see (contact_visible_to:
 *                      this may run on a service-role client).
 *   eligibleRecipients the matches less anyone on the opt-out list (or
 *                      tagged unsubscribed from email by an import), anyone
 *                      already in the campaign's sequence (ever: re-enrolling
 *                      isn't supported), and anyone in another active
 *                      sequence; each skip counted by reason.
 *
 * The same guards enrollContacts applies at enrollment, read here first so
 * the card names only people who will really get the email.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { isContactVisibleTo } from '@/lib/crm/contact-visibility'
import { fetchAllRows } from '@/lib/supabase/paging'
import { optedOutByTag } from '@/lib/outreach/opt-out'
import { audienceTypes, type CampaignAudience } from './shape'

const DAY_MS = 24 * 60 * 60 * 1000
/** The most candidate rows one match reads (a small business's whole CRM; the card sends to 200 at most). */
export const AUDIENCE_SCAN_MAX = 1000
/** Visibility checks run this many at a time. */
const VISIBILITY_BATCH = 50

export interface AudienceContact {
  id: string
  full_name: string | null
  first_name: string | null
  last_name: string | null
  email: string
  last_interaction_at: string | null
  company: { name: string | null } | null
  tags: string[]
}

export interface AudienceSkips {
  opted_out: number
  already_in_sequence: number
  in_another_sequence: number
}

/** The ISO cutoff for "last in touch more than N days ago". Pure. */
export function audienceCutoff(days: number, now: number = Date.now()): string {
  return new Date(now - days * DAY_MS).toISOString()
}

/** The contacts an audience matches, longest-quiet first, visible to `userId`. Throws on a failed read. */
export async function matchAudience(
  supabase: SupabaseClient,
  // `grants: false` on a guest's or a linked agent's turn: a contact shared with the launcher (a grant) is never on the card.
  args: { workspaceId: string; userId: string; audience: CampaignAudience; now?: number; grants?: boolean },
): Promise<AudienceContact[]> {
  const { audience } = args
  let query = supabase
    .from('contact')
    .select('id, full_name, first_name, last_name, email, last_interaction_at, tags, company:company_id(name)')
    .eq('workspace_id', args.workspaceId)
    .is('merged_into_contact_id', null)
    .not('email', 'is', null)
  const types = audienceTypes(audience)
  if (types) query = query.in('relationship_type', types)
  if (audience.last_contacted_more_than_days !== undefined) {
    const cutoff = audienceCutoff(audience.last_contacted_more_than_days, args.now)
    // Quoted: an ISO time holds '.' and ':', both reserved inside a PostgREST or=() list.
    query = audience.include_never_contacted
      ? query.or(`last_interaction_at.lt."${cutoff}",last_interaction_at.is.null`)
      : query.lt('last_interaction_at', cutoff)
  }
  if (audience.tags_any?.length) query = query.overlaps('tags', audience.tags_any)
  if (audience.contact_ids?.length) query = query.in('id', audience.contact_ids)
  const { data, error } = await query.order('last_interaction_at', { ascending: true, nullsFirst: true }).limit(AUDIENCE_SCAN_MAX)
  if (error) throw new Error(`audience read failed: ${error.message}`)

  const rows = ((data ?? []) as Array<Record<string, unknown>>)
    .map((r) => ({
      id: r.id as string,
      full_name: (r.full_name as string | null) ?? null,
      first_name: (r.first_name as string | null) ?? null,
      last_name: (r.last_name as string | null) ?? null,
      email: typeof r.email === 'string' ? r.email.trim() : '',
      last_interaction_at: (r.last_interaction_at as string | null) ?? null,
      company: (r.company as { name: string | null } | null) ?? null,
      tags: Array.isArray(r.tags) ? (r.tags as unknown[]).filter((t): t is string => typeof t === 'string') : [],
    }))
    .filter((r) => r.email !== '')

  // Fail closed: a contact the launcher can't see is never on their card.
  const visible: AudienceContact[] = []
  for (let i = 0; i < rows.length; i += VISIBILITY_BATCH) {
    const batch = rows.slice(i, i + VISIBILITY_BATCH)
    const keep = await Promise.all(batch.map((r) => isContactVisibleTo(supabase, r.id, args.userId, args.grants === false ? { grants: false } : {})))
    batch.forEach((r, j) => {
      if (keep[j]) visible.push(r)
    })
  }
  return visible
}

/** Every row of a paged read (a response stops at 1000 rows); throws on a failed one. */
async function allRows<T>(makeQuery: Parameters<typeof fetchAllRows<T>>[0]): Promise<T[]> {
  const { data, error } = await fetchAllRows<T>(makeQuery)
  if (error) throw new Error(error.message)
  return data
}

/**
 * The matches a launch may send to, in match order, and the rest counted by
 * reason. `sequenceId`: the campaign's sequence. Throws on a failed read.
 */
export async function eligibleRecipients(
  supabase: SupabaseClient,
  args: { workspaceId: string; sequenceId: string; contacts: readonly AudienceContact[] },
): Promise<{ eligible: AudienceContact[]; skipped: AudienceSkips }> {
  const [suppressed, inSequence, active] = await Promise.all([
    allRows<{ email: string }>(() => supabase.from('outreach_suppression').select('id, email').eq('workspace_id', args.workspaceId)),
    allRows<{ contact_id: string | null; contact_email: string }>(() =>
      supabase
        .from('sequence_enrollment')
        .select('id, contact_id, contact_email')
        .eq('workspace_id', args.workspaceId)
        .eq('sequence_id', args.sequenceId),
    ),
    allRows<{ contact_id: string | null; contact_email: string; sequence_id: string }>(() =>
      supabase
        .from('sequence_enrollment')
        .select('id, contact_id, contact_email, sequence_id')
        .eq('workspace_id', args.workspaceId)
        .eq('status', 'active'),
    ),
  ])
  const suppressedEmails = new Set(suppressed.map((s) => s.email.toLowerCase()))
  const inSequenceIds = new Set(inSequence.map((e) => e.contact_id).filter(Boolean))
  const inSequenceEmails = new Set(inSequence.map((e) => e.contact_email.toLowerCase()))
  const activeIds = new Set(active.map((e) => e.contact_id).filter(Boolean))
  const activeEmails = new Set(active.map((e) => e.contact_email.toLowerCase()))

  const skipped: AudienceSkips = { opted_out: 0, already_in_sequence: 0, in_another_sequence: 0 }
  const eligible: AudienceContact[] = []
  const seenEmails = new Set<string>()
  for (const contact of args.contacts) {
    const email = contact.email.toLowerCase()
    if (suppressedEmails.has(email) || optedOutByTag(contact.tags, 'email')) {
      skipped.opted_out += 1
    } else if (inSequenceIds.has(contact.id) || inSequenceEmails.has(email)) {
      skipped.already_in_sequence += 1
    } else if (activeIds.has(contact.id) || activeEmails.has(email)) {
      skipped.in_another_sequence += 1
    } else if (!seenEmails.has(email)) {
      // Two contacts with one address get one email.
      seenEmails.add(email)
      eligible.push(contact)
    }
  }
  return { eligible, skipped }
}
