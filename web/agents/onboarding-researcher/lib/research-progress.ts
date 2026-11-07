/**
 * Read/merge helpers for the durable research state that lives under
 * `member.onboarding_progress.research`.
 *
 * WHERE STATE LIVES (no new migration): the research lifecycle is persisted as a
 * JSONB sub-object under the existing `member.onboarding_progress` column, keyed
 * `research`:
 *
 *   onboarding_progress.research = {
 *     sessionId:   string   // the eve session id (also the stream handle)
 *     status:      'running' | 'done' | 'skipped'
 *     startedAt:   ISO8601   // set by the kickoff route
 *     finishedAt?: ISO8601   // set by finish_research
 *     brief?:      string     // the warm, first-person user-facing summary
 *     companyFound?: boolean  // whether company research produced a profile
 *     seededSummary?: {       // what save_starter_content set up (if it ran)
 *       projectName: string; actionCount: number; workspaceRenamed?: string
 *     }
 *   }
 *
 * WHY NOT the merge_onboarding_progress RPC HERE:
 * ---------------------------------------------------------------------------
 * That RPC (migration 140) is `SECURITY INVOKER` and pinned to `auth.uid()`, so
 * it only works when called with the END USER'S JWT. The eve runtime is a
 * SEPARATE service from Next.js with no per-request user JWT bound to PostgREST,
 * so a tool calling that RPC via a service-role client would hit its
 * `auth.uid() is null -> raise 'not authenticated'` guard. Separately, the RPC
 * only DEEP-merges the `tutorial` key; every OTHER top-level key (including
 * `research`) is SHALLOW-merged (`||`), i.e. REPLACED wholesale — so it could
 * not incrementally update `research` without clobbering sibling fields anyway.
 *
 * The kickoff route DOES use the RPC (it runs in Next with the user's JWT, and
 * writes the ENTIRE initial `research` object once — where the RPC's shallow
 * top-level merge is exactly right: it sets `research` wholesale while
 * preserving sibling top-level keys like `tutorial`). This helper is the TOOL
 * path: a service-role, member-scoped read-modify-write that deep-merges WITHIN
 * `research` so `finish_research` can add status/brief/finishedAt without losing
 * the `sessionId`/`startedAt` the kickoff wrote.
 *
 * Scope safety: the update is pinned to the single `(user_id, workspace_id)`
 * member row (that pair is UNIQUE), both derived from the verified principal —
 * never model input.
 *
 * WHY A CAS RETRY LOOP (not a plain read-modify-write):
 * ---------------------------------------------------------------------------
 * This service-role write touches the WHOLE `onboarding_progress` column, and it
 * races with the general onboarding endpoint (src/app/api/account/onboarding),
 * which writes `tutorial` progress via the atomic `merge_onboarding_progress`
 * RPC. A plain read-modify-write here reads the blob, splices in `research`, and
 * writes the whole blob back — so a `tutorial` step ticked between our read and
 * our write is silently clobbered (lost update). We can't route this through the
 * RPC (it's `auth.uid()`-scoped and the eve runtime has no user JWT — see the
 * header above), so instead we optimistic-lock on `member.updated_at`: read it
 * alongside the blob, guard the UPDATE with `.eq('updated_at', <read value>)`,
 * and retry on a lost race (zero rows). The `member_updated_at` trigger bumps
 * `updated_at` on EVERY update (including the tutorial RPC's), so a concurrent
 * write invalidates our guard and we recompute against the fresh baseline.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export type ResearchStatus = 'starting' | 'running' | 'done' | 'skipped' | 'error'

/** Compact record of what the seeding tool set up, persisted by finish_research. */
export interface SeededSummary {
  projectName: string
  actionCount: number
  workspaceRenamed?: string
}

/**
 * One captured tool call from the research run — the durable, ground-truth trail
 * of what the researcher actually did (a search it ran, a page it read, the
 * project it set up). Written INCREMENTALLY by the researcher's activity hook as
 * `actions.requested` events fire, then rendered into the home conversation as
 * scannable history so the main agent can answer "what did you look at?".
 *
 * `callId` is the eve tool-call id — stable and unique per call, so a hook that
 * re-processes a replayed event (reconnect) never double-appends. `label` is the
 * friendly one-liner from research-activity-labels.ts.
 */
export interface ResearchActivityEntry {
  callId: string
  toolName: string
  label: string
}

export interface ResearchState {
  sessionId?: string
  status?: ResearchStatus
  startedAt?: string
  finishedAt?: string
  brief?: string
  companyFound?: boolean
  seededSummary?: SeededSummary
  /**
   * The captured tool-call trail (see ResearchActivityEntry). Appended to during
   * the run by the activity hook; read by finish_research to compose the home
   * "here's what I looked into" message. Bounded (see MAX_ACTIVITY_ENTRIES).
   */
  activityLog?: ResearchActivityEntry[]
  [key: string]: unknown
}

/**
 * Hard ceiling on stored activity entries — a runaway research loop must not
 * bloat the member's onboarding_progress blob. Far above any real run's tool
 * count; once hit, further calls are dropped (the earliest, most-representative
 * calls are the ones worth keeping).
 */
export const MAX_ACTIVITY_ENTRIES = 80

/** Bounded CAS attempts — a handful is ample for the low write contention here. */
const MAX_MERGE_ATTEMPTS = 5

/**
 * Deep-merge `patch` into `member.onboarding_progress.research` for exactly one
 * member row (`user_id` + `workspace_id`), preserving every other top-level
 * onboarding_progress key and every research field the patch doesn't touch.
 *
 * Concurrency-safe: optimistic-locked on `member.updated_at` so a concurrent
 * write to a SIBLING key (e.g. `tutorial`) is never clobbered — a lost CAS
 * re-reads and re-merges. Returns the merged research object, or null when no
 * member row matched.
 */
export async function mergeResearchProgress(
  service: SupabaseClient,
  args: { userId: string; workspaceId: string; patch: ResearchState }
): Promise<ResearchState | null> {
  const { userId, workspaceId, patch } = args

  for (let attempt = 0; attempt < MAX_MERGE_ATTEMPTS; attempt++) {
    const { data: row, error: readErr } = await service
      .from('member')
      .select('onboarding_progress, updated_at')
      .eq('user_id', userId)
      .eq('workspace_id', workspaceId)
      .maybeSingle<{
        onboarding_progress: Record<string, unknown> | null
        updated_at: string
      }>()
    if (readErr) throw new Error(`research-progress read failed: ${readErr.message}`)
    if (!row) return null

    const progress: Record<string, unknown> = { ...(row.onboarding_progress ?? {}) }
    const existingResearch = (progress.research as ResearchState | undefined) ?? {}
    const mergedResearch: ResearchState = { ...existingResearch, ...patch }
    progress.research = mergedResearch

    // CAS: only write if the row hasn't changed since we read it. `.select()`
    // returns the affected rows so we can tell a win (1 row) from a lost race
    // (0 rows) — a sibling write (e.g. tutorial) bumped updated_at underneath us.
    const { data: written, error: writeErr } = await service
      .from('member')
      .update({ onboarding_progress: progress })
      .eq('user_id', userId)
      .eq('workspace_id', workspaceId)
      .eq('updated_at', row.updated_at)
      .select('user_id')
    if (writeErr) throw new Error(`research-progress write failed: ${writeErr.message}`)

    if (written && written.length > 0) return mergedResearch
    // Lost the CAS — a concurrent writer touched the row. Re-read and re-merge.
  }

  throw new Error(
    `research-progress write failed: exhausted ${MAX_MERGE_ATTEMPTS} CAS attempts under contention`
  )
}

/**
 * APPEND one or more captured tool-call entries onto
 * `member.onboarding_progress.research.activityLog`, CAS-safe and dedup-by-callId.
 *
 * This differs from mergeResearchProgress (a shallow `{...prev, ...patch}` that
 * would REPLACE activityLog wholesale): here we CONCAT onto the existing array,
 * skipping any callId already present, so the same event replayed on a stream
 * reconnect never double-appends and two hook invocations racing never lose an
 * entry. Bounded at MAX_ACTIVITY_ENTRIES (extra calls are dropped, earliest kept).
 *
 * Uses the same optimistic-lock-on-updated_at retry loop as mergeResearchProgress
 * so a concurrent write to a sibling key (tutorial, or finish_research's merge)
 * never clobbers this append and vice-versa. Best-effort by design: the caller
 * (the activity hook) swallows failures — a lost trail entry must NEVER fail the
 * research run.
 */
export async function appendResearchActivity(
  service: SupabaseClient,
  args: { userId: string; workspaceId: string; entries: ResearchActivityEntry[] }
): Promise<ResearchActivityEntry[] | null> {
  const { userId, workspaceId, entries } = args
  if (entries.length === 0) return []

  for (let attempt = 0; attempt < MAX_MERGE_ATTEMPTS; attempt++) {
    const { data: row, error: readErr } = await service
      .from('member')
      .select('onboarding_progress, updated_at')
      .eq('user_id', userId)
      .eq('workspace_id', workspaceId)
      .maybeSingle<{
        onboarding_progress: Record<string, unknown> | null
        updated_at: string
      }>()
    if (readErr) throw new Error(`research-activity read failed: ${readErr.message}`)
    if (!row) return null

    const progress: Record<string, unknown> = { ...(row.onboarding_progress ?? {}) }
    const existingResearch = (progress.research as ResearchState | undefined) ?? {}
    const existingLog = Array.isArray(existingResearch.activityLog)
      ? existingResearch.activityLog
      : []

    const seen = new Set(existingLog.map((e) => e.callId))
    const additions: ResearchActivityEntry[] = []
    for (const e of entries) {
      if (!e.callId || seen.has(e.callId)) continue
      seen.add(e.callId)
      additions.push(e)
    }
    // Nothing new to add (all already recorded) — no write needed.
    if (additions.length === 0) return existingLog

    const nextLog = [...existingLog, ...additions].slice(0, MAX_ACTIVITY_ENTRIES)
    progress.research = { ...existingResearch, activityLog: nextLog }

    const { data: written, error: writeErr } = await service
      .from('member')
      .update({ onboarding_progress: progress })
      .eq('user_id', userId)
      .eq('workspace_id', workspaceId)
      .eq('updated_at', row.updated_at)
      .select('user_id')
    if (writeErr) throw new Error(`research-activity write failed: ${writeErr.message}`)

    if (written && written.length > 0) return nextLog
    // Lost the CAS — re-read and re-append against the fresh baseline.
  }

  throw new Error(
    `research-activity write failed: exhausted ${MAX_MERGE_ATTEMPTS} CAS attempts under contention`
  )
}
