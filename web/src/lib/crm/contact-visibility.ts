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
 *
 * `grants: false` on a turn that reads no grant (a guest's or a linked
 * agent's, which run the owner's tools: omitGrants): the 3-arg twin
 * (migration 519) without its grant arm, so a contact shared with the owner
 * stays theirs. Absent: the 2-arg twin, grants and all, as before.
 */
export async function isContactVisibleTo(
  supabase: SupabaseClient,
  contactId: string,
  userId: string,
  opts: { grants?: boolean } = {},
): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc('contact_visible_to', {
      p_contact_id: contactId,
      p_user_id: userId,
      ...(opts.grants === false ? { p_grants: false } : {}),
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

/** Keeps only the rows `userId` may see, in their original order. `grants` as isContactVisibleTo's. */
export async function filterVisibleContacts<T extends { id?: unknown }>(
  supabase: SupabaseClient,
  userId: string,
  rows: readonly T[],
  opts: { grants?: boolean } = {},
): Promise<T[]> {
  const keep = await Promise.all(
    rows.map((row) =>
      typeof row?.id === 'string' ? isContactVisibleTo(supabase, row.id, userId, opts) : Promise.resolve(false),
    ),
  )
  return rows.filter((_, i) => keep[i])
}

/**
 * The gate for a tool that WRITES a contact (update_contact,
 * update_crm_contact, enrich_contact, set_custom_fields): the contact EDIT
 * rule for an explicit user (`contact_editable_by`, migration 498), which is
 * contact_update's can_edit_contact: its creator, an owner or admin, anyone
 * when it is workspace-visible, or an `edit` contact_share; or, on the
 * person's own turn, an EDIT grant (512's entity_edit_granted, never for a
 * guest member). Seeing a contact (a teammate's team contact, a view share, a
 * view grant) never lets someone change it. Fails CLOSED like
 * isContactVisibleTo.
 *
 * `grants: false` on a turn that reads no grant (a guest's or a linked
 * agent's, which run the owner's tools: omitGrants): what was shared with
 * the owner is never theirs to change.
 */
export async function isContactWritableTo(
  supabase: SupabaseClient,
  contactId: string,
  userId: string,
  opts: { grants?: boolean } = {},
): Promise<boolean> {
  return (await contactWriteAccess(supabase, contactId, userId, opts)) !== null
}

/**
 * isContactWritableTo, saying how: 'rule' (its own edit rule), 'grant' (only
 * an edit grant, 512: the tool then keeps to what the contact SAYS, never
 * its company or email, whose autolink files it under a company a granted
 * contact would open), or null.
 */
export async function contactWriteAccess(
  supabase: SupabaseClient,
  contactId: string,
  userId: string,
  opts: { grants?: boolean } = {},
): Promise<'rule' | 'grant' | null> {
  if (await contactEditableBy(supabase, contactId, userId)) return 'rule'
  if (opts.grants === false) return null
  return (await editGranted(supabase, 'contact', contactId, userId)) ? 'grant' : null
}

/** 498's contact_editable_by, the contact's own edit rule. */
async function contactEditableBy(supabase: SupabaseClient, contactId: string, userId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc('contact_editable_by', {
      p_contact_id: contactId,
      p_user_id: userId,
    })
    if (error) {
      console.warn('[contact-visibility] contact_editable_by failed:', error.message)
      return false
    }
    return data === true
  } catch (e) {
    console.warn('[contact-visibility] contact_editable_by threw:', e)
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
 * `grants: false` as isContactVisibleTo's: no grant on the company, and none
 * on one of its contacts, opens it (519's 3-arg twin).
 */
export async function isCompanyVisibleTo(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  opts: { grants?: boolean } = {},
): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc('company_visible_to', {
      p_company_id: companyId,
      p_user_id: userId,
      ...(opts.grants === false ? { p_grants: false } : {}),
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
 * 496), the twin of isContactWritableTo; or, on the person's own turn, an
 * EDIT grant on the company itself (512's entity_edit_granted). A view grant
 * on the company, or any grant on one of its contacts, lets someone read it,
 * never change it. `grants: false` as isContactWritableTo's. Fails CLOSED.
 */
export async function isCompanyWritableTo(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  opts: { grants?: boolean } = {},
): Promise<boolean> {
  return (await companyWriteAccess(supabase, companyId, userId, opts)) !== null
}

/**
 * isCompanyWritableTo, saying how: 'rule', 'grant' (only an edit grant: the
 * tool then never changes its domain, whose adoption trigger pulls other
 * members' contacts in and opens the company to their readers), or null.
 */
export async function companyWriteAccess(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  opts: { grants?: boolean } = {},
): Promise<'rule' | 'grant' | null> {
  try {
    const { data, error } = await supabase.rpc('company_visible_to_ungranted', {
      p_company_id: companyId,
      p_user_id: userId,
    })
    if (error) console.warn('[contact-visibility] company_visible_to_ungranted failed:', error.message)
    else if (data === true) return 'rule'
  } catch (e) {
    console.warn('[contact-visibility] company_visible_to_ungranted threw:', e)
  }
  if (opts.grants === false) return null
  return (await editGranted(supabase, 'company', companyId, userId)) ? 'grant' : null
}

/** 512's entity_edit_granted: an EDIT grant on this contact or company reaches the user. Fails CLOSED. */
async function editGranted(supabase: SupabaseClient, type: 'contact' | 'company', id: string, userId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc('entity_edit_granted', { p_type: type, p_id: id, p_user_id: userId })
    if (error) {
      console.warn('[contact-visibility] entity_edit_granted failed:', error.message)
      return false
    }
    return data === true
  } catch (e) {
    console.warn('[contact-visibility] entity_edit_granted threw:', e)
    return false
  }
}

/** Keeps only the company rows `userId` may see, in their original order. `grants` as isCompanyVisibleTo's. */
export async function filterVisibleCompanies<T extends { id?: unknown }>(
  supabase: SupabaseClient,
  userId: string,
  rows: readonly T[],
  opts: { grants?: boolean } = {},
): Promise<T[]> {
  const keep = await Promise.all(
    rows.map((row) =>
      typeof row?.id === 'string' ? isCompanyVisibleTo(supabase, row.id, userId, opts) : Promise.resolve(false),
    ),
  )
  return rows.filter((_, i) => keep[i])
}
