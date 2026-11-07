/**
 * One-off back-fill (security review 2026-10-31): encrypt the provider OAuth
 * tokens still stored in plaintext in user_oauth_tokens. Run by
 * scripts/encrypt-oauth-tokens.ts; it takes any service-role client, so the
 * deployment itself could run it too, with its own key.
 *
 * Since the review every write encrypts (token-crypto.ts) and every read
 * decrypts, passing a legacy plaintext value through, so rows migrate as they
 * refresh or reconnect. A token that never refreshes (GitHub's have no expiry)
 * stays plaintext until this runs.
 *
 *  - Only the columns still in plaintext are rewritten, each write fenced on
 *    the values it read: a row a refresh or a reconnect rewrote meanwhile is
 *    skipped (it is encrypted already). A second run finds nothing to do.
 *  - Jira and Linear rows with an expiry are LEFT ALONE: both rotate the refresh
 *    token on every refresh, so rewriting the row under a refresh in flight
 *    would cost that refresh its compare-and-swap (token-manager.ts
 *    persistRefreshedToken) and its rotated token with it. They migrate at
 *    their own next refresh.
 *  - THE KEY IS PROVEN FIRST. A wrong key (DEV's, a typo) would encrypt every
 *    row unrecoverably, and while no token row is encrypted yet there is
 *    nothing in this table to check it against. So a write needs at least one
 *    ciphertext the app itself wrote (the connected apps' tokens in
 *    connected_mcp_server, and any token row already encrypted) to open with
 *    this key, and none to fail; otherwise nothing is written.
 *
 * Returns counts only: never an id, an email or a token.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { decryptCredential } from '@/lib/crypto/credentials'
import { encryptOAuthToken, isEncryptedOAuthToken } from './token-crypto'

const PAGE = 1000

export type TokenRow = {
  id: string
  provider: string
  expires_at: string | null
  access_token: string
  refresh_token: string | null
}

export interface TokenBackfillCounts {
  rows: number
  accessPlaintext: number
  accessEncrypted: number
  refreshPlaintext: number
  refreshEncrypted: number
  refreshNull: number
  /** Jira/Linear rows still in plaintext, left to migrate at their next refresh. */
  rotatingLeft: number
  toEncrypt: number
  /** App-written ciphertexts that open (fail) with this key; null with no key. */
  keyOpened: number | null
  keyFailed: number | null
  encrypted: number
  changedSinceRead: number
  failed: number
}

export class TokenBackfillRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TokenBackfillRefused'
  }
}

/**
 * The token columns a stored row still holds in plaintext, encrypted: the
 * patch that finishes its migration, or null when it is already encrypted.
 */
export function plaintextTokenPatch(row: {
  access_token: string
  refresh_token: string | null
}): { access_token?: string; refresh_token?: string } | null {
  const patch: { access_token?: string; refresh_token?: string } = {}
  if (!isEncryptedOAuthToken(row.access_token)) patch.access_token = encryptOAuthToken(row.access_token)
  if (row.refresh_token && !isEncryptedOAuthToken(row.refresh_token)) {
    patch.refresh_token = encryptOAuthToken(row.refresh_token)
  }
  return Object.keys(patch).length > 0 ? patch : null
}

function needsEncrypting(row: Pick<TokenRow, 'access_token' | 'refresh_token'>): boolean {
  return !isEncryptedOAuthToken(row.access_token) || Boolean(row.refresh_token && !isEncryptedOAuthToken(row.refresh_token))
}

/** A Jira or Linear row with an expiry: it rotates, so it migrates at its own next refresh. */
export function migratesOnRefresh(row: Pick<TokenRow, 'provider' | 'expires_at'>): boolean {
  return (row.provider === 'jira' || row.provider === 'linear') && row.expires_at !== null
}

/**
 * Whether this process's CREDENTIAL_ENCRYPTION_KEY is the one the app writes
 * with: how many of the app's own ciphertexts open with it, and how many don't.
 * Proven only when at least one opens and none fails.
 */
export function checkCredentialKey(ciphertexts: readonly string[]): { opened: number; failed: number; proven: boolean } {
  let opened = 0
  let failed = 0
  for (const c of ciphertexts) {
    try {
      decryptCredential(c)
      opened++
    } catch {
      failed++
    }
  }
  return { opened, failed, proven: opened > 0 && failed === 0 }
}

async function pages<T>(page: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    out.push(...((data ?? []) as T[]))
    if (!data || data.length < PAGE) return out
  }
}

/** The ciphertexts the app itself wrote: connected apps' tokens, and token rows already encrypted. */
async function appCiphertexts(supabase: SupabaseClient, rows: readonly TokenRow[]): Promise<string[]> {
  const servers = await pages<{ access_token_encrypted: string | null; refresh_token_encrypted: string | null }>((from, to) =>
    supabase.from('connected_mcp_server').select('access_token_encrypted, refresh_token_encrypted').order('id').range(from, to),
  )
  const out: string[] = []
  for (const s of servers) {
    for (const v of [s.access_token_encrypted, s.refresh_token_encrypted]) if (v) out.push(v)
  }
  for (const r of rows) {
    for (const v of [r.access_token, r.refresh_token]) if (v && isEncryptedOAuthToken(v)) out.push(v)
  }
  return out
}

export async function encryptPlaintextOAuthTokens(
  supabase: SupabaseClient,
  opts: { execute: boolean },
): Promise<TokenBackfillCounts> {
  const hasKey = Boolean(process.env.CREDENTIAL_ENCRYPTION_KEY)
  if (opts.execute && !hasKey) throw new TokenBackfillRefused('CREDENTIAL_ENCRYPTION_KEY is not set; nothing written.')

  const rows = await pages<TokenRow>((from, to) =>
    supabase.from('user_oauth_tokens').select('id, provider, expires_at, access_token, refresh_token').order('id').range(from, to),
  )
  const counts: TokenBackfillCounts = {
    rows: rows.length,
    accessPlaintext: 0,
    accessEncrypted: 0,
    refreshPlaintext: 0,
    refreshEncrypted: 0,
    refreshNull: 0,
    rotatingLeft: 0,
    toEncrypt: 0,
    keyOpened: null,
    keyFailed: null,
    encrypted: 0,
    changedSinceRead: 0,
    failed: 0,
  }
  const todo: TokenRow[] = []
  for (const row of rows) {
    if (isEncryptedOAuthToken(row.access_token)) counts.accessEncrypted++
    else counts.accessPlaintext++
    if (row.refresh_token === null) counts.refreshNull++
    else if (isEncryptedOAuthToken(row.refresh_token)) counts.refreshEncrypted++
    else counts.refreshPlaintext++
    if (!needsEncrypting(row)) continue
    if (migratesOnRefresh(row)) counts.rotatingLeft++
    else todo.push(row)
  }
  counts.toEncrypt = todo.length

  if (hasKey) {
    const key = checkCredentialKey(await appCiphertexts(supabase, rows))
    counts.keyOpened = key.opened
    counts.keyFailed = key.failed
    if (opts.execute && !key.proven) {
      throw new TokenBackfillRefused(
        key.opened === 0
          ? 'No ciphertext the app wrote opens with this CREDENTIAL_ENCRYPTION_KEY, so it cannot be proven to be the app’s key; nothing written.'
          : 'Some ciphertexts the app wrote do not open with this CREDENTIAL_ENCRYPTION_KEY (a wrong key, or mixed keys); nothing written.',
      )
    }
  }
  if (!opts.execute) return counts

  for (const row of todo) {
    const patch = plaintextTokenPatch(row)
    if (!patch) continue
    // Fenced on what was read: a row rewritten since matches nothing.
    let write = supabase.from('user_oauth_tokens').update(patch).eq('id', row.id).eq('access_token', row.access_token)
    write = row.refresh_token === null ? write.is('refresh_token', null) : write.eq('refresh_token', row.refresh_token)
    const { data, error } = await write.select('id')
    if (error) counts.failed++
    else if ((data ?? []).length === 0) counts.changedSinceRead++
    else counts.encrypted++
  }
  return counts
}
