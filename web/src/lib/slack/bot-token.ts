/**
 * The bot token of each Slack team the app is installed in (migration 643,
 * `slack_bot_token`): stored by the install (./install.ts), read for every
 * call the bot makes, refreshed when the Slack app has token rotation on, and
 * deleted when the app is removed (an `app_uninstalled` event, a
 * `tokens_revoked` one after the token is checked, or Disconnect in Settings)
 * or the token is dead for good.
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
 * expires (12 hours) and a refresh token comes with it, which Slack takes
 * once. The web and worker containers both call Slack, so a refresh is made
 * safe across them:
 *   - a token within {@link REFRESH_MARGIN_MS} of expiry is refreshed first,
 *     one refresh at a time per team in this process;
 *   - before redeeming the refresh token a container CLAIMS the row
 *     (`refresh_claimed_until`, a compare and set on the version and a lapsed
 *     claim); only the claimer calls Slack. One that loses the claim reads the
 *     row again a few times for the new version, and meanwhile uses the
 *     current token while it is still valid;
 *   - the new tokens are written only over the version read, clearing the
 *     claim; a write that errors is retried, and if it still fails the new
 *     token is kept in this process until it expires (logged);
 *   - an expired token is never handed out.
 * A token Slack calls dead (DEAD_TOKEN_ERRORS) is renewed once by a forced
 * refresh ({@link renewDeadSlackBotToken}). When there is no refresh token, or
 * Slack definitively refuses the refresh (`invalid_refresh_token`, or any
 * refusal once the token it would replace is dead or expired, with no newer
 * version found), the row is deleted at its version and the team reads as
 * "installation gone": Settings then asks for the app to be added again.
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
const ROW_COLUMNS = 'slack_team_id, bot_token_enc, refresh_token_enc, expires_at, bot_user_id, scopes, version, refresh_claimed_until, installed_at'
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
/** After a refused or lost refresh, the row is read again after each of these waits, looking for another container's write. */
const REREAD_WAITS_MS = [250, 750, 1_500]
/** How long one container's claim on a refresh lasts. */
const CLAIM_MS = 30_000
/** A refreshed token's write that errors is tried again after each of these waits. */
const WRITE_RETRY_WAITS_MS = [200, 600, 1_500]
/** How often an install's save is tried while other writers keep moving the row. */
const SAVE_ATTEMPTS = 4
/** A refresh that failed for these reasons failed on the way, not at Slack's word. */
const TRANSIENT_ERRORS: ReadonlySet<string> = new Set([
  'request_failed',
  'ratelimited',
  'not_configured',
  'bad_answer',
  'internal_error',
  'fatal_error',
  'service_unavailable',
  'request_timeout',
])

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
  refresh_claimed_until: string | null
  installed_at: string
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

function expired(row: TokenRow, now: number): boolean {
  const expires = expiresAtMs(row)
  return expires !== null && expires <= now
}

/** Cache a token for at most `maxMs`, and never into its refresh margin (so never past its expiry). */
function cacheToken(teamId: string, token: string, expiresAt: number | null, now: number, maxMs: number = CACHE_MS): void {
  const until = Math.min(now + maxMs, expiresAt === null ? Infinity : expiresAt - REFRESH_MARGIN_MS)
  if (until > now) cache.set(teamId, { token, until })
  else cache.delete(teamId)
}

/** The row's bot token, decrypted and cached; null when it has expired (an expired token is never handed out). */
function tokenFromRow(teamId: string, row: TokenRow, now: number): string | null {
  if (expired(row, now)) {
    cache.delete(teamId)
    return null
  }
  const token = decryptCredential(row.bot_token_enc)
  cacheToken(teamId, token, expiresAtMs(row), now)
  return token
}

/** Delete the row at the version it was read at (a newer install is never deleted). Best effort. */
async function deleteRowAt(svc: SupabaseClient, teamId: string, version: number): Promise<void> {
  forgetSlackBotToken(teamId)
  try {
    await svc.from(TABLE).delete().eq('slack_team_id', teamId).eq('version', version)
  } catch {
    // The token is unusable either way.
  }
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
  /** When the install happened (ms); now when absent. */
  installedAt?: number
}

/**
 * Store a team's bot token from an install (encrypted), replacing any earlier
 * one and stamping `installed_at`. The version moves on atomically: the row
 * is updated only at the version just read (retried when another writer moved
 * it), or inserted when there is none (retried when another insert won), so a
 * refresh that read the old row can't write over it, nor it over a refresh.
 * True when stored. Never throws.
 */
export async function saveSlackBotToken(svc: SupabaseClient, input: SaveSlackBotTokenInput): Promise<boolean> {
  forgetSlackBotToken(input.teamId)
  try {
    const fields = {
      app_id: input.appId,
      bot_token_enc: encryptCredential(input.botToken),
      refresh_token_enc: input.refreshToken ? encryptCredential(input.refreshToken) : null,
      expires_at: input.expiresAt === null ? null : new Date(input.expiresAt).toISOString(),
      bot_user_id: input.botUserId,
      scopes: input.scopes.slice(0, 1000),
      refresh_claimed_until: null,
      installed_at: new Date(input.installedAt ?? Date.now()).toISOString(),
    }
    for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
      const existing = await readRow(svc, input.teamId)
      if (existing) {
        const { data, error } = await svc
          .from(TABLE)
          .update({ ...fields, version: existing.version + 1 })
          .eq('slack_team_id', input.teamId)
          .eq('version', existing.version)
          .select('version')
        if (error) {
          console.warn('[slack/bot-token] save failed', { teamId: input.teamId, code: error.code })
          return false
        }
        if (Array.isArray(data) && data.length === 1) return true
        continue // another writer moved the row on: read it again
      }
      const { error } = await svc.from(TABLE).insert({ slack_team_id: input.teamId, ...fields, version: 1 })
      if (!error) return true
      if (error.code === '23505') continue // another insert won: update that one
      console.warn('[slack/bot-token] save failed', { teamId: input.teamId, code: error.code })
      return false
    }
    console.warn('[slack/bot-token] save failed: the row kept moving', { teamId: input.teamId })
    return false
  } catch (error) {
    console.warn('[slack/bot-token] save failed', { teamId: input.teamId, error: error instanceof Error ? error.name : 'error' })
    return false
  } finally {
    forgetSlackBotToken(input.teamId)
  }
}

/** What deleting a team's token did. */
export type SlackTokenDeleteOutcome = 'deleted' | 'none' | 'newer' | 'failed'

/**
 * Delete a team's stored token (the app was removed). `installedBefore` (ISO)
 * deletes only a token installed before then: an event from before a new
 * install never deletes the new install's token ('newer'). Never throws.
 */
export async function deleteSlackBotToken(svc: SupabaseClient, teamId: string, opts: { installedBefore?: string } = {}): Promise<SlackTokenDeleteOutcome> {
  forgetSlackBotToken(teamId)
  try {
    let query = svc.from(TABLE).delete().eq('slack_team_id', teamId)
    if (opts.installedBefore) query = query.lt('installed_at', opts.installedBefore)
    const { data, error } = await query.select('slack_team_id')
    if (error) return 'failed'
    if (Array.isArray(data) && data.length > 0) return 'deleted'
    if (!opts.installedBefore) return 'none'
    return (await readRow(svc, teamId)) ? 'newer' : 'none'
  } catch {
    return 'failed'
  }
}

/** Which of these teams have a stored token (the app is installed there). Throws on a failed read. */
export async function teamsWithStoredToken(svc: SupabaseClient, teamIds: readonly string[]): Promise<Set<string>> {
  if (teamIds.length === 0) return new Set()
  const { data, error } = await svc.from(TABLE).select('slack_team_id').in('slack_team_id', [...teamIds])
  if (error) throw new SlackTokenError('slack: bot token read failed')
  return new Set(((data ?? []) as Array<{ slack_team_id: string }>).map((r) => r.slack_team_id))
}

// ── Getting a token ─────────────────────────────────────────────────────────

/**
 * A team's bot token, never an expired one. Throws
 * {@link SlackInstallationGoneError} when none is stored (or the stored one is
 * dead and can't be renewed: its row is then deleted), {@link SlackTokenError}
 * when it can't be read or renewed for now.
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
  return tokenOrRenew(teamId, row, deps, false)
}

/**
 * Slack called `deadToken` dead (DEAD_TOKEN_ERRORS): a token to try once more
 * with. The row's token when it has moved on since; otherwise one forced
 * refresh. No refresh token, or a refresh definitively refused: the row is
 * deleted and this throws {@link SlackInstallationGoneError}.
 */
export async function renewDeadSlackBotToken(teamId: string, deadToken: string, partial: Partial<SlackTokenDeps> = {}): Promise<string> {
  forgetSlackBotToken(teamId)
  const deps = withDefaults(partial)
  const row = await readRow(deps.svc, teamId)
  if (!row) throw new SlackInstallationGoneError()
  const dead = decryptCredential(row.bot_token_enc) === deadToken
  return tokenOrRenew(teamId, row, deps, dead)
}

async function tokenOrRenew(teamId: string, row: TokenRow, deps: SlackTokenDeps, dead: boolean): Promise<string> {
  const now = deps.now()
  const expires = expiresAtMs(row)
  const due = dead || (expires !== null && expires - REFRESH_MARGIN_MS <= now)
  if (!due) {
    const token = tokenFromRow(teamId, row, now)
    if (token) return token
  }
  if (row.refresh_token_enc) return refreshOnce(teamId, row, deps, dead)
  // No way to renew it.
  if (dead || expired(row, now)) {
    await deleteRowAt(deps.svc, teamId, row.version)
    throw new SlackInstallationGoneError()
  }
  const token = tokenFromRow(teamId, row, now)
  if (token) return token
  throw new SlackInstallationGoneError()
}

/** One refresh at a time per team in this process; concurrent callers share it. */
function refreshOnce(teamId: string, row: TokenRow, deps: SlackTokenDeps, dead: boolean): Promise<string> {
  const running = refreshing.get(teamId)
  if (running) return running
  const promise = refresh(teamId, row, deps, dead).finally(() => {
    if (refreshing.get(teamId) === promise) refreshing.delete(teamId)
  })
  refreshing.set(teamId, promise)
  return promise
}

/**
 * Claim the row for one refresh: only at the version read, and only when no
 * other container holds an unexpired claim. True when this container may
 * redeem the refresh token.
 */
async function claimRefresh(svc: SupabaseClient, teamId: string, version: number, now: number): Promise<boolean> {
  try {
    const { data, error } = await svc
      .from(TABLE)
      .update({ refresh_claimed_until: new Date(now + CLAIM_MS).toISOString() })
      .eq('slack_team_id', teamId)
      .eq('version', version)
      .or(`refresh_claimed_until.is.null,refresh_claimed_until.lt."${new Date(now).toISOString()}"`)
      .select('version')
    return !error && Array.isArray(data) && data.length === 1
  } catch {
    return false
  }
}

async function releaseClaim(svc: SupabaseClient, teamId: string, version: number): Promise<void> {
  try {
    await svc.from(TABLE).update({ refresh_claimed_until: null }).eq('slack_team_id', teamId).eq('version', version)
  } catch {
    // It lapses by itself.
  }
}

/** Read the row again after each short wait, for another writer's newer version. Null when none came. */
async function rereadForNewer(teamId: string, row: TokenRow, deps: SlackTokenDeps): Promise<TokenRow | null> {
  for (const wait of REREAD_WAITS_MS) {
    await deps.sleep(wait)
    const fresh = await readRow(deps.svc, teamId)
    if (!fresh) throw new SlackInstallationGoneError()
    if (fresh.version !== row.version) return fresh
  }
  return null
}

/** The current token while it is still valid (and not known dead), tried again after a short while. */
function stillValid(teamId: string, row: TokenRow, deps: SlackTokenDeps, dead: boolean): string | null {
  const now = deps.now()
  if (dead || expired(row, now)) return null
  const token = decryptCredential(row.bot_token_enc)
  cacheToken(teamId, token, null, now, Math.min(RETRY_REFRESH_MS, (expiresAtMs(row) ?? Infinity) - now))
  return token
}

async function refresh(teamId: string, row: TokenRow, deps: SlackTokenDeps, dead: boolean): Promise<string> {
  if (!(await claimRefresh(deps.svc, teamId, row.version, deps.now()))) {
    // Another container is redeeming it: wait for its write.
    const fresh = await rereadForNewer(teamId, row, deps)
    const newer = fresh ? tokenFromRow(teamId, fresh, deps.now()) : null
    if (newer) return newer
    const current = stillValid(teamId, row, deps, dead)
    if (current) return current
    throw new SlackTokenError('slack: the bot token is being renewed elsewhere')
  }

  const answer = await slackOauthAccess({ grant_type: 'refresh_token', refresh_token: decryptCredential(row.refresh_token_enc!) }, { fetch: deps.fetch })
  const grant = answer.ok ? answer.grant : null
  // A refresh answer may leave out token_type; it must carry a token, for this team.
  if (grant && grant.botToken && (grant.tokenType === null || grant.tokenType === 'bot') && (!grant.teamId || grant.teamId === teamId)) {
    return writeRefreshed(teamId, row, grant, grant.botToken, deps)
  }

  const error = answer.ok ? 'bad_grant' : answer.error
  console.warn('[slack/bot-token] refresh refused', { teamId, error })
  await releaseClaim(deps.svc, teamId, row.version)
  const fresh = await rereadForNewer(teamId, row, deps)
  const newer = fresh ? tokenFromRow(teamId, fresh, deps.now()) : null
  if (newer) return newer
  if (TRANSIENT_ERRORS.has(error)) {
    const current = stillValid(teamId, row, deps, dead)
    if (current) return current
    throw new SlackTokenError('slack: the bot token could not be renewed for now')
  }
  // Slack refused it. Definitive when it says the refresh token is no good,
  // or when the token it would replace is dead or expired: nothing works any more.
  if (error === 'invalid_refresh_token' || dead || expired(row, deps.now())) {
    console.warn('[slack/bot-token] token dead and not renewable; removed', { teamId })
    await deleteRowAt(deps.svc, teamId, row.version)
    throw new SlackInstallationGoneError()
  }
  const current = stillValid(teamId, row, deps, dead)
  if (current) return current
  throw new SlackTokenError('slack: the bot token could not be renewed')
}

/**
 * Write a refreshed token over the version that was read, clearing the claim.
 * A write that errors is retried; one that still fails keeps the new token in
 * this process until it expires (the refresh token it came with is spent, so
 * dropping it would lose the team). Zero rows matched: a new install moved
 * the row on, and its token stands.
 */
async function writeRefreshed(teamId: string, row: TokenRow, grant: SlackOAuthGrant, token: string, deps: SlackTokenDeps): Promise<string> {
  const now = deps.now()
  const expiresAt = grant.expiresIn === null ? null : now + grant.expiresIn * 1000
  const patch = {
    bot_token_enc: encryptCredential(token),
    // Slack sends a new refresh token with each refresh; keep the old one if it ever doesn't.
    refresh_token_enc: grant.refreshToken ? encryptCredential(grant.refreshToken) : row.refresh_token_enc,
    expires_at: expiresAt === null ? null : new Date(expiresAt).toISOString(),
    ...(grant.botUserId ? { bot_user_id: grant.botUserId } : {}),
    ...(grant.scopes ? { scopes: grant.scopes } : {}),
    version: row.version + 1,
    refresh_claimed_until: null,
  }
  for (let attempt = 0; attempt <= WRITE_RETRY_WAITS_MS.length; attempt++) {
    if (attempt > 0) await deps.sleep(WRITE_RETRY_WAITS_MS[attempt - 1])
    let result: { data: unknown; error: unknown }
    try {
      result = await deps.svc.from(TABLE).update(patch).eq('slack_team_id', teamId).eq('version', row.version).select('version')
    } catch (error) {
      result = { data: null, error }
    }
    if (result.error) continue
    if (Array.isArray(result.data) && result.data.length === 1) {
      cacheToken(teamId, token, expiresAt, now)
      return token
    }
    const fresh = await readRow(deps.svc, teamId)
    if (!fresh) throw new SlackInstallationGoneError()
    const theirs = tokenFromRow(teamId, fresh, deps.now())
    if (theirs) return theirs
    break
  }
  console.error('[slack/bot-token] refreshed token not stored; kept in this process until it expires', { teamId })
  cache.set(teamId, { token, until: expiresAt === null ? now + CACHE_MS : expiresAt - 1_000 })
  return token
}

// ── Checking and removing an installation ───────────────────────────────────

/**
 * Check a team's installation: a token is stored for it, and Slack's
 * auth.test with that token names the same team. A token Slack calls dead is
 * renewed once (renewDeadSlackBotToken) and checked again. Returns the token,
 * or null when none is stored, it is dead and can't be renewed, or it names
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
  let auth = await slackApi<SlackAuthTest>('auth.test', token, {}, { fetch: partial.fetch })
  if (!auth.ok && DEAD_TOKEN_ERRORS.has(auth.error)) {
    try {
      token = await renewDeadSlackBotToken(teamId, token, partial)
    } catch (error) {
      if (isInstallationGone(error)) return null
      throw error
    }
    auth = await slackApi<SlackAuthTest>('auth.test', token, {}, { fetch: partial.fetch })
    if (!auth.ok && DEAD_TOKEN_ERRORS.has(auth.error)) {
      forgetSlackBotToken(teamId)
      return null
    }
  }
  if (!auth.ok) throw new SlackTokenError(`slack: auth.test failed (${auth.error})`)
  return auth.team_id === teamId ? { token } : null
}

/**
 * Disconnect in Settings: Slack's auth.revoke with the team's bot token, best
 * effort, then the stored row deleted. Per Slack, revoking a bot token does
 * not uninstall the app from the workspace (it stays listed there), and with
 * token rotation it revokes that one access token; what makes the app stop
 * answering is that this app no longer holds a token for the team. 'gone'
 * when none was stored; 'failed' only when the row could not be deleted.
 * Never throws.
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
  return (await deleteSlackBotToken(deps.svc, teamId)) === 'failed' ? 'failed' : 'revoked'
}
