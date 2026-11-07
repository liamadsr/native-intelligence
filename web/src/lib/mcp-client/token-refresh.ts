/**
 * An OAuth MCP server's access token, kept fresh (GEN-1171): the integrations'
 * rules (src/lib/oauth/token-manager.ts) applied to connected apps.
 *
 *   • FROM THE STORED ROW. A caller's row can be minutes old (a chat turn
 *     loads its servers once, then calls them many times), and refreshing from
 *     it spends a refresh token an earlier call already spent: a provider that
 *     rotates them refuses that, and some revoke the whole sign-in for it. So
 *     a refresh starts from the row as stored, under a short lease
 *     (`refresh_lease_until`, migration 451) that one refresh holds, and one
 *     per server in this process at a time. A caller that finds the lease
 *     taken waits for the holder's tokens.
 *   • DEFINITIVE OR NOT. Only the token endpoint's refusal that means the
 *     sign-in is gone (isDefinitiveRefreshFailure: 400/401, or a revoked
 *     grant) marks the server `reauth_required_at`, as for integrations; a
 *     5xx, a timeout or a network error fails this call and leaves the status
 *     alone, and so does an MCP server refusing a token it was just given
 *     (withClient's retry). And only while the row still holds the refresh
 *     token that was refused: if it changed (the person reconnected, another
 *     refresh rotated it), that one is used instead.
 *   • ONCE MARKED, NO MORE TRIES. Every call fails at once with
 *     McpTokenExpiredError until the person reconnects (the OAuth callback
 *     clears the mark), and the mark itself tells them, once
 *     (./expired-notice.ts).
 *   • SAVED COMPARE-AND-SWAP on the refresh token spent, so a refresh landing
 *     after a reconnect never overwrites the new sign-in.
 *
 * The refresh has its own time bound, never a caller's deadline: a caller
 * that gives up stops waiting, and the refresh still lands and is saved (an
 * aborted token request may already have rotated the token at the provider),
 * held open past the response by Next's after().
 *
 * Only a stored row (a uuid id) is refreshed or written: a probe row (the
 * OAuth callback's, the Connect card's) passes through as it is.
 *
 * Every column from 451 is optional here: a write retries without them, and
 * the lease is skipped, so the deploy and the migration land in either order.
 */
import { after } from 'next/server'
import { decryptCredential, decryptCredentialOrNull, encryptCredential } from '@/lib/crypto/credentials'
import { TokenRefreshError } from '@/lib/oauth/token-manager'
import { getServiceClient } from '@/lib/supabase/service'
import { refreshAccessToken, type TokenResponse } from './oauth'
import { isMissingColumnError } from './public-row'
import { isMcpExpiredMessage } from './needs-reconnect'
import type { ConnectedMcpServerRow } from './types'

/**
 * Thrown when an MCP server's OAuth tokens have expired and either no
 * refresh token is on file or the refresh-token grant failed for good. The
 * UI surfaces a "Reconnect" CTA when it sees this code.
 */
export class McpTokenExpiredError extends Error {
  code = 'MCP_TOKEN_EXPIRED' as const
  constructor(public displayName: string, cause?: unknown) {
    super(
      `MCP server "${displayName}" needs to be reconnected — the OAuth token expired and could not be refreshed.`,
    )
    if (cause) (this as { cause?: unknown }).cause = cause
  }
}

/** A refresh that failed for now (a 5xx, a timeout, the network): the sign-in may well be fine. */
export class McpTokenRefreshUnavailableError extends Error {
  constructor(displayName: string, cause?: unknown) {
    super(`Couldn't renew the sign-in for "${displayName}" just now. Try again in a minute.`)
    if (cause) (this as { cause?: unknown }).cause = cause
  }
}

/** A call refreshes a token that expires within this window, so a call never straddles the expiry. */
export const REFRESH_LEEWAY_MS = 5 * 60_000
/** The token request's own bound. */
export const REFRESH_TIMEOUT_MS = 10_000
/** How long a lease holds: longer than the token request, so it never lapses mid-refresh. */
export const REFRESH_LEASE_MS = 20_000
/** How long a caller waits for another refresh's tokens. */
export const LEASE_WAIT_MS = 15_000
const LEASE_POLL_MS = 250

const STORED_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A row from the table (a uuid id), not a probe built for one call. */
export function isStoredMcpServer(server: Pick<ConnectedMcpServerRow, 'id'>): boolean {
  return STORED_ID.test(server.id)
}

type Supabase = ReturnType<typeof getServiceClient>

export interface TokenRefreshDeps {
  supabase?: Supabase
  refresh?: (input: Parameters<typeof refreshAccessToken>[0]) => Promise<TokenResponse>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** The mark just flipped on (once per sign-in): tell the person. Default: ./expired-notice.ts. */
  onMarked?: (server: MarkedServer) => Promise<void>
  /** Hold a refresh its caller gave up on open past the response. Default: Next's after(). */
  defer?: (work: Promise<unknown>) => void
}

export interface EnsureFreshOptions {
  /** The caller's deadline: it stops waiting for the refresh (the refresh itself goes on). */
  signal?: AbortSignal
  /** Refresh even though it looks fresh: the server refused this access token (a 401). */
  force?: boolean
  /** Refresh when it expires within this long (the keep-alive's window). Default REFRESH_LEEWAY_MS. */
  leewayMs?: number
}

/** The fields the notice needs about a server whose mark just flipped on. */
export interface MarkedServer {
  id: string
  user_id: string
  workspace_id: string | null
  display_name: string
  server_url: string
  reauth_required_at: string
}

function expiresAtMs(row: Pick<ConnectedMcpServerRow, 'token_expires_at'>): number | null {
  if (!row.token_expires_at) return null
  const ms = Date.parse(row.token_expires_at)
  return Number.isFinite(ms) ? ms : null
}

/** A token with no expiry counts as fresh: it is refreshed when its server refuses it (withClient's retry). */
function isFresh(row: Pick<ConnectedMcpServerRow, 'token_expires_at'>, leewayMs: number, nowMs: number): boolean {
  const at = expiresAtMs(row)
  return at === null || at > nowMs + leewayMs
}

/** The refreshes running in this process, one per server. */
const inFlight = new Map<string, Promise<ConnectedMcpServerRow>>()

/** Test seam: forget the refreshes in flight. */
export function _resetTokenRefreshForTests(): void {
  inFlight.clear()
  warnedMissingColumns = false
}

/**
 * The server with a usable access token: as it is, or refreshed first (and
 * saved). Throws McpTokenExpiredError when the sign-in is gone (marking it),
 * McpTokenRefreshUnavailableError when the refresh failed for now, and the
 * signal's reason when the caller's deadline passed. Call it BEFORE building
 * the transport.
 */
export async function ensureFreshAccessToken(
  server: ConnectedMcpServerRow,
  opts: EnsureFreshOptions = {},
  deps: TokenRefreshDeps = {},
): Promise<ConnectedMcpServerRow> {
  if (server.auth_type !== 'oauth2' || !isStoredMcpServer(server)) return server
  const leewayMs = opts.leewayMs ?? REFRESH_LEEWAY_MS
  if (server.reauth_required_at) {
    // Marked when this row was read: still marked, or reconnected since?
    const { row } = await readRow(deps.supabase ?? getServiceClient(), server.id)
    if (!row || row.reauth_required_at) throw new McpTokenExpiredError(server.display_name)
    server = row
  }
  if (!opts.force && isFresh(server, leewayMs, deps.now?.() ?? Date.now())) return server
  const flight = joinOrStart(server, { force: opts.force === true, leewayMs }, deps)
  return opts.signal ? untilAborted(flight, opts.signal, deps) : flight
}

async function joinOrStart(
  server: ConnectedMcpServerRow,
  ctx: { force: boolean; leewayMs: number },
  deps: TokenRefreshDeps,
): Promise<ConnectedMcpServerRow> {
  const running = inFlight.get(server.id)
  if (running) {
    const row = await running
    // A forced caller needs a token other than the one its server refused.
    if (!ctx.force || row.access_token_encrypted !== server.access_token_encrypted) return row
  }
  const flight = refreshStored(server, ctx, deps, 0).finally(() => {
    if (inFlight.get(server.id) === flight) inFlight.delete(server.id)
  })
  // A caller that stopped waiting leaves no unhandled rejection behind.
  flight.catch(() => {})
  inFlight.set(server.id, flight)
  return flight
}

/** after() holds the invocation open past the response; outside a request scope (a test, a script) the work just floats. */
function deferAfter(work: Promise<unknown>): void {
  try {
    after(work)
  } catch {
    void work
  }
}

/**
 * The refresh, until the caller's deadline: then the caller gets the signal's
 * reason, and the refresh is handed to `defer` so it still lands and is saved.
 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal, deps: TokenRefreshDeps): Promise<T> {
  const hold = () => (deps.defer ?? deferAfter)(work.catch(() => {}))
  const reason = () => (signal.reason instanceof Error ? signal.reason : new Error('The call was stopped'))
  if (signal.aborted) {
    hold()
    return Promise.reject(reason())
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      hold()
      reject(reason())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (err) => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
  })
}

let warnedMissingColumns = false

function warnMissingColumns() {
  if (warnedMissingColumns) return
  warnedMissingColumns = true
  console.warn('[mcp token] connected_mcp_server.reauth_required_at / refresh_lease_until are missing (migration 451 not applied yet); refreshing without them.')
}

function missing450(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  return isMissingColumnError(error, 'reauth_required_at') || isMissingColumnError(error, 'refresh_lease_until')
}

type ReadResult = { row: ConnectedMcpServerRow | null; gone: boolean }

/** The stored row now; `gone` when it was deleted (disconnected), a null row when the read failed. */
async function readRow(svc: Supabase, id: string): Promise<ReadResult> {
  try {
    const { data, error } = await svc.from('connected_mcp_server').select('*').eq('id', id).maybeSingle<ConnectedMcpServerRow>()
    if (error) return { row: null, gone: false }
    return data ? { row: data, gone: false } : { row: null, gone: true }
  } catch {
    return { row: null, gone: false }
  }
}

type Lease = { state: 'held'; row: ConnectedMcpServerRow; until: string } | { state: 'taken' } | { state: 'none' }

/** Take the server's refresh lease, returning the row as stored when it was free. */
async function takeLease(svc: Supabase, id: string, nowMs: number): Promise<Lease> {
  const until = new Date(nowMs + REFRESH_LEASE_MS).toISOString()
  try {
    const { data, error } = await svc
      .from('connected_mcp_server')
      .update({ refresh_lease_until: until })
      .eq('id', id)
      .or(`refresh_lease_until.is.null,refresh_lease_until.lt.${new Date(nowMs).toISOString()}`)
      .select('*')
    if (error) {
      if (missing450(error)) warnMissingColumns()
      return { state: 'none' }
    }
    const row = Array.isArray(data) ? (data[0] as ConnectedMcpServerRow | undefined) : undefined
    return row ? { state: 'held', row, until } : { state: 'taken' }
  } catch {
    return { state: 'none' }
  }
}

/** Let go of our lease: only ours (fenced on its value), never a later holder's. */
async function releaseLease(svc: Supabase, id: string, until: string): Promise<void> {
  try {
    await svc.from('connected_mcp_server').update({ refresh_lease_until: null }).eq('id', id).eq('refresh_lease_until', until)
  } catch {
    // It lapses on its own in REFRESH_LEASE_MS.
  }
}

/** Is this row's token one the caller can use (not the one its server refused)? */
function usable(row: ConnectedMcpServerRow, caller: ConnectedMcpServerRow, ctx: { force: boolean; leewayMs: number }, nowMs: number): boolean {
  if (ctx.force) return row.access_token_encrypted !== caller.access_token_encrypted && isFresh(row, 0, nowMs)
  return isFresh(row, ctx.leewayMs, nowMs)
}

async function refreshStored(
  caller: ConnectedMcpServerRow,
  ctx: { force: boolean; leewayMs: number },
  deps: TokenRefreshDeps,
  attempt: number,
): Promise<ConnectedMcpServerRow> {
  const svc = deps.supabase ?? getServiceClient()
  const now = () => deps.now?.() ?? Date.now()
  const lease = await takeLease(svc, caller.id, now())
  if (lease.state === 'taken') return waitForHolder(svc, caller, ctx, deps, attempt)

  let row = caller
  if (lease.state === 'held') row = lease.row
  else {
    const read = await readRow(svc, caller.id)
    if (read.gone) throw new Error(`MCP server "${caller.display_name}" is no longer connected`)
    row = read.row ?? caller
  }
  try {
    if (row.reauth_required_at) throw new McpTokenExpiredError(row.display_name)
    // Another refresh (or a reconnect) got there first.
    if (usable(row, caller, ctx, now())) return row

    const spent = row.refresh_token_encrypted
    const meta = (row.oauth_metadata ?? {}) as { token_endpoint?: string; client_id?: string; client_secret?: string; client_secret_encrypted?: string }
    if (!spent || !meta.token_endpoint || !meta.client_id) {
      await markNeedsReconnect(svc, row, spent, deps)
      throw new McpTokenExpiredError(row.display_name)
    }

    let next: TokenResponse
    try {
      next = await (deps.refresh ?? refreshAccessToken)({
        token_endpoint: meta.token_endpoint,
        client_id: meta.client_id,
        // Saved encrypted by the OAuth callback; a plain one is from before that.
        client_secret: decryptCredentialOrNull(meta.client_secret_encrypted) ?? meta.client_secret,
        refresh_token: decryptCredential(spent),
        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      })
    } catch (err) {
      if (!(err instanceof TokenRefreshError) || !err.definitive) {
        console.warn('[mcp token] refresh failed for now:', { server: row.display_name, message: err instanceof Error ? err.message : String(err) })
        throw new McpTokenRefreshUnavailableError(row.display_name, err)
      }
      // Refused for good, unless the stored token changed meanwhile (a reconnect, another refresh).
      const current = await readRow(svc, row.id)
      if (current.row && current.row.refresh_token_encrypted !== spent && !current.row.reauth_required_at) return current.row
      console.warn('[mcp token] refresh refused, needs reconnect:', { server: row.display_name, message: err.message })
      await markNeedsReconnect(svc, row, spent, deps)
      throw new McpTokenExpiredError(row.display_name, err)
    }

    const tokens = {
      access_token_encrypted: encryptCredential(next.access_token),
      // Some providers rotate the refresh token on each refresh; keep whichever one we now hold.
      refresh_token_encrypted: next.refresh_token ? encryptCredential(next.refresh_token) : spent,
      token_expires_at: next.expires_in ? new Date(now() + next.expires_in * 1000).toISOString() : null,
    }
    // An old expired message as the last error goes with the new sign-in.
    await saveTokens(svc, row.id, spent, tokens, isMcpExpiredMessage(row.last_error))
    return { ...row, ...tokens, reauth_required_at: null }
  } finally {
    if (lease.state === 'held') await releaseLease(svc, row.id, lease.until)
  }
}

/** Another refresh holds the lease: its tokens, once saved; one more try of our own if it saved none. */
async function waitForHolder(
  svc: Supabase,
  caller: ConnectedMcpServerRow,
  ctx: { force: boolean; leewayMs: number },
  deps: TokenRefreshDeps,
  attempt: number,
): Promise<ConnectedMcpServerRow> {
  const now = () => deps.now?.() ?? Date.now()
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const until = now() + LEASE_WAIT_MS
  while (now() < until) {
    await sleep(LEASE_POLL_MS)
    const { row, gone } = await readRow(svc, caller.id)
    if (gone) throw new Error(`MCP server "${caller.display_name}" is no longer connected`)
    if (!row) continue
    if (row.reauth_required_at) throw new McpTokenExpiredError(row.display_name)
    if (usable(row, caller, ctx, now())) return row
    const leaseAt = row.refresh_lease_until ? Date.parse(row.refresh_lease_until) : NaN
    // The holder let go with nothing we can use: take it ourselves, once.
    if (!(leaseAt > now())) {
      if (attempt === 0) return refreshStored(caller, ctx, deps, 1)
      break
    }
  }
  throw new McpTokenRefreshUnavailableError(caller.display_name)
}

/**
 * Save refreshed tokens, only while the row still holds the refresh token
 * spent (a reconnect meanwhile wins), clearing the mark (and an expired
 * message as the last error). Retried once; a failed save is logged, and the
 * token in hand still serves this call.
 */
async function saveTokens(
  svc: Supabase,
  id: string,
  spent: string,
  tokens: { access_token_encrypted: string; refresh_token_encrypted: string; token_expires_at: string | null },
  clearExpiredError: boolean,
): Promise<void> {
  const write = async (payload: Record<string, unknown>) => {
    try {
      const { error } = await svc.from('connected_mcp_server').update(payload).eq('id', id).eq('refresh_token_encrypted', spent)
      return error
    } catch (err) {
      return { message: err instanceof Error ? err.message : String(err) }
    }
  }
  const base = { ...tokens, ...(clearExpiredError ? { last_error: null } : {}) }
  for (let i = 0; i < 2; i++) {
    let error = await write({ ...base, reauth_required_at: null })
    if (error && missing450(error)) {
      warnMissingColumns()
      error = await write(base)
    }
    if (!error) return
    if (i === 1) console.error('[mcp token] could not save refreshed tokens:', { server: id, message: error.message })
  }
}

/**
 * Mark the server as needing a reconnect, only while it still holds the
 * refresh token that was refused (none, when it never had one) and is not
 * marked yet. The first mark tells the person (onMarked). Never throws.
 */
async function markNeedsReconnect(svc: Supabase, row: ConnectedMcpServerRow, spent: string | null, deps: TokenRefreshDeps): Promise<void> {
  const at = new Date(deps.now?.() ?? Date.now()).toISOString()
  const lastError = new McpTokenExpiredError(row.display_name).message
  try {
    const base = svc
      .from('connected_mcp_server')
      .update({ reauth_required_at: at, last_error: lastError })
      .eq('id', row.id)
      .is('reauth_required_at', null)
    const scoped = spent ? base.eq('refresh_token_encrypted', spent) : base.is('refresh_token_encrypted', null)
    const { data, error } = await scoped.select('id, user_id, workspace_id, display_name, server_url, reauth_required_at')
    if (error) {
      if (!missing450(error)) {
        console.warn('[mcp token] could not mark needs reconnect:', { server: row.id, message: error.message })
        return
      }
      // Before 451: the last error is the mark (mcpNeedsReconnect reads it); no notice without the column.
      warnMissingColumns()
      const fallback = svc.from('connected_mcp_server').update({ last_error: lastError }).eq('id', row.id)
      await (spent ? fallback.eq('refresh_token_encrypted', spent) : fallback.is('refresh_token_encrypted', null))
      return
    }
    const flipped = Array.isArray(data) ? (data[0] as MarkedServer | undefined) : undefined
    if (!flipped) return
    const onMarked = deps.onMarked ?? (async (server: MarkedServer) => (await import('./expired-notice')).recordMcpReconnectEvent(server))
    await onMarked(flipped).catch((err: unknown) => console.warn('[mcp token] reconnect notice failed:', err instanceof Error ? err.message : String(err)))
  } catch (err) {
    console.warn('[mcp token] could not mark needs reconnect:', { server: row.id, message: err instanceof Error ? err.message : String(err) })
  }
}
