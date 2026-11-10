/**
 * The git push gate: the ONLY way a cloud coding run's commits reach GitHub.
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 * A coding run works in a Vercel Sandbox with a shell. Its GitHub credential is
 * the triggering person's OAuth token (repo scope), which can write every
 * branch of the repo, the live (default) branch included. A pre-push hook in
 * the sandbox can't hold a model that sets out to skip it, and a firewall rule
 * can't read which branch a push updates (that is in the request body). So
 * the sandbox no longer holds a credential that can push at all
 * (agents/coding-agent/sandbox.ts brokers the GitHub token for READS only),
 * and its pushes come here instead. This works for any repo on any GitHub
 * plan: no branch protection needed.
 *
 * ── What it does ────────────────────────────────────────────────────────────
 * It speaks git's smart-HTTP push protocol (git-receive-pack.ts):
 *   GET  …/git/info/refs?service=git-receive-pack → GitHub's advertisement
 *   POST …/git/git-receive-pack                    → judged, then forwarded
 * The run is the push token's (git-push-token.ts, HMAC-signed, minted with the
 * run's spec); everything else is read from the database on every request
 * with the same build the sandbox was seeded from (buildAgentRunSpec): the
 * repo, the run's branch, its base, the GitHub token. Nothing in the request
 * (its path, a header, the model, a text message) names the repo or the
 * branch.
 *
 * A push goes through only when:
 *   - the token verifies and the run is a live coding run (a settled or
 *     canceled run pushes nothing);
 *   - the run's live repo and branch are still the ones the token was minted
 *     for (a member re-pointing the project's repo mid-run pushes nothing);
 *   - the run's branch is a run branch (`dial8/…`) and isn't its base;
 *   - EVERY ref update in it is `refs/heads/<the run's branch>` and none
 *     deletes it, and it carries no push options (a section the gate would
 *     forward unread). One refused update refuses the whole push, answered as git's
 *     own "[remote rejected]" so the model reads why.
 * Anything it can't read is refused (fail closed). A force update of the
 * run's OWN branch is not refused: that branch is the run's to rewrite, a PR's
 * merge is pinned to the head the person approved (a moved head is shown
 * again, never merged), and the default branch is out of reach either way.
 *
 * The person's yes merges on our server with their token (website approval,
 * the outcome route's reviewed fast-forward), never through here.
 *
 * LIMIT: the pack passes through a Vercel Function, so a push is bounded by its
 * request body limit (4.5 MB on Vercel). A code change's pack is far below
 * that; a run that commits large binaries gets a refused push.
 */
import { getServiceClient } from '@/lib/admin'
import { apiError, badRequest, forbidden, notFound } from '@/lib/api-errors'
import { buildAgentRunSpec, NOT_LIVE_STATUSES } from './spec-rebuild'
import { extractGitPushToken, verifyGitPushToken, type GitPushTokenClaims } from './git-push-token'
import { judgeReceivePack, parseReceivePackRequest, rejectionReport, wantsReportStatus } from './git-receive-pack'

/** Where the gate is mounted. Twin of GIT_PUSH_PATH in agents/coding-agent/lib/spec-client.ts. */
export const GIT_PUSH_PATH = '/api/internal/agent-run/git'

/** A run's branches all start here (branchNameFor, ciFixBranch); anything else is never pushed. */
export const RUN_BRANCH_PREFIX = 'dial8/'

/** Cap on a push body read into memory (Vercel's own request limit is lower). */
export const MAX_PUSH_BYTES = 64 * 1024 * 1024

/** What a push needs, read server-side from the run. */
export interface PushTarget {
  repoFullName: string
  branchName: string
  baseBranch: string
  githubToken: string
}

export interface GitPushProxyDeps {
  verifyToken: (token: string | null) => GitPushTokenClaims | null
  loadTarget: (claims: GitPushTokenClaims) => Promise<PushTarget | { refused: string }>
  fetchImpl: typeof fetch
}

/** The run's push target, or why it can't push. Same build as the sandbox's spec. */
export async function loadPushTarget(claims: GitPushTokenClaims): Promise<PushTarget | { refused: string }> {
  const built = await buildAgentRunSpec(getServiceClient(), { agentRunId: claims.agentRunId, workspaceId: claims.workspaceId })
  if (!built.ok) return { refused: 'this run is not runnable' }
  if (!built.run.status || NOT_LIVE_STATUSES.has(built.run.status)) return { refused: 'this run has ended' }
  const { repoFullName, branchName, baseBranch, githubToken } = built.spec
  return { repoFullName, branchName, baseBranch, githubToken }
}

const defaultDeps: GitPushProxyDeps = {
  verifyToken: (t) => verifyGitPushToken(t),
  loadTarget: loadPushTarget,
  fetchImpl: (...args) => fetch(...args),
}

function githubAuth(token: string): string {
  return `Basic ${Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')}`
}

/** git expects a git/… user agent on smart HTTP; keep the client's when it is one. */
function userAgent(request: Request): string {
  const ua = request.headers.get('user-agent') ?? ''
  return /^git\/[\w.\-]+/.test(ua) ? ua.slice(0, 200) : 'git/2.45.0 ni-push-gate'
}

async function readCapped(request: Request): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!request.body) return new Uint8Array(0)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > MAX_PUSH_BYTES) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

/** Pass GitHub's answer back as git expects it (status, type, streamed body). */
function relay(upstream: Response): Response {
  const headers = new Headers({ 'cache-control': 'no-cache' })
  const type = upstream.headers.get('content-type')
  if (type) headers.set('content-type', type)
  return new Response(upstream.body, { status: upstream.status, headers })
}

/** Which gate endpoint a path (after GIT_PUSH_PATH) names. */
function endpointOf(segments: string[]): 'info-refs' | 'receive-pack' | null {
  const p = segments.join('/')
  if (p === 'info/refs') return 'info-refs'
  if (p === 'git-receive-pack') return 'receive-pack'
  return null
}

/**
 * Who is pushing, and to what. A Response when the push can't go at all
 * (403: never git's 401, which would make git prompt for a password).
 */
async function authorize(request: Request, deps: GitPushProxyDeps): Promise<PushTarget | Response> {
  const claims = deps.verifyToken(extractGitPushToken(request))
  if (!claims) return forbidden('Push refused: invalid or expired push credential')
  let target: PushTarget | { refused: string }
  try {
    target = await deps.loadTarget(claims)
  } catch (err) {
    console.error('[git-push] could not read the run', claims.agentRunId, err instanceof Error ? err.message : err)
    return apiError('Push refused: the run could not be read', { status: 503, code: 'RUN_UNREADABLE' })
  }
  if ('refused' in target) return forbidden(`Push refused: ${target.refused}`)
  if (target.repoFullName.toLowerCase() !== claims.repoFullName.toLowerCase() || target.branchName !== claims.branchName) {
    console.error('[git-push] the run no longer matches its push token', claims.agentRunId)
    return forbidden("Push refused: the run's repository or branch changed since it started")
  }
  if (!target.branchName.startsWith(RUN_BRANCH_PREFIX) || target.branchName === target.baseBranch) {
    console.error('[git-push] refusing a run whose branch is not a run branch', claims.agentRunId, target.branchName)
    return forbidden('Push refused: this run has no branch of its own')
  }
  return target
}

export async function handleGitPush(
  request: Request,
  segments: string[],
  deps: GitPushProxyDeps = defaultDeps,
): Promise<Response> {
  const endpoint = endpointOf(segments)
  if (!endpoint) return notFound('Only git push is served here')
  const method = request.method.toUpperCase()

  if (endpoint === 'info-refs') {
    if (method !== 'GET') return apiError('Method not allowed', { status: 405, code: 'METHOD_NOT_ALLOWED' })
    if (new URL(request.url).searchParams.get('service') !== 'git-receive-pack') {
      return forbidden('Only git push is served here; fetch from GitHub directly')
    }
    const target = await authorize(request, deps)
    if (target instanceof Response) return target
    const upstream = await deps
      .fetchImpl(`https://github.com/${target.repoFullName}.git/info/refs?service=git-receive-pack`, {
        method: 'GET',
        headers: { authorization: githubAuth(target.githubToken), 'user-agent': userAgent(request), accept: '*/*' },
        redirect: 'error',
      })
      .catch(() => null)
    if (!upstream) return apiError('GitHub could not be reached', { status: 502, code: 'UPSTREAM' })
    return relay(upstream)
  }

  if (method !== 'POST') return apiError('Method not allowed', { status: 405, code: 'METHOD_NOT_ALLOWED' })
  const encoding = (request.headers.get('content-encoding') ?? 'identity').toLowerCase()
  if (encoding !== 'identity') return badRequest('Push refused: compressed push bodies are not supported')
  const target = await authorize(request, deps)
  if (target instanceof Response) return target

  const body = await readCapped(request)
  if (!body) return apiError('Push refused: the push is too large', { status: 413, code: 'TOO_LARGE' })
  const parsed = parseReceivePackRequest(body)
  if (!parsed.ok) return badRequest(`Push refused: ${parsed.reason}`)
  // git's auth probe before a large push: nothing to update.
  if (parsed.probe) {
    return new Response(null, { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-result', 'cache-control': 'no-cache' } })
  }

  const verdict = judgeReceivePack(parsed.commands, target.branchName)
  if (!verdict.allowed) {
    console.warn('[git-push] refused', target.repoFullName, verdict.rejections.map((r) => r.ref).join(', '))
    if (!wantsReportStatus(parsed.capabilities)) return forbidden(`Push refused: ${verdict.rejections[0].reason}`)
    return new Response(rejectionReport(verdict.rejections, parsed.capabilities), {
      status: 200,
      headers: { 'content-type': 'application/x-git-receive-pack-result', 'cache-control': 'no-cache' },
    })
  }

  const upstream = await deps
    .fetchImpl(`https://github.com/${target.repoFullName}.git/git-receive-pack`, {
      method: 'POST',
      headers: {
        authorization: githubAuth(target.githubToken),
        'content-type': 'application/x-git-receive-pack-request',
        accept: 'application/x-git-receive-pack-result',
        'user-agent': userAgent(request),
      },
      body,
      redirect: 'error',
    })
    .catch(() => null)
  if (!upstream) return apiError('GitHub could not be reached', { status: 502, code: 'UPSTREAM' })
  return relay(upstream)
}
