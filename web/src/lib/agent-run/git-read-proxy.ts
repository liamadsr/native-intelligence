/**
 * The git read gate: the ONLY way a cloud coding run's sandbox reads its repo
 * from GitHub (clone, fetch, LFS). The other half of the app's git gate is the
 * push gate (git-push-proxy.ts); both are mounted at GIT_PUSH_PATH and
 * handleGitGate below sends each request to its half.
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 * The GitHub token behind a run is the triggering person's OAuth token (repo
 * scope): it can write every branch of the repo. It never leaves the app. The
 * sandbox side only ever holds the run's git gate token (git-push-token.ts),
 * which opens nothing on GitHub and only the gate here; the gate adds the
 * GitHub token server-side. So no sandbox provider (with or without credential
 * injection) needs the GitHub token, and none is handed it.
 *
 * ── What it serves ──────────────────────────────────────────────────────────
 *   GET  …/git/info/refs?service=git-upload-pack → GitHub's same path (clone/fetch advertisement)
 *   POST …/git/git-upload-pack                   → GitHub's same path (clone, fetch)
 *   POST …/git/info/lfs/objects/batch            → GitHub's same path (LFS batch API)
 *   POST …/git/info/lfs/locks/verify             → GitHub's same path (git-lfs's pre-push lock check)
 * Each with exactly that method; anything else here is the push gate's to
 * answer (404 for a path it doesn't serve either).
 *
 * The run is the gate token's; the repo and the GitHub token are read from the
 * database on every request with the same build the sandbox was seeded from
 * (loadPushTarget → buildAgentRunSpec). Nothing in the request (its path, a
 * header, the body) names the repo.
 *
 * A read goes through only when (authorizeRun, shared with the push gate):
 *   - the token verifies and the run is a live coding run (a settled or
 *     canceled run reads nothing);
 *   - the run's live repo and branch are still the ones the token was minted
 *     for (a member re-pointing the project's repo mid-run reads nothing).
 * The push gate's checks on the branch's shape (a `dial8/…` branch that isn't
 * its base) are not applied: a read moves no ref. Refusals are 403, never
 * git's 401 (which would make git prompt), and logged with the run id only.
 * Anything unreadable is refused (fail closed).
 *
 * What goes upstream: the run's GitHub token as HTTP Basic, a `git/…` user
 * agent, and ONLY these request headers from the client: `Git-Protocol` (git's
 * protocol v2 rides it), `Content-Type`, `Content-Encoding` (git may gzip an
 * upload-pack request: the bytes are forwarded untouched, GitHub reads them)
 * and `Accept`. Never the client's `Authorization` (the gate token stays here),
 * cookies, or anything else. Every upstream fetch is `redirect: 'error'`.
 * What comes back: GitHub's status, content type and `cache-control:
 * no-cache`, with its body STREAMED through (relay): a clone's pack can be
 * large, and the gate never holds it.
 *
 * ACCEPTED: the LFS batch endpoint forwards whatever operation the body names,
 * `download` AND `upload` (as the hosted sandbox's firewall rule did before the
 * gate: it could not read a body either, and git-lfs needs `upload` to push an
 * LFS repo's objects). An `upload` batch answers with upload actions, so a run
 * can store LFS objects in the repo's LFS storage. That moves no ref: nothing
 * reaches a branch, let alone the live one, except through the push gate.
 * `locks/verify` only LISTS the repo's LFS locks (ours and others') and
 * changes nothing; anonymous, it fails and git-lfs aborts the push of a private
 * LFS repo. No other LFS lock endpoint (create, unlock) is served.
 */
import { apiError, badRequest, notFound } from '@/lib/api-errors'
import {
  authorizeRun,
  defaultGitGateDeps,
  githubAuth,
  handleGitPush,
  readCapped,
  relay,
  userAgent,
  type GitPushProxyDeps,
} from './git-push-proxy'

/**
 * Cap on an upload-pack REQUEST body (the client's wants, haves, shallow and
 * filter lines: about 50 bytes a line; the pack comes back in the response,
 * which is streamed and has no cap). A shallow clone sends a few hundred
 * bytes; a fetch's negotiation re-sends its haves each round (git stops after
 * a few hundred in vain), and a fetch of every tag of a large repo wants tens
 * of thousands of refs: still well under 8 MB. The bytes may be gzipped, so
 * this caps what the gate holds in memory, not what GitHub inflates.
 */
export const MAX_UPLOAD_PACK_REQUEST_BYTES = 8 * 1024 * 1024

/**
 * Cap on an LFS request body (JSON). git-lfs batches at most 100 objects a
 * request by default (about 100 bytes each); a lock check sends a ref name. A
 * megabyte is ten times anything git-lfs sends.
 */
export const MAX_LFS_REQUEST_BYTES = 1024 * 1024

/** The client request headers forwarded to GitHub, and nothing else (lower-case). */
export const FORWARDED_READ_HEADERS = ['git-protocol', 'content-type', 'content-encoding', 'accept'] as const

/** A forwarded header longer than this is refused (git's own values are a few dozen characters). */
const MAX_FORWARDED_HEADER_CHARS = 1024

type ReadEndpoint = 'upload-pack-refs' | 'upload-pack' | 'lfs-batch' | 'lfs-locks-verify'

/** Each read endpoint: its one method, its path at GitHub (under `<repo>.git/`), its body cap. */
const READ_ENDPOINTS: Record<ReadEndpoint, { method: 'GET' | 'POST'; upstreamPath: string; maxBodyBytes: number }> = {
  'upload-pack-refs': { method: 'GET', upstreamPath: 'info/refs?service=git-upload-pack', maxBodyBytes: 0 },
  'upload-pack': { method: 'POST', upstreamPath: 'git-upload-pack', maxBodyBytes: MAX_UPLOAD_PACK_REQUEST_BYTES },
  'lfs-batch': { method: 'POST', upstreamPath: 'info/lfs/objects/batch', maxBodyBytes: MAX_LFS_REQUEST_BYTES },
  'lfs-locks-verify': { method: 'POST', upstreamPath: 'info/lfs/locks/verify', maxBodyBytes: MAX_LFS_REQUEST_BYTES },
}

/**
 * Which read endpoint a request names (its path after GIT_PUSH_PATH, and for
 * `info/refs` the `service`), or null when it names none (a push endpoint, or
 * nothing the gate serves).
 */
export function readEndpointOf(request: Request, segments: string[]): ReadEndpoint | null {
  const p = segments.join('/')
  if (p === 'info/refs') {
    return new URL(request.url).searchParams.get('service') === 'git-upload-pack' ? 'upload-pack-refs' : null
  }
  if (p === 'git-upload-pack') return 'upload-pack'
  if (p === 'info/lfs/objects/batch') return 'lfs-batch'
  if (p === 'info/lfs/locks/verify') return 'lfs-locks-verify'
  return null
}

/** The whitelisted client headers, or null when one is too long to be git's. */
function forwardedHeaders(request: Request): Record<string, string> | null {
  const out: Record<string, string> = {}
  for (const name of FORWARDED_READ_HEADERS) {
    const value = request.headers.get(name)
    if (value === null) continue
    if (value.length > MAX_FORWARDED_HEADER_CHARS) return null
    out[name] = value
  }
  return out
}

/** The read half of the gate (see this file's header). */
export async function handleGitRead(
  request: Request,
  segments: string[],
  deps: GitPushProxyDeps = defaultGitGateDeps,
): Promise<Response> {
  const endpoint = readEndpointOf(request, segments)
  if (!endpoint) return notFound('Not a git gate endpoint')
  const spec = READ_ENDPOINTS[endpoint]
  if (request.method.toUpperCase() !== spec.method) {
    return apiError('Method not allowed', { status: 405, code: 'METHOD_NOT_ALLOWED' })
  }
  const clientHeaders = forwardedHeaders(request)
  if (!clientHeaders) return badRequest('Fetch refused: a request header is too long')

  const authorized = await authorizeRun(request, deps, 'read')
  if (authorized instanceof Response) return authorized
  const { target } = authorized

  let body: Uint8Array<ArrayBuffer> | undefined
  if (spec.method === 'POST') {
    const read = await readCapped(request, spec.maxBodyBytes)
    if (!read) return apiError('Fetch refused: the request is too large', { status: 413, code: 'TOO_LARGE' })
    body = read
  }

  const upstream = await deps
    .fetchImpl(`https://github.com/${target.repoFullName}.git/${spec.upstreamPath}`, {
      method: spec.method,
      // The client's whitelisted headers first, so neither can replace these two.
      headers: { ...clientHeaders, authorization: githubAuth(target.githubToken), 'user-agent': userAgent(request) },
      ...(body ? { body } : {}),
      redirect: 'error',
    })
    .catch(() => null)
  if (!upstream) return apiError('GitHub could not be reached', { status: 502, code: 'UPSTREAM' })
  return relay(upstream)
}

/**
 * The whole git gate, as the route serves it: the four read endpoints go to
 * the read gate, everything else to the push gate (which serves its two
 * endpoints and refuses the rest exactly as it always has).
 */
export async function handleGitGate(
  request: Request,
  segments: string[],
  deps: GitPushProxyDeps = defaultGitGateDeps,
): Promise<Response> {
  if (readEndpointOf(request, segments)) return handleGitRead(request, segments, deps)
  return handleGitPush(request, segments, deps)
}
