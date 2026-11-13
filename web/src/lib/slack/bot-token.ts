/**
 * The bot token of each Slack team the app is installed in (migration 643,
 * `slack_bot_token`): stored by the install (./install.ts), read for every
 * call the bot makes, refreshed when the Slack app has token rotation on, and
 * deleted when the app is removed (an `app_uninstalled` or `tokens_revoked`
 * event, or Disconnect in Settings).
 *
 * At rest the bot token and the refresh token are encrypted with the helper
 * every other stored credential uses (src/lib/crypto/credentials.ts,
 * CREDENTIAL_ENCRYPTION_KEY). The table is the service role's only. No token
 * is ever logged or put in an error message.
 *
 * In process, a team's token is cached briefly ({@link CACHE_MS}), so a turn's
 * several calls read the row once; {@link forgetSlackBotToken} drops it (a
 * token Slack called dead, a new install, a removal). Other containers keep
 * theirs until it lapses.
 *
 * Token rotation: when Slack's install answer carries `expires_in`, the token
 * expires (12 hours) and a refresh token comes with it. A token within
 * {@link REFRESH_MARGIN_MS} of expiry is refreshed first, with
 * oauth.v2.access and `grant_type=refresh_token`, one refresh at a time per
 * team in this process, and written back only over the version it was read
 * at (compare and set). Another container may refresh the same team at the
 * same moment: whoever writes second finds the row moved on and uses what is
 * there, and when Slack refuses a refresh token another container already
 * spent, the row is read again (a few times, briefly) and the newer token
 * used. A token that is still valid is used when a refresh fails.
 *
 * A team with no stored token is "installation gone" ({@link isInstallationGone}):
 * the app is not in that Slack workspace (never added, or removed).
 */
import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getServiceClient } from '@/lib/admin'
import { decryptCredential, encryptCredential } from '@/lib/crypto/credentials'
import { slackClientId, slackClientSecret } from './config'
import { DEAD_TOKEN_ERRORS, slackApi, type SlackAuthTest } from './web-api'

const TABLE = 'slack_bot_token'
const ROW_COLUMNS = 'slack_team_id, bot_token_enc, refresh_token_enc, expires_at, bot_user_id, scopes, version'
const OAUTH_ACCESS_URL = 'https://slack.com/api/oauth.v2.access'
const TIMEOUT_MS = 8_000
const TEAM_ID = /^T[A-Z0-9]{2,30}$/
const USER_ID = /^[UW][A-Z0-9]{2,30}$/
const APP_ID = /^A[A-Z0-9]{2,30}$/

/** How long a token read from the row is used without reading it again. */
export const CACHE_MS = 60_000
/** A rotating token is refreshed this long before it expires. */
export const REFRESH_MARGIN_MS = 5 * 60_000
/** A refresh that failed while the token is still valid is tried again after this long. */
const RETRY_REFRESH_MS = 30_000
/** After a refused refresh, the row is read again after each of these waits, looking for another container's write. */
const REREAD_WAITS_MS = [250, 750, 1_500]

/** Thrown when no bot token is stored for a team: the app is not (or no longer) installed there. */
export class SlackInstallationGoneError extends Error {
  constructor() {
    super('No Slack bot token is stored for this team: the app is not installed there.')
    this.name = 'SlackInstallationGoneError'
  }
}

/** Thrown when a stored token could not be read or renewed (a transient failure, not a removal). */
export class SlackTokenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SlackTokenError'
  }
}

/** True when the error says the team has no stored token (removed, or never added). */
export function isInstallationGone(error: unknown): boolean {
  return error instanceof SlackInstallationGoneError
}

/** What the token functions use; the defaults are the real ones, tests pass fakes. */
export interface SlackTokenDeps {
  svc: SupabaseClient
  fetch: typeof fetch
  now: () => number
  sleep: (ms: number) => Promise<void>
}

function withDefaults(deps: Partial<SlackTokenDeps>): SlackTokenDeps {
  return {
    svc: deps.svc ?? getServiceClient(),
    fetch: deps.fetch ?? fetch,
    now: deps.now ?? Date.now,
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  }
}

interface TokenRow {
  slack_team_id: string
  bot_token_enc: string
  refresh_token_enc: string | null
  expires_at: string | null
  bot_user_id: string | null
  scopes: string
  version: number
}

// ── Slack's oauth.v2.access ─────────────────────────────────────────────────

/** What a successful oauth.v2.access answer holds (an install, or a refresh). */
export interface SlackOAuthGrant {
  appId: string | null
  teamId: string | null
  teamName: string
  enterpriseId: string | null
  isEnterpriseInstall: boolean
  tokenType: string | null
  botToken: string | null
  refreshToken: string | null
  /** Seconds until the bot token expires; null when the app does not rotate tokens. */
  expiresIn: number | null
  botUserId: string | null
  scopes: string
  /** The Slack user who ran the install. */
  authedUserId: string | null
}

/**
 * One oauth.v2.access call with the app's client id and secret (HTTP Basic,
 * as Slack prefers). `{ ok: false, error }` for Slack's refusal, a network
 * failure (`request_failed`) or a missing setting (`not_configured`). Never
 * throws; never logs what it sent or got.
 */
export async function slackOauthAccess(
  params: Record<string, string>,
  deps: { fetch?: typeof fetch } = {},
): Promise<{ ok: true; grant: SlackOAuthGrant } | { ok: false; error: string }> {
  const clientId = slackClientId()
  const clientSecret = slackClientSecret()
  if (!clientId || !clientSecret) return { ok: false, error: 'not_configured' }
  let body: unknown
  try {
    const res = await (deps.fetch ?? fetch)(OAUTH_ACCESS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (res.status === 429) return { ok: false, error: 'ratelimited' }
    body = await res.json().catch(() => null)
  } catch {
    return { ok: false, error: 'request_failed' }
  }
  return readSlackGrant(body)
}

/** Read an oauth.v2.access answer. Pure; `{ ok: false, error }` with Slack's error code when it refused. */
export function readSlackGrant(body: unknown): { ok: true; grant: SlackOAuthGrant } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'bad_answer' }
  const b = body as Record<string, unknown>
  if (b.ok !== true) return { ok: false, error: typeof b.error === 'string' && /^[a-z0-9_]{1,60}$/.test(b.error) ? b.error : 'unknown_error' }
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null)
  const team = (b.team && typeof b.team === 'object' ? b.team : {}) as Record<string, unknown>
  const enterprise = (b.enterprise && typeof b.enterprise === 'object' ? b.enterprise : {}) as Record<string, unknown>
  const authed = (b.authed_user && typeof b.authed_user === 'object' ? b.authed_user : {}) as Record<string, unknown>
  const teamId = str(team.id)
  const enterpriseId = str(enterprise.id)
  const appId = str(b.app_id)
  const botUserId = str(b.bot_user_id)
  const authedUserId = str(authed.id)
  const expiresIn = typeof b.expires_in === 'number' && Number.isFinite(b.expires_in) && b.expires_in > 0 ? b.expires_in : null
  return {
    ok: true,
    grant: {
      appId: appId && APP_ID.test(appId) ? appId : null,
      teamId: teamId && TEAM_ID.test(teamId) ? teamId : null,
      teamName: (str(team.name) ?? '').slice(0, 200),
      enterpriseId: enterpriseId && /^E[A-Z0-9]{2,30}$/.test(enterpriseId) ? enterpriseId : null,
      isEnterpriseInstall: b.is_enterprise_install === true,
      tokenType: str(b.token_type),
      botToken: str(b.access_token),
      refreshToken: str(b.refresh_token),
      expiresIn,
      botUserId: botUserId && USER_ID.test(botUserId) ? botUserId : null,
      scopes: (str(b.scope) ?? '').slice(0, 1000),
      authedUserId: authedUserId && USER_ID.test(authedUserId) ? authedUserId : null,
    },
  }
}

// ── The stored row ──────────────────────────────────────────────────────────

type Cached = { token: string; until: number }
const cache = new Map<string, Cached>()
const refreshing = new Map<string, Promise<string>>()

/** Drop a team's cached token (Slack called it dead, it was replaced, or removed), so the next call reads the row again. */
export function forgetSlackBotToken(teamId: string): void {
  cache.delete(teamId)
}

async function readRow(svc: SupabaseClient, teamId: string): Promise<TokenRow | null> {
  const { data, error } = await svc.from(TABLE).select(ROW_COLUMNS).eq('slack_team_id', teamId).maybeSingle<TokenRow>()
  if (error) throw new SlackTokenError('slack: bot token read failed')
  return data ?? null
}

function expiresAtMs(row: TokenRow): number | null {
  if (!row.expires_at) return null
  const t = Date.parse(row.expires_at)
  return Number.isFinite(t) ? t : null
}

/** The row's bot token, decrypted, cached until the cache lapses or the refresh margin begins. */
function tokenFromRow(teamId: string, row: TokenRow, now: number): string {
  const token = decryptCredential(row.bot_token_enc)
  const expires = expiresAtMs(row)
  const until = Math.min(now + CACHE_MS, expires === null ? Infinity : expires - REFRESH_MARGIN_MS)
  if (until > now) cache.set(teamId, { token, until })
  else cache.delete(teamId)
  return token
}

export interface SaveSlackBotTokenInput {
  teamId: string
  appId: string
  botToken: string
  refreshToken: string | null
  /** When the bot token expires (ms); null when the app does not rotate tokens. */
  expiresAt: number | null
  botUserId: string | null
  scopes: string
}

/**
 * Store a team's bot token from an install (encrypted), replacing any earlier
 * one; the version moves on, so a refresh that read the old row cannot write
 * over it. True when stored. Never throws.
 */
export async function saveSlackBotToken(svc: SupabaseClient, input: SaveSlackBotTokenInput): Promise<boolean> {
  try {
    const existing = await readRow(svc, input.teamId)
    const { error } = await svc.from(TABLE).upsert(
      {
        slack_team_id: input.teamId,
        app_id: input.appId,
        bot_token_enc: encryptCredential(input.botToken),
        refresh_token_enc: input.refreshToken ? encryptCredential(input.refreshToken) : null,
        expires_at: input.expiresAt === null ? null : new Date(input.expiresAt).toISOString(),
        bot_user_id: input.botUserId,
        scopes: input.scopes.slice(0, 1000),
        version: (existing?.version ?? 0) + 1,
      },
      { onConflict: 'slack_team_id' },
    )
    forgetSlackBotToken(input.teamId)
    if (error) {
      console.warn('[slack/bot-token] save failed', { teamId: input.teamId, code: error.code })
      return false
    }
    return true
  } catch (error) {
    console.warn('[slack/bot-token] save failed', { teamId: input.teamId, error: error instanceof Error ? error.name : 'error' })
    return false
  }
}

/**
 * Delete a team's stored token (the app was removed). `writtenBefore` (ISO)
 * deletes only a row written before then: an event from before a new install
 * never deletes the new install's token. True when nothing failed (a row
 * already gone counts). Never throws.
 */
export async function deleteSlackBotToken(svc: SupabaseClient, teamId: string, opts: { writtenBefore?: string } = {}): Promise<boolean> {
  forgetSlackBotToken(teamId)
  try {
    let query = svc.from(TABLE).delete().eq('slack_team_id', teamId)
    if (opts.writtenBefore) query = query.lt('updated_at', opts.writtenBefore)
    const { error } = await query
    return !error
  } catch {
    return false
  }
}

// ── Getting a token ─────────────────────────────────────────────────────────

/**
 * A team's bot token. Throws {@link SlackInstallationGoneError} when none is
 * stored, {@link SlackTokenError} when it can't be read or renewed.
 */
export async function slackBotToken(teamId: string, partial: Partial<SlackTokenDeps> = {}): Promise<string> {
  const now = (partial.now ?? Date.now)()
  const hit = cache.get(teamId)
  if (hit && hit.until > now) return hit.token
  const deps = withDefaults(partial)
  const row = await readRow(deps.svc, teamId)
  if (!row) {
    cache.delete(teamId)
    throw new SlackInstallationGoneError()
  }
  const expires = expiresAtMs(row)
  if (expires !== null && row.refresh_token_enc && expires - REFRESH_MARGIN_MS <= now) {
    return refreshOnce(teamId, row, deps)
  }
  return tokenFromRow(teamId, row, now)
}

/** One refresh at a time per team in this process; concurrent callers share it. */
function refreshOnce(teamId: string, row: TokenRow, deps: SlackTokenDeps): Promise<string> {
  const running = refreshing.get(teamId)
  if (running) return running
  const promise = refresh(teamId, row, deps).finally(() => {
    if (refreshing.get(teamId) === promise) refreshing.delete(teamId)
  })
  refreshing.set(teamId, promise)
  return promise
}

async function refresh(teamId: string, row: TokenRow, deps: SlackTokenDeps): Promise<string> {
  const answer = await slackOauthAccess({ grant_type: 'refresh_token', refresh_token: decryptCredential(row.refresh_token_enc!) }, { fetch: deps.fetch })
  const grant = answer.ok ? answer.grant : null
  if (grant && grant.tokenType === 'bot' && grant.botToken && (!grant.teamId || grant.teamId === teamId)) {
    const now = deps.now()
    const { data, error } = await deps.svc
      .from(TABLE)
      .update({
        bot_token_enc: encryptCredential(grant.botToken),
        // Slack sends a new refresh token with each refresh; keep the old one if it ever doesn't.
        refresh_token_enc: grant.refreshToken ? encryptCredential(grant.refreshToken) : row.refresh_token_enc,
        expires_at: grant.expiresIn === null ? null : new Date(now + grant.expiresIn * 1000).toISOString(),
        ...(grant.botUserId ? { bot_user_id: grant.botUserId } : {}),
        ...(grant.scopes ? { scopes: grant.scopes } : {}),
        version: row.version + 1,
      })
      .eq('slack_team_id', teamId)
      .eq('version', row.version)
      .select('version')
    if (!error && Array.isArray(data) && data.length === 1) {
      cache.set(teamId, { token: grant.botToken, until: Math.min(now + CACHE_MS, grant.expiresIn === null ? Infinity : now + grant.expiresIn * 1000 - REFRESH_MARGIN_MS) })
      return grant.botToken
    }
    // Another writer moved the row on first (a refresh elsewhere, or a new install): theirs stands.
    const fresh = await readRow(deps.svc, teamId)
    if (!fresh) throw new SlackInstallationGoneError()
    return tokenFromRow(teamId, fresh, deps.now())
  }

  // Refused (often: another container spent this refresh token first) or unreachable.
  console.warn('[slack/bot-token] refresh refused', { teamId, error: answer.ok ? 'bad_grant' : answer.error })
  for (const wait of REREAD_WAITS_MS) {
    await deps.sleep(wait)
    const fresh = await readRow(deps.svc, teamId)
    if (!fresh) throw new SlackInstallationGoneError()
    if (fresh.version !== row.version) return tokenFromRow(teamId, fresh, deps.now())
  }
  const expires = expiresAtMs(row)
  const now = deps.now()
  if (expires !== null && expires > now) {
    // Not renewed, but still valid: use it, and try again after a short while (not on every call).
    const token = decryptCredential(row.bot_token_enc)
    cache.set(teamId, { token, until: Math.min(now + RETRY_REFRESH_MS, expires) })
    return token
  }
  throw new SlackTokenError('slack: the bot token expired and could not be renewed')
}

// ── Checking and removing an installation ───────────────────────────────────

/**
 * Check a team's installation before binding it: a token is stored for it,
 * and Slack's auth.test with that token names the same team. Returns the
 * token, or null when none is stored, Slack calls it dead, or it names
 * another team. Throws when Slack could not be asked.
 */
export async function verifySlackInstallation(teamId: string, partial: Partial<SlackTokenDeps> = {}): Promise<{ token: string } | null> {
  let token: string
  try {
    token = await slackBotToken(teamId, partial)
  } catch (error) {
    if (isInstallationGone(error)) return null
    throw error
  }
  const auth = await slackApi<SlackAuthTest>('auth.test', token, {}, { fetch: partial.fetch })
  if (!auth.ok) {
    if (DEAD_TOKEN_ERRORS.has(auth.error)) {
      forgetSlackBotToken(teamId)
      return null
    }
    throw new SlackTokenError(`slack: auth.test failed (${auth.error})`)
  }
  return auth.team_id === teamId ? { token } : null
}

/**
 * Remove the app's token for a team (Disconnect in Settings): Slack's
 * auth.revoke with it, best effort, then the stored row deleted. 'gone' when
 * none was stored; 'failed' only when the row could not be deleted. Never throws.
 */
export async function revokeSlackBotToken(teamId: string, partial: Partial<SlackTokenDeps> = {}): Promise<'revoked' | 'gone' | 'failed'> {
  let deps: SlackTokenDeps
  try {
    deps = withDefaults(partial)
  } catch {
    return 'failed'
  }
  let token: string | null = null
  try {
    token = await slackBotToken(teamId, deps)
  } catch (error) {
    if (isInstallationGone(error)) return 'gone'
    // A token that can't be read or renewed is still deleted below.
  }
  if (token) {
    const revoked = await slackApi<{ revoked?: boolean }>('auth.revoke', token, {}, { fetch: deps.fetch })
    if (!revoked.ok && !DEAD_TOKEN_ERRORS.has(revoked.error)) console.warn('[slack/bot-token] auth.revoke failed', { teamId, error: revoked.error })
  }
  return (await deleteSlackBotToken(deps.svc, teamId)) ? 'revoked' : 'failed'
}
