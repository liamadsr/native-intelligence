/**
 * The push credential a coding run's sandbox holds: a signed token that the
 * git push gate (/api/internal/agent-run/git, git-push-proxy.ts) accepts, and
 * nothing else does.
 *
 * Why a token of its own: the sandbox never holds a credential that can write
 * the repo on GitHub. Its GitHub token is brokered for reads only
 * (agents/coding-agent/sandbox.ts), and every push goes to our gate, which
 * pushes with the run's GitHub token only to the run's own branch. The gate
 * needs to know which run is pushing, so the firewall (or, off Vercel, git's
 * config) presents this token.
 *
 * It is NOT a run token: a run token opens the spec route (which hands out the
 * GitHub token), the event route and the outcome route. This one opens only
 * the push gate, and the gate re-reads the run from the database on every
 * request (live status, repo, branch). So even a push token that leaked into
 * the sandbox could do no more than the run itself may: push its own branch
 * while the run is live.
 *
 * Format: base64url(payload).base64url(hmac). The key is the agent-run
 * internal secret (no new env var), with domain separation: the MAC is over
 * `git-push.<payload>`, and a run token's is over the bare payload (base64url
 * never contains a '.'), so neither can ever verify as the other. The payload
 * also carries `purpose: 'git-push'`.
 *
 * It also carries the repo and branch the run's spec named when it was minted
 * (the moment the sandbox was seeded). The gate refuses a push when the run's
 * live spec now names another repo or branch: a project's `github_repo` is
 * member-written, and a run must never push into a repo it wasn't cloned from.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { internalSecret } from './agent-run-token'

/**
 * Lifetime. The firewall carries the token from the sandbox's creation and
 * can't be refreshed, so it has to outlast a long run (or one that waits on a
 * question). The real bound is the run's status, re-read on every push: a
 * settled or canceled run pushes nothing, whatever its token says.
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

/** Mint a run's push token. Throws when the agent-run secret is unset (no run can start then anyway). */
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

/** Verify a push token: its MAC, purpose, shape and expiry. Null on anything else (fail closed). */
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
 * The push token a request presents: HTTP Basic (git's own form: the password
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
