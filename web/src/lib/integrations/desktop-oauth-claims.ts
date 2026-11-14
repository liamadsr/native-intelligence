/**
 * The desktop OAuth claim secrets this window is holding (security review
 * 2026-10-31, P0-2).
 *
 * A desktop connect finishes in the system browser, so the callback hands the
 * provider's code back to the app by deep link (dial8desktop://oauth/complete)
 * instead of exchanging it. Only the window that started the connect may claim
 * it: the authorize route gave that window a secret (whose hash is signed into
 * the state), and the claim route exchanges the code only for that secret plus
 * the signed-in user the state names.
 *
 * Module state is per webview, so the secret lives only in the window that
 * started the connect. Every window hears the deep link (the OAuth branch of
 * the deep-link handler is ungated); a window without the secret ignores it.
 * Keyed by the exact signed state string the deep link carries back. Taking
 * an entry removes it: a code is claimed at most once from here.
 */
import { parseSlackInstallResult, type SlackInstallResult } from '@/lib/slack/install-result'

/** How long a started connect waits for its deep link (matches the state's 10-minute life). */
const CLAIM_TTL_MS = 10 * 60 * 1000

interface PendingClaim {
  claimSecret: string
  at: number
}

const pending = new Map<string, PendingClaim>()

function prune(now: number) {
  for (const [state, claim] of pending) {
    if (now - claim.at > CLAIM_TTL_MS) pending.delete(state)
  }
}

/** Remember the claim secret for a desktop connect this window started. */
export function holdDesktopOAuthClaim(state: string, claimSecret: string): void {
  const now = Date.now()
  prune(now)
  pending.set(state, { claimSecret, at: now })
}

/** The claim secret for this state, removed as it is taken; null when this window didn't start it. */
export function takeDesktopOAuthClaim(state: string): string | null {
  const now = Date.now()
  prune(now)
  const claim = pending.get(state)
  if (!claim) return null
  pending.delete(state)
  return claim.claimSecret
}

/** What the deep-link handler reports once a claim settles (the OAuth callback event's shape). */
export interface DesktopOAuthClaimOutcome {
  success: boolean
  provider: string
  capability: string
  error?: string
}

/**
 * Finish a desktop connect from its `dial8desktop://oauth/complete` deep link:
 * null when this window didn't start it (another window, or a link nobody
 * started here — never claimed), else the claim route's outcome. `sealed` is
 * the provider's code as the callback sealed it; only the server opens it.
 */
export async function claimDesktopOAuth(
  link: { provider: string; capability: string; sealed: string; state: string },
  fetchImpl: typeof fetch = fetch,
): Promise<DesktopOAuthClaimOutcome | null> {
  const claimSecret = takeDesktopOAuthClaim(link.state)
  if (!claimSecret) return null
  const failed = (error: string): DesktopOAuthClaimOutcome => ({
    success: false,
    provider: link.provider,
    capability: link.capability,
    error,
  })
  try {
    const res = await fetchImpl(`/api/oauth/${encodeURIComponent(link.provider)}/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sealed: link.sealed, state: link.state, claimSecret }),
    })
    const body = (await res.json().catch(() => null)) as
      | { success?: boolean; provider?: string; capability?: string; error?: string }
      | null
    if (!res.ok || !body?.success) return failed(body?.error || `claim_failed_${res.status}`)
    return {
      success: true,
      provider: body.provider || link.provider,
      capability: body.capability || link.capability,
    }
  } catch {
    return failed('claim_failed')
  }
}

// ── MCP connectors (the same idea for their own flow) ──────────────────────
//
// An MCP connector's desktop connect returns as dial8desktop://mcp-oauth/
// complete?code&state. The start route gave this window the state and its
// claim secret (src/lib/integrations/start-mcp-oauth.ts); the claim route
// completes it only for that secret and the row's own signed-in person
// (src/lib/mcp-client/oauth-binding.ts). Kept apart from the integration
// claims: different routes, different shapes.

const pendingMcp = new Map<string, PendingClaim>()

/**
 * How long a held MCP claim stays claimable: the server's row life plus its
 * claim grace (src/lib/mcp-client/oauth-binding.ts MCP_FLOW_MAX_MS, 10 + 5
 * minutes; not imported, which would bring server crypto into the bundle).
 */
const MCP_CLAIM_TTL_MS = 15 * 60 * 1000

/** Remember the claim secret for a desktop MCP connect this window started. */
export function holdDesktopMcpClaim(state: string, claimSecret: string): void {
  const now = Date.now()
  for (const [s, claim] of pendingMcp) if (now - claim.at > MCP_CLAIM_TTL_MS) pendingMcp.delete(s)
  pendingMcp.set(state, { claimSecret, at: now })
}

function takeDesktopMcpClaim(state: string): string | null {
  const claim = pendingMcp.get(state)
  pendingMcp.delete(state)
  if (!claim || Date.now() - claim.at > MCP_CLAIM_TTL_MS) return null
  return claim.claimSecret
}

/** How a desktop MCP connect ended, for the connect hook (navigation-events.ts McpOAuthCallbackDetail). */
export interface DesktopMcpClaimOutcome {
  state: string
  success: boolean
  name?: string
  error?: string
}

/**
 * Finish a desktop MCP connect from its deep link: null when this window
 * didn't start it (never claimed). An error link (`error` set, no code) for
 * this window's flow ends it without a claim. `onClaiming` runs once the claim
 * is this window's to make, before the (possibly slow) claim request.
 */
export async function claimDesktopMcp(
  link: { state: string; code?: string | null; error?: string | null },
  fetchImpl: typeof fetch = fetch,
  onClaiming?: () => void,
): Promise<DesktopMcpClaimOutcome | null> {
  const claimSecret = takeDesktopMcpClaim(link.state)
  if (!claimSecret) return null
  const { state } = link
  if (!link.code) return { state, success: false, error: link.error || 'The connection was not completed' }
  onClaiming?.()
  try {
    const res = await fetchImpl('/api/account/mcp-servers/oauth/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: link.code, state: link.state, claim_secret: claimSecret }),
    })
    const body = (await res.json().catch(() => null)) as { success?: boolean; name?: string; error?: string } | null
    if (!res.ok || !body?.success) return { state, success: false, error: body?.error || `claim_failed_${res.status}` }
    return { state, success: true, name: body.name }
  } catch {
    return { state, success: false, error: 'claim_failed' }
  }
}

// ── Slack's install (the same idea for its own flow) ───────────────────────
//
// "Add to Slack" in the desktop app returns as dial8desktop://slack/complete
// ?sealed&state (or slack/error?error&state). The install route gave this
// window the state and its claim secret (src/app/api/account/integrations/
// slack/install/route.ts); POST /api/slack/oauth/claim finishes it only for
// that secret and the state's own signed-in person. Kept apart from the
// other two: a different route, a different answer.

const pendingSlack = new Map<string, PendingClaim>()

/**
 * How long a held Slack claim stays claimable: the state's 10 minutes plus
 * the claim grace of 5 (src/lib/oauth/state.ts OAUTH_STATE_TTL_MS and
 * CLAIM_GRACE_MS; not imported, which would bring server crypto into the bundle).
 */
const SLACK_CLAIM_TTL_MS = 15 * 60 * 1000

/** Remember the claim secret for a desktop Slack install this window started. */
export function holdDesktopSlackClaim(state: string, claimSecret: string): void {
  const now = Date.now()
  for (const [s, claim] of pendingSlack) if (now - claim.at > SLACK_CLAIM_TTL_MS) pendingSlack.delete(s)
  pendingSlack.set(state, { claimSecret, at: now })
}

/** Forget a held Slack claim: Slack's page never opened, so nothing can come back for it. */
export function dropDesktopSlackClaim(state: string): void {
  pendingSlack.delete(state)
}

function takeDesktopSlackClaim(state: string): string | null {
  const claim = pendingSlack.get(state)
  pendingSlack.delete(state)
  if (!claim || Date.now() - claim.at > SLACK_CLAIM_TTL_MS) return null
  return claim.claimSecret
}

/** How a desktop Slack install ended (navigation-events.ts SlackInstallCallbackDetail). */
export interface DesktopSlackClaimOutcome {
  state: string
  result: SlackInstallResult
}

/**
 * Finish a desktop Slack install from its deep link: null when this window
 * didn't start it (never claimed). A link without a sealed code (Slack
 * refused, or the callback did) ends this window's install without a claim,
 * as cancelled or failed: the only two things the callback says that way. Any
 * app on the machine can open a link, so a link's own word is never taken for
 * more than that; good news is only ever what the claim route answers.
 */
export async function claimDesktopSlackInstall(
  link: { state: string; sealed?: string | null; error?: SlackInstallResult | null },
  fetchImpl: typeof fetch = fetch,
): Promise<DesktopSlackClaimOutcome | null> {
  const claimSecret = takeDesktopSlackClaim(link.state)
  if (!claimSecret) return null
  const { state } = link
  if (!link.sealed) return { state, result: link.error === 'denied' ? 'denied' : 'failed' }
  try {
    const res = await fetchImpl('/api/slack/oauth/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sealed: link.sealed, state, claimSecret }),
    })
    const body = (await res.json().catch(() => null)) as { result?: unknown } | null
    return { state, result: parseSlackInstallResult(typeof body?.result === 'string' ? body.result : null) ?? 'failed' }
  } catch {
    return { state, result: 'failed' }
  }
}

/** Tests only. */
export function resetDesktopOAuthClaimsForTests(): void {
  pending.clear()
  pendingMcp.clear()
  pendingSlack.clear()
}
