/**
 * The person's GitHub integration token: user_oauth_tokens, provider and
 * capability `github`, decrypted (token-crypto.ts). GitHub tokens never expire
 * or refresh, so they are read here rather than through token-manager.ts.
 *
 * Outside token-manager.ts, this is the one reader of a token column; the
 * tripwire (src/lib/oauth/__tests__/token-column-tripwire.test.ts) keeps it
 * that way. Every coding path (the outcome route, spec rebuilds, CI fixes,
 * proactive attempts, run_agent, the Mac's pull requests), the PR lookups and
 * the agent's GitHub tools call it.
 *
 * Hand it the SERVICE client, with a user id the caller has authorized (the
 * session's own, a run token's, a flow's run-as user). The token columns are
 * the service role's alone (migration 466): a user-scoped client reads
 * nothing, which is logged here and answers as "not connected".
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { decryptOAuthToken } from './token-crypto'

type TokenRow = { access_token?: unknown; account_id?: unknown }

/**
 * A row's token, decrypted. Null when it has none, or when it does not decrypt
 * (logged with the user id, never the value): a caller treats it as not
 * connected, and the ciphertext never goes out as a bearer token.
 */
function openRow(row: TokenRow, userId: string): string | null {
  const stored = row.access_token
  if (typeof stored !== 'string' || !stored) return null
  try {
    return decryptOAuthToken(stored)
  } catch (err) {
    console.error(
      `[github-token] could not decrypt the stored GitHub token for user ${userId}: ` +
        (err instanceof Error ? err.message : String(err)),
    )
    return null
  }
}

/** A failed read, logged with the user id and the error (never a value). */
function logReadError(error: { message?: unknown; code?: unknown } | null | undefined, userId: string): void {
  if (!error) return
  console.error(
    `[github-token] could not read the stored GitHub token for user ${userId}` +
      (error.code ? ` (${String(error.code)})` : '') +
      `: ${String(error.message ?? 'unknown error')}`,
  )
}

/** The user's newest GitHub token, or null (not connected, a read error, or undecryptable). */
export async function storedGithubToken(supabase: SupabaseClient, userId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('user_oauth_tokens')
    .select('access_token')
    .eq('user_id', userId)
    .eq('provider', 'github')
    .eq('capability', 'github')
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  logReadError(error, userId)
  return data ? openRow(data as TokenRow, userId) : null
}

/** Every GitHub token of the user's with its connected account, newest first. */
export async function storedGithubTokensByAccount(
  supabase: SupabaseClient,
  userId: string,
): Promise<Array<{ accountId: string; token: string }>> {
  const { data, error } = await supabase
    .from('user_oauth_tokens')
    .select('access_token, account_id')
    .eq('user_id', userId)
    .eq('provider', 'github')
    .eq('capability', 'github')
    .order('updated_at', { ascending: false })
  logReadError(error, userId)
  const out: Array<{ accountId: string; token: string }> = []
  for (const row of (Array.isArray(data) ? data : []) as TokenRow[]) {
    if (typeof row.account_id !== 'string') continue
    const token = openRow(row, userId)
    if (token) out.push({ accountId: row.account_id, token })
  }
  return out
}
