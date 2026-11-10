/**
 * POST /api/internal/agent-run/outcome  (token via header)
 *
 * INTERNAL-ONLY terminal settle for the eve `coding-agent` runtime (Phase 3).
 * The eve agent's `finish_run` tool posts here exactly once at the end of a run:
 *
 *   { result: 'pr_open'|'completed'|'failed', summary, error?,
 *     pr?: { title, body, head, base } }
 *
 * This is the SINGLE writer of the run's terminal state + the PR link — the three
 * racing writers of the legacy path (in-run MCP ni_link_pr, Inngest
 * record-outcome, GitHub webhook) collapse to this one on the eve path (the
 * webhook stays as an out-of-band reconciler). It:
 *
 *   1. When `pr` present: creates the GitHub PR server-side with the triggering
 *      user's OAuth token (plain REST fetch, github.ts idiom). A 422 "already
 *      exists" (a retry after a prior create) is handled by looking up the open
 *      PR for head/base and proceeding — replay-safe. Then upserts
 *      action_github_pr (onConflict action_id,repo_full_name,pr_number — the SAME
 *      key the legacy record-outcome uses), sets agent_run.pr_url/branch.
 *   2. Always sets the terminal agent_run.status + finished_at, and (action-origin
 *      only) syncs actions.agent_run_status with the SAME mapping the legacy path
 *      writes: pr_open->'pr_open', completed->'idle', failed->'failed'.
 *
 * ── Idempotency + guards ────────────────────────────────────────────────────
 *   - A re-POST of the SAME outcome after the row is already terminal → 200
 *     { ok, alreadySettled: true } (safe replay — Inngest retries, network
 *     retries).
 *   - A CONFLICTING outcome after the row is terminal → 409.
 *   - Canceled guard: a row in 'canceling'/'canceled' is NOT resurrected by a
 *     late finish_run — any outcome against it → 409 RUN_CANCELED. The watcher
 *     owns settling a canceling row to canceled.
 *   - CAS-guarded terminal writes: PR creation is a GitHub round trip, so a Stop
 *     can land between the status read and the settle. Every terminal write
 *     carries `status NOT IN (terminal, canceling)` in its WHERE; a lost CAS
 *     writes nothing else (no action mirror, no PR link, no ledger) and answers
 *     from the winner's status — 409 RUN_CANCELED / OUTCOME_CONFLICT carrying the
 *     prUrl so an already-opened PR is not lost.
 *   - Branch guard: a PR is opened only from the spec's head branch
 *     (`dial8/<identifier>-<run8>`) into the spec's base (the repo's default
 *     branch), the pair the spec stored at its first build (agent_run.branch +
 *     base_branch, migration 371; a run built before that derives the head and
 *     looks the base up, and a failed lookup is 503 BASE_LOOKUP_FAILED). A model
 *     `pr.head` or `pr.base` naming anything else → 400 PR_HEAD_MISMATCH /
 *     PR_BASE_MISMATCH, nothing settled, so the model can call finish_run again.
 *     This stops a PR from the wrong branch. A direct push of any other branch
 *     never happens: the sandbox holds no credential that can push to GitHub,
 *     and the git push gate (src/lib/agent-run/git-push-proxy.ts) accepts only
 *     the run's own branch.
 *
 * Auth: same two gates as the spec/event routes — shared secret + signed run
 * token. Tenancy is the token's; the repo + GitHub token are re-derived
 * server-side, never taken from the request body.
 */
import { placeRunSuggestions } from '@/lib/suggestions/deliver'
import { resolveWorkItemIdForAgentRun } from '@/lib/work/touch'
import { NextResponse } from 'next/server'
import { lookupRepoDefaultBranch } from '@/lib/agent-run/github-default-branch'
import { readSpecBranches, specHeadBranch } from '@/lib/agent-run/spec-rebuild'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getServiceClient } from '@/lib/admin'
import { storedGithubToken } from '@/lib/oauth/github-token'
import {
  extractInternalSecret,
  verifyInternalSecret,
  extractAgentRunToken,
  verifyAgentRunToken,
  type AgentRunTokenClaims,
} from '@/lib/agent-run/agent-run-token'
import { mirrorAgentRunStatus, type AgentRunDeliverable } from '@/lib/work/agent-run-mirror'
import { emitChildSettled } from '@/lib/agent-run/delegation'
import { moveActionToReview } from '@/lib/actions/agent-finish'
import { statusChangeDepthForWorkRun } from '@/lib/agent-run/run-work-spec-rebuild'
import { requestMemorySummary } from '@/lib/work/agent-memory'
import { evaluateExpects, normalizeWorkExpects } from '@/lib/work/roles'
import type { WorkDeliverable } from '@/lib/agent-run/types'
import { commitsAfterReviewNote, reviewBeforePr, withReviewSection } from '@/lib/coding/review'
import { isUnattendedCodingRun, prCeilingFor, type CodingRunStarter } from '@/lib/coding/unattended'
import { readCiFix, type CiFixFacts } from '@/lib/coding/ci-fix-task'
import { onWebsiteRunSettled } from '@/lib/website/deploy'

export const dynamic = 'force-dynamic'
// The reviewer runs inside a pr_open settle (P10 F6): its model call is
// bounded at 120s (CODE_REVIEW_TIMEOUT_MS), plus the GitHub reads and writes.
export const maxDuration = 300

type RunResult = 'pr_open' | 'completed' | 'failed'

interface OutcomeBody {
  result?: unknown
  summary?: unknown
  error?: unknown
  pr?: { title?: unknown; body?: unknown; head?: unknown; base?: unknown }
  /** Work-run settle (result='work_completed'): the reviewable artifacts. */
  deliverables?: unknown
}

const TERMINAL = new Set(['pr_open', 'completed', 'failed', 'canceled'])

/**
 * The CAS guard every coding-path terminal write carries: the row must still be
 * live (not settled, not being canceled) AT WRITE TIME. A NOT-IN rather than an
 * equality on the observed status, so the watcher's benign queued → running flip
 * in the read→write gap doesn't fail a legitimate settle.
 */
const NOT_SETTLEABLE = `(${[...TERMINAL, 'canceling'].join(',')})`

/** Clamp for the settle-time result summary written onto agent_run.result_summary. */
const RESULT_SUMMARY_MAX_CHARS = 2000
/** Cap on the number of deliverables a work run may report. */
const MAX_DELIVERABLES = 24

/** result → terminal agent_run.status. Identity for pr_open/completed/failed. */
function runStatusFor(result: RunResult): string {
  return result
}

/**
 * result → actions.agent_run_status — the SAME mapping legacy record-outcome
 * writes: a PR opens → 'pr_open'; a clean no-PR finish returns the action to
 * 'idle'; a failure → 'failed'.
 */
function actionStatusFor(result: RunResult): string {
  if (result === 'pr_open') return 'pr_open'
  if (result === 'completed') return 'idle'
  return 'failed'
}

/** Parse a GitHub PR URL into repo + number — mirrors the legacy record-outcome regex. */
function parsePrUrl(url: string): { repoFullName: string; prNumber: number } | null {
  const m = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/)
  if (!m) return null
  return { repoFullName: m[1], prNumber: parseInt(m[2], 10) }
}

/**
 * Create (or, on replay, find) the PR via the GitHub REST API with the user's
 * OAuth token — the github.ts fetch idiom. Returns the PR url + number, or an
 * error string. A 422 "already exists" is treated as success by looking up the
 * open PR for head/base (replay safety after a prior successful create).
 */
async function createOrFindPr(args: {
  repoFullName: string
  githubToken: string
  title: string
  body: string
  head: string
  base: string
  /** Open it as a draft: the unattended ceiling (P10 F4, unattended.ts). A draft can't merge. */
  draft: boolean
}): Promise<CreatedPr | { error: string }> {
  const { repoFullName, githubToken, title, body, head, base, draft } = args
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${githubToken}`,
    'Content-Type': 'application/json',
  }

  try {
    const res = await fetch(`https://api.github.com/repos/${repoFullName}/pulls`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title, body, head, base, ...(draft ? { draft: true } : {}) }),
    })

    if (res.ok) {
      return createdPr(await res.json())
    }

    // 422 = validation failed. The replay case: a PR for this head already exists.
    // Look it up and proceed. Any OTHER 422 (e.g. no commits between base..head)
    // is a real failure surfaced below.
    if (res.status === 422) {
      // GitHub wants head as `owner:branch` for cross-fork, but same-repo lookup
      // by `head=owner:branch` works; derive owner from repoFullName.
      const owner = repoFullName.split('/')[0]
      const lookup = await fetch(
        `https://api.github.com/repos/${repoFullName}/pulls?head=${encodeURIComponent(`${owner}:${head}`)}&base=${encodeURIComponent(base)}&state=open`,
        { headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${githubToken}` } },
      )
      if (lookup.ok) {
        const arr = (await lookup.json()) as unknown[]
        if (Array.isArray(arr) && arr.length > 0) {
          return createdPr(arr[0])
        }
      }
      const detail = await res.text()
      return { error: `GitHub PR create 422: ${detail.slice(0, 500)}` }
    }

    const detail = await res.text()
    return { error: `GitHub PR create failed (${res.status}): ${detail.slice(0, 500)}` }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

/** A PR GitHub answered with: where it is, the commit it opened at, and whether it is a draft. */
interface CreatedPr {
  url: string
  number: number
  headSha: string | null
  nodeId: string | null
  draft: boolean
}

function createdPr(raw: unknown): CreatedPr {
  const d = (raw ?? {}) as { html_url?: string; number?: number; head?: { sha?: string }; node_id?: string; draft?: boolean }
  return { url: d.html_url as string, number: d.number as number, headSha: d.head?.sha ?? null, nodeId: d.node_id ?? null, draft: d.draft === true }
}

const githubHeaders = (token: string) => ({
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
})

/** The commit a branch points at now, or null when GitHub can't say. */
async function branchSha(repoFullName: string, branch: string, token: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${repoFullName}/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`, {
      headers: githubHeaders(token),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    const d = (await res.json()) as { object?: { sha?: string } }
    return d.object?.sha ?? null
  } catch {
    return null
  }
}

/**
 * A PR opened ready whose head moved past the reviewed commit while it was
 * opening (a push in the gap): back to draft (GraphQL; REST can't) and the
 * note on top of its body. Best-effort: a failure is logged, the PR stays.
 */
async function draftAfterLatePush(args: { repoFullName: string; pr: CreatedPr; reviewedSha: string; token: string; body: string }): Promise<void> {
  try {
    if (args.pr.nodeId) {
      await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: githubHeaders(args.token),
        body: JSON.stringify({ query: 'mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { pullRequest { id } } }', variables: { id: args.pr.nodeId } }),
      })
    }
    await fetch(`https://api.github.com/repos/${args.repoFullName}/pulls/${args.pr.number}`, {
      method: 'PATCH',
      headers: githubHeaders(args.token),
      body: JSON.stringify({ body: `${commitsAfterReviewNote(args.reviewedSha, args.pr.headSha)}${args.body}` }),
    })
  } catch (err) {
    console.warn('[agent-run-outcome] could not mark a late-pushed PR draft', err instanceof Error ? err.message : err)
  }
}

/**
 * A CI fix run's approved commit reaches its PR (P10 F7): the PR's branch is
 * fast-forwarded to EXACTLY the commit the reviewer read (force false, so a
 * PR that moved since refuses), and the PR body's review section is replaced
 * with this review. Nothing else ever reaches the PR from a fix run. Returns
 * an error string when the move was refused.
 */
async function moveCiFixIntoPr(args: {
  repoFullName: string
  token: string
  fix: CiFixFacts
  reviewedSha: string | null
  section: string
}): Promise<{ prUrl: string; prNumber: number } | { error: string }> {
  const { fix } = args
  const parsed = fix.prUrl ? parsePrUrl(fix.prUrl) : null
  if (!fix.prBranch || !fix.prUrl || !parsed || parsed.repoFullName.toLowerCase() !== args.repoFullName.toLowerCase()) {
    return { error: 'the pull request this run fixes could not be found' }
  }
  if (!args.reviewedSha) return { error: 'no reviewed commit to move the pull request to' }
  try {
    const ref = fix.prBranch.split('/').map(encodeURIComponent).join('/')
    const moved = await fetch(`https://api.github.com/repos/${args.repoFullName}/git/refs/heads/${ref}`, {
      method: 'PATCH',
      headers: githubHeaders(args.token),
      body: JSON.stringify({ sha: args.reviewedSha, force: false }),
    })
    if (!moved.ok) return { error: `GitHub refused to move the pull request to the reviewed commit (${moved.status}); it may have moved since` }
    // The review section now speaks for the commit it read.
    const got = await fetch(`https://api.github.com/repos/${args.repoFullName}/pulls/${parsed.prNumber}`, { headers: githubHeaders(args.token) })
    if (got.ok) {
      const pr = (await got.json()) as { body?: string | null }
      await fetch(`https://api.github.com/repos/${args.repoFullName}/pulls/${parsed.prNumber}`, {
        method: 'PATCH',
        headers: githubHeaders(args.token),
        body: JSON.stringify({ body: withReviewSection(pr.body ?? '', args.section) }),
      })
    }
    return { prUrl: fix.prUrl, prNumber: parsed.prNumber }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

export async function POST(request: Request) {
  // Gate 1: our-infrastructure caller.
  if (!verifyInternalSecret(extractInternalSecret(request))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  // Gate 2: a valid run token — the authoritative source of tenancy.
  const claims = verifyAgentRunToken(extractAgentRunToken(request))
  if (!claims) {
    return NextResponse.json({ error: 'invalid or expired run token' }, { status: 401 })
  }

  let body: OutcomeBody
  try {
    body = (await request.json()) as OutcomeBody
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  // ── Work-run settle branch (kind='workspace') ───────────────────────────────
  // The work-agent's finish_work posts result='work_completed'; this route is the
  // SINGLE writer of a work run's terminal state too. Routed before the coding
  // enum so the two settle paths stay cleanly separate.
  if (body.result === 'work_completed') {
    return settleWorkRun(getServiceClient(), claims, body)
  }

  const result = body.result
  if (result !== 'pr_open' && result !== 'completed' && result !== 'failed') {
    return NextResponse.json(
      { error: "result must be 'pr_open' | 'completed' | 'failed'", code: 'INVALID_RESULT' },
      { status: 400 },
    )
  }
  const summary = typeof body.summary === 'string' ? body.summary : null
  const errorMessage = typeof body.error === 'string' ? body.error : null

  const supabase = getServiceClient()

  // Load the run (workspace-scoped). Repo/branch/action come off the row, never
  // the request body — the body only carries model-authored PR text.
  const { data: run } = await supabase
    .from('agent_run')
    .select('id, status, action_id, triggered_by, repo_full_name, branch, pr_url, log_tail, origin, flow_id, fire_key, parent_run_id')
    .eq('id', claims.agentRunId)
    .eq('workspace_id', claims.workspaceId)
    .maybeSingle()
  if (!run) {
    return NextResponse.json({ error: 'agent run not found' }, { status: 404 })
  }

  const currentStatus = run.status as string
  const targetStatus = runStatusFor(result)

  // ── Canceled guard (checked FIRST) ──────────────────────────────────────────
  // A canceling/canceled run is not resurrected by a late finish_run. The watcher
  // owns settling canceling → canceled; any outcome here 409s with a clear code.
  if (currentStatus === 'canceling' || currentStatus === 'canceled') {
    return NextResponse.json(
      { error: 'run was canceled — outcome ignored', code: 'RUN_CANCELED' },
      { status: 409 },
    )
  }

  // ── Idempotency on an already-terminal row ──────────────────────────────────
  if (TERMINAL.has(currentStatus)) {
    if (currentStatus === targetStatus) {
      // Same outcome replayed after settle — safe no-op.
      return NextResponse.json({ ok: true, alreadySettled: true, prUrl: run.pr_url ?? null })
    }
    // Conflicting terminal outcome — refuse to overwrite.
    return NextResponse.json(
      { error: `run already settled as '${currentStatus}'`, code: 'OUTCOME_CONFLICT' },
      { status: 409 },
    )
  }

  const nowIso = new Date().toISOString()
  const actionId = run.action_id as string | null

  // ── PR creation (only when result is pr_open with a pr payload) ──────────────
  let prUrl: string | null = run.pr_url as string | null
  let prNumber: number | null = null
  let repoFullName: string | null = (run.repo_full_name as string | null) ?? null
  const branch = run.branch as string | null
  // The branch the PR was actually opened from — set below to the real head so the
  // run row and the action_github_pr link both record it (run.branch may be null
  // on the eve path, which never wrote it at dispatch time).
  let headBranch: string | null = branch
  // Who started it (unattended.ts): the PR ceiling and how a stop is told.
  const starter = run as CodingRunStarter
  const unattended = isUnattendedCodingRun(starter)
  // A CI fix run (P10 F7): its approved commit moves the existing PR; it never opens one.
  let ciFix: CiFixFacts | null = null

  if (result === 'pr_open') {
    const pr = body.pr
    // The spec's head and base are the ONLY ones a PR may use: the model names
    // `pr.head` / `pr.base`, but can't pick others (eve-templates-lessons §1.4).
    // They are the pair the spec stored at its first build (migration 371);
    // a run built before that derives the head the way the spec does and looks
    // the base up below. Absent a model value, the spec's is used.
    const stored = await readSpecBranches(supabase, { agentRunId: claims.agentRunId, workspaceId: claims.workspaceId })
    const hasStored = Boolean(stored.branchName && stored.baseBranch)
    const specHead = hasStored
      ? stored.branchName
      : await specHeadBranch(supabase, { agentRunId: claims.agentRunId, workspaceId: claims.workspaceId, actionId })
    const modelHead = pr && typeof pr.head === 'string' && pr.head.trim() ? pr.head.trim() : null
    const head = specHead
    headBranch = head
    const modelBase = pr && typeof pr.base === 'string' && pr.base.trim() ? pr.base.trim() : null
    const title = pr && typeof pr.title === 'string' ? pr.title : summary || 'Native Intelligence agent PR'
    const prBody = pr && typeof pr.body === 'string' ? pr.body : summary || ''

    if (modelHead && specHead && modelHead !== specHead) {
      return NextResponse.json(
        {
          error: `pr.head must be this run's working branch '${specHead}', not '${modelHead}'`,
          code: 'PR_HEAD_MISMATCH',
        },
        { status: 400 },
      )
    }

    if (!repoFullName || !head) {
      return NextResponse.json(
        { error: 'pr_open requires a known repo and head branch for this run', code: 'PR_CONTEXT_MISSING' },
        { status: 400 },
      )
    }

    const triggeredBy = run.triggered_by as string | null
    const githubToken = triggeredBy ? await storedGithubToken(supabase, triggeredBy) : null
    if (!githubToken) {
      return NextResponse.json(
        { error: 'no GitHub token for the triggering user — cannot open PR', code: 'NO_GITHUB_TOKEN' },
        { status: 400 },
      )
    }

    // The spec's base: the stored one, else the repo's default branch looked up
    // the same way the spec did. A failed lookup is a 503 (retry finish_run),
    // never a guess: falling back to 'main' could refuse a right base or accept
    // a wrong one.
    const base = hasStored ? stored.baseBranch! : await lookupRepoDefaultBranch(repoFullName, githubToken)
    if (!base) {
      return NextResponse.json(
        { error: "could not look up the repository's default branch — try finish_run again", code: 'BASE_LOOKUP_FAILED' },
        { status: 503 },
      )
    }
    if (modelBase && modelBase !== base) {
      return NextResponse.json(
        { error: `pr.base must be the base branch '${base}', not '${modelBase}'`, code: 'PR_BASE_MISMATCH' },
        { status: 400 },
      )
    }
    // ── The review (P10 F6, src/lib/coding/review.ts) ──────────────────────
    // A reviewer on another vendor reads the real diff (base...head on
    // GitHub) against the action and its acceptance criteria. Approve opens
    // the PR with the verdict in its body; request_changes sends the coder
    // back (finish_run's answer, nothing settled), at most twice; reject, or
    // a third request, settles the run without a PR.
    const gate = await reviewBeforePr(supabase, {
      agentRunId: claims.agentRunId,
      workspaceId: claims.workspaceId,
      userId: (run.triggered_by as string | null) ?? claims.userId,
      repoFullName,
      githubToken,
      base,
      head,
      unattended,
    })
    if (gate.kind === 'changes') {
      return NextResponse.json({
        ok: false,
        settled: false,
        changesRequested: true,
        roundsLeft: gate.roundsLeft,
        message: gate.message,
      })
    }
    // A person's run that stops is told (the reason names the branch); an
    // unattended run's stop is a quiet ledger entry, no push (Liam's Q5).
    const stopRun = async (reason: string): Promise<Response> => {
      const took = await settleFailed(supabase, {
        agentRunId: claims.agentRunId,
        workspaceId: claims.workspaceId,
        actionId,
        errorMessage: reason,
        finishedAt: nowIso,
        quiet: unattended,
      })
      if (!took) return lostSettleResponse(supabase, claims, 'failed', null)
      // A website change (roadmap track E): its owner is told it didn't work out.
      await onWebsiteRunSettled(supabase, { workspaceId: claims.workspaceId, agentRunId: claims.agentRunId, result: 'failed', prUrl: null, summary: null, error: reason })
      return NextResponse.json({ ok: true, alreadySettled: false, prUrl: null, reviewStopped: true, message: reason })
    }
    if (gate.kind === 'stop') return stopRun(gate.reason)
    const reviewedSha = gate.entry?.head_sha ?? null

    ciFix = await readCiFix(supabase, { agentRunId: claims.agentRunId, workspaceId: claims.workspaceId })
    if (ciFix.fixOf) {
      // Only the reviewed commit reaches the PR, and only on approve.
      if (gate.entry?.verdict !== 'approve') return stopRun(`Nothing reached the pull request: the fix was not approved by the reviewer. The work is on ${head}.`)
      const moved = await moveCiFixIntoPr({ repoFullName, token: githubToken, fix: ciFix, reviewedSha, section: gate.section })
      if ('error' in moved) return stopRun(`Nothing reached the pull request: ${moved.error}. The work is on ${head}.`)
      prUrl = moved.prUrl
      prNumber = moved.prNumber
    } else {
      // The ceiling (P10 F4): a run nobody started by hand opens a DRAFT, always,
      // whatever the model asked for. A person marks it ready. A person's run
      // also opens a draft when its review was partial or could not run.
      const ceilingDraft = prCeilingFor(starter) === 'draft'
      let draft = ceilingDraft || gate.draft
      // The branch must still be at the commit the reviewer read; a push since
      // means unreviewed commits: a draft, with a note saying so.
      const nowAt = reviewedSha ? await branchSha(repoFullName, head, githubToken) : null
      const moved = Boolean(reviewedSha && nowAt && nowAt !== reviewedSha)
      if (moved) draft = true
      const draftNote = ceilingDraft ? '> Draft: opened by a run nobody started by hand. Read it, then mark it ready for review.\n\n' : ''
      const movedNote = moved && reviewedSha ? commitsAfterReviewNote(reviewedSha, nowAt) : ''
      const reviewedBody = `${draftNote}${movedNote}${gate.section ? `${prBody.trimEnd()}\n\n${gate.section}` : prBody}`

      const created = await createOrFindPr({ repoFullName, githubToken, title, body: reviewedBody, head, base, draft })
      if (!('error' in created) && reviewedSha && created.headSha && created.headSha !== reviewedSha && !created.draft) {
        await draftAfterLatePush({ repoFullName, pr: created, reviewedSha, token: githubToken, body: reviewedBody })
      }
      if ('error' in created) {
        // PR creation failed — settle the run FAILED with the error rather than
        // leaving it non-terminal (a stuck row is worse than a recorded failure).
        const took = await settleFailed(supabase, {
          agentRunId: claims.agentRunId,
          workspaceId: claims.workspaceId,
          actionId,
          errorMessage: created.error,
          finishedAt: nowIso,
        })
        if (!took) {
          // A Stop (or another settle) won during the GitHub call. A canceled run
          // stays canceled; report that rather than the PR failure.
          const winner = await readWinnerStatus(supabase, claims)
          if (winner === 'canceling' || winner === 'canceled') {
            return NextResponse.json(
              { error: 'run was canceled — outcome ignored', code: 'RUN_CANCELED' },
              { status: 409 },
            )
          }
          // Any other winner settled the row first: this outcome (and the failure
          // it would have recorded) was dropped, so never answer as if the run
          // was settled failed. The PR error rides along for the agent's log.
          return NextResponse.json(
            {
              error: `run settled as '${winner ?? 'unknown'}' — outcome ignored`,
              code: 'OUTCOME_CONFLICT',
              prError: created.error,
            },
            { status: 409 },
          )
        }
        // A website change (roadmap track E): its owner is told it didn't work out.
        await onWebsiteRunSettled(supabase, { workspaceId: claims.workspaceId, agentRunId: claims.agentRunId, result: 'failed', prUrl: null, summary: null, error: created.error })
        return NextResponse.json(
          { error: created.error, code: 'PR_CREATE_FAILED' },
          { status: 502 },
        )
      }

      prUrl = created.url
      prNumber = created.number
      // Prefer the repo/number parsed from the returned URL (authoritative).
      const parsed = parsePrUrl(created.url)
      if (parsed) {
        repoFullName = parsed.repoFullName
        prNumber = parsed.prNumber
      }
    }
  }

  // ── Terminal settle on agent_run (CAS-guarded) ──────────────────────────────
  // The canceled check above is a separate, earlier read, and PR creation is a
  // GitHub round trip: a Stop landing in between must not be overwritten. The
  // guard lives in the UPDATE's WHERE; a lost CAS writes nothing further.
  const { data: settledRows } = await supabase
    .from('agent_run')
    .update({
      status: targetStatus,
      ...(prUrl ? { pr_url: prUrl } : {}),
      ...(headBranch ? { branch: headBranch } : {}),
      error_message: errorMessage,
      finished_at: nowIso,
    })
    .eq('id', claims.agentRunId)
    .eq('workspace_id', claims.workspaceId)
    .not('status', 'in', NOT_SETTLEABLE)
    .select('id')
  if (!settledRows || settledRows.length === 0) {
    return lostSettleResponse(supabase, claims, targetStatus, prUrl)
  }

  // ── Action mirror (action-origin only) ──────────────────────────────────────
  if (actionId) {
    await supabase
      .from('actions')
      .update({ agent_run_status: actionStatusFor(result) })
      .eq('id', actionId)

    // Single-writer PR link — the SAME onConflict key legacy record-outcome uses.
    // A CI fix run's PR is already linked, from its own branch: left as it is.
    if (result === 'pr_open' && prUrl && repoFullName && prNumber != null && !ciFix?.fixOf) {
      await supabase.from('action_github_pr').upsert(
        {
          workspace_id: claims.workspaceId,
          action_id: actionId,
          pr_url: prUrl,
          repo_full_name: repoFullName,
          pr_number: prNumber,
          head_branch: headBranch,
        },
        { onConflict: 'action_id,repo_full_name,pr_number' },
      )
    }
  }

  // The ledger row settles the same way (a PR is a deliverable the user reviews).
  // A CI fix run (P10 F7) moved a PR whose own row already waits on the
  // person: it just finishes, so the same PR isn't a second review card.
  await mirrorAgentRunStatus(
    supabase,
    { agentRunId: claims.agentRunId, workspaceId: claims.workspaceId },
    result === 'failed'
      ? { status: 'failed', error: errorMessage ?? 'The run failed' }
      : result === 'pr_open' && !ciFix?.fixOf
        ? { status: 'pr_open', prUrl: prUrl ?? null, summary }
        : { status: 'completed', summary },
  )

  // A business's website change (roadmap track E): its pull request goes to
  // the owner's merge card (after the host's preview), a failure is told.
  // A no-op for every other run; never throws.
  if (!ciFix?.fixOf) {
    await onWebsiteRunSettled(supabase, { workspaceId: claims.workspaceId, agentRunId: claims.agentRunId, result, prUrl: prUrl ?? null, summary: summary || null, error: errorMessage ?? null })
  }

  return NextResponse.json({ ok: true, alreadySettled: false, prUrl: prUrl ?? null })
}

/** Re-read a run's status after a lost CAS (workspace-scoped). */
async function readWinnerStatus(
  supabase: SupabaseClient,
  claims: AgentRunTokenClaims,
): Promise<string | null> {
  const { data: winner } = await supabase
    .from('agent_run')
    .select('status')
    .eq('id', claims.agentRunId)
    .eq('workspace_id', claims.workspaceId)
    .maybeSingle()
  return (winner?.status as string | null) ?? null
}

/**
 * Answer a coding-path settle whose CAS lost, from the WINNER's status — never
 * claim an outcome was recorded when it wasn't. The prUrl rides along on every
 * answer: when the PR was opened before the Stop landed, it exists on GitHub and
 * must not vanish with the dropped settle.
 */
async function lostSettleResponse(
  supabase: SupabaseClient,
  claims: AgentRunTokenClaims,
  targetStatus: string,
  prUrl: string | null,
): Promise<Response> {
  const winner = await readWinnerStatus(supabase, claims)
  if (prUrl) {
    console.warn('[agent-run-outcome] settle lost its CAS after the PR was opened', {
      agentRunId: claims.agentRunId,
      winner,
      prUrl,
    })
  }
  if (winner === targetStatus) {
    // A concurrent identical settle won — a genuine idempotent replay.
    return NextResponse.json({ ok: true, alreadySettled: true, prUrl })
  }
  if (winner === 'canceling' || winner === 'canceled') {
    return NextResponse.json(
      { error: 'run was canceled — outcome ignored', code: 'RUN_CANCELED', prUrl },
      { status: 409 },
    )
  }
  return NextResponse.json(
    { error: `run settled as '${winner ?? 'unknown'}' — outcome ignored`, code: 'OUTCOME_CONFLICT', prUrl },
    { status: 409 },
  )
}

/**
 * Settle a run as failed (used when PR creation itself fails). Mirrors the
 * terminal path: agent_run.status='failed' + finished_at + action mirror. The
 * same CAS as the main settle; returns whether the write took (a lost CAS writes
 * nothing else).
 */
async function settleFailed(
  supabase: SupabaseClient,
  args: {
    agentRunId: string
    workspaceId: string
    actionId: string | null
    errorMessage: string
    finishedAt: string
    /** An unattended run's stop: a quiet ledger entry, no push (Q5). */
    quiet?: boolean
  },
): Promise<boolean> {
  const { data: took } = await supabase
    .from('agent_run')
    .update({ status: 'failed', error_message: args.errorMessage, finished_at: args.finishedAt })
    .eq('id', args.agentRunId)
    .eq('workspace_id', args.workspaceId)
    .not('status', 'in', NOT_SETTLEABLE)
    .select('id')
  if (!took || took.length === 0) return false
  await mirrorAgentRunStatus(
    supabase,
    { agentRunId: args.agentRunId, workspaceId: args.workspaceId },
    { status: 'failed', error: args.errorMessage, ...(args.quiet ? { quiet: true } : {}) },
  )
  if (args.actionId) {
    await supabase.from('actions').update({ agent_run_status: 'failed' }).eq('id', args.actionId)
  }
  return true
}

// ── Work-run settle (kind='workspace') ────────────────────────────────────────

const DELIVERABLE_TYPES = new Set(['email_draft', 'document', 'action', 'entity'])

/**
 * Validate + normalize the model-supplied deliverables. Drops malformed entries
 * (never fails the settle over them — a bad deliverable is a UI gap, not a stuck
 * run); caps the list; trims strings; keeps `entity_type` only for type 'entity'.
 */
function sanitizeDeliverables(raw: unknown): WorkDeliverable[] {
  if (!Array.isArray(raw)) return []
  const out: WorkDeliverable[] = []
  for (const item of raw) {
    if (out.length >= MAX_DELIVERABLES) break
    if (!item || typeof item !== 'object') continue
    const d = item as Record<string, unknown>
    const type = typeof d.type === 'string' ? d.type : ''
    const id = typeof d.id === 'string' ? d.id.trim() : ''
    const label = typeof d.label === 'string' ? d.label.trim() : ''
    if (!DELIVERABLE_TYPES.has(type) || !id || !label) continue
    const deliverable: WorkDeliverable = { type: type as WorkDeliverable['type'], id, label }
    if (type === 'entity' && typeof d.entity_type === 'string' && d.entity_type.trim()) {
      deliverable.entity_type = d.entity_type.trim()
    }
    out.push(deliverable)
  }
  return out
}

/**
 * Terminal settle for a WORK run (result='work_completed'). The single writer of:
 *   - agent_run.status='completed' + finished_at + result_summary (clamped) +
 *     deliverables (validated),
 *   - the tracked action → REVIEW, not Done (moveActionToReview: a state named
 *     like review, else its started state; agent_run_status='idle'). The
 *     person's Reviewed on the job marks it Done (decision 9),
 *   - a `work_run_ready` notification (target_type='agent_run', target_id=run id)
 *     for the triggering user, deep-linking the run.
 *
 * Idempotent: a second finish_work against an already-terminal run is a no-op
 * success (200 alreadySettled). A canceling/canceled row is NOT resurrected — the
 * watcher owns settling that (409 RUN_CANCELED), exactly like the coding path.
 */
async function settleWorkRun(
  supabase: SupabaseClient,
  claims: AgentRunTokenClaims,
  body: OutcomeBody,
): Promise<Response> {
  const summary = typeof body.summary === 'string' ? body.summary : ''
  if (!summary.trim()) {
    return NextResponse.json(
      { error: 'summary is required', code: 'INVALID_SUMMARY' },
      { status: 400 },
    )
  }
  const resultSummary = summary.trim().slice(0, RESULT_SUMMARY_MAX_CHARS)
  const deliverables = sanitizeDeliverables(body.deliverables)

  // Load the run + its tracked action (team + title come off the action).
  const { data: run } = await supabase
    .from('agent_run')
    .select('id, status, kind, action_id, attention_item_id, triggered_by, expects, ai_team_member_id, origin, origin_depth')
    .eq('id', claims.agentRunId)
    .eq('workspace_id', claims.workspaceId)
    .maybeSingle()
  if (!run) {
    return NextResponse.json({ error: 'agent run not found' }, { status: 404 })
  }
  if (run.kind !== 'workspace') {
    return NextResponse.json(
      { error: 'run is not a workspace run', code: 'WRONG_KIND' },
      { status: 400 },
    )
  }

  const currentStatus = run.status as string

  // Canceled guard (FIRST): a canceling/canceled run is not resurrected by a late
  // finish_work. The watcher owns settling canceling → canceled.
  if (currentStatus === 'canceling' || currentStatus === 'canceled') {
    return NextResponse.json(
      { error: 'run was canceled — outcome ignored', code: 'RUN_CANCELED' },
      { status: 409 },
    )
  }

  // needs_input guard (Loops v3 Phase 3): a run parked on an unanswered question
  // MUST NOT be clobbered into 'completed' by a stray finish_work. The park and any
  // finish_work happen on DIFFERENT turns (the agent parks the turn on the ask, then
  // finishes on a LATER resumed turn), so this should never race in practice — but a
  // finish_work landing while the row is parked would erase the open question and
  // strand the user's answer. Refuse it; the CAS below is a second line of defence.
  if (currentStatus === 'needs_input') {
    return NextResponse.json(
      { error: 'run is waiting on user input — outcome ignored', code: 'RUN_NEEDS_INPUT' },
      { status: 409 },
    )
  }

  // Idempotency on an already-terminal row. A second finish_work from a follow-up
  // turn against an already-settled run is a no-op that NEVER rewrites
  // result_summary / deliverables — the first settle owns them.
  if (TERMINAL.has(currentStatus)) {
    if (currentStatus === 'completed') {
      // Same terminal outcome replayed — safe no-op. The row's existing summary +
      // deliverables are untouched (we return before any write).
      return NextResponse.json({ ok: true, alreadySettled: true })
    }
    // Conflicting terminal outcome (failed) — refuse to overwrite.
    return NextResponse.json(
      { error: `run already settled as '${currentStatus}'`, code: 'OUTCOME_CONFLICT' },
      { status: 409 },
    )
  }

  const nowIso = new Date().toISOString()
  const actionId = run.action_id as string | null

  // ── Terminal settle on agent_run (CAS-guarded on the observed status) ────────
  // Guard against a concurrent terminal write (watcher settling canceled) in the
  // gap since our SELECT: only transition a row STILL in the status we observed.
  const { data: settled } = await supabase
    .from('agent_run')
    .update({
      status: 'completed',
      result_summary: resultSummary,
      deliverables,
      finished_at: nowIso,
    })
    .eq('id', claims.agentRunId)
    .eq('status', currentStatus)
    .select('id')
  if (!settled || settled.length === 0) {
    // We lost the CAS: the row changed status in the SELECT→UPDATE gap. Do NOT blindly
    // report success — re-read the WINNER and answer honestly, so the agent isn't told
    // "already settled; stop now" when the run was actually canceled/parked with the
    // outcome dropped (see the pre-CAS guards, which check the SAME statuses).
    const { data: winner } = await supabase
      .from('agent_run')
      .select('status')
      .eq('id', claims.agentRunId)
      .maybeSingle()
    const winnerStatus = (winner?.status as string | null) ?? null
    if (winnerStatus === 'completed') {
      // A concurrent completed-settle won — genuine idempotent replay.
      return NextResponse.json({ ok: true, alreadySettled: true })
    }
    if (winnerStatus === 'canceling' || winnerStatus === 'canceled') {
      return NextResponse.json(
        { error: 'run was canceled — outcome ignored', code: 'RUN_CANCELED' },
        { status: 409 },
      )
    }
    if (winnerStatus === 'needs_input') {
      return NextResponse.json(
        { error: 'run is waiting on user input — outcome ignored', code: 'RUN_NEEDS_INPUT' },
        { status: 409 },
      )
    }
    // Anything else (failed, or a status we can't classify) — a real conflict; the
    // outcome was NOT recorded, so don't claim it was.
    return NextResponse.json(
      { error: `run settled as '${winnerStatus ?? 'unknown'}' — outcome ignored`, code: 'OUTCOME_CONFLICT' },
      { status: 409 },
    )
  }

  // What the run was asked to hand back (agent_run.expects: a delegated child's
  // brief, an attempt's card) against what it did. A shortfall never fails the
  // run: an honest short result is reviewable. It rides on the ledger row, and
  // the parent of a delegated child reads it off the child (delegation.ts).
  const { unmet } = evaluateExpects(normalizeWorkExpects((run as { expects?: unknown }).expects), deliverables)

  // The ledger row settles with the deliverables the user now reviews.
  await mirrorAgentRunStatus(
    supabase,
    { agentRunId: claims.agentRunId, workspaceId: claims.workspaceId },
    {
      status: 'completed',
      summary: resultSummary,
      deliverables: deliverables as AgentRunDeliverable[],
      ...(unmet.length > 0 ? { expectsUnmet: unmet } : {}),
    },
  )
  // Suggestions the run staged without a document_id land in the first
  // document it delivered (src/lib/suggestions/deliver.ts). With no document
  // they stay homeless and expire a day on.
  const firstDocument = (deliverables as AgentRunDeliverable[]).find((d) => d.type === 'document' && d.id)
  if (firstDocument) {
    const trackedJobId = await resolveWorkItemIdForAgentRun(supabase, claims.agentRunId)
    if (trackedJobId) await placeRunSuggestions(supabase, { trackedJobId, documentId: firstDocument.id })
  }
  // A delegated child's parent picks its work back up.
  await emitChildSettled(supabase, { childRunId: claims.agentRunId, workspaceId: claims.workspaceId })
  // A run done as a teammate teaches that teammate's memory (plan row 15).
  await requestMemorySummary({
    agentRunId: claims.agentRunId,
    workspaceId: claims.workspaceId,
    teammateId: ((run as { ai_team_member_id?: string | null }).ai_team_member_id as string | null) ?? null,
  })

  // ── Tracked action → REVIEW, never Done (decision 9, Liam 2026-10-14) ──────
  // The agent finished; the person marks it Done from the review (the ledger's
  // Reviewed, resolve.ts settleWorkReview). One helper for every finish path
  // (src/lib/actions/agent-finish.ts): a team state named like review, else
  // where it is when started, else the first started state; agent_run_status
  // back to idle. A delegated action and a For you Start settle the same way.
  if (actionId) {
    const triggeredBy = ((run as { triggered_by?: string | null }).triggered_by as string | null) ?? null
    await moveActionToReview(supabase, {
      actionId,
      workspaceId: claims.workspaceId,
      // The run's terminal settle: its run status goes back to idle.
      resetRunStatus: true,
      // The status write is an AGENT's, at the depth the run's row says (the
      // flow loop guard), the same depth its tool calls carry.
      actor: triggeredBy
        ? {
            userId: triggeredBy,
            origin: {
              actor: 'agent',
              depth: statusChangeDepthForWorkRun(run as { origin?: string | null; origin_depth?: number | null }),
              run_id: claims.agentRunId,
            },
          }
        : null,
    })
  }

  // The "ready for review" push is the ledger's (`work_needs_you`, sent by the
  // mirror's needs_review transition above) — the one notification for work.

  return NextResponse.json({ ok: true, alreadySettled: false })
}
