import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * CONTACT VISIBILITY for contact tools that may run on a SERVICE-ROLE client
 * (eve chat tool route, live-agent tool route, MCP, unattended runs).
 *
 * The `contact` table's RLS (mig 058 `contact_select_visibility`) hides other
 * members' private/team contacts, but service role bypasses RLS and
 * `can_view_contact` reads auth.uid(), which is NULL there. So the tools fence
 * each row through `contact_visible_to(contact, user)` (mig 234), the
 * explicit-user twin. It fails CLOSED: an RPC error, a throw, or anything but
 * `true` counts as not visible. On an RLS client the check is redundant and
 * harmless.
 */
export async function isContactVisibleTo(
  supabase: SupabaseClient,
  contactId: string,
  userId: string,
): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc('contact_visible_to', {
      p_contact_id: contactId,
      p_user_id: userId,
    })
    if (error) {
      console.warn('[contact-visibility] contact_visible_to failed:', error.message)
      return false
    }
    return data === true
  } catch (e) {
    console.warn('[contact-visibility] contact_visible_to threw:', e)
    return false
  }
}

/** Keeps only the rows `userId` may see, in their original order. */
export async function filterVisibleContacts<T extends { id?: unknown }>(
  supabase: SupabaseClient,
  userId: string,
  rows: readonly T[],
): Promise<T[]> {
  const keep = await Promise.all(
    rows.map((row) =>
      typeof row?.id === 'string' ? isContactVisibleTo(supabase, row.id, userId) : Promise.resolve(false),
    ),
  )
  return rows.filter((_, i) => keep[i])
}

/**
 * The gate for a tool that WRITES a contact (update_contact,
 * update_crm_contact, enrich_contact): contact_visible_to without its grant
 * arm (`contact_visible_to_ungranted`, migration 495). A per-item grant
 * (migration 492) lets someone read a contact, never change it, so a contact
 * they see only through one is "not found" here, as it was before grants.
 * Fails CLOSED like isContactVisibleTo.
 */
export async function isContactWritableTo(
  supabase: SupabaseClient,
  contactId: string,
  userId: string,
): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc('contact_visible_to_ungranted', {
      p_contact_id: contactId,
      p_user_id: userId,
    })
    if (error) {
      console.warn('[contact-visibility] contact_visible_to_ungranted failed:', error.message)
      return false
    }
    return data === true
  } catch (e) {
    console.warn('[contact-visibility] contact_visible_to_ungranted threw:', e)
    return false
  }
}

/**
 * COMPANY VISIBILITY, the company twin of isContactVisibleTo: the `company`
 * table's RLS (mig 059) keys off auth.uid(), which is NULL on a service-role
 * client, so tools fence each company through `company_visible_to(company,
 * user)` (mig 235). A company is visible to a workspace owner/admin, or to a
 * member who can see at least one of its non-merged contacts. Fails CLOSED like
 * the contact check: an RPC error, a throw, or anything but `true` is hidden.
 */
export async function isCompanyVisibleTo(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc('company_visible_to', {
      p_company_id: companyId,
      p_user_id: userId,
    })
    if (error) {
      console.warn('[contact-visibility] company_visible_to failed:', error.message)
      return false
    }
    return data === true
  } catch (e) {
    console.warn('[contact-visibility] company_visible_to threw:', e)
    return false
  }
}

/**
 * The gate for a tool that WRITES a company (set_custom_fields): company_
 * visible_to without its grant arm (`company_visible_to_ungranted`, migration
 * 496), the twin of isContactWritableTo. A grant on the company, or on one of
 * its contacts, lets someone read it, never change it. Fails CLOSED.
 */
export async function isCompanyWritableTo(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc('company_visible_to_ungranted', {
      p_company_id: companyId,
      p_user_id: userId,
    })
    if (error) {
      console.warn('[contact-visibility] company_visible_to_ungranted failed:', error.message)
      return false
    }
    return data === true
  } catch (e) {
    console.warn('[contact-visibility] company_visible_to_ungranted threw:', e)
    return false
  }
}

/** Keeps only the company rows `userId` may see, in their original order. */
export async function filterVisibleCompanies<T extends { id?: unknown }>(
  supabase: SupabaseClient,
  userId: string,
  rows: readonly T[],
): Promise<T[]> {
  const keep = await Promise.all(
    rows.map((row) =>
      typeof row?.id === 'string' ? isCompanyVisibleTo(supabase, row.id, userId) : Promise.resolve(false),
    ),
  )
  return rows.filter((_, i) => keep[i])
}
