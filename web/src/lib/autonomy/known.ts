/**
 * Who counts as KNOWN for a graduated call (docs/plans/earned-autonomy.md §4;
 * Liam, 11-27, decision 3): any of
 *   - mail history: an address the person has SENT mail to (a thread of
 *     theirs in Sent). Mail only received doesn't count: an injected email
 *     would otherwise make its own sender "known";
 *   - workspace members;
 *   - CRM contacts the person added by hand: source 'manual', created by
 *     their own member, not merged away, and not made by an unattended agent
 *     turn (those carry the HubSpot hold, contacts.ts). Contacts from a bulk
 *     import (CSV, vCard, export files, the Stripe/HubSpot/Brevo/Google
 *     imports) don't count: their source isn't 'manual'. A source that can't
 *     be read counts as new.
 *
 * A quote's customer (`quote:<id>`) and a poll's guests (`poll:<id>`) are
 * resolved to their addresses and numbers first; the ref is known only when
 * every one of them is.
 *
 * FAIL CLOSED: any read that fails leaves its addresses out of the set (new).
 * Service-role client, fenced on the workspace and person.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { HUBSPOT_PUSH_HOLD_KEY } from '@/lib/crm/hubspot-push-hold'
import { findMembersByEmail } from '@/lib/workspace-member-emails'

export interface KnownArgs {
  workspaceId: string
  userId: string
  /** kind.recipients: lower-cased addresses, numbers, `quote:` and `poll:` refs. */
  recipients: readonly string[]
}

/** Digits of a phone number, for matching (+1 312-555-0142 and 3125550142 match on the last 10). */
export function phoneKey(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  return digits.length > 10 ? digits.slice(-10) : digits
}

const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)
const isPhone = (s: string) => !isEmail(s) && phoneKey(s).length >= 7 && /^[+\d\s().-]+$/.test(s)

/** Expand quote: and poll: refs into their people. A ref that can't be read expands to nothing (and stays unknown). */
async function expandRefs(db: SupabaseClient, workspaceId: string, recipients: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  for (const r of recipients) {
    try {
      if (r.startsWith('quote:')) {
        const { data, error } = await db.from('customer_quote').select('customer_email, customer_phone').eq('id', r.slice(6)).eq('workspace_id', workspaceId).maybeSingle()
        const row = data as { customer_email?: string | null; customer_phone?: string | null } | null
        const people = [row?.customer_email, row?.customer_phone].filter((v): v is string => typeof v === 'string' && !!v.trim()).map((v) => v.trim().toLowerCase())
        out.set(r, error || !people.length ? [] : people)
      } else if (r.startsWith('poll:')) {
        const { data, error } = await db.from('time_offer_recipient').select('email, phone, answered_at').eq('offer_id', r.slice(5)).eq('workspace_id', workspaceId)
        const rows = (data ?? []) as Array<{ email?: string | null; phone?: string | null }>
        const people = rows.flatMap((g) => [g.email, g.phone]).filter((v): v is string => typeof v === 'string' && !!v.trim()).map((v) => v.trim().toLowerCase())
        out.set(r, error || !people.length ? [] : people)
      }
    } catch {
      out.set(r, [])
    }
  }
  return out
}

/** The subset of `recipients` the person knows. */
export async function knownRecipients(
  db: SupabaseClient,
  args: KnownArgs,
  /** Test seam: members' sign-in addresses (there is no member.email column; workspace-member-emails.ts). */
  memberEmails: (workspaceId: string, emails: string[]) => Promise<ReadonlySet<string>> = async (ws, emails) => new Set((await findMembersByEmail(ws, emails)).keys()),
): Promise<Set<string>> {
  const known = new Set<string>()
  const refs = await expandRefs(db, args.workspaceId, args.recipients)
  const people = new Set<string>()
  for (const r of args.recipients) {
    if (refs.has(r)) for (const p of refs.get(r) ?? []) people.add(p)
    else people.add(r.trim().toLowerCase())
  }
  const emails = [...people].filter(isEmail)
  const phones = [...people].filter(isPhone)
  const knownPeople = new Set<string>()

  // Workspace members (their sign-in address), and the person's own member id.
  let memberId: string | null = null
  try {
    const { data } = await db.from('member').select('id').eq('workspace_id', args.workspaceId).eq('user_id', args.userId).maybeSingle()
    memberId = (data as { id?: string } | null)?.id ?? null
  } catch {
    // fail closed: no hand-added contacts without the person's member row
  }
  if (emails.length) {
    try {
      for (const e of await memberEmails(args.workspaceId, emails)) knownPeople.add(e)
    } catch {
      // fail closed
    }
  }

  // Mail the person sent: their own threads in Sent that name the address.
  if (emails.length) {
    try {
      const { data, error } = await db
        .from('email_thread_index')
        .select('participant_emails, folder, label_ids, trust')
        .eq('workspace_id', args.workspaceId)
        .eq('user_id', args.userId)
        .overlaps('participant_emails', emails)
        .limit(500)
      if (!error) {
        for (const t of (data ?? []) as Array<{ participant_emails?: string[] | null; folder?: string | null; label_ids?: string[] | null; trust?: string | null }>) {
          const sent = t.folder === 'sent' || (Array.isArray(t.label_ids) && t.label_ids.includes('SENT'))
          if (!sent || t.trust) continue
          for (const p of t.participant_emails ?? []) {
            const e = String(p).trim().toLowerCase()
            if (emails.includes(e)) knownPeople.add(e)
          }
        }
      }
    } catch {
      // fail closed
    }
  }

  // Contacts the person added by hand.
  if (memberId && (emails.length || phones.length)) {
    try {
      const { data, error } = await db
        .from('contact')
        .select('email, secondary_emails, phone, source, created_by_member_id, merged_into_contact_id, metadata')
        .eq('workspace_id', args.workspaceId)
        .eq('created_by_member_id', memberId)
        .eq('source', 'manual')
        .is('merged_into_contact_id', null)
        .limit(5000)
      if (!error) {
        const phoneKeys = new Map(phones.map((p) => [phoneKey(p), p]))
        for (const c of (data ?? []) as Array<{ email?: string | null; secondary_emails?: string[] | null; phone?: string | null; source?: string | null; created_by_member_id?: string | null; merged_into_contact_id?: string | null; metadata?: Record<string, unknown> | null }>) {
          if (c.source !== 'manual' || c.created_by_member_id !== memberId || c.merged_into_contact_id) continue
          if (c.metadata && typeof c.metadata === 'object' && HUBSPOT_PUSH_HOLD_KEY in c.metadata) continue
          for (const e of [c.email, ...(c.secondary_emails ?? [])]) {
            const v = typeof e === 'string' ? e.trim().toLowerCase() : ''
            if (v && emails.includes(v)) knownPeople.add(v)
          }
          if (typeof c.phone === 'string' && c.phone.trim()) {
            const match = phoneKeys.get(phoneKey(c.phone))
            if (match) knownPeople.add(match)
          }
        }
      }
    } catch {
      // fail closed
    }
  }

  for (const r of args.recipients) {
    const expanded = refs.get(r)
    if (expanded) {
      if (expanded.length && expanded.every((p) => knownPeople.has(p))) known.add(r)
    } else if (knownPeople.has(r.trim().toLowerCase())) {
      known.add(r.trim().toLowerCase())
    }
  }
  return known
}
