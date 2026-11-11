/**
 * The git gate token: the ONE credential a coding run's sandbox side holds for
 * git. The app's git gate (/api/internal/agent-run/git) accepts it on its read
 * endpoints (clone, fetch, LFS: git-read-proxy.ts) and its push endpoints
 * (git-push-proxy.ts), and nothing else does. (Named "push token" in code: it
 * predates the read gate.)
 *
 * Why a token of its own: the GitHub token behind a run (the triggering
 * person's, repo scope) is not handed to the coding agent, any network policy
 * or the sandbox (and the read gate refuses an LFS answer that contains it),
 * so nothing in the sandbox can write the repo on GitHub, or read a private
 * one, except through the gate. The gate
 * needs to know which run is asking, so the hosted sandbox's firewall (or, on
 * any other provider, git's config for the gate URL only) presents this token,
 * and the gate adds the GitHub token server-side.
 *
 * It is NOT a run token: a run token opens the spec route, the event route and
 * the outcome route. This one opens only the git gate, and the gate re-reads
 * the run from the database on every request (live status, repo, branch). So
 * even a gate token that leaked into the sandbox could do no more than the run
 * itself may: read its own repo and push its own branch, while the run is
 * live. (Reading the repo includes the LFS batch API, which also answers
 * `upload` batches: see git-read-proxy.ts. No ref moves except through the
 * push gate.)
 *
 * Format: base64url(payload).base64url(hmac). The key is the agent-run
 * internal secret (no new env var), with domain separation: the MAC is over
 * `git-push.<payload>`, and a run token's is over the bare payload (base64url
 * never contains a '.'), so neither can ever verify as the other. The payload
 * also carries `purpose: 'git-push'`.
 *
 * It also carries the repo and branch the run's spec named when it was minted
 * (the moment the sandbox was seeded). The gate refuses a read or a push when
 * the run's live spec now names another repo or branch: a project's
 * `github_repo` is member-written, and a run must never read or push a repo it
 * wasn't cloned from.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { internalSecret } from './agent-run-token'

/**
 * Lifetime. The firewall (or git's config) carries the token from the
 * sandbox's creation and can't be refreshed, so it has to outlast a long run
 * (or one that waits on a question). The real bound is the run's status,
 * re-read on every gate request: a settled or canceled run reads and pushes
 * nothing, whatever its token says.
 */
export const GIT_PUSH_TOKEN_TTL_MS = 6 * 60 * 60 * 1000

const PURPOSE = 'git-push'
const MAC_PREFIX = `${PURPOSE}.`

export interface GitPushTokenClaims {
  agentRunId: string
  workspaceId: string
  /** The run's repo ("owner/repo") when the token was minted. */
  repoFullName: string
  /** The run's branch when the token was minted. */
  branchName: string
  exp: number
}

type MintClaims = Omit<GitPushTokenClaims, 'exp'>

function mac(payloadB64: string, secret: string): string {
  return createHmac('sha256', secret).update(`${MAC_PREFIX}${payloadB64}`).digest('base64url')
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = new Uint8Array(Buffer.from(a, 'utf8'))
  const bb = new Uint8Array(Buffer.from(b, 'utf8'))
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/** Mint a run's git gate token. Throws when the agent-run secret is unset (no run can start then anyway). */
export function mintGitPushToken(claims: MintClaims, now = Date.now()): string {
  const secret = internalSecret()
  if (!secret) throw new Error('[git-push] AGENT_RUN_INTERNAL_SECRET is not set: cannot mint a push token')
  const payload = {
    purpose: PURPOSE,
    agentRunId: claims.agentRunId,
    workspaceId: claims.workspaceId,
    repoFullName: claims.repoFullName,
    branchName: claims.branchName,
    exp: now + GIT_PUSH_TOKEN_TTL_MS,
  }
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return `${payloadB64}.${mac(payloadB64, secret)}`
}

/** Verify a git gate token: its MAC, purpose, shape and expiry. Null on anything else (fail closed). */
export function verifyGitPushToken(token: string | null | undefined, now = Date.now()): GitPushTokenClaims | null {
  const secret = internalSecret()
  if (!secret) return null
  if (typeof token !== 'string' || token.length === 0 || token.length > 2048) return null
  const dot = token.indexOf('.')
  if (dot <= 0 || dot !== token.lastIndexOf('.') || dot === token.length - 1) return null
  const payloadB64 = token.slice(0, dot)
  if (!constantTimeEqual(token.slice(dot + 1), mac(payloadB64, secret))) return null
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as Record<string, unknown>
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  if (raw.purpose !== PURPOSE) return null
  if (typeof raw.agentRunId !== 'string' || !raw.agentRunId) return null
  if (typeof raw.workspaceId !== 'string' || !raw.workspaceId) return null
  if (typeof raw.repoFullName !== 'string' || !raw.repoFullName) return null
  if (typeof raw.branchName !== 'string' || !raw.branchName) return null
  if (typeof raw.exp !== 'number' || raw.exp <= now) return null
  return {
    agentRunId: raw.agentRunId,
    workspaceId: raw.workspaceId,
    repoFullName: raw.repoFullName,
    branchName: raw.branchName,
    exp: raw.exp,
  }
}

/**
 * The git gate token a request presents: HTTP Basic (git's own form: the password
 * is the token, the user name is ignored) or a Bearer header. Null otherwise.
 */
export function extractGitPushToken(request: Request): string | null {
  const h = request.headers.get('authorization')
  if (!h) return null
  if (h.startsWith('Bearer ')) return h.slice(7).trim() || null
  if (h.startsWith('Basic ')) {
    const decoded = Buffer.from(h.slice(6).trim(), 'base64').toString('utf8')
    const colon = decoded.indexOf(':')
    if (colon < 0) return null
    return decoded.slice(colon + 1) || null
  }
  return null
}
