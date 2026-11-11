/**
 * The git read gate: the ONLY way a cloud coding run's sandbox reads its repo
 * from GitHub (clone, fetch, LFS). The other half of the app's git gate is the
 * push gate (git-push-proxy.ts); both are mounted at GIT_PUSH_PATH and
 * handleGitGate below sends each request to its half.
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 * The GitHub token behind a run is the triggering person's OAuth token (repo
 * scope): it can write every branch of the repo. It is not handed to the
 * coding agent (the spec route drops it), to any sandbox network policy, or to
 * the sandbox: the sandbox side only ever holds the run's git gate token
 * (git-push-token.ts), which opens nothing on GitHub and only the gate here;
 * the gate adds the GitHub token server-side. And the gate refuses an LFS
 * answer from GitHub that contains it (below). So no sandbox provider, with or
 * without credential injection, needs the GitHub token.
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
 *     for (a member re-pointing the project's repo mid-run reads nothing);
 *   - the run has fewer than READS_PER_RUN reads in flight in this process
 *     (else 429).
 * The push gate's checks on the branch's shape (a `dial8/…` branch that isn't
 * its base) are not applied: a read moves no ref. Anything unreadable is
 * refused (fail closed); refusals are logged with the run id only.
 *
 * NEVER A 401: the read gate never answers git with a 401 (git would prompt
 * for a password). Its own refusals are 403, and a 401 from GitHub (GitHub
 * refused the person's credential: a revoked or expired connection) is turned
 * into a 403 too. (The push gate relays GitHub's statuses as they are.)
 *
 * What goes upstream: the run's GitHub token as HTTP Basic, a `git/…` user
 * agent, and ONLY these request headers from the client: `Git-Protocol` (git's
 * protocol v2 rides it), `Content-Type`, `Content-Encoding` (git may gzip an
 * upload-pack request: the bytes are forwarded untouched, GitHub reads them)
 * and `Accept`. Never the client's `Authorization` (the gate token stays here),
 * cookies, or anything else. The client's abort signal goes with it, so a
 * client that goes away ends the GitHub request. Redirects are never followed
 * (`redirect: 'manual'`): a 3xx (a renamed or transferred repository) is a 502
 * saying so, and its `location` is never relayed.
 *
 * What comes back: GitHub's status, content type and `cache-control:
 * no-cache`, nothing else (no `www-authenticate`, no `location`).
 *   - info/refs and upload-pack: the body is STREAMED through (a clone's pack
 *     is binary and can be large; the gate never holds it).
 *   - the two LFS endpoints: the answer is read whole, up to
 *     MAX_LFS_ANSWER_BYTES, and refused (502, nothing of it sent) when it
 *     contains the run's GitHub token, raw or as its Basic credential. NOT
 *     checked: the other credentials a batch answer carries, GitHub's own
 *     short-lived links and headers for its LFS storage (the object
 *     transfers), as before the gate.
 *
 * WHAT BOUNDS A READ: at most READS_PER_RUN in flight per run (a slot is held
 * from authorization until the answer's body has ended, failed or been
 * cancelled, or the client went away, and for READ_SLOT_MAX_AGE_MS at most),
 * each request body by its cap, and the client's abort. A slow trickle from
 * GitHub is not cut by time here: after READ_SLOT_MAX_AGE_MS it only stops
 * counting against the run.
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
 * this caps what the gate holds in memory for ONE request, not what GitHub
 * inflates; READS_PER_RUN bounds how many such requests a run has at once.
 */
export const MAX_UPLOAD_PACK_REQUEST_BYTES = 8 * 1024 * 1024

/**
 * Cap on an LFS request body (JSON). git-lfs batches at most 100 objects a
 * request by default (about 100 bytes each); a lock check sends a ref name. A
 * megabyte is ten times anything git-lfs sends.
 */
export const MAX_LFS_REQUEST_BYTES = 1024 * 1024

/**
 * Cap on an LFS ANSWER, which the gate reads whole to check it for the GitHub
 * token. A batch answer for git-lfs's default 100 objects carries one action
 * each (a signed link and its headers, about a kilobyte): some 100-200 KB. A
 * lock check lists the repo's locks a page at a time. 4 MB is well over ten
 * times either; a bigger answer is refused (502), never streamed unchecked.
 */
export const MAX_LFS_ANSWER_BYTES = 4 * 1024 * 1024

/** Reads one run may have in flight at once in this process (beyond it: 429). */
export const READS_PER_RUN = 4

/**
 * A slot is given back after this long whatever became of its read: as long as
 * the hosted sandbox itself may live. A read still going then only stops being
 * counted; one whose slot nothing would ever have released stops holding the
 * run out of the gate.
 */
export const READ_SLOT_MAX_AGE_MS = 30 * 60 * 1000

/** The client request headers forwarded to GitHub, and nothing else (lower-case). */
export const FORWARDED_READ_HEADERS = ['git-protocol', 'content-type', 'content-encoding', 'accept'] as const

/** A forwarded header longer than this is refused (git's own values are a few dozen characters). */
const MAX_FORWARDED_HEADER_CHARS = 1024

type ReadEndpoint = 'upload-pack-refs' | 'upload-pack' | 'lfs-batch' | 'lfs-locks-verify'

/** Each read endpoint: its one method, its path at GitHub (under `<repo>.git/`), its body cap. */
const READ_ENDPOINTS: Record<ReadEndpoint, { method: 'GET' | 'POST'; upstreamPath: string; maxBodyBytes: number; lfs: boolean }> = {
  'upload-pack-refs': { method: 'GET', upstreamPath: 'info/refs?service=git-upload-pack', maxBodyBytes: 0, lfs: false },
  'upload-pack': { method: 'POST', upstreamPath: 'git-upload-pack', maxBodyBytes: MAX_UPLOAD_PACK_REQUEST_BYTES, lfs: false },
  'lfs-batch': { method: 'POST', upstreamPath: 'info/lfs/objects/batch', maxBodyBytes: MAX_LFS_REQUEST_BYTES, lfs: true },
  'lfs-locks-verify': { method: 'POST', upstreamPath: 'info/lfs/locks/verify', maxBodyBytes: MAX_LFS_REQUEST_BYTES, lfs: true },
}

/**
 * The reads each run has in flight. One per process (the default); tests pass
 * their own. A slot's release is idempotent, so the several ways a read can
 * end (body ended, failed, cancelled, client gone) can all call it.
 */
export class ReadSlots {
  private readonly inFlight = new Map<string, number>()

  constructor(
    private readonly perRun: number = READS_PER_RUN,
    private readonly maxAgeMs: number = READ_SLOT_MAX_AGE_MS,
  ) {}

  /** A release function, or null when the run already has `perRun` reads in flight. */
  acquire(runId: string): (() => void) | null {
    const n = this.inFlight.get(runId) ?? 0
    if (n >= this.perRun) return null
    this.inFlight.set(runId, n + 1)
    let released = false
    const release = () => {
      if (released) return
      released = true
      clearTimeout(expiry)
      const left = (this.inFlight.get(runId) ?? 1) - 1
      if (left <= 0) this.inFlight.delete(runId)
      else this.inFlight.set(runId, left)
    }
    // A slot nothing ever gives back (a read whose answer is neither read to
    // its end nor cancelled, with no abort from the client) comes back by
    // itself, so a run can never lock itself out of the gate for good.
    const expiry = setTimeout(release, this.maxAgeMs)
    expiry.unref?.()
    return release
  }

  /** Reads in flight for a run (for tests and diagnostics). */
  count(runId: string): number {
    return this.inFlight.get(runId) ?? 0
  }
}

const processReadSlots = new ReadSlots()

/** The read gate's seams: the git gate's, plus the slot table (one per process by default). */
export type GitReadDeps = GitPushProxyDeps & { readSlots?: ReadSlots }

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

/**
 * Whether `bytes` carry the GitHub token: raw, or as the base64 of its Basic
 * credential (`x-access-token:<token>`, as githubAuth builds it), plain or
 * with JSON's escaped slashes.
 */
export function carriesGithubToken(bytes: Uint8Array, githubToken: string): boolean {
  if (!githubToken) return false
  const text = Buffer.from(bytes).toString('latin1')
  const basic = githubAuth(githubToken).slice('Basic '.length)
  return [githubToken, basic, basic.split('/').join('\\/')].some((needle) => text.includes(needle))
}

/**
 * The same stream, releasing the read's slot when it ends, fails or is
 * cancelled (pull-based: nothing is read ahead of the client).
 */
function releasingStream(body: ReadableStream<Uint8Array>, release: () => void): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          release()
          controller.close()
          return
        }
        controller.enqueue(value)
      } catch (err) {
        release()
        controller.error(err)
      }
    },
    async cancel(reason) {
      release()
      await reader.cancel(reason).catch(() => {})
    },
  })
}

const NULL_BODY_STATUSES = new Set([204, 205, 304])

/** The read half of the gate (see this file's header). */
export async function handleGitRead(
  request: Request,
  segments: string[],
  deps: GitReadDeps = defaultGitGateDeps,
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
  const { runId, target } = authorized

  const release = (deps.readSlots ?? processReadSlots).acquire(runId)
  if (!release) {
    console.warn('[git-read] refused: too many reads in flight', runId)
    return apiError('Fetch refused: this run has too many git reads in flight; try again', { status: 429, code: 'TOO_MANY_READS' })
  }
  // A client that goes away frees its slot even if nothing reads or cancels the answer.
  request.signal?.addEventListener('abort', release, { once: true })

  let handedOff = false
  try {
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
        redirect: 'manual',
        signal: request.signal,
      })
      .catch(() => null)
    if (!upstream) return apiError('GitHub could not be reached', { status: 502, code: 'UPSTREAM' })

    if (upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel().catch(() => {})
      console.warn('[git-read] GitHub redirected the read: the repository moved', runId)
      return apiError(
        "Fetch refused: GitHub says this repository has moved or been renamed. Update the project's GitHub repository setting, then start the run again.",
        { status: 502, code: 'REPO_MOVED' },
      )
    }
    if (upstream.status === 401) {
      await upstream.body?.cancel().catch(() => {})
      console.warn("[git-read] GitHub refused the person's credential", runId)
      return apiError(
        "Fetch refused: GitHub refused the GitHub connection of the person who started the run (for example it was revoked or has expired). Reconnect GitHub, then start the run again.",
        { status: 403, code: 'GITHUB_CREDENTIAL_REFUSED' },
      )
    }

    if (spec.lfs) {
      const answer = await readCapped(upstream, MAX_LFS_ANSWER_BYTES)
      if (!answer) {
        console.warn('[git-read] refused an LFS answer over its cap', runId)
        return apiError("Fetch refused: GitHub's LFS answer is too large for the gate", { status: 502, code: 'LFS_ANSWER_TOO_LARGE' })
      }
      if (carriesGithubToken(answer, target.githubToken)) {
        console.error("[git-read] refused an LFS answer that carries the person's GitHub token", runId)
        return apiError("Fetch refused: GitHub's LFS answer carried a credential the sandbox must not get", { status: 502, code: 'LFS_ANSWER_CARRIES_TOKEN' })
      }
      return relay(upstream, NULL_BODY_STATUSES.has(upstream.status) ? null : answer)
    }

    if (!upstream.body || NULL_BODY_STATUSES.has(upstream.status)) {
      await upstream.body?.cancel().catch(() => {})
      return relay(upstream, null)
    }
    handedOff = true
    return relay(upstream, releasingStream(upstream.body, release))
  } finally {
    // Every answer but a streamed one is complete here; a streamed one releases
    // its slot when its body ends, fails or is cancelled (or the client goes).
    if (!handedOff) release()
  }
}

/**
 * The whole git gate, as the route serves it: the four read endpoints go to
 * the read gate, everything else to the push gate (which serves its two
 * endpoints and refuses the rest exactly as it always has).
 */
export async function handleGitGate(
  request: Request,
  segments: string[],
  deps: GitReadDeps = defaultGitGateDeps,
): Promise<Response> {
  if (readEndpointOf(request, segments)) return handleGitRead(request, segments, deps)
  return handleGitPush(request, segments, deps)
}
