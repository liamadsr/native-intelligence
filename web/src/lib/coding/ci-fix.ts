/**
 * The CI fix loop on Native Intelligence's own pull requests (P10; eve-templates-lessons.md
 * F7, Foreman's "red CI on its own PR").
 *
 * The GitHub webhook (src/app/api/webhooks/github/route.ts, signature checked
 * as for pull_request) hands a completed, failing check_suite or check_run
 * here. It acts only for a person who switched it on, and only on a branch
 * WE created:
 *   - OPT-IN (Liam, 2026-10-20; eve-alignment §5b "flows are the switch"):
 *     the person who started the PR's coding run has the ci_fix_loop recipe
 *     switched on for that repo (src/lib/flows/recipes.ts). No loop, nothing:
 *     no fix run, no "CI still red" card. The loop shows in their flows list
 *     and they turn it off there;
 *   - the branch has the coding runs' prefix (`dial8/`, branchNameFor);
 *   - a coding run in our database has that exact repo and branch, opened its
 *     PR (pr_url, status pr_open) and works an action;
 *   - GitHub says that PR is open, comes from the same repo (never a fork
 *     that named a branch like ours), and its head is the failing commit.
 * Anything else is ignored, with a reason.
 *
 * Then one failing commit is claimed atomically (agent_run_claim_ci_fix,
 * migration 394; two check events for one commit arrive together):
 *   - 'start': one fix run on that branch (a coding run, origin 'attempt',
 *     ci_fix_of_run_id set, the checks' output in ci_failure). At most
 *     MAX_CI_FIX_RUNS per PR, counted from the PR run's own trail;
 *   - 'exhausted': the agent says "CI is still red on ENG-42" in the
 *     starter's home thread, once (a notice, never a For you card: P13);
 *   - 'duplicate' / 'busy' / 'reported': nothing.
 *
 * The fix run reads the checks' output fenced as untrusted outside text
 * (ci-fix-task.ts) and works on a SIDE branch forked from the PR's
 * (`<pr-branch>-cifix-<id>`, startFrom), the only branch its push gate
 * allows. It goes through the same reviewer as every run; only on approve
 * does the outcome route fast-forward the PR's branch to exactly the reviewed
 * commit and rewrite the PR's review section. Anything else (rejected,
 * stopped, failed, finished without a PR result) reaches nothing. The plan
 * meter is read before the claim (fail closed); only GitHub Actions and the
 * apps in CI_FIX_CHECK_APPS count; a public repo is never touched.
 */
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { inngest } from '@/lib/inngest/client'
import { ensureWorkForAgentRun } from '@/lib/work/agent-run-mirror'
import { runEnvironmentIdFor, runEnvironmentUsable } from '@/lib/environments/resolve'
import { storedGithubToken } from '@/lib/oauth/github-token'
import { appendHomeMessage } from '@/lib/chat/home-message-writer'
import { githubPrUrl } from './ci-red'
import { escapeMarkdownInline } from '@/lib/chat/teammate-report'

/** Writes the agent's message into a person's home thread (appendHomeMessage; a test passes its own). */
type TellHome = typeof appendHomeMessage
import { boundCiFailure, ciFixBranch, type CiCheck, type CiFailure } from './ci-fix-task'

/** The prefix every coding run's branch has (spec-rebuild.ts branchNameFor). */
export const DIAL8_BRANCH_PREFIX = 'dial8/'
/** Fix runs per PR before the starter is told CI is still red. */
export const MAX_CI_FIX_RUNS = 2
/** Conclusions that mean the check failed. Cancelled, neutral, skipped, stale and action_required are not a failure to fix. */
export const FAILING_CONCLUSIONS: ReadonlySet<string> = new Set(['failure', 'timed_out', 'startup_failure'])

/**
 * The check apps whose failures start a fix run: GitHub Actions, plus the
 * slugs listed in CI_FIX_CHECK_APPS (comma-separated, e.g. "vercel"). Any
 * other app's check (a third-party bot anyone can install) is ignored.
 */
export function trustedCheckApps(env: Record<string, string | undefined> = process.env): ReadonlySet<string> {
  const extra = (env.CI_FIX_CHECK_APPS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  return new Set(['github-actions', ...extra])
}

/** A failing check event, as the webhook gave it. */
export interface CiEvent {
  source: 'check_suite' | 'check_run'
  repoFullName: string
  branch: string
  headSha: string
  /** check_suite: its id, to list its runs' output. */
  suiteId: number | null
  /** check_run: the run itself, with its output. */
  checks: CiCheck[]
  /** The GitHub App that ran the check (its slug), null when the payload names none. */
  app: string | null
  /**
   * The pull requests GitHub matched to the check (same head commit and
   * branch, in this repo): a fork's check names none. The agent's
   * `pr.changed` reads it (agent-events/pr-changed.ts); the fix loop checks
   * the PR itself.
   */
  prNumbers?: number[]
}

/** The PR numbers in a check payload's `pull_requests`. Pure. */
function prNumbersOf(value: unknown): number[] {
  const out: number[] = []
  for (const p of Array.isArray(value) ? value : []) {
    const n = (p as { number?: unknown } | null)?.number
    if (typeof n === 'number' && Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n)
  }
  return out.slice(0, 20)
}

/** A failing completed check_suite / check_run payload, or null for anything else. Pure. */
export function ciEventFrom(event: string | null, payload: unknown): CiEvent | null {
  const p = (payload ?? {}) as Record<string, unknown>
  if (p.action !== 'completed') return null
  const repoFullName = (p.repository as { full_name?: unknown } | undefined)?.full_name
  if (typeof repoFullName !== 'string') return null
  if (event === 'check_suite') {
    const s = (p.check_suite ?? {}) as { id?: unknown; conclusion?: unknown; head_branch?: unknown; head_sha?: unknown; app?: { slug?: unknown }; pull_requests?: unknown }
    if (typeof s.conclusion !== 'string' || !FAILING_CONCLUSIONS.has(s.conclusion)) return null
    if (typeof s.head_branch !== 'string' || typeof s.head_sha !== 'string') return null
    const app = typeof s.app?.slug === 'string' ? s.app.slug.toLowerCase() : null
    return { source: 'check_suite', repoFullName, branch: s.head_branch, headSha: s.head_sha, suiteId: typeof s.id === 'number' ? s.id : null, checks: [], app, prNumbers: prNumbersOf(s.pull_requests) }
  }
  if (event === 'check_run') {
    const r = (p.check_run ?? {}) as {
      name?: unknown
      conclusion?: unknown
      head_sha?: unknown
      html_url?: unknown
      details_url?: unknown
      output?: { title?: unknown; summary?: unknown; text?: unknown }
      check_suite?: { head_branch?: unknown; id?: unknown }
      app?: { slug?: unknown }
      pull_requests?: unknown
    }
    if (typeof r.conclusion !== 'string' || !FAILING_CONCLUSIONS.has(r.conclusion)) return null
    const branch = r.check_suite?.head_branch
    if (typeof branch !== 'string' || typeof r.head_sha !== 'string') return null
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null)
    return {
      source: 'check_run',
      repoFullName,
      branch,
      headSha: r.head_sha,
      suiteId: typeof r.check_suite?.id === 'number' ? r.check_suite.id : null,
      app: typeof r.app?.slug === 'string' ? r.app.slug.toLowerCase() : null,
      prNumbers: prNumbersOf(r.pull_requests),
      checks: [
        {
          name: str(r.name) ?? 'check',
          conclusion: r.conclusion,
          title: str(r.output?.title),
          summary: str(r.output?.summary),
          text: str(r.output?.text),
          url: str(r.html_url) ?? str(r.details_url),
        },
      ],
    }
  }
  return null
}

/** The run_agent step marker the ci_fix_loop recipe writes (RunAgentActionConfig.fix_ci). */
export const CI_FIX_MARKER = 'fix_ci'

/**
 * Whether `ownerUserId` has the CI fix loop switched on for `repoFullName` in
 * this workspace: an enabled pr_status_changed loop they own on that repo
 * whose run_agent step carries the marker. The one place "is it on" is read.
 */
export async function ciFixLoopOn(
  supabase: SupabaseClient,
  args: { workspaceId: string; ownerUserId: string | null; repoFullName: string },
): Promise<boolean> {
  if (!args.ownerUserId) return false
  const { data, error } = await supabase
    .from('flow')
    .select('id, trigger_config, actions')
    .eq('workspace_id', args.workspaceId)
    .eq('created_by', args.ownerUserId)
    .eq('enabled', true)
    .eq('trigger_type', 'pr_status_changed')
    .contains('actions', JSON.stringify([{ type: 'run_agent', config: { [CI_FIX_MARKER]: true } }]))
  if (error || !data) return false
  const repo = args.repoFullName.toLowerCase()
  return (data as Array<{ trigger_config?: { repo_full_name?: unknown }; actions?: Array<{ type?: string; enabled?: boolean; config?: Record<string, unknown> }> }>).some(
    (f) =>
      typeof f.trigger_config?.repo_full_name === 'string' &&
      f.trigger_config.repo_full_name.toLowerCase() === repo &&
      (f.actions ?? []).some((a) => a.type === 'run_agent' && a.enabled !== false && a.config?.[CI_FIX_MARKER] === true),
  )
}

export type CiFixOutcome =
  | { handled: 'fix_started'; fixRunId: string; prRunId: string }
  | { handled: 'reported_red'; prRunId: string }
  | { handled: 'ignored'; reason: string }

const ignored = (reason: string): CiFixOutcome => ({ handled: 'ignored', reason })

interface PrRun {
  id: string
  workspace_id: string
  action_id: string | null
  triggered_by: string | null
  ai_team_member_id: string | null
  repo_full_name: string
  branch: string
  base_branch: string | null
  pr_url: string | null
  status: string
  acceptance_criteria?: unknown
  /** Migration 420: the environment the PR run started in. */
  environment_id?: string | null
}

/** The PR number in `prUrl`, only when the URL is a PR of `repoFullName` (case aside). Pure. */
export function prNumberOf(prUrl: string, repoFullName: string): number | null {
  const m = prUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/)
  if (!m || m[1].toLowerCase() !== repoFullName.toLowerCase()) return null
  return Number(m[2])
}

/**
 * GitHub's view of the PR: open, from this repo (not a fork), at this head,
 * and the repo private (decision 2: Native Intelligence never pushes agent work into a
 * public repo on its own). Null when it is ours; else why not.
 */
async function prIsOurs(args: { repoFullName: string; prUrl: string; headSha: string; token: string; fetchImpl: typeof fetch }): Promise<string | null> {
  const n = prNumberOf(args.prUrl, args.repoFullName)
  if (!n) return 'pr_url_unreadable'
  try {
    const res = await args.fetchImpl(`https://api.github.com/repos/${args.repoFullName}/pulls/${n}`, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${args.token}` },
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return `pr_lookup_${res.status}`
    const pr = (await res.json()) as { state?: string; head?: { sha?: string; repo?: { full_name?: string; private?: boolean } | null }; base?: { repo?: { private?: boolean } | null } }
    if (pr.state !== 'open') return 'pr_not_open'
    if ((pr.head?.repo?.full_name ?? '').toLowerCase() !== args.repoFullName.toLowerCase()) return 'pr_from_another_repo'
    if (pr.head?.sha !== args.headSha) return 'not_the_pr_head'
    if (pr.base?.repo?.private !== true || pr.head?.repo?.private !== true) return 'public_repo'
    return null
  } catch {
    return 'pr_lookup_failed'
  }
}

/** A check suite's failing runs, with their output. Best-effort: none on any failure. */
async function failingRunsOfSuite(args: { repoFullName: string; suiteId: number; token: string; fetchImpl: typeof fetch }): Promise<CiCheck[]> {
  try {
    const res = await args.fetchImpl(`https://api.github.com/repos/${args.repoFullName}/check-suites/${args.suiteId}/check-runs?filter=latest&per_page=50`, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${args.token}` },
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return []
    const data = (await res.json()) as { check_runs?: Array<Record<string, unknown>> }
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null)
    return (data.check_runs ?? [])
      .filter((r) => typeof r.conclusion === 'string' && FAILING_CONCLUSIONS.has(r.conclusion))
      .map((r) => {
        const output = (r.output ?? {}) as Record<string, unknown>
        return {
          name: str(r.name) ?? 'check',
          conclusion: r.conclusion as string,
          title: str(output.title),
          summary: str(output.summary),
          text: str(output.text),
          url: str(r.html_url) ?? str(r.details_url),
        }
      })
  } catch {
    return []
  }
}

/**
 * Handle one failing check event. Never throws for an ignored event; a
 * database failure propagates (the webhook answers 500). GitHub does not
 * redeliver a failed webhook on its own, so that failure is lost unless
 * someone redelivers it; the next failing check tries again.
 */
export async function handleCiFailure(
  supabase: SupabaseClient,
  ev: CiEvent,
  deps: { fetchImpl?: typeof fetch; send?: (event: { name: string; data: Record<string, unknown> }) => Promise<unknown>; newId?: () => string; tellHome?: TellHome } = {},
): Promise<CiFixOutcome> {
  const fetchImpl = deps.fetchImpl ?? fetch
  if (!ev.branch.startsWith(DIAL8_BRANCH_PREFIX)) return ignored('not_a_dial8_branch')
  if (!ev.app || !trustedCheckApps().has(ev.app)) return ignored('check_app_not_trusted')

  // The run that created this branch and opened its PR.
  const { data: rows, error } = await supabase
    .from('agent_run')
    .select('id, workspace_id, action_id, triggered_by, ai_team_member_id, repo_full_name, branch, base_branch, pr_url, status, acceptance_criteria, environment_id')
    .eq('repo_full_name', ev.repoFullName)
    .eq('branch', ev.branch)
    .eq('kind', 'coding')
    .is('ci_fix_of_run_id', null)
    .order('created_at', { ascending: false })
    .limit(1)
  if (error) throw new Error(`ci-fix: run lookup failed: ${error.message}`)
  const run = ((rows ?? []) as PrRun[])[0]
  if (!run) return ignored('branch_not_ours')
  if (!run.pr_url || run.status !== 'pr_open') return ignored('no_open_pr_from_this_run')
  if (!run.action_id) return ignored('no_action')
  // Opt-in: the PR run's owner switched the loop on for this repo, or nothing happens.
  if (!(await ciFixLoopOn(supabase, { workspaceId: run.workspace_id, ownerUserId: run.triggered_by, repoFullName: ev.repoFullName }))) {
    return ignored('ci_fix_loop_off')
  }

  const token = run.triggered_by ? await storedGithubToken(supabase, run.triggered_by) : null
  if (!token) return ignored('no_github_token')
  const notOurs = await prIsOurs({ repoFullName: ev.repoFullName, prUrl: run.pr_url, headSha: ev.headSha, token, fetchImpl })
  if (notOurs) return ignored(notOurs)

  // The plan meter, before anything is claimed: an unattended run never
  // spends on a plan it could not read (fail closed, like the attempt gate).
  const { data: limit, error: limitErr } = await supabase.rpc('check_ai_usage_limit', { p_user_id: run.triggered_by })
  const limitRow = Array.isArray(limit) ? (limit[0] as { allowed?: boolean } | undefined) : undefined
  if (limitErr || !limitRow) return ignored('usage_check_failed')
  if (limitRow.allowed !== true) return ignored('usage_limit')

  const { data: action } = await supabase
    .from('actions')
    .select('id, identifier, title, project_id')
    .eq('id', run.action_id)
    .eq('workspace_id', run.workspace_id)
    .maybeSingle()
  const a = (action ?? {}) as { id?: string; identifier?: string | null; title?: string | null; project_id?: string | null }
  const identifier = a.identifier || a.id || run.action_id

  // The fix runs where the PR run did (migration 420), decided before
  // anything is claimed: if that environment was archived or can't be used
  // any more, no fix starts (it would fail at its first session, and a claim
  // for a run never made would hold the PR busy). A PR run from before
  // environments gets its project's, else the workspace default.
  let environmentId: string | null
  if (run.environment_id) {
    if (!(await runEnvironmentUsable(supabase, { environmentId: run.environment_id, workspaceId: run.workspace_id, userId: run.triggered_by }))) {
      return ignored('environment_unusable')
    }
    environmentId = run.environment_id
  } else {
    environmentId = await runEnvironmentIdFor(supabase, { projectId: a.project_id ?? null, workspaceId: run.workspace_id, userId: run.triggered_by })
  }

  const fixRunId = (deps.newId ?? randomUUID)()
  const { data: claim, error: claimErr } = await supabase.rpc('agent_run_claim_ci_fix', {
    p_run_id: run.id,
    p_workspace_id: run.workspace_id,
    p_head_sha: ev.headSha,
    p_fix_run_id: fixRunId,
    p_max: MAX_CI_FIX_RUNS,
  })
  if (claimErr) throw new Error(`ci-fix: claim failed: ${claimErr.message}`)

  if (claim === 'exhausted') {
    await reportStillRed(supabase, { run, identifier, ev }, deps.tellHome ?? appendHomeMessage)
    return { handled: 'reported_red', prRunId: run.id }
  }
  if (claim !== 'start') return ignored(`claim_${String(claim)}`)

  const checks = ev.checks.length > 0 ? ev.checks : ev.suiteId ? await failingRunsOfSuite({ repoFullName: ev.repoFullName, suiteId: ev.suiteId, token, fetchImpl }) : []
  const failure: CiFailure = boundCiFailure({ head_sha: ev.headSha, pr_url: run.pr_url, checks })
  const { error: insertErr } = await supabase.from('agent_run').insert({
    id: fixRunId,
    workspace_id: run.workspace_id,
    kind: 'coding',
    action_id: run.action_id,
    ai_team_member_id: run.ai_team_member_id,
    triggered_by: run.triggered_by,
    status: 'queued',
    origin: 'attempt',
    repo_full_name: run.repo_full_name,
    // A side branch of the PR's: the push gate allows only it, and the PR
    // moves to its commit only on the reviewer's approve (the outcome route).
    branch: ciFixBranch(run.branch, fixRunId),
    base_branch: run.base_branch,
    ci_fix_of_run_id: run.id,
    ci_failure: failure,
    environment_id: environmentId,
    // The PR run's criteria still hold, and a CI fix needs no pre-check: the
    // task is the checks' failure, not new text to read.
    acceptance_criteria: Array.isArray(run.acceptance_criteria) ? run.acceptance_criteria : [],
    precheck: { verdict: 'actionable', questions: [], kind: 'bug', size: 'small', reason: 'A CI fix of an open pull request.', model: null, at: new Date().toISOString() },
  })
  // The claim counted it: a fix that could not be inserted still spends one of the two.
  if (insertErr) throw new Error(`ci-fix: fix run insert failed: ${insertErr.message}`)
  await ensureWorkForAgentRun(
    supabase,
    { id: fixRunId, workspace_id: run.workspace_id, kind: 'coding', status: 'queued', triggered_by: run.triggered_by, action_id: run.action_id, origin: 'attempt', ai_team_member_id: run.ai_team_member_id },
    { actionTitle: `Fix CI on ${identifier}` },
  )
  const send = deps.send ?? ((e: { name: string; data: Record<string, unknown> }) => inngest.send(e))
  try {
    await send({ name: 'agent/run.requested', data: { agent_run_id: fixRunId, workspace_id: run.workspace_id } })
  } catch (err) {
    // Never dispatched: settle it failed, so it stops counting as a live fix
    // (the claim's busy check) and a later failure can start the next one.
    await supabase
      .from('agent_run')
      .update({ status: 'failed', error_message: `The fix run could not be dispatched: ${err instanceof Error ? err.message : String(err)}`, finished_at: new Date().toISOString() })
      .eq('id', fixRunId)
      .eq('status', 'queued')
    return ignored('dispatch_failed')
  }
  return { handled: 'fix_started', fixRunId, prRunId: run.id }
}

/** A check's name as the notice prints it: plain characters only, clipped (GitHub check names are anyone's text). */
function checkName(name: string): string {
  return name.replace(/[^\w .:/()-]/g, '').trim().slice(0, 60)
}

/**
 * The notice: "CI is still red on ENG-42", once per PR (the claim reports
 * once; the message id is the run's too), as the agent's message in the
 * run starter's home thread (P13: a notice is a chat message, never a For
 * you card). Native Intelligence's own words around the action's identifier, the checks'
 * names and the PR link (a github.com pull request, or none).
 */
async function reportStillRed(
  supabase: SupabaseClient,
  args: { run: PrRun; identifier: string; ev: CiEvent },
  tellHome: TellHome,
): Promise<void> {
  if (!args.run.triggered_by) return
  const names = args.ev.checks.map((c) => checkName(c.name ?? '')).filter(Boolean).slice(0, 3)
  const pr = githubPrUrl(args.run.pr_url)
  const text = [
    `CI is still red on **${escapeMarkdownInline(args.identifier)}** after ${MAX_CI_FIX_RUNS} fix runs${names.length ? ` (${names.map(escapeMarkdownInline).join(', ')})` : ''}, so I've stopped trying.`,
    pr ? `The pull request is open for you to look at: ${pr}` : 'The pull request is open for you to look at.',
  ].join(' ')
  await tellHome(supabase, {
    userId: args.run.triggered_by,
    workspaceId: args.run.workspace_id,
    messageId: `ci-red-${args.run.id}`,
    parts: [{ type: 'text', text }],
    metadata: { kind: 'ci_red', agent_run_id: args.run.id, head_sha: args.ev.headSha },
  })
}
