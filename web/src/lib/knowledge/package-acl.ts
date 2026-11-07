import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Package ACL — the single code seam over the SQL predicates from mig 238.
 *
 * The canonical visibility/edit rules live in `package_visible_to` /
 * `package_editable_by` (SECURITY DEFINER, explicit-requester convention from
 * mig 237). RLS enforces them for user-JWT clients automatically; every
 * SERVICE-ROLE path that reads or mutates package-scoped data (MCP tools, MCP
 * brief resources, live-agent injection) must go through these wrappers
 * instead of re-implementing the rules in TypeScript.
 *
 * Both wrappers fail CLOSED: an RPC error reads as "no access".
 */

export async function packageVisibleTo(
  supabase: SupabaseClient,
  userId: string,
  packageId: string,
): Promise<boolean> {
  const { data, error } = await supabase.rpc('package_visible_to', {
    p_package_id: packageId,
    p_user_id: userId,
  })
  if (error) return false
  return data === true
}

export async function packageEditableBy(
  supabase: SupabaseClient,
  userId: string,
  packageId: string,
): Promise<boolean> {
  const { data, error } = await supabase.rpc('package_editable_by', {
    p_package_id: packageId,
    p_user_id: userId,
  })
  if (error) return false
  return data === true
}
