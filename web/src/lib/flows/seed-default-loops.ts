/**
 * Seed the default loop on every new workspace (GEN-148).
 *
 * A new workspace does not arrive empty: it arrives with Triage already
 * running. This function inserts that one `run_skill` flow, wired to
 * capture_processed and quietly waiting for data. The user's first meeting
 * gets triaged. Nobody clicked "install".
 *
 * See docs/loop-engine/SEED-LOOPS-DESIGN.md for the original rationale. The
 * governing decisions embodied here:
 *
 *   - THE SEED SET: Triage alone, ENABLED. It is event-driven (it fires only
 *     when a capture is processed), so it is silent on an empty workspace and
 *     delivers the day-one "your first meeting organizes itself" promise. It is
 *     the post-call filter that keeps only the user's own commitments.
 *     Weekly groom, Morning brief and the Commitment reconciler used to seed as
 *     disabled loops too. Almost nobody turned them on (one workspace of ~147
 *     on PROD), and each one minted an idle work bot, so they are no longer
 *     seeded (migration 351 removed the idle copies). Their skills stay in the
 *     library to run on demand or to build a loop from.
 *
 *   - SAFETY: Triage runs the CLOSED loop (act mode + auto_apply) because it is
 *     a verdict-contract skill (migration 166) whose effects go through the
 *     verdict-apply engine, NOT raw tools. That engine's trust gate only
 *     auto-applies a proposal the model marked is_mine_explicit (something the
 *     user said, first-person, they'd do). A new to-do that is ambiguous or
 *     someone else's stays in its capture for the user to confirm (For You
 *     carries only what needs them: a question, a draft, work to start), and
 *     allow_external is forced false so no unattended external side effect can
 *     fire. So day-one
 *     auto-apply is safe by construction: it can only ever add work the user
 *     explicitly took on. (Loop-closure E2: Liam's Part-4 decision, full
 *     auto-apply at ship, gated on explicitness.)
 *
 *   - IDEMPOTENT: the loop carries a stable seed_key. The seeder reads the
 *     workspace's existing seed_keys first and inserts only what is missing, so
 *     every caller can run it again safely: the workspace create route, the
 *     signup hook (seed-signup-loops.ts) and the onboarding Prime step. The
 *     partial unique index (workspace_id, seed_key) backstops the narrow
 *     concurrent-double-seed race with a 23505 the seeder catches (see the
 *     insert step for why a plain INSERT, not an upsert).
 *
 *   - SKILL RESOLUTION: run_skill actions reference the promoted system skill
 *     by slug, resolved to an id at seed time, never a hardcoded UUID. A missing
 *     skill is SKIPPED, not fatal, so the seeder is safe to run ahead of any
 *     skill promotion.
 *
 *   - RUN-AS IDENTITY: created_by = the workspace creator's auth.users id. This
 *     is exactly the run-as identity the dispatchers honor
 *     (runAsUserId: flow.created_by), so the seeded loop bills and attributes
 *     to the creator.
 *
 * BEST-EFFORT: callers wrap this in try/catch. A seeding failure must never
 * fail workspace creation or sign-in: a workspace with no loops still works.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { backfillFlowBot, type BackfillFlow } from './flow-bot'
import type { FlowAction, RunSkillActionConfig, CaptureProcessedTriggerConfig } from './types'

/**
 * Stable seed keys: the idempotency marker and the UI "is-seeded" predicate.
 * Only Triage is seeded now. Older workspaces can still hold a loop keyed
 * 'seed:groom', 'seed:reconcile' or 'seed:brief' that someone turned on; code
 * that recognises those (system-teammates.ts, reconcile-decision.ts) matches
 * the literal key.
 */
export const SEED_KEYS = {
  triage: 'seed:triage',
} as const

export type SeedKey = (typeof SEED_KEYS)[keyof typeof SEED_KEYS]

/** One entry in the seed set. `skillSlug` is resolved to a recipe id at seed time; if it doesn't resolve, the loop is skipped. */
interface SeedSpec {
  seedKey: SeedKey
  /** system skill slug (recipe.slug, category 'skill', is_system) */
  skillSlug: string
  name: string
  description: string
  enabled: boolean
  mode: RunSkillActionConfig['mode']
  trust: NonNullable<RunSkillActionConfig['trust']>
  deliver: NonNullable<RunSkillActionConfig['deliver']>
  trigger: CaptureProcessedTriggerConfig
}

/** The seed set: Triage, the one loop every workspace starts with. */
const SEED_SET: SeedSpec[] = [
  {
    seedKey: SEED_KEYS.triage,
    skillSlug: 'triage',
    name: 'Triage after every capture',
    description:
      "After each processed capture, decides every proposed action — accept, fold in, or dismiss. Things you explicitly committed to are added automatically; anything ambiguous or someone else's stays in the capture for you to confirm, and only what needs you — a question, a draft to review, work to start — comes to For You.",
    enabled: true,
    // The closed loop (E2). Triage is a verdict-contract skill (migration 166),
    // so it runs in act mode with auto_apply — but the verdict-apply trust gate
    // only auto-applies items the model marked is_mine_explicit (things the user
    // said, first-person, they'd do). A new to-do that isn't stays in its
    // capture (verdict-apply's 'staged'). So auto_apply here is safe by construction: it can never silently apply
    // someone else's commitment or an ambiguous one. deliver.document is off —
    // the cards + the run's ledger are the surface, not a markdown doc (D4).
    mode: 'act',
    trust: { auto_apply: true, min_confidence: 0.85, allow_external: false, max_cards_per_run: 3 },
    deliver: { document: false, notification: true },
    trigger: { kind: 'capture_processed' },
  },
]

/**
 * Build the run_skill action for a seed spec. allow_external is forced false
 * at this layer whatever the spec says: a seeded loop never fires an external
 * side effect unattended.
 */
function buildRunSkillAction(skillId: string, spec: SeedSpec): FlowAction {
  const config: RunSkillActionConfig = {
    skill_id: skillId,
    mode: spec.mode,
    // No model key: nobody pins a model (auto model selection). A loop runs
    // its skill's tier (recipe.agent_config.model_tier, Think by default),
    // decided at fire time.
    deliver: spec.deliver,
    trust: { ...spec.trust, allow_external: false },
  }
  return {
    // Deterministic-per-call is unnecessary; the action id just keys
    // canvas_layout + action_results within this flow.
    id: crypto.randomUUID(),
    type: 'run_skill',
    config,
    condition: null,
    parent_id: null,
    enabled: true,
    bearer_token_encrypted: null,
  }
}

export interface SeedDefaultLoopsResult {
  /** seed keys of loops inserted on this call (empty if all already existed). */
  seeded: SeedKey[]
  /** seed keys skipped because their skill slug didn't resolve. */
  skippedMissingSkill: SeedKey[]
  /** seed keys already present (idempotency no-op). */
  alreadyPresent: SeedKey[]
}

/**
 * Seed the default loop into `workspaceId`, attributed to `createdByUserId`
 * (an auth.users id). Idempotent. Uses the passed service client
 * (RLS-bypassed): every query filters/inserts by explicit workspace_id.
 *
 * Throws on an unexpected DB error so the caller's try/catch logs it — but a
 * missing skill or an already-seeded workspace is a normal, non-throwing
 * outcome.
 */
export async function seedDefaultLoops(
  service: SupabaseClient,
  { workspaceId, createdByUserId }: { workspaceId: string; createdByUserId: string },
): Promise<SeedDefaultLoopsResult> {
  const result: SeedDefaultLoopsResult = {
    seeded: [],
    skippedMissingSkill: [],
    alreadyPresent: [],
  }

  // 1. Which loops already exist? (idempotency guard)
  const { data: existingRows, error: existingErr } = await service
    .from('flow')
    .select('seed_key')
    .eq('workspace_id', workspaceId)
    .not('seed_key', 'is', null)
  if (existingErr) throw new Error(`seed-default-loops: read existing failed: ${existingErr.message}`)
  const alreadySeeded = new Set((existingRows ?? []).map((r) => r.seed_key as string))

  const missing: SeedSpec[] = []
  for (const spec of SEED_SET) {
    if (alreadySeeded.has(spec.seedKey)) result.alreadyPresent.push(spec.seedKey)
    else missing.push(spec)
  }
  // The usual answer on a repeat call (the signup hook runs on every session
  // ping in a new account's first hour): nothing to do, so no skill lookup.
  if (missing.length === 0) return result

  // 2. Resolve the missing loops' skill slugs → ids in one query. Missing = skip.
  const { data: skillRows, error: skillErr } = await service
    .from('recipe')
    .select('id, slug')
    .eq('category', 'skill')
    .eq('is_system', true)
    .in('slug', missing.map((s) => s.skillSlug))
  if (skillErr) throw new Error(`seed-default-loops: resolve skills failed: ${skillErr.message}`)
  const skillIdBySlug = new Map<string, string>(
    (skillRows ?? []).map((r) => [r.slug as string, r.id as string]),
  )

  // 3. Build the rows to insert — only loops whose skill resolves.
  const toInsert: Array<Record<string, unknown>> = []
  for (const spec of missing) {
    const skillId = skillIdBySlug.get(spec.skillSlug)
    if (!skillId) {
      result.skippedMissingSkill.push(spec.seedKey)
      continue
    }
    toInsert.push({
      workspace_id: workspaceId,
      team_id: null, // capture_processed is workspace-scoped
      name: spec.name,
      description: spec.description,
      enabled: spec.enabled,
      trigger_type: spec.trigger.kind,
      trigger_config: spec.trigger,
      actions: [buildRunSkillAction(skillId, spec)],
      canvas_layout: {},
      created_by: createdByUserId,
      next_run_at: null, // event-driven: nothing to schedule
      seed_key: spec.seedKey,
    })
  }

  if (toInsert.length === 0) return result

  // 4. Insert. A plain INSERT — NOT an upsert. The step-1 `alreadySeeded` read
  //    is the real idempotency guard: `toInsert` already excludes every loop
  //    the workspace has, so in the normal and retry-after-partial-seed paths
  //    there is nothing to conflict with.
  //
  //    We deliberately do NOT use .upsert(onConflict) here: migration 160's
  //    unique index is PARTIAL (WHERE seed_key IS NOT NULL), and Postgres can't
  //    infer a partial index as an ON CONFLICT arbiter without its predicate
  //    restated — which PostgREST/supabase-js can't emit — so an upsert would
  //    raise 42P10 on the very FIRST insert (empirically confirmed on PG 17).
  //    A plain INSERT into a partial unique index has no such problem.
  //
  //    The partial unique index still backstops the one race it needs to: two
  //    concurrent creates for the SAME workspace_id both reading empty at
  //    step 1 (a narrow TOCTOU — creates normally get distinct fresh ids). The
  //    second insert then violates the index with 23505; we treat that as
  //    "the racer seeded it" and re-read to report accurately, never throwing.
  const { data: inserted, error: insertErr } = await service
    .from('flow')
    .insert(toInsert)
    .select('id, workspace_id, team_id, name, created_by, seed_key, actions')

  if (insertErr) {
    // 23505 = unique_violation: a concurrent seeder won the race. Not an error
    // for us — re-read what's now present and report it as already-seeded.
    if (insertErr.code === '23505') {
      const { data: after } = await service
        .from('flow')
        .select('seed_key')
        .eq('workspace_id', workspaceId)
        .not('seed_key', 'is', null)
      const present = new Set((after ?? []).map((r) => r.seed_key as string))
      for (const row of toInsert) {
        const key = row.seed_key as SeedKey
        if (present.has(key) && !result.alreadyPresent.includes(key)) {
          result.alreadyPresent.push(key)
        }
      }
      return result
    }
    throw new Error(`seed-default-loops: insert failed: ${insertErr.message}`)
  }

  result.seeded = (inserted ?? []).map((r) => r.seed_key as SeedKey)

  // 5. Every loop has a bot (bots-v3 Phase 3): the seeded loop gets one, in
  //    the same order as any loop (backfillFlowBot). Triage's seed key maps to
  //    the Captures system teammate (system-teammates.ts; systemTeammateId
  //    re-seeds that row if it is missing), so this names Captures rather than
  //    making a fronts_only work bot. Fail-soft: a loop left
  //    without one is the editor's to fix ("Pick a bot"), and seeding never
  //    fails on it.
  for (const row of (inserted ?? []) as BackfillFlow[]) {
    if (!row?.id) continue
    try {
      const outcome = await backfillFlowBot(service, row, { execute: true })
      if (outcome.kind === 'failed') console.warn(`[seed-default-loops] no bot for ${row.seed_key}: ${outcome.error}`)
    } catch (err) {
      console.warn('[seed-default-loops] bot step failed:', err instanceof Error ? err.message : err)
    }
  }
  return result
}
