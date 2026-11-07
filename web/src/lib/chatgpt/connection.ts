/**
 * A person's ChatGPT connection (migration 404): the encrypted tokens their
 * "Continue with ChatGPT" consent produced, and a valid access token on
 * demand for AI that runs on their plan (docs/plans/chatgpt-free-tier.md).
 *
 * Server only, service-role client only: the table has no client access.
 *
 * REFRESH IS LEASED. OpenAI rotates refresh tokens, and two servers refreshing
 * with the same one can end the session (refresh_token_reused). So a refresh
 * first takes `refresh_lease_until` with a conditional update; whoever loses
 * waits briefly and reads the winner's new token instead of refreshing too.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { decryptCredential, encryptCredential } from '@/lib/crypto/credentials'
import { CHATGPT_ISSUER, CHATGPT_PLAN_SCOPE, chatGptClient } from './config'
import { ChatGptTokenError, refreshTokens, type ChatGptIdentity, type TokenSet } from './oidc'

export type ConnectionStatus = 'active' | 'exhausted' | 'revoked'

/** Refresh this long before expiry. */
export const REFRESH_BUFFER_MS = 5 * 60 * 1000
const LEASE_MS = 30 * 1000
const LEASE_WAIT_MS = 400
/**
 * How long a caller waits on another caller's refresh: the lease's own
 * length (and a poll), so a slow refresh is waited out rather than answered
 * `busy`. On DEV (10-21) one took 18 s while the network stalled, and every
 * other call in flight failed with 503.
 */
const LEASE_WAIT_TRIES = Math.ceil(LEASE_MS / LEASE_WAIT_MS) + 1

/** Refresh errors that mean the token set is dead: sign in again. */
const DEAD_REFRESH_CODES = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
])

interface ConnectionRow {
  user_id: string
  client_id: string
  access_token_enc: string
  refresh_token_enc: string | null
  expires_at: string
  status: ConnectionStatus
  plan_enabled: boolean
  refresh_lease_until: string | null
}

const COLUMNS =
  'user_id, client_id, access_token_enc, refresh_token_enc, expires_at, status, plan_enabled, refresh_lease_until'

/** The Dial8 user already linked to this ChatGPT account, if any. */
export async function connectedUserId(service: SupabaseClient, sub: string): Promise<string | null> {
  const { data, error } = await service
    .from('chatgpt_connection')
    .select('user_id')
    .eq('issuer', CHATGPT_ISSUER)
    .eq('subject', sub)
    .maybeSingle()
  if (error) throw new Error(`chatgpt_connection lookup failed: ${error.message}`)
  return data?.user_id ?? null
}

/** Store (or replace) a person's connection after a verified sign-in. */
export async function saveConnection(
  service: SupabaseClient,
  input: { userId: string; identity: ChatGptIdentity; clientId: string; tokens: TokenSet },
  now = Date.now(),
): Promise<void> {
  const { userId, identity, clientId, tokens } = input
  const { error } = await service.from('chatgpt_connection').upsert(
    {
      user_id: userId,
      issuer: CHATGPT_ISSUER,
      subject: identity.sub,
      client_id: clientId,
      email: identity.email,
      access_token_enc: encryptCredential(tokens.accessToken),
      refresh_token_enc: tokens.refreshToken ? encryptCredential(tokens.refreshToken) : null,
      expires_at: new Date(now + tokens.expiresIn * 1000).toISOString(),
      scopes: tokens.scopes,
      plan_enabled: tokens.scopes.includes(CHATGPT_PLAN_SCOPE),
      status: 'active',
      exhausted_at: null,
      last_error: null,
      refresh_lease_until: null,
      updated_at: new Date(now).toISOString(),
    },
    { onConflict: 'user_id' },
  )
  if (error) throw new Error(`chatgpt_connection save failed: ${error.message}`)
}

export type AccessTokenResult =
  | { ok: true; accessToken: string; status: Exclude<ConnectionStatus, 'revoked'> }
  | { ok: false; reason: 'not_connected' | 'not_enabled' | 'revoked' | 'refresh_failed' | 'busy' }

/**
 * A valid plan access token for this person, refreshing first when it is
 * within REFRESH_BUFFER_MS of expiry. Never throws for an expected state;
 * the caller turns `ok: false` into "AI stops" (phase 4).
 *
 * An `exhausted` connection still gets its token, with its status: the last
 * call ran out of plan credits, and trying again costs Dial8 nothing (OpenAI
 * refuses while the plan is spent), so a plan that has reset just works.
 * Only `revoked` stops here.
 */
export async function getPlanAccessToken(
  service: SupabaseClient,
  userId: string,
  now: () => number = Date.now,
): Promise<AccessTokenResult> {
  let row = await loadRow(service, userId)
  if (!row) return { ok: false, reason: 'not_connected' }
  if (row.status === 'revoked') return { ok: false, reason: 'revoked' }
  if (!row.plan_enabled) return { ok: false, reason: 'not_enabled' }
  const status = row.status
  if (Date.parse(row.expires_at) - now() > REFRESH_BUFFER_MS) {
    return { ok: true, accessToken: decryptCredential(row.access_token_enc), status }
  }
  if (!row.refresh_token_enc) return { ok: false, reason: 'refresh_failed' }

  // Take the lease, or wait for whoever holds it: for their fresh token, or,
  // when they let go without one (their refresh failed, or they died and the
  // lease ran out), for the lease, to refresh ourselves.
  let leased = await takeLease(service, userId, now())
  for (let i = 0; !leased && i < LEASE_WAIT_TRIES; i++) {
    await new Promise((r) => setTimeout(r, LEASE_WAIT_MS))
    row = await loadRow(service, userId)
    if (!row) return { ok: false, reason: 'not_connected' }
    if (row.status === 'revoked') return { ok: false, reason: 'revoked' }
    if (Date.parse(row.expires_at) - now() > REFRESH_BUFFER_MS) {
      return { ok: true, accessToken: decryptCredential(row.access_token_enc), status: row.status }
    }
    if (!row.refresh_token_enc) return { ok: false, reason: 'refresh_failed' }
    const leaseUntil = row.refresh_lease_until ? Date.parse(row.refresh_lease_until) : 0
    if (leaseUntil < now()) leased = await takeLease(service, userId, now())
  }
  if (!leased) return { ok: false, reason: 'busy' }

  const client = chatGptClient()
  if (!client) {
    await releaseLease(service, userId)
    return { ok: false, reason: 'refresh_failed' }
  }
  try {
    const tokens = await refreshTokens(client, row.client_id, decryptCredential(row.refresh_token_enc))
    const { error } = await service
      .from('chatgpt_connection')
      .update({
        access_token_enc: encryptCredential(tokens.accessToken),
        // Rotating: store the replacement; keep the old one only if none came back.
        refresh_token_enc: tokens.refreshToken ? encryptCredential(tokens.refreshToken) : row.refresh_token_enc,
        expires_at: new Date(now() + tokens.expiresIn * 1000).toISOString(),
        ...(tokens.scopes.length ? { scopes: tokens.scopes, plan_enabled: tokens.scopes.includes(CHATGPT_PLAN_SCOPE) } : {}),
        refresh_lease_until: null,
        last_error: null,
        updated_at: new Date(now()).toISOString(),
      })
      .eq('user_id', userId)
    if (error) throw new Error(`chatgpt_connection refresh save failed: ${error.message}`)
    return { ok: true, accessToken: tokens.accessToken, status }
  } catch (err) {
    const dead = err instanceof ChatGptTokenError && !!err.code && DEAD_REFRESH_CODES.has(err.code)
    await service
      .from('chatgpt_connection')
      .update({
        refresh_lease_until: null,
        last_error: err instanceof Error ? err.message.slice(0, 300) : 'refresh failed',
        ...(dead ? { status: 'revoked' as const } : {}),
        updated_at: new Date(now()).toISOString(),
      })
      .eq('user_id', userId)
    return { ok: false, reason: dead ? 'revoked' : 'refresh_failed' }
  }
}

/** Mark a connection exhausted or revoked (phase 4 calls this when a plan
 *  request fails), or active again once the plan works. */
export async function setConnectionStatus(
  service: SupabaseClient,
  userId: string,
  status: ConnectionStatus,
  lastError: string | null = null,
  now = Date.now(),
): Promise<void> {
  const { error } = await service
    .from('chatgpt_connection')
    .update({
      status,
      exhausted_at: status === 'exhausted' ? new Date(now).toISOString() : null,
      last_error: lastError,
      updated_at: new Date(now).toISOString(),
    })
    .eq('user_id', userId)
  if (error) throw new Error(`chatgpt_connection status update failed: ${error.message}`)
}

async function loadRow(service: SupabaseClient, userId: string): Promise<ConnectionRow | null> {
  const { data, error } = await service.from('chatgpt_connection').select(COLUMNS).eq('user_id', userId).maybeSingle()
  if (error) throw new Error(`chatgpt_connection read failed: ${error.message}`)
  return (data as ConnectionRow | null) ?? null
}

/** Conditional update: only one caller gets a row back. */
async function takeLease(service: SupabaseClient, userId: string, now: number): Promise<boolean> {
  const nowIso = new Date(now).toISOString()
  const { data, error } = await service
    .from('chatgpt_connection')
    .update({ refresh_lease_until: new Date(now + LEASE_MS).toISOString() })
    .eq('user_id', userId)
    .or(`refresh_lease_until.is.null,refresh_lease_until.lt.${nowIso}`)
    .select('user_id')
  if (error) throw new Error(`chatgpt_connection lease failed: ${error.message}`)
  return (data?.length ?? 0) > 0
}

async function releaseLease(service: SupabaseClient, userId: string): Promise<void> {
  await service.from('chatgpt_connection').update({ refresh_lease_until: null }).eq('user_id', userId)
}
