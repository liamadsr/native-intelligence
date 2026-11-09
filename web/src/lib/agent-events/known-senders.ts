/**
 * "Known people" (Liam, 2026-10-15): a thread that needs a reply from someone
 * the person knows reaches them in the home thread within a couple of
 * minutes; everything else waits quietly in the review pile and the digest.
 *
 * A sender is KNOWN to the person in a workspace when, from what Native Intelligence
 * already holds (never a stored message body, which is going away):
 *   • the CRM: a contact in the workspace with that address, as its primary or
 *     a secondary address (a merged-away tombstone doesn't count), or the
 *     thread index row is linked to a contact (`linked_contact_id`);
 *   • the person has written to it: a thread in the index whose newest
 *     message is the person's own (from one of their connected mail
 *     addresses) with that address among its participants (the index keeps
 *     addresses only: no stored mail, and sent drafts are deleted).
 *
 * Addresses compare lower-cased (each spelling as given is asked for too, since
 * a stored address keeps its case). Every read is bounded and fails soft: a
 * failed read knows nobody (the quiet side), never everybody.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

/** At most this many addresses are checked at once. */
const MAX_ADDRESSES = 50

function norm(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim().toLowerCase()
  return v.includes('@') && v.length <= 320 ? v : null
}

function lowerAll(values: unknown): string[] {
  return (Array.isArray(values) ? values : []).map(norm).filter((v): v is string => v !== null)
}

/**
 * The subset of `addresses` the person knows in this workspace (lower-cased).
 * Never throws.
 */
export async function knownSenders(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; addresses: Iterable<string | null | undefined> },
): Promise<Set<string>> {
  const given = [...args.addresses].filter((v): v is string => typeof v === 'string' && norm(v) !== null).map((v) => v.trim())
  const wanted = [...new Set(given.map((v) => norm(v) as string))].slice(0, MAX_ADDRESSES)
  const known = new Set<string>()
  if (!wanted.length) return known
  // Stored addresses keep whatever case they were written in: ask for the
  // lower-cased form and each spelling as given, and compare lower-cased.
  const spellings = (list: readonly string[]) => [...new Set([...list, ...given.filter((g) => list.includes(norm(g) as string))])]
  const left = () => spellings(wanted.filter((a) => !known.has(a)))

  // 1. The CRM: a live contact with the address as its primary or a secondary one.
  try {
    const [primary, secondary] = await Promise.all([
      supabase.from('contact').select('email').eq('workspace_id', args.workspaceId).is('merged_into_contact_id', null).in('email', spellings(wanted)).limit(MAX_ADDRESSES),
      supabase
        .from('contact')
        .select('secondary_emails')
        .eq('workspace_id', args.workspaceId)
        .is('merged_into_contact_id', null)
        .overlaps('secondary_emails', spellings(wanted))
        .limit(MAX_ADDRESSES),
    ])
    for (const r of (primary.error ? [] : (primary.data as Array<{ email?: unknown }> | null)) ?? []) {
      const e = norm(r.email)
      if (e && wanted.includes(e)) known.add(e)
    }
    for (const r of (secondary.error ? [] : (secondary.data as Array<{ secondary_emails?: unknown }> | null)) ?? []) {
      for (const e of lowerAll(r.secondary_emails)) if (wanted.includes(e)) known.add(e)
    }
  } catch {
    // The CRM read failed: nobody known through it.
  }
  if (!left().length) return known

  // 2. A thread whose newest message is the person's own, with the address on
  //    it (the index keeps participant addresses, never a subject or body).
  try {
    const { data: accounts, error: accountError } = await supabase
      .from('connected_account')
      .select('account_email')
      .eq('user_id', args.userId)
      .eq('capability', 'email')
    const own = accountError ? [] : lowerAll(((accounts as Array<{ account_email?: unknown }> | null) ?? []).map((a) => a.account_email))
    if (own.length) {
      const { data, error } = await supabase
        .from('email_thread_index')
        .select('participant_emails')
        .eq('workspace_id', args.workspaceId)
        .eq('user_id', args.userId)
        .in('from_email', own)
        .overlaps('participant_emails', left())
        .limit(MAX_ADDRESSES)
      if (!error) {
        for (const r of (data as Array<{ participant_emails?: unknown }> | null) ?? []) {
          for (const e of lowerAll(r.participant_emails)) if (wanted.includes(e) && !own.includes(e)) known.add(e)
        }
      }
    }
  } catch {
    // Nobody known through the thread index.
  }
  return known
}

/** True when a thread row's sender is known: its linked contact, or its address in `known`. Pure. */
export function isKnownThreadSender(row: { from_email?: unknown; linked_contact_id?: unknown }, known: ReadonlySet<string>): boolean {
  if (typeof row.linked_contact_id === 'string' && row.linked_contact_id) return true
  const e = norm(row.from_email)
  return e !== null && known.has(e)
}
