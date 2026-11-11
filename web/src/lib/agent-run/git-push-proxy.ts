/**
 * The git push gate: the ONLY way a cloud coding run's commits reach GitHub.
 * It is one half of the app's git gate (mounted at GIT_PUSH_PATH); the other
 * half, the read gate (git-read-proxy.ts, which also dispatches between the
 * two: handleGitGate), serves the run's clones, fetches and LFS requests.
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 * A coding run works in a sandbox with a shell. The GitHub credential behind
 * it is the triggering person's OAuth token (repo scope), which can write
 * every branch of the repo, the live (default) branch included. A pre-push
 * hook in the sandbox can't hold a model that sets out to skip it, and a
 * firewall rule can't read which branch a push updates (that is in the
 * request body). So the GitHub token never enters the sandbox, for reads or
 * pushes (agents/coding-agent/sandbox.ts): the sandbox side only ever holds
 * the run's git gate token (git-push-token.ts), and its pushes come here.
 * This works for any repo on any GitHub plan: no branch protection needed.
 *
 * ── What it does ────────────────────────────────────────────────────────────
 * It speaks git's smart-HTTP push protocol (git-receive-pack.ts):
 *   GET  …/git/info/refs?service=git-receive-pack → GitHub's advertisement
 *   POST …/git/git-receive-pack                    → judged, then forwarded
 * The run is the gate token's (git-push-token.ts, HMAC-signed, minted with the
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
 *     (these two are authorizeRun, which the read gate shares)
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
 * LIMIT: the gate judges a push's commands before any of it reaches GitHub,
 * so the whole push is read into memory first, up to MAX_PUSH_BYTES (on
 * Vercel a function's request body limit, 4.5 MB, was lower still). A code
 * change's pack is far below that; a run that commits large binaries gets a
 * refused push.
 */
import { getServiceClient } from '@/lib/admin'
import { apiError, badRequest, forbidden, notFound } from '@/lib/api-errors'
import { buildAgentRunSpec, NOT_LIVE_STATUSES } from './spec-rebuild'
import { extractGitPushToken, verifyGitPushToken, type GitPushTokenClaims } from './git-push-token'
import { judgeReceivePack, parseReceivePackRequest, rejectionReport, wantsReportStatus } from './git-receive-pack'

/**
 * Where the git gate (reads and pushes) is mounted. Twin of GIT_PUSH_PATH in
 * agents/coding-agent/lib/spec-client.ts. (The name predates the read gate.)
 */
export const GIT_PUSH_PATH = '/api/internal/agent-run/git'

/** A run's branches all start here (branchNameFor, ciFixBranch); anything else is never pushed. */
export const RUN_BRANCH_PREFIX = 'dial8/'

/**
 * Cap on a push body read into memory. A code change's pack is far below it;
 * a run that commits large binaries gets a refused push (413).
 */
export const MAX_PUSH_BYTES = 64 * 1024 * 1024

/**
 * What the git gate needs, read server-side from the run: the repo and the
 * GitHub token (reads and pushes), the run's branch and its base (pushes).
 */
export interface PushTarget {
  repoFullName: string
  branchName: string
  baseBranch: string
  githubToken: string
}

/** The git gate's seams (reads and pushes share them). */
export interface GitPushProxyDeps {
  verifyToken: (token: string | null) => GitPushTokenClaims | null
  loadTarget: (claims: GitPushTokenClaims) => Promise<PushTarget | { refused: string }>
  fetchImpl: typeof fetch
}

/** The run's git gate target, or why it gets none. Same build as the sandbox's spec. */
export async function loadPushTarget(claims: GitPushTokenClaims): Promise<PushTarget | { refused: string }> {
  const built = await buildAgentRunSpec(getServiceClient(), { agentRunId: claims.agentRunId, workspaceId: claims.workspaceId })
  if (!built.ok) return { refused: 'this run is not runnable' }
  if (!built.run.status || NOT_LIVE_STATUSES.has(built.run.status)) return { refused: 'this run has ended' }
  const { repoFullName, branchName, baseBranch, githubToken } = built.spec
  return { repoFullName, branchName, baseBranch, githubToken }
}

export const defaultGitGateDeps: GitPushProxyDeps = {
  verifyToken: (t) => verifyGitPushToken(t),
  loadTarget: loadPushTarget,
  fetchImpl: (...args) => fetch(...args),
}

/**
 * The GitHub token as git's HTTP Basic credential, for the gate's upstream
 * requests only (it is not handed to the coding agent or the sandbox).
 */
export function githubAuth(token: string): string {
  return `Basic ${Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')}`
}

/** git expects a git/… user agent on smart HTTP; keep the client's when it is one. */
export function userAgent(request: Request): string {
  const ua = request.headers.get('user-agent') ?? ''
  return /^git\/[\w.\-]+/.test(ua) ? ua.slice(0, 200) : 'git/2.45.0 ni-git-gate'
}

/**
 * A body (a request's, or an upstream answer's) read into memory, or null once
 * it passes `maxBytes` (the read stops there and the rest is cancelled).
 */
export async function readCapped(
  source: { body: ReadableStream<Uint8Array> | null },
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!source.body) return new Uint8Array(0)
  const reader = source.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > maxBytes) {
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

/**
 * Pass GitHub's answer back as git expects it: its status, its content type,
 * `cache-control: no-cache`, and its body STREAMED through (never read into
 * memory: a clone's pack can be large). No other upstream header is relayed
 * (no `www-authenticate`, no `location`). `body` lets the read gate pass the
 * same stream wrapped (git-read-proxy.ts); the push gate always relays
 * GitHub's own body and status as they are.
 */
export function relay(upstream: Response, body: BodyInit | null = upstream.body): Response {
  const headers = new Headers({ 'cache-control': 'no-cache' })
  const type = upstream.headers.get('content-type')
  if (type) headers.set('content-type', type)
  return new Response(body, { status: upstream.status, headers })
}

/** Which push endpoint a path (after GIT_PUSH_PATH) names. */
function endpointOf(segments: string[]): 'info-refs' | 'receive-pack' | null {
  const p = segments.join('/')
  if (p === 'info/refs') return 'info-refs'
  if (p === 'git-receive-pack') return 'receive-pack'
  return null
}

/**
 * Which run a git gate request is for, and its target, checked the same way
 * for a read and a push: the gate token verifies; the run is a live coding
 * run; the run's live repo and branch are still the ones the token was minted
 * for. A Response when the request can't go at all (403: never git's 401,
 * which would make git prompt for a password; 503 when the run can't be read).
 * This covers the gate's OWN refusals; what GitHub answers afterwards is each
 * half's to relay (the push gate relays GitHub's status as it is).
 * Refusals are logged with the run id only, never a token.
 */
export async function authorizeRun(
  request: Request,
  deps: GitPushProxyDeps,
  kind: 'push' | 'read',
): Promise<{ runId: string; target: PushTarget } | Response> {
  const label = kind === 'push' ? 'Push' : 'Fetch'
  const tag = `[git-${kind}]`
  const claims = deps.verifyToken(extractGitPushToken(request))
  if (!claims) return forbidden(`${label} refused: invalid or expired git gate credential`)
  let target: PushTarget | { refused: string }
  try {
    target = await deps.loadTarget(claims)
  } catch (err) {
    console.error(`${tag} could not read the run`, claims.agentRunId, err instanceof Error ? err.message : err)
    return apiError(`${label} refused: the run could not be read`, { status: 503, code: 'RUN_UNREADABLE' })
  }
  if ('refused' in target) {
    console.warn(`${tag} refused`, claims.agentRunId, target.refused)
    return forbidden(`${label} refused: ${target.refused}`)
  }
  if (target.repoFullName.toLowerCase() !== claims.repoFullName.toLowerCase() || target.branchName !== claims.branchName) {
    console.error(`${tag} the run no longer matches its git gate token`, claims.agentRunId)
    return forbidden(`${label} refused: the run's repository or branch changed since it started`)
  }
  return { runId: claims.agentRunId, target }
}

/**
 * Who is pushing, and to what: authorizeRun, then the push-only checks on the
 * shape of the run's branch.
 */
async function authorize(request: Request, deps: GitPushProxyDeps): Promise<PushTarget | Response> {
  const authorized = await authorizeRun(request, deps, 'push')
  if (authorized instanceof Response) return authorized
  const { runId, target } = authorized
  if (!target.branchName.startsWith(RUN_BRANCH_PREFIX) || target.branchName === target.baseBranch) {
    console.error('[git-push] refusing a run whose branch is not a run branch', runId, target.branchName)
    return forbidden('Push refused: this run has no branch of its own')
  }
  return target
}

/**
 * The push half of the gate. It serves only the two push endpoints; the
 * route reaches it through handleGitGate (git-read-proxy.ts), which sends the
 * read endpoints to the read gate and everything else here.
 */
export async function handleGitPush(
  request: Request,
  segments: string[],
  deps: GitPushProxyDeps = defaultGitGateDeps,
): Promise<Response> {
  const endpoint = endpointOf(segments)
  if (!endpoint) return notFound('Not a git gate endpoint')
  const method = request.method.toUpperCase()

  if (endpoint === 'info-refs') {
    if (method !== 'GET') return apiError('Method not allowed', { status: 405, code: 'METHOD_NOT_ALLOWED' })
    if (new URL(request.url).searchParams.get('service') !== 'git-receive-pack') {
      return forbidden('Only git-upload-pack and git-receive-pack are served here')
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

  const body = await readCapped(request, MAX_PUSH_BYTES)
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
