/**
 * POST /api/account/onboarding/research — kick off the onboarding research
 * agent for the signed-in user's workspace.
 *
 * This is the server-side trigger for Phase 1 of the eve migration (see
 * docs/plans/eve-migration-plan.md). It:
 *   1. seeds the workspace's default loops (idempotent — closes a known gap
 *      where first-ever signups never got seeded loops), then
 *   2. starts a DURABLE eve session on the `onboarding-researcher` agent,
 *      dispatched fire-and-forget (the research runs in the background even if
 *      nobody streams it), then
 *   3. records { sessionId, status:'running', startedAt } under
 *      member.onboarding_progress.research so the wizard can rehydrate.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * CLIENT CONTRACT (for the onboarding-wizard UI task) — the streaming surface
 * this route sets up:
 *
 *   • Kick off (once, from the wizard):
 *       POST /api/account/onboarding/research   (cookies; same-origin)
 *       → 200 { sessionId, status }   // idempotent: same sessionId on repeat
 *       → 401 when unauthenticated; 404 when no workspace
 *
 *   • Live stream (browser, same-origin, cookies):
 *       GET /eve/onboarding-researcher/v1/session/<sessionId>/stream
 *       ?startIndex=<n>   // optional cursor for reconnect
 *       NDJSON events. Prefer eve's `useEveAgent({ agent: 'onboarding-researcher',
 *       initialSession })` which finds this route automatically. Terminal
 *       states arrive as `session.completed` / `session.failed`. Progress shows
 *       as `actions.requested` (tool calls: web_search / web_fetch / save_*),
 *       `action.result`, and `message.appended` deltas.
 *
 *   • Durable result / rehydration (survives reload, no stream needed):
 *       GET /api/account/onboarding  → member.onboardingProgress.research = {
 *         sessionId, status: 'running'|'done'|'skipped', startedAt,
 *         finishedAt?, brief?, companyFound?
 *       }
 *       The `brief` (warm, first-person "here's what I learned…") lands here
 *       when the agent calls finish_research. Poll or read it on wizard finish.
 *
 * The stream route is protected by the researcher agent's session-ownership ACL
 * (see agents/onboarding-researcher/channels/eve.ts): a session registered to
 * another user 403s; the caller's own (or an unregistered) id is allowed.
 * ───────────────────────────────────────────────────────────────────────────
 */
import { requireWorkspace } from '@/lib/api-auth'
import { serverError, forbidden } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/admin'
import { mirrorOnboardingResearchStarted } from '@/lib/work/onboarding-research-mirror'
import { seedDefaultLoops } from '@/lib/flows/seed-default-loops'
import { resolveWorkspaceEdition } from '@/lib/editions'
import { parsePriming } from '@/lib/onboarding/research-priming'
import { chatgptPlanFor } from '@/lib/chatgpt/plan-route'
import { AGENT_RUN_SECRET_HEADER, AGENT_RUN_TOKEN_HEADER, internalSecret, mintAgentRunToken } from '@/lib/agent-run/agent-run-token'
import { eveDispatchOrigin } from '@/lib/eve/dispatch-origin'
import { Client } from 'eve/client'
import type { SupabaseClient } from '@supabase/supabase-js'
import { NextResponse, type NextRequest } from 'next/server'

/** The named eve mount for the research agent (see next.config.mjs). */
const RESEARCHER_MOUNT = '/eve/onboarding-researcher'

/**
 * A `starting` claim older than this is STALE and re-claimable: its owner died
 * between winning the claim and persisting either a sessionId or the `error`
 * release (crash, redeploy, timeout), so it will never advance on its own.
 * This route exports no maxDuration, so its runtime is bounded by the
 * deployment default (300s under Fluid compute; routes needing more opt up to
 * 800s explicitly) — 10 minutes is comfortably above that ceiling, so a live
 * kickoff can never still be running when its claim goes stale.
 */
const STALE_STARTING_MS = 10 * 60 * 1000

/**
 * Research statuses. `starting` is a transient CLAIM placeholder written BEFORE
 * the eve session exists (see the kickoff flow below); `error` is terminal but
 * RE-CLAIMABLE (a later kickoff may retry a run whose eve session never started).
 */
interface ResearchState {
  sessionId?: string
  status?: 'starting' | 'running' | 'done' | 'skipped' | 'error'
  startedAt?: string
  finishedAt?: string
  brief?: string
  companyFound?: boolean
  /**
   * Written by the researcher's finish_research (service-role deep-merge within
   * `research`) when it seeds starter content. The route never writes this — it
   * only carries the type so reads of the durable blob stay well-typed.
   */
  seededSummary?: {
    projectName: string
    actionCount: number
    workspaceRenamed?: string
  }
  /**
   * Compare-and-swap token stamped onto the claim placeholder. It makes the
   * ownership claim atomic: two concurrent kickoffs both read the same prior
   * state, but only one UPDATE ... where the prior claimNonce still matches wins
   * (the other matches zero rows). Cleared once a real sessionId lands.
   */
  claimNonce?: string
}

export async function POST(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  // ── Idempotence: if a research session already exists for this member,
  //    return it. Never start a second run for the same workspace. ──────────
  const { data: member } = await supabase
    .from('member')
    .select('id, display_name, role, onboarding_completed_at, onboarding_progress')
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)
    .maybeSingle<{
      id: string
      display_name: string | null
      role: string | null
      onboarding_completed_at: string | null
      onboarding_progress: { research?: ResearchState } | null
    }>()

  // ── OWNER-ONLY GATE. This kickoff drives a service-role researcher run that
  //    seeds a project + starter actions and can RENAME the workspace — an
  //    action the "Owners can update workspace" RLS policy (migration 013)
  //    restricts to owners. requireWorkspace() only verifies membership, so
  //    without this a plain member (e.g. someone who accepted an invite into a
  //    shared workspace) could trigger a run that mutates a workspace they don't
  //    own. Gate on the caller being the workspace OWNER of a brand-new,
  //    self-owned workspace (onboarding not yet completed) — invited members get
  //    onboarding_completed_at stamped on accept, so the wizard never runs for
  //    them and neither should this. Mirrors the owner-only RLS write.
  if (member?.role !== 'owner' || member.onboarding_completed_at) {
    return forbidden('Onboarding research is only available to the workspace owner.')
  }

  const existing = member?.onboarding_progress?.research
  if (existing?.sessionId) {
    // Idempotent short-circuit: a run already exists. Return it and IGNORE any
    // body — the request never even reads it (priming was captured on the first
    // kickoff, if at all).
    return NextResponse.json({
      sessionId: existing.sessionId,
      status: existing.status ?? 'running',
    })
  }

  // ── Optional priming (role + focus). Best-effort: an absent/invalid body is
  //    simply an empty priming, never a 400. Persist it under
  //    onboarding_progress.priming BEFORE the claim so it's durable even if the
  //    caller later loses the claim race; a priming write failure must NOT block
  //    kickoff. Then fold role/focus into the researcher brief below. ─────────
  const priming = await parsePriming(request)
  if (Object.keys(priming).length > 0) {
    const { error: primingErr } = await supabase.rpc('merge_onboarding_progress', {
      p_workspace_id: workspaceId,
      p_patch: { priming },
      p_user_id: user.id,
    })
    if (primingErr) {
      console.error('[onboarding.research] failed to persist priming', {
        workspaceId,
        error: primingErr.message,
      })
    }
  }

  const service = getServiceClient()

  // ── CLAIM-BEFORE-CREATE. A double-POST (two tabs, a client retry) must not
  //    spawn two eve sessions. Since eve MINTS the session id itself (the create
  //    route takes no caller id), we can't claim the id up front — so we claim a
  //    `starting` PLACEHOLDER with a unique nonce, then create the session, then
  //    record the real id. The claim is an atomic compare-and-swap: only the
  //    kickoff whose CAS matches the just-read prior claim wins; a concurrent
  //    caller matches zero rows, re-reads, and returns the winner's state
  //    (idempotent — no second session). A prior `error` claim is re-claimable
  //    so a run whose eve session never started can be retried. ──────────────
  const claim = await claimResearchRun(service, {
    userId: user.id,
    workspaceId,
    prior: existing ?? null,
  })
  if (claim.outcome === 'lost') {
    // Another kickoff won the claim (or already has a live run). Return its
    // state; never start a second session.
    return NextResponse.json({
      ...(claim.state.sessionId ? { sessionId: claim.state.sessionId } : {}),
      status: claim.state.status ?? 'starting',
    })
  }
  if (claim.outcome === 'error') {
    // Could not even record the claim — surface it rather than start a run we
    // can't track (that would orphan the eve session under the ownership ACL).
    return serverError('Could not start onboarding research.')
  }
  const { claimNonce } = claim

  // ── Which persona this workspace signed up for. The stamp lands in
  //    /api/analytics/auth-session, which the trial wall fires on MOUNT before
  //    onboarding starts (and the wizard again on its own mount) — so the
  //    edition is already on the workspace by now. A missing/unstamped edition
  //    resolves to `full`, today's behavior.
  //    Read for the researcher's brief. `resolveWorkspaceEdition` never
  //    throws, so it needs no guard of its own. ─────────────────────────────
  const { edition } = await resolveWorkspaceEdition(service, workspaceId)

  // ── Seed Triage (idempotent). The signup hook (POST
  //    /api/analytics/auth-session → seed-signup-loops.ts) normally seeded it
  //    already, but only inside the account's first hour: an email-confirmation
  //    signup who confirms later, or a ping that never landed, reaches
  //    onboarding without it, and this catches them. On a seeded workspace it
  //    is one read. Best-effort: a seeding failure must never block research
  //    kickoff. ─────────────────────────────────────────────────────────────
  try {
    await seedDefaultLoops(service, {
      workspaceId,
      createdByUserId: user.id,
    })
  } catch (err) {
    console.error('[onboarding.research] seed-default-loops failed', {
      workspaceId,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  // ── The ChatGPT free tier: a person on their own ChatGPT plan researches
  //    on it. The researcher runs on their plan (its web search is OpenAI's
  //    own, agents/onboarding-researcher/lib/model.ts), and its enrichment
  //    calls run their cards on it too (deepSearchForUser). Their plan token,
  //    an agent-run token the plan proxy verifies and pays with, rides the
  //    vouched session create below. When the plan can't be read, no research
  //    (the claim becomes 'skipped', the wizard's quiet line): a free user
  //    never runs on Native Intelligence's models. ───────────────────────────────────────
  let planToken: string | null = null
  try {
    if (await chatgptPlanFor(user.id, { attempts: 2, failClosed: true })) {
      planToken = mintAgentRunToken({ agentRunId: `onboarding-research:${workspaceId}`, workspaceId, userId: user.id })
    }
  } catch (err) {
    console.error('[onboarding.research] plan check failed (skipping research)', {
      workspaceId,
      error: err instanceof Error ? err.message : String(err),
    })
    const { error: skipErr } = await supabase.rpc('merge_onboarding_progress', {
      p_workspace_id: workspaceId,
      p_patch: { research: { status: 'skipped', finishedAt: new Date().toISOString(), companyFound: false } },
      p_user_id: user.id,
    })
    // A failed write leaves the claim 'starting'; it goes stale and the next
    // kickoff lands here again.
    if (skipErr) console.error('[onboarding.research] failed to record a skipped run', { workspaceId, error: skipErr.message })
    return NextResponse.json({ status: 'skipped' })
  }

  // ── Build the task brief the researcher reads as its first user message. ──
  const workspaceName = await resolveWorkspaceName(supabase, workspaceId)
  const brief = {
    userName:
      (member?.display_name ?? undefined) ||
      (user.user_metadata?.full_name as string | undefined) ||
      (user.user_metadata?.name as string | undefined) ||
      '',
    email: user.email ?? '',
    workspaceName: workspaceName ?? '',
    workspaceId,
    // Empty-string when absent, matching the existing convention above so the
    // brief shape is stable regardless of whether the wizard primed the run.
    role: priming.role ?? '',
    // The same picks unflattened, so a future seeding instruction can branch on
    // an exact chip rather than substring-matching the sentence. `role` above
    // is unchanged — the agent's prose prompt still reads it.
    roles: priming.roles ?? [],
    focus: priming.focus ?? '',
    // From the wizard's question steps — how this person meets and captures.
    // Same stable-shape convention: empty when unanswered.
    meetingPlatforms: priming.meetingPlatforms ?? [],
    capturePreference: priming.capturePreference ?? '',
    // The persona this workspace signed up for ('full' | 'sales' | 'notes' |
    // 'brain'), so the starter content the researcher builds matches the
    // product the user actually came for. Always present — an unstamped
    // workspace sends 'full', which asks for nothing in particular.
    edition: edition.id,
  }

  // ── Start the durable eve session, fire-and-forget. `send()` returns as soon
  //    as the POST completes (the runtime creates a DURABLE session and answers
  //    immediately); we read sessionId WITHOUT consuming the stream, so the run
  //    continues server-side even though no one is attached. Forward the
  //    caller's Cookie (+ Authorization if present) so the researcher's eve
  //    AuthFn authenticates the SAME user and derives the SAME workspace. ─────
  const cookieHeader = request.headers.get('cookie') ?? ''
  const authHeader = request.headers.get('authorization') ?? ''
  // The researcher's channel creates a session only for a request carrying
  // this secret (agents/onboarding-researcher/channels/eve.ts): only this
  // route starts research, never a browser directly.
  const secret = internalSecret()
  if (!secret) {
    await releaseClaimToError(service, { userId: user.id, workspaceId, claimNonce }).catch(() => {})
    return serverError('Onboarding research is not configured.')
  }

  const client = new Client({
    // The app's own address (never a request header: the secret rides this
    // call).
    host: `${eveDispatchOrigin()}${RESEARCHER_MOUNT}`,
    // Server-to-server; forward the browser's credentials so the eve channel
    // sees this exact user's session. redirect:'error' prevents a
    // cross-origin redirect from carrying these headers elsewhere.
    headers: async () => {
      const h: Record<string, string> = { [AGENT_RUN_SECRET_HEADER]: secret }
      // A free user's research runs on their own plan (see above).
      if (planToken) h[AGENT_RUN_TOKEN_HEADER] = planToken
      if (cookieHeader) h.cookie = cookieHeader
      if (authHeader) h.authorization = authHeader
      // Pin the workspace explicitly so the researcher derives the SAME one the
      // kickoff used, even if the user has multiple memberships.
      h['x-workspace-id'] = workspaceId
      return h
    },
    redirect: 'error',
  })

  let sessionId: string
  try {
    // Create the session over the client's authenticated raw fetch against the
    // channel's create route (the auth/header cascade above still applies).
    // This used to send `mode: 'task'` so the run ended with
    // `session.completed`; eve 0.67 removed run modes (the route ignores the
    // field), so the finished run parks at `session.waiting`. The wizard
    // (use-research-companion.ts) already treats turn.completed /
    // session.waiting as a boundary and reconciles from the stored research
    // status that finish_research writes.
    const res = await client.fetch('/eve/v1/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: JSON.stringify(brief) }),
    })
    if (!res.ok) throw new Error(`eve session create failed (${res.status})`)
    const created = (await res.json()) as { sessionId?: string }
    sessionId = created.sessionId ?? ''
    if (!sessionId) throw new Error('eve did not return a sessionId')
  } catch (err) {
    console.error('[onboarding.research] failed to start eve session', {
      workspaceId,
      error: err instanceof Error ? err.message : String(err),
    })
    // The claim is still `starting`; move it to the terminal-but-re-claimable
    // `error` state so the wizard doesn't hang on a run that never began and a
    // later kickoff can retry. Best-effort — a write failure here is not worse
    // than the run failing anyway.
    await releaseClaimToError(service, {
      userId: user.id,
      workspaceId,
      claimNonce,
    }).catch(() => {})
    return serverError('Could not start onboarding research.')
  }

  // ── Persist the running state via the merge RPC. This route HAS the user's
  //    JWT (via requireWorkspace's cookie-scoped supabase client), so the
  //    auth.uid()-scoped RPC works here. It shallow-merges top-level keys, so
  //    writing the WHOLE `research` object sets it wholesale while preserving
  //    sibling keys like `tutorial`. finish_research later deep-merges within
  //    `research` (service-role) to add status/brief without losing sessionId.
  //    The real sessionId lands here (the ACL registers ownership on it); the
  //    claimNonce is dropped now that the run is fully tracked. ──────────────
  const researchPatch: ResearchState = {
    sessionId,
    status: 'running',
    startedAt: new Date().toISOString(),
  }
  const { error: mergeErr } = await supabase.rpc('merge_onboarding_progress', {
    p_workspace_id: workspaceId,
    p_patch: { research: researchPatch },
    p_user_id: user.id,
  })
  if (mergeErr) {
    // The session is already running durably; failing to record it would leave
    // an orphan the wizard can't find. Surface it.
    console.error('[onboarding.research] failed to persist research state', {
      workspaceId,
      sessionId,
      error: mergeErr.message,
    })
    return serverError('Research started but could not be recorded.')
  }

  // The run's Activity row (Sequence row 6), keyed by the session id;
  // finish_research settles it through /api/internal/onboarding-research/settle.
  // Fail-soft: the research is already running and recorded.
  await mirrorOnboardingResearchStarted(service, { workspaceId, memberId: member.id, sessionId })

  return NextResponse.json({ sessionId })
}

/** Result of the atomic claim attempt. */
type ClaimResult =
  | { outcome: 'won'; claimNonce: string }
  | { outcome: 'lost'; state: ResearchState }
  | { outcome: 'error' }

/**
 * Atomically claim the research run for `(userId, workspaceId)` by CAS-writing a
 * `starting` placeholder (with a unique nonce) over the prior research state.
 *
 * The guard matches the EXACT prior claim we read:
 *   - fresh member (no research, or no prior claim) → `research->>claimNonce IS
 *     NULL` AND `research->>sessionId IS NULL`;
 *   - re-claim of a terminal `error` run or a STALE `starting` claim →
 *     `research->>claimNonce = <priorNonce>` (still no live sessionId).
 * Concurrent kickoffs read the same prior state and race on this UPDATE; only
 * the first flips the nonce, so exactly one row comes back from `.select()`. The
 * loser gets zero rows, re-reads, and returns the winner's state.
 *
 * Written service-role (RLS-bypassed) but pinned to the single verified
 * `(user_id, workspace_id)` row — the placeholder replaces `research` wholesale
 * while the parent `onboarding_progress` retains sibling keys (`tutorial` etc.)
 * because we merge onto the freshly-read blob.
 */
async function claimResearchRun(
  service: SupabaseClient,
  args: { userId: string; workspaceId: string; prior: ResearchState | null }
): Promise<ClaimResult> {
  const { userId, workspaceId, prior } = args

  // Only a fresh member (no prior claim), a terminal `error` run, or a STALE
  // `starting` claim is claimable. A FRESH `starting` claim (its eve session id
  // hasn't landed yet — sessionId short-circuits earlier) is an in-flight peer:
  // hand its state back without racing. A stale one's owner is dead (see
  // STALE_STARTING_MS) and would otherwise block research for this member
  // forever; the nonce-CAS below still keeps concurrent recoveries single-winner.
  // `running` is never reclaimed here — it carries a live sessionId whose
  // durable eve session owns the lifecycle.
  const priorStatus = prior?.status
  const staleStarting = priorStatus === 'starting' && isStaleStarting(prior?.startedAt)
  const claimable = !prior || priorStatus === 'error' || staleStarting
  if (!claimable) {
    return { outcome: 'lost', state: prior ?? {} }
  }

  const claimNonce = crypto.randomUUID()
  const placeholder: ResearchState = {
    status: 'starting',
    startedAt: new Date().toISOString(),
    claimNonce,
  }

  // Re-read the blob so we preserve sibling top-level keys (tutorial …) when we
  // set `research` wholesale.
  const { data: row, error: readErr } = await service
    .from('member')
    .select('onboarding_progress')
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
    .maybeSingle<{ onboarding_progress: Record<string, unknown> | null }>()
  if (readErr) return { outcome: 'error' }
  const progress: Record<string, unknown> = { ...(row?.onboarding_progress ?? {}) }
  progress.research = placeholder

  let update = service
    .from('member')
    .update({ onboarding_progress: progress, updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
    // The run must not already carry a live sessionId (a fully-tracked run is
    // handled by the idempotent short-circuit; this narrows the CAS window).
    .is('onboarding_progress->research->>sessionId', null)

  update = prior?.claimNonce
    ? // Re-claim: the prior nonce must still be in place (nobody re-claimed since
      // we read). PostgREST casts the JSON text value to string for comparison.
      update.eq('onboarding_progress->research->>claimNonce', prior.claimNonce)
    : // First claim: there must be no prior nonce.
      update.is('onboarding_progress->research->>claimNonce', null)

  const { data: claimed, error: writeErr } = await update.select('user_id')
  if (writeErr) return { outcome: 'error' }

  if (!claimed || claimed.length === 0) {
    // Lost the CAS. Re-read and return whoever won it (or a run that finished in
    // between). No second session.
    const state = await readResearchState(service, { userId, workspaceId })
    return { outcome: 'lost', state }
  }

  return { outcome: 'won', claimNonce }
}

/**
 * Whether a `starting` claim's startedAt is beyond the stale threshold. A
 * missing or unparseable startedAt counts as stale — such a claim can never
 * age out, and the nonce-CAS still keeps a re-claim single-winner.
 */
function isStaleStarting(startedAt: string | undefined): boolean {
  if (!startedAt) return true
  const started = Date.parse(startedAt)
  if (Number.isNaN(started)) return true
  return Date.now() - started > STALE_STARTING_MS
}

/**
 * Move a `starting` claim to the terminal-but-re-claimable `error` state after
 * the eve session failed to start, so the wizard stops waiting and a later
 * kickoff can retry. CAS-guarded on OUR nonce so we never clobber a claim that
 * some concurrent path already advanced past ours.
 */
async function releaseClaimToError(
  service: SupabaseClient,
  args: { userId: string; workspaceId: string; claimNonce: string }
): Promise<void> {
  const { userId, workspaceId, claimNonce } = args
  const { data: row } = await service
    .from('member')
    .select('onboarding_progress')
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
    .maybeSingle<{ onboarding_progress: Record<string, unknown> | null }>()
  const progress: Record<string, unknown> = { ...(row?.onboarding_progress ?? {}) }
  const existingResearch = (progress.research as ResearchState | undefined) ?? {}
  progress.research = { ...existingResearch, status: 'error' }

  await service
    .from('member')
    .update({ onboarding_progress: progress, updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
    // Only if OUR claim is still the current one — keeps the `error` nonce so a
    // later kickoff can re-claim exactly this failed run.
    .eq('onboarding_progress->research->>claimNonce', claimNonce)
}

/** Read just the research sub-object for the member row. */
async function readResearchState(
  service: SupabaseClient,
  args: { userId: string; workspaceId: string }
): Promise<ResearchState> {
  const { userId, workspaceId } = args
  const { data } = await service
    .from('member')
    .select('onboarding_progress')
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
    .maybeSingle<{ onboarding_progress: { research?: ResearchState } | null }>()
  return data?.onboarding_progress?.research ?? {}
}

/** Best-effort workspace name for the task brief. */
async function resolveWorkspaceName(
  supabase: SupabaseClient,
  workspaceId: string
): Promise<string | null> {
  const { data } = await supabase
    .from('workspace')
    .select('name')
    .eq('id', workspaceId)
    .maybeSingle<{ name: string | null }>()
  return data?.name ?? null
}

