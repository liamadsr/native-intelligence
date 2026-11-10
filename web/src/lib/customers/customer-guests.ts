/**
 * A business's customers as guest rows (roadmap B2, migration 458): anyone
 * who texts a business's number and isn't one of its own people becomes an
 * `agent_guest` with preset 'customer', so their texts ride the guest
 * pipeline unchanged (their own thread, a text turn carrying their
 * `guestId`, every tool call re-checked live), while their agent is the
 * business's front desk (./customer-spec.ts) holding only CUSTOMER_TOOLS.
 *
 * A customer row is active and its number bound from its first text (they
 * texted from it: that is the binding), owned by the number's owner, scoped
 * to the number (business_number_id), one per business and phone
 * (agent_guest_customer_phone_key). It is never in the People tab and never
 * reached through the Native Intelligence number (store.ts leaves preset 'customer' out).
 *
 * Server only; service role.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { AGENT_GUEST_SELECT, toGuest, type AgentGuest } from '@/lib/guests/store'
import { GUEST_ASK_BEFORE } from '@/lib/guests/presets'
import { CUSTOMER_TOOLS } from './customer-tools-list'
import type { BusinessNumber } from './numbers'

/** "Customer ending 4567": the name a customer goes by until one is known. */
export function customerPlaceholderName(phone: string): string {
  return `Customer ending ${phone.slice(-4)}`
}

/** The business's customer row for this number (not removed), or null. Throws on a failed read. */
export async function findCustomerGuest(supabase: SupabaseClient, workspaceId: string, phone: string): Promise<AgentGuest | null> {
  const { data, error } = await supabase
    .from('agent_guest')
    .select(AGENT_GUEST_SELECT)
    .eq('workspace_id', workspaceId)
    .eq('phone_e164', phone)
    .eq('preset', 'customer')
    .neq('state', 'removed')
    .maybeSingle()
  if (error) throw new Error(`agent_guest read failed: ${error.message}`)
  return data ? toGuest(data as Parameters<typeof toGuest>[0]) : null
}

/**
 * The customer row for this number at this business, made on their first
 * text. A name and contact found since are filled into a row still on the
 * placeholder. Throws on a failed write.
 */
export async function ensureCustomerGuest(
  supabase: SupabaseClient,
  args: { number: BusinessNumber; phone: string; contact: { id: string; fullName: string } | null },
  now: number = Date.now(),
): Promise<{ guest: AgentGuest; created: boolean }> {
  const existing = await findCustomerGuest(supabase, args.number.workspaceId, args.phone)
  if (existing) {
    const patch: Record<string, unknown> = {}
    if (args.contact && !existing.contactId) patch.contact_id = args.contact.id
    if (args.contact && existing.displayName === customerPlaceholderName(args.phone) && !/^Customer ending \d{4}$/.test(args.contact.fullName)) patch.display_name = args.contact.fullName.slice(0, 80)
    if (existing.businessNumberId !== args.number.id) patch.business_number_id = args.number.id
    if (!Object.keys(patch).length) return { guest: existing, created: false }
    const { data, error } = await supabase
      .from('agent_guest')
      .update({ ...patch, updated_at: new Date(now).toISOString() })
      .eq('id', existing.id)
      .select(AGENT_GUEST_SELECT)
      .single()
    if (error || !data) throw new Error(`agent_guest update failed: ${error?.message ?? 'no row'}`)
    return { guest: toGuest(data as Parameters<typeof toGuest>[0]), created: false }
  }
  const at = new Date(now).toISOString()
  const name = args.contact && !/^Customer ending \d{4}$/.test(args.contact.fullName) ? args.contact.fullName.slice(0, 80) : customerPlaceholderName(args.phone)
  const { data, error } = await supabase
    .from('agent_guest')
    .insert({
      owner_user_id: args.number.ownerUserId,
      workspace_id: args.number.workspaceId,
      display_name: name,
      phone_e164: args.phone,
      channels: ['sms'],
      phone_bound_at: at,
      preset: 'customer',
      // For the record only: a customer's ceiling is CUSTOMER_TOOLS, whatever the row says (guest-turn.ts).
      tools: [...CUSTOMER_TOOLS],
      ask_tools: [],
      ask_before: [...GUEST_ASK_BEFORE],
      state: 'active',
      activated_at: at,
      business_number_id: args.number.id,
      contact_id: args.contact?.id ?? null,
    })
    .select(AGENT_GUEST_SELECT)
    .single()
  if (data) return { guest: toGuest(data as Parameters<typeof toGuest>[0]), created: true }
  // Two first texts raced: the other one made it.
  if ((error as { code?: string } | null)?.code === '23505') {
    const raced = await findCustomerGuest(supabase, args.number.workspaceId, args.phone)
    if (raced) return { guest: raced, created: false }
  }
  throw new Error(`agent_guest insert failed: ${error?.message ?? 'no row'}`)
}

/** Link a customer row to its CRM contact (and its name, while on the placeholder). Best effort. */
export async function linkCustomerContact(supabase: SupabaseClient, guest: Pick<AgentGuest, 'id' | 'displayName' | 'phone' | 'contactId'>, contact: { id: string; fullName: string }): Promise<void> {
  if (guest.contactId === contact.id) return
  const patch: Record<string, unknown> = { contact_id: contact.id, updated_at: new Date().toISOString() }
  if (guest.phone && guest.displayName === customerPlaceholderName(guest.phone) && !/^Customer ending \d{4}$/.test(contact.fullName)) patch.display_name = contact.fullName.slice(0, 80)
  try {
    await supabase.from('agent_guest').update(patch).eq('id', guest.id).eq('preset', 'customer')
  } catch {
    // Best effort: the quote lookup also matches by number.
  }
}
