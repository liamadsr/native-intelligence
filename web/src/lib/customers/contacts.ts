/**
 * A customer's CRM contact (roadmap B1/B2): found by their email or whole
 * number in the business's workspace (never a merged-away one), else made.
 * A found contact keeps everything it has: a form or a text never gives it
 * an email or a phone (they are unverified: a stranger could post someone's
 * email with their own number and take over who that contact is). Only a
 * placeholder name is replaced, and a plain contact becomes a lead.
 *
 * Made contacts are the workspace's (visibility 'workspace', the owner as
 * creator), source 'web_form' or 'sms'. A made one (never a found one) starts
 * the workspace's contact_created loops (emit-contact-created.ts), here
 * rather than in each caller so every public intake does it the same way.
 *
 * By default the found contact's change and the loops happen at once (the
 * quote intake and a customer's text). With `defer`, neither happens here:
 * the contact is still found or made (its id is what the caller links), and
 * what was held back comes back as `deferred`, for the caller to apply with
 * settleCustomerContact once what it was for is stored (a form's row:
 * src/lib/forms/deps.ts), or never. Server only; service role.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { notifyContactCreated } from '@/lib/flows/emit-contact-created'
import { isE164, normalizeE164 } from '@/lib/twilio/phone'

export interface CustomerContactInput {
  name: string | null
  email: string | null
  phone: string | null
  source: 'web_form' | 'sms'
}

export interface CustomerContact {
  id: string
  fullName: string
  email: string | null
  phone: string | null
  created: boolean
  /** With `defer` only: what was held back (see the header). */
  deferred?: DeferredContactWork
}

/** What a deferred upsert held back: the found contact's change, and whether a made one's loops are owed. */
export interface DeferredContactWork {
  /** A found contact's change (a placeholder name replaced, a plain contact made a lead), or null. */
  patch: { full_name?: string; relationship_type?: 'lead' } | null
  /** The contact was made: its contact_created loops are owed. */
  notify: boolean
}

interface ContactRow {
  id: string
  full_name: string
  email: string | null
  phone: string | null
  relationship_type: string | null
}

const CONTACT_SELECT = 'id, full_name, email, phone, relationship_type'

/**
 * The workspace's live contact with this email or number, or null. A stored
 * phone is read as E.164 (a ten-digit one as US/Canada) and must equal the
 * number whole, so "(646) 555-0173" finds +16465550173 and a foreign number
 * that merely ends the same never does. Throws on a failed read.
 */
export async function findContactByEmailOrPhone(
  supabase: SupabaseClient,
  workspaceId: string,
  who: { email: string | null; phone: string | null },
): Promise<ContactRow | null> {
  if (who.email && /^[^\s,()"]+@[^\s,()"]+$/.test(who.email)) {
    const { data, error } = await supabase
      .from('contact')
      .select(CONTACT_SELECT)
      .eq('workspace_id', workspaceId)
      .is('merged_into_contact_id', null)
      .or(`email.eq.${who.email},secondary_emails.cs.{"${who.email}"}`)
      .limit(1)
      .maybeSingle<ContactRow>()
    if (error) throw new Error(`contact read failed: ${error.message}`)
    if (data) return data
  }
  if (who.phone && isE164(who.phone)) {
    const phone = who.phone
    // A narrow ilike on the last four digits, then the whole-number comparison here.
    const { data, error } = await supabase
      .from('contact')
      .select(CONTACT_SELECT)
      .eq('workspace_id', workspaceId)
      .is('merged_into_contact_id', null)
      .ilike('phone', `%${phone.slice(-4)}%`)
      .limit(50)
    if (error) throw new Error(`contact read failed: ${error.message}`)
    const match = ((data ?? []) as ContactRow[]).find((row) => normalizeE164(row.phone) === phone)
    if (match) return match
  }
  return null
}

async function ownerMemberId(supabase: SupabaseClient, workspaceId: string, ownerUserId: string): Promise<string | null> {
  const { data } = await supabase.from('member').select('id').eq('workspace_id', workspaceId).eq('user_id', ownerUserId).maybeSingle<{ id: string }>()
  return data?.id ?? null
}

/** A name for a contact with none: the email's local part, else "Customer ending 1234". */
function fallbackName(input: CustomerContactInput): string {
  if (input.email) return input.email.split('@')[0]
  return input.phone ? `Customer ending ${input.phone.slice(-4)}` : 'Customer'
}

/**
 * Apply what an upsert held back (or did at once): the found contact's
 * change, then a made contact's contact_created loops. The change throws on
 * a failed write; the loops never throw.
 */
export async function settleCustomerContact(
  supabase: SupabaseClient,
  args: { workspaceId: string; contactId: string },
  work: DeferredContactWork,
  deps: { notify?: typeof notifyContactCreated } = {},
): Promise<void> {
  if (work.patch && Object.keys(work.patch).length) {
    const { error } = await supabase.from('contact').update({ ...work.patch, updated_at: new Date().toISOString() }).eq('id', args.contactId).eq('workspace_id', args.workspaceId)
    if (error) throw new Error(`contact update failed: ${error.message}`)
  }
  // The contact_created loops a public intake's new contact starts. Never throws.
  if (work.notify) await (deps.notify ?? notifyContactCreated)(supabase, { workspaceId: args.workspaceId, contactId: args.contactId, source: 'form' }).catch(() => false)
}

/**
 * Find or make the customer's contact (see the header). Null when there is
 * nothing to match or make it by. Throws on a failed read or write.
 */
export async function upsertCustomerContact(
  supabase: SupabaseClient,
  args: { workspaceId: string; ownerUserId: string },
  input: CustomerContactInput,
  deps: { notify?: typeof notifyContactCreated; defer?: boolean } = {},
): Promise<CustomerContact | null> {
  if (!input.email && !input.phone) return null
  const existing = await findContactByEmailOrPhone(supabase, args.workspaceId, input)
  if (existing) {
    // Never an email or phone from a form or a text: see the header.
    const patch: NonNullable<DeferredContactWork['patch']> = {}
    if (input.name && /^Customer ending \d{4}$/.test(existing.full_name)) patch.full_name = input.name
    if (!existing.relationship_type || existing.relationship_type === 'contact') patch.relationship_type = 'lead'
    const work: DeferredContactWork = { patch: Object.keys(patch).length ? patch : null, notify: false }
    const found = { id: existing.id, email: existing.email, phone: existing.phone, created: false }
    if (deps.defer) return { ...found, fullName: existing.full_name, deferred: work }
    await settleCustomerContact(supabase, { workspaceId: args.workspaceId, contactId: existing.id }, work, deps)
    return { ...found, fullName: patch.full_name ?? existing.full_name }
  }
  const fullName = input.name ?? fallbackName(input)
  const [firstName, ...rest] = fullName.split(' ')
  const { data, error } = await supabase
    .from('contact')
    .insert({
      workspace_id: args.workspaceId,
      created_by_member_id: await ownerMemberId(supabase, args.workspaceId, args.ownerUserId),
      visibility: 'workspace',
      full_name: fullName,
      first_name: input.name ? firstName || null : null,
      last_name: input.name ? rest.join(' ') || null : null,
      email: input.email,
      phone: input.phone,
      relationship_type: 'lead',
      source: input.source,
    })
    .select(CONTACT_SELECT)
    .single<ContactRow>()
  if (error || !data) throw new Error(`contact insert failed: ${error?.message ?? 'no row'}`)
  const made = { id: data.id, fullName: data.full_name, email: data.email, phone: data.phone, created: true }
  const work: DeferredContactWork = { patch: null, notify: true }
  if (deps.defer) return { ...made, deferred: work }
  await settleCustomerContact(supabase, { workspaceId: args.workspaceId, contactId: data.id }, work, deps)
  return made
}
