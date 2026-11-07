import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { OAuthCapability, OAuthProvider } from './config'
import { decryptOAuthToken, encryptOAuthToken, isEncryptedOAuthToken } from './token-crypto'

type Provider = OAuthProvider

interface OAuthToken {
  id: string
  user_id: string
  provider: Provider
  capability: string
  /** Both as stored: a `v1` ciphertext, or plaintext on a legacy row (token-crypto.ts). */
  access_token: string
  refresh_token: string | null
  token_type: string
  expires_at: string | null
  scopes: string[]
  email: string | null
  account_id: string | null
}

const REFRESH_BUFFER_MS = 5 * 60 * 1000 // refresh 5 min before expiry

function getServiceSupabase() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
}

/**
 * Get a valid access token for a specific connected account.
 *
 * Only a token row of the account's OWNER counts: the row's user_id must be
 * the connected_account's user_id. A row that names someone else's account
 * (a teammate's account id carries no secret, and before migration 469 a
 * member could write such a row with their own session) is never used for it.
 */
export async function getValidTokenForAccount(
  accountId: string,
): Promise<{ token: string; email: string | null; accountId: string } | null> {
  const supabase = getServiceSupabase()

  const { data: account, error: accountError } = await supabase
    .from('connected_account')
    .select('user_id')
    .eq('id', accountId)
    .maybeSingle()
  const ownerId = (account as { user_id?: unknown } | null)?.user_id
  if (accountError || typeof ownerId !== 'string' || !ownerId) return null

  // Use maybeSingle with ordering to pick the most specific token.
  // An account may have both a legacy 'both' token and a specific capability token;
  // prefer the specific one (capability != 'both') and the most recently updated.
  const { data: rows, error } = await supabase
    .from('user_oauth_tokens')
    .select('*')
    .eq('account_id', accountId)
    .eq('user_id', ownerId)
    .order('updated_at', { ascending: false })

  if (error || !rows || rows.length === 0) return null

  // Prefer a capability-specific token over the legacy 'both' token
  const data = rows.find((r: Record<string, unknown>) => r.capability !== 'both') ?? rows[0]

  const tokenRow = data as unknown as OAuthToken
  const result = await ensureValidToken(supabase, tokenRow)
  if (!result) return null
  return { ...result, accountId }
}

/**
 * Get a valid token for the primary account of a given capability.
 * Falls back to any available account if no primary is set.
 * Used by AI tools and features that need "any" token for a capability.
 */
export async function getValidTokenForCapability(
  userId: string,
  capability: OAuthCapability,
): Promise<{ token: string; email: string | null; accountId: string; provider: Provider } | null> {
  const supabase = getServiceSupabase()

  // Find the primary connected account for this capability
  const { data: primaryAccount } = await supabase
    .from('connected_account')
    .select('id, provider')
    .eq('user_id', userId)
    .eq('capability', capability)
    .eq('is_primary', true)
    .eq('is_enabled', true)
    .single()

  if (primaryAccount) {
    const result = await getValidTokenForAccount(primaryAccount.id)
    if (result) return { ...result, provider: primaryAccount.provider as Provider }
  }

  // Fallback: any enabled account for this capability
  const { data: anyAccount } = await supabase
    .from('connected_account')
    .select('id, provider')
    .eq('user_id', userId)
    .eq('capability', capability)
    .eq('is_enabled', true)
    .order('created_at', { ascending: true })
    .limit(1)
    .single()

  if (!anyAccount) return null

  const result = await getValidTokenForAccount(anyAccount.id)
  if (!result) return null
  return { ...result, provider: anyAccount.provider as Provider }
}

/**
 * Get valid tokens for ALL enabled accounts of a given capability.
 * Used for unified views (all email accounts, all calendar accounts).
 */
export async function getAllValidTokens(
  userId: string,
  capability: OAuthCapability,
): Promise<Array<{ token: string; email: string | null; accountId: string; provider: Provider }>> {
  const supabase = getServiceSupabase()

  const { data: accounts } = await supabase
    .from('connected_account')
    .select('id, provider')
    .eq('user_id', userId)
    .eq('capability', capability)
    .eq('is_enabled', true)
    .order('created_at', { ascending: true })

  if (!accounts || accounts.length === 0) return []

  const results = await Promise.allSettled(
    accounts.map(async (account) => {
      const result = await getValidTokenForAccount(account.id)
      if (!result) return null
      return { ...result, provider: account.provider as Provider }
    }),
  )

  return results
    .filter(
      (r): r is PromiseFulfilledResult<NonNullable<Awaited<ReturnType<typeof getValidTokenForAccount>> & { provider: Provider }>> =>
        r.status === 'fulfilled' && r.value !== null,
    )
    .map((r) => r.value)
}

/**
 * Legacy backward-compatible function.
 * Get a valid access token for a provider + capability, refreshing if needed.
 * Checks for an exact capability match first, then falls back to legacy 'both' tokens.
 *
 * @deprecated Use getValidTokenForAccount, getValidTokenForCapability, or getAllValidTokens instead.
 */
export async function getValidToken(
  userId: string,
  provider: Provider,
  capability?: OAuthCapability,
): Promise<{ token: string; email: string | null } | null> {
  const supabase = getServiceSupabase()

  // Try exact capability match first, then fall back to 'both' (legacy)
  const capabilitiesToTry = capability
    ? [capability, 'both']
    : ['calendar', 'email', 'both']

  let tokenRow: OAuthToken | null = null

  for (const cap of capabilitiesToTry) {
    const { data, error } = await supabase
      .from('user_oauth_tokens')
      .select('*')
      .eq('user_id', userId)
      .eq('provider', provider)
      .eq('capability', cap)
      .order('created_at', { ascending: true })
      .limit(1)
      .single()

    if (!error && data) {
      tokenRow = data as unknown as OAuthToken
      break
    }
  }

  if (!tokenRow) return null
  return ensureValidToken(supabase, tokenRow)
}

/**
 * Check token expiry and refresh if needed.
 */
async function ensureValidToken(
  supabase: SupabaseClient,
  tokenRow: OAuthToken,
): Promise<{ token: string; email: string | null } | null> {
  if (tokenRow.expires_at) {
    const expiresAt = new Date(tokenRow.expires_at).getTime()
    if (Date.now() > expiresAt - REFRESH_BUFFER_MS) {
      if (!tokenRow.refresh_token) return null
      return await refreshToken(supabase, tokenRow)
    }
  }

  const token = openStoredToken(tokenRow, 'access_token')
  return token ? { token, email: tokenRow.email } : null
}

/**
 * A stored token column, decrypted. Null when it does not decrypt (another key,
 * or tampered): every caller reads null as "no usable token", so this logs the
 * account (never the value) and the ciphertext never goes out as a bearer token.
 */
function openStoredToken(tokenRow: OAuthToken, column: 'access_token' | 'refresh_token'): string | null {
  const stored = tokenRow[column]
  if (!stored) return null
  try {
    return decryptOAuthToken(stored)
  } catch (err) {
    console.error(
      `[token-manager] could not decrypt the stored ${tokenRow.provider} ${column} for account ` +
        `${tokenRow.account_id ?? tokenRow.id}: ${err instanceof Error ? err.message : String(err)}`,
    )
    return null
  }
}

interface RefreshedToken {
  access_token: string
  expires_in: number
  refresh_token?: string
}

/**
 * Dispatch to the provider-specific refresh handler. Explicit per-provider
 * mapping (not a google-or-else ternary) so an unsupported provider fails
 * loudly instead of silently falling into the Microsoft path — the latent
 * bug that let github tokens hit the Microsoft token endpoint.
 */
async function refreshForProvider(
  provider: Provider,
  refreshToken: string,
): Promise<RefreshedToken> {
  switch (provider) {
    case 'google':
      return refreshGoogleToken(refreshToken)
    case 'microsoft':
      return refreshMicrosoftToken(refreshToken)
    case 'hubspot':
      return refreshHubspotToken(refreshToken)
    case 'asana':
      return refreshAsanaToken(refreshToken)
    case 'jira':
      return refreshJiraToken(refreshToken)
    case 'linear':
      return refreshLinearToken(refreshToken)
    case 'brevo':
      return refreshBrevoToken(refreshToken)
    default:
      throw new Error(`No refresh handler for provider: ${provider}`)
  }
}

async function refreshToken(
  supabase: SupabaseClient,
  token: OAuthToken,
): Promise<{ token: string; email: string | null } | null> {
  // The refresh token AS STORED is what the CAS and the reconnect flag compare
  // against (a ciphertext never equals its plaintext, nor another encryption
  // of it); it is decrypted only to be spent.
  const storedRefreshToken = token.refresh_token!
  const spentRefreshToken = openStoredToken(token, 'refresh_token')
  if (!spentRefreshToken) return null
  try {
    const refreshed = await refreshForProvider(token.provider, spentRefreshToken)

    const payload = {
      // Access + refresh land in ONE statement on purpose. Atlassian rotates
      // its refresh token on EVERY use (the one we just spent is dead), so a
      // two-statement write that persisted the access token and then failed
      // would leave the row holding a refresh token that can never be
      // exchanged again — an unrecoverable connection needing a manual
      // reconnect.
      access_token: encryptOAuthToken(refreshed.access_token),
      // Providers (Atlassian always, Microsoft v2.0 often) rotate refresh
      // tokens; persist the new one when returned, otherwise keep the
      // existing value. A legacy row still holding it in plaintext gets it
      // back encrypted, so the row leaves its first refresh fully encrypted.
      ...(refreshed.refresh_token
        ? { refresh_token: encryptOAuthToken(refreshed.refresh_token) }
        : isEncryptedOAuthToken(storedRefreshToken)
          ? {}
          : { refresh_token: encryptOAuthToken(spentRefreshToken) }),
      expires_at: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    }

    await persistRefreshedToken(supabase, token, storedRefreshToken, payload)

    // The grant works, so the connection is healthy: clear any reconnect flag.
    // A separate statement from the token write above, so a missing column
    // (migration 348 not applied yet) can never cost us the token save.
    if (token.account_id) await setReauthRequiredAt(supabase, token.account_id, null)

    return { token: refreshed.access_token, email: token.email }
  } catch (err) {
    console.error(`OAuth token refresh failed for ${token.provider}:`, err)
    if (err instanceof TokenRefreshError && err.definitive) {
      await flagReauthRequired(supabase, token, storedRefreshToken)
    }
    return null
  }
}

// ---------------------------------------------------------------------------
// "Needs reconnect" state (connected_account.reauth_required_at, migration 348)
// ---------------------------------------------------------------------------

/**
 * OAuth `error` codes that mean the grant itself is gone (expired, revoked, or
 * the app was removed), so only a fresh consent fixes it.
 */
const REVOKED_GRANT_ERRORS = new Set([
  'invalid_grant',
  'unauthorized_client',
  'access_denied',
  'invalid_token',
])

/**
 * Whether a token-endpoint refusal is DEFINITIVE (the user has to reconnect)
 * rather than transient (the next call may well succeed).
 *
 *  - 5xx: never definitive, whatever the body says. The provider is unwell.
 *  - 400 / 401: definitive. This is how the providers here answer a dead or
 *    revoked refresh token (Google, Microsoft, Linear: 400 invalid_grant;
 *    HubSpot: 400 BAD_REFRESH_TOKEN; Asana: 400/401).
 *  - Anything else (403, 429, ...): definitive only when the body names a
 *    revoked grant. Atlassian answers a spent rotated token with
 *    403 {"error":"invalid_grant"}.
 *
 * Network errors and timeouts never get here: fetch throws, and that is not a
 * TokenRefreshError.
 */
export function isDefinitiveRefreshFailure(status: number, oauthError: string | null): boolean {
  if (status >= 500) return false
  if (status === 400 || status === 401) return true
  return oauthError !== null && REVOKED_GRANT_ERRORS.has(oauthError)
}

/** A non-OK answer from a provider's token endpoint. */
export class TokenRefreshError extends Error {
  readonly status: number
  readonly oauthError: string | null
  readonly definitive: boolean

  constructor(label: string, status: number, oauthError: string | null) {
    super(`${label} refresh failed: ${status}${oauthError ? ` (${oauthError})` : ''}`)
    this.name = 'TokenRefreshError'
    this.status = status
    this.oauthError = oauthError
    this.definitive = isDefinitiveRefreshFailure(status, oauthError)
  }
}

/**
 * Build the error for a non-OK token-endpoint response, reading the OAuth
 * `error` code from the body when it is JSON (a non-JSON body leaves it null;
 * the status is then the useful part).
 */
async function tokenEndpointFailure(label: string, res: Response): Promise<TokenRefreshError> {
  let oauthError: string | null = null
  try {
    const body = (await res.json()) as { error?: unknown }
    if (typeof body?.error === 'string' && body.error) oauthError = body.error
  } catch {
    // Non-JSON (or unreadable) body.
  }
  return new TokenRefreshError(label, res.status, oauthError)
}

/**
 * Postgres 42703 (undefined_column) or PostgREST PGRST204 (column not in the
 * schema cache): what touching reauth_required_at returns before migration 348
 * is applied.
 */
export function isMissingColumnError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const { code, message } = err as { code?: unknown; message?: unknown }
  if (code === '42703' || code === 'PGRST204') return true
  return (
    typeof message === 'string' &&
    /column/i.test(message) &&
    /(does not exist|could not find)/i.test(message)
  )
}

let warnedMissingReauthColumn = false

/**
 * Set (an ISO timestamp) or clear (null) connected_account.reauth_required_at.
 *
 * Best effort and NEVER throws: an error is logged and swallowed, and a missing
 * column (migration 348 not applied) is logged once per process. Callers keep
 * it out of any statement whose failure matters (the token write, the OAuth
 * callback's account insert).
 *
 * Conditional on the current value, so it only writes a row that needs it:
 * setting keeps the FIRST failure time, and clearing skips healthy rows (the
 * common case on the hot refresh path, which then costs no row write).
 */
export async function setReauthRequiredAt(
  supabase: SupabaseClient,
  accountId: string,
  at: string | null,
): Promise<void> {
  try {
    const base = supabase
      .from('connected_account')
      .update({ reauth_required_at: at })
      .eq('id', accountId)
    const { error } =
      at === null
        ? await base.not('reauth_required_at', 'is', null)
        : await base.is('reauth_required_at', null)
    if (error) logReauthWriteError(error, accountId)
  } catch (err) {
    logReauthWriteError(err, accountId)
  }
}

function logReauthWriteError(err: unknown, accountId: string) {
  if (isMissingColumnError(err)) {
    if (!warnedMissingReauthColumn) {
      warnedMissingReauthColumn = true
      console.warn(
        '[token-manager] connected_account.reauth_required_at is missing (migration 348 ' +
          'not applied yet); skipping the reconnect flag.',
      )
    }
    return
  }
  const message = err instanceof Error ? err.message : (err as { message?: string } | null)?.message
  console.warn(
    `[token-manager] could not write reauth_required_at for account ${accountId}: ` +
      `${message ?? String(err)}`,
  )
}

/**
 * Mark the connection as needing a reconnect after a definitive refresh
 * failure, but only while the token row still holds the refresh token that was
 * just refused (its stored value). If it changed, the user reconnected (or a
 * concurrent refresh rotated it) while this one was in flight, and the
 * connection is fine. An error reading the row also skips the flag: when
 * unsure, don't tell the user to reconnect.
 */
async function flagReauthRequired(
  supabase: SupabaseClient,
  token: OAuthToken,
  storedRefreshToken: string,
): Promise<void> {
  if (!token.account_id) return
  try {
    const { data, error } = await supabase
      .from('user_oauth_tokens')
      .select('id')
      .eq('id', token.id)
      .eq('refresh_token', storedRefreshToken)
      .maybeSingle()
    if (error || !data) return
  } catch {
    return
  }
  await setReauthRequiredAt(supabase, token.account_id, new Date().toISOString())
}

/**
 * Persist the refreshed credentials — CHECKED and COMPARE-AND-SWAPPED.
 *
 * Two failures this guards, both of which used to be invisible because
 * supabase-js does not throw on a failed write and the result was discarded:
 *
 *  - THE WRITE FAILS (PostgREST 5xx, statement timeout, pooler blip). Benign for
 *    a provider with a long-lived refresh token — the next call just refreshes
 *    again — but TERMINAL for Atlassian, which killed the token we just spent
 *    the moment it was exchanged. So it is retried once and, if it still fails,
 *    logged loudly with the account id: the access token in hand is still valid
 *    for ~an hour and Atlassian's 10-minute reuse leeway gives the next call a
 *    chance, so returning it beats failing a call we already paid for.
 *  - A RACING WRITER WON. The update is conditional on the refresh token we
 *    actually spent (its stored value: every write encrypts with a fresh IV,
 *    so a rewritten row never matches), so a concurrent refresh — or an
 *    in-flight refresh landing AFTER the user reconnected (the OAuth callback
 *    UPDATEs this same row) —
 *    matches 0 rows instead of clobbering newer credentials with values derived
 *    from a dead chain. Losing that race is fine: the winner's tokens are newer
 *    than ours, and the access token we return is still good for its full TTL.
 */
async function persistRefreshedToken(
  supabase: SupabaseClient,
  token: OAuthToken,
  storedRefreshToken: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const write = () =>
    supabase
      .from('user_oauth_tokens')
      .update(payload)
      .eq('id', token.id)
      // The CAS: only the row that still holds the token we just spent.
      .eq('refresh_token', storedRefreshToken)
      .select('id')

  let { data, error } = await write()
  if (error) {
    console.warn(
      `[token-manager] persisting the refreshed ${token.provider} token for account ` +
        `${token.account_id ?? token.id} failed (${error.message}); retrying once.`,
    )
    ;({ data, error } = await write())
  }

  if (error) {
    console.error(
      `[token-manager] COULD NOT PERSIST the refreshed ${token.provider} token for account ` +
        `${token.account_id ?? token.id} (${error.message}). ` +
        (refreshTokenRotates(token.provider)
          ? 'This provider ROTATES refresh tokens, so the stored one is already dead — ' +
            'the connection will need a manual reconnect once this access token expires.'
          : 'The stored refresh token is still valid; the next call will refresh again.'),
    )
    return
  }

  if ((data?.length ?? 0) === 0) {
    console.warn(
      `[token-manager] a concurrent writer already replaced the ${token.provider} credentials ` +
        `for account ${token.account_id ?? token.id}; keeping theirs and using the access ` +
        'token just minted.',
    )
  }
}

/**
 * Providers that invalidate the refresh token the moment it is exchanged.
 *
 * The property this gates is persistRefreshedToken's failure MESSAGE, but the
 * reason it is a list rather than a comment is the CAS write above it: for these
 * providers a lost write is unrecoverable (the spent token is already dead), so
 * they are the ones whose persistence has to be conditional on the token we
 * actually spent rather than a blind update.
 */
function refreshTokenRotates(provider: Provider): boolean {
  return provider === 'jira' || provider === 'linear' || provider === 'brevo'
}

async function refreshGoogleToken(refreshToken: string) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })

  if (!res.ok) throw await tokenEndpointFailure('Google', res)
  return res.json() as Promise<{
    access_token: string
    expires_in: number
    refresh_token?: string
  }>
}

async function refreshMicrosoftToken(refreshToken: string) {
  const res = await fetch(
    'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.MICROSOFT_CLIENT_ID!,
        client_secret: process.env.MICROSOFT_CLIENT_SECRET!,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
    },
  )

  if (!res.ok) throw await tokenEndpointFailure('Microsoft', res)
  return res.json() as Promise<{
    access_token: string
    expires_in: number
    refresh_token?: string
  }>
}

async function refreshHubspotToken(refreshToken: string) {
  // Date-versioned token endpoint; access tokens live ~30 min so refresh is a
  // hot path. Refresh tokens don't expire, but HubSpot may return a rotated one
  // — refreshToken() persists it conditionally.
  const res = await fetch('https://api.hubapi.com/oauth/2026-03/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.HUBSPOT_CLIENT_ID!,
      client_secret: process.env.HUBSPOT_CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })

  if (!res.ok) throw await tokenEndpointFailure('HubSpot', res)
  return res.json() as Promise<{
    access_token: string
    expires_in: number
    refresh_token?: string
  }>
}

async function refreshAsanaToken(refreshToken: string) {
  // Asana access tokens live exactly 3600s, so refresh is a hot path. Refresh
  // tokens are long-lived and NOT rotated on every refresh — refreshToken()
  // persists a new one only when the response carries it.
  const res = await fetch('https://app.asana.com/-/oauth_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.ASANA_CLIENT_ID!,
      client_secret: process.env.ASANA_CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })

  if (!res.ok) throw await tokenEndpointFailure('Asana', res)
  return res.json() as Promise<{
    access_token: string
    expires_in: number
    refresh_token?: string
  }>
}

/**
 * Linear refresh — the SECOND rotating one, and the hottest path of the three.
 *
 * Linear access tokens live ~24h (vs Atlassian's 1h), so this fires far less
 * often per connection — but the rotation semantics are Atlassian's: the
 * response carries a NEW refresh_token and the one just sent is spent, with a
 * ~30-minute reuse grace for the concurrency race two lambdas can lose. That is
 * why 'linear' is in refreshTokenRotates() and why the CAS persist applies to it.
 *
 * The practical consequence for CALLERS is the opposite of Jira's: because a
 * Linear token is valid for a full day, a bare 401 from the GraphQL API almost
 * never means "the connection is dead" — it means this token aged out and the
 * next call refreshes. Only a failure HERE is worth surfacing as
 * reconnect_required.
 */
async function refreshLinearToken(refreshToken: string) {
  const res = await fetch('https://api.linear.app/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.LINEAR_CLIENT_ID!,
      client_secret: process.env.LINEAR_CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })

  // Same reasoning as the Jira handler: invalid_grant is the ONE failure a
  // reconnect fixes, and it also means a rotated token was lost, so the error
  // names it (tokenEndpointFailure reads it from the body).
  if (!res.ok) throw await tokenEndpointFailure('Linear', res)
  return res.json() as Promise<{
    access_token: string
    expires_in: number
    refresh_token?: string
  }>
}

/**
 * Brevo refresh — a PUBLIC app (PKCE, config.ts isPkceProvider): client_id
 * and the refresh token, no secret. Access tokens live an hour, refresh
 * tokens 30 days; Brevo may return a new refresh token (its docs: replace the
 * stored one when it does), so it is treated as rotating.
 */
async function refreshBrevoToken(refreshToken: string) {
  const res = await fetch('https://oauth.brevo.com/realms/partner/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.BREVO_CLIENT_ID!,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) throw await tokenEndpointFailure('Brevo', res)
  return res.json() as Promise<{
    access_token: string
    expires_in: number
    refresh_token?: string
  }>
}

/**
 * Atlassian (Jira Cloud) refresh — the ROTATING one.
 *
 * Three things make this different from every sibling above:
 *  - The response ALWAYS carries a brand-new `refresh_token`, and the one we
 *    just sent is dead the moment it's exchanged. refreshToken()'s conditional
 *    spread therefore always fires for jira; dropping it would strand the
 *    connection after exactly one refresh.
 *  - Access tokens live 3600s and the refresh token dies after 90 days of
 *    INACTIVITY, so the refresh path is what keeps a connection alive at all.
 *  - Reusing an already-exchanged refresh token is tolerated for a 10-minute
 *    leeway window (Atlassian's own concurrency allowance, which is exactly the
 *    race two Vercel lambdas can lose). Outside it, the exchange fails
 *    `403 {"error":"invalid_grant"}` — unrecoverable without a full re-consent.
 *    That surfaces here as a throw, which refreshToken() turns into a null
 *    token, which every Jira caller renders as the same reconnect-required
 *    contract Asana uses ('unauthorized' / 'reconnect_required').
 *
 * The body is form-encoded rather than the JSON the docs show; Atlassian's
 * token endpoint accepts both, and form-encoding keeps this handler identical in
 * shape to its siblings.
 */
async function refreshJiraToken(refreshToken: string) {
  const res = await fetch('https://auth.atlassian.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.JIRA_CLIENT_ID!,
      client_secret: process.env.JIRA_CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })

  // Surface invalid_grant explicitly: it is the ONE failure a reconnect fixes
  // and the one worth spotting in logs, since it also means a rotated token
  // was lost (or the user revoked the app). tokenEndpointFailure reads it from
  // the body, and that is what makes this 403 count as definitive.
  if (!res.ok) throw await tokenEndpointFailure('Jira', res)
  return res.json() as Promise<{
    access_token: string
    expires_in: number
    refresh_token?: string
  }>
}
