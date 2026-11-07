import type { SupabaseClient } from '@supabase/supabase-js'
import { mailboxAddresses } from './reply-policy'

/**
 * Every address the person sends from, lower-cased: each connected mail
 * account's, and the address they sign in with. Mail from any of them is the
 * person's own (Liam, 2026-10-27, GEN-1164: "Test" mails he sent himself got
 * drafted replies asking him about "our last call"), and no draft is ever
 * addressed to one of them. Never throws: a failed read leaves that source
 * out, so the result can be empty.
 */
export async function ownMailAddresses(supabase: SupabaseClient, userId: string): Promise<Set<string>> {
  const own = new Set<string>()
  const add = (value: unknown) => {
    const found = typeof value === 'string' ? mailboxAddresses(value) : []
    if (found.length === 1) own.add(found[0])
  }
  try {
    const { data, error } = await supabase
      .from('connected_account')
      .select('account_email')
      .eq('user_id', userId)
      .eq('capability', 'email')
    if (!error) for (const row of (data as Array<{ account_email?: unknown }> | null) ?? []) add(row.account_email)
  } catch {
    // No connected accounts known.
  }
  try {
    const { data } = await supabase.auth.admin.getUserById(userId)
    add(data?.user?.email)
  } catch {
    // No sign-in address known.
  }
  return own
}
