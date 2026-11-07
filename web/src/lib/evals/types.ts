/**
 * Shared row and payload types for Evals, mirroring migration `252_evals.sql`
 * — the source of truth for enums and columns (spec §3.2, docs/plans/evals.md).
 *
 * The const arrays below are the SINGLE source for both the TypeScript unions
 * and the schema-lockstep test, following the `src/lib/prospecting/types.ts`
 * precedent: adding a value in one place and not the other fails a test rather
 * than producing a runtime 23514 in production.
 *
 * The jsonb columns are typed, not `unknown`: `script`, `chunks` and `expected`
 * on a case, `trace` on a trial, `progress`/`scores` on a run. Every one of
 * them is written by our own code, so the type IS the contract — a grader that
 * reads `trace.flushes[i].nudges` has no other schema to check against.
 */

// ---------------------------------------------------------------------------
// Enum vocabularies — in lockstep with the CHECK constraints in 252
// ---------------------------------------------------------------------------

/** `eval_suite.target_kind`. An agent is a live-meeting persona; a skill is a
 *  chat/loop preset. Both are `recipe` rows. */
export const EVAL_TARGET_KINDS = ['agent', 'skill'] as const
export type EvalTargetKind = (typeof EVAL_TARGET_KINDS)[number]

/** `eval_suite.suite_kind`. A capability suite starts low and shows progress; a
 *  regression suite must stay green. */
export const EVAL_SUITE_KINDS = ['capability', 'regression'] as const
export type EvalSuiteKind = (typeof EVAL_SUITE_KINDS)[number]

/**
 * The judge a suite uses when `eval_suite.judge_model` is null: a frontier
 * Anthropic model, stronger than the live-agent default by design (judges.ts
 * rule 4).
 *
 * IT LIVES HERE, NOT IN judges.ts, because the Properties sidebar has to name
 * the default beside the models a user can pick, and this module is the only
 * client-safe half of the evals lib — judges.ts pulls in the AI SDK and the
 * gateway factory, which have no business in a browser bundle. `judges.ts`
 * re-exports it, so every server caller is unchanged and the value has exactly
 * one definition.
 */
export const DEFAULT_JUDGE_MODEL_ID = 'claude-sonnet-4-5-20250929'

/** `eval_run.mode` / `eval_case.modes[]`. Batch is one end-of-meeting call;
 *  live replays the transcript chunk by chunk. They exercise different prompts
 *  (spec §1), which is why a case declares which ones it is valid for. */
export const EVAL_MODES = ['batch', 'live'] as const
export type EvalMode = (typeof EVAL_MODES)[number]

/** `eval_run.speed`. Only the wait BETWEEN chunks differs — flush boundaries
 *  are frozen on the case, so a watched replay and a sweep are comparable. */
export const EVAL_SPEEDS = ['realtime', 'fast', 'instant'] as const
export type EvalSpeed = (typeof EVAL_SPEEDS)[number]

/**
 * The speeds a run can actually be STARTED at today.
 *
 * `realtime` and `fast` are the watched replays and they need the client driver
 * (spec §4.1, P1). The server driver genuinely sleeps between chunks, so a
 * 15-minute case at `realtime` would sit ~900s inside one `step.run` against a
 * serve route whose `maxDuration` is 300 — it does not run slowly, it times out.
 * Until that driver ships this is the enum every entry point enforces; the UI
 * picker still RENDERS the other two, disabled and labelled, so the shape of the
 * feature stays visible.
 */
export const RUNNABLE_EVAL_SPEEDS = ['instant'] as const
export type RunnableEvalSpeed = (typeof RUNNABLE_EVAL_SPEEDS)[number]

/** `eval_run.driver`. Server = Inngest (batch, and live at `instant`);
 *  client = the replay screen in the browser (spec §4.1). */
export const EVAL_DRIVERS = ['server', 'client'] as const
export type EvalDriver = (typeof EVAL_DRIVERS)[number]

/** `eval_case.polarity`. A negative control expects the agent to do NOTHING;
 *  a suite with no negative controls earns the amber chip (spec §8.2). */
export const EVAL_POLARITIES = ['positive', 'negative'] as const
export type EvalPolarity = (typeof EVAL_POLARITIES)[number]

/** `eval_case.visibility`. A case seeded from a private capture stays
 *  creator-only; RLS honours this column on top of workspace membership. */
export const EVAL_CASE_VISIBILITIES = ['workspace', 'private'] as const
export type EvalCaseVisibility = (typeof EVAL_CASE_VISIBILITIES)[number]

/** `eval_run.status`. `is_live` is generated from `queued|running`. */
export const EVAL_RUN_STATUSES = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const
export type EvalRunStatus = (typeof EVAL_RUN_STATUSES)[number]

/** `eval_trial.status`. Note `errored`, which a run does not have: a harness
 *  failure on ONE trial must stay distinguishable from a prompt regression. */
export const EVAL_TRIAL_STATUSES = [
  'queued',
  'running',
  'completed',
  'errored',
  'cancelled',
] as const
export type EvalTrialStatus = (typeof EVAL_TRIAL_STATUSES)[number]

/** `eval_check.dimension`. The compare view's columns. */
export const EVAL_DIMENSIONS = [
  'proposals',
  'summary',
  'nudges',
  'tools',
  'gate',
  'cost',
  'latency',
] as const
export type EvalDimension = (typeof EVAL_DIMENSIONS)[number]

/** `eval_check.severity`, imported verbatim from eve's assertion vocabulary
 *  (spec §3.1) because it has no better English replacement. */
export const EVAL_SEVERITIES = ['gate', 'soft'] as const
export type Severity = (typeof EVAL_SEVERITIES)[number]

/** `eval_check.outcome`. `unknown` is a first-class third state that never
 *  counts as pass or fail and is excluded from the pass-rate denominator
 *  (spec §6.4); `skipped` is a grader that could not run at all. */
export const EVAL_CHECK_OUTCOMES = ['pass', 'fail', 'unknown', 'skipped'] as const
export type CheckOutcome = (typeof EVAL_CHECK_OUTCOMES)[number]

/** `eval_check.human_override`. */
export const EVAL_HUMAN_OVERRIDES = ['agree', 'disagree'] as const
export type EvalHumanOverride = (typeof EVAL_HUMAN_OVERRIDES)[number]

/** `eval_run.outcome`: the 3-state roll-up (spec §3.1). "verdict" is reserved
 *  — it already means a triage skill's structured decision. */
export const EVAL_RUN_OUTCOMES = ['passed', 'scored', 'failed'] as const
export type RunOutcome = (typeof EVAL_RUN_OUTCOMES)[number]

/** `eval_trial.outcome`: the run roll-up plus `errored`, which is what a
 *  harness failure scores as instead of a zero. */
export const EVAL_TRIAL_OUTCOMES = [...EVAL_RUN_OUTCOMES, 'errored'] as const
export type TrialOutcome = (typeof EVAL_TRIAL_OUTCOMES)[number]

/** `recipe_prompt_version.status`. `proposed` is staged by the assistant and
 *  needs a Promote click (spec §7). */
export const PROMPT_VERSION_STATUSES = ['saved', 'proposed'] as const
export type PromptVersionStatus = (typeof PROMPT_VERSION_STATUSES)[number]

// ---------------------------------------------------------------------------
// The case: script, frozen chunks, expected outcomes
// ---------------------------------------------------------------------------

/**
 * One line of a synthetic meeting. `t_ms` is the offset from the start of the
 * call — the ONLY clock the replay knows, since the real TranscriptGate reads
 * wall time and an instant replay through it would collapse into one flush
 * (decision 1).
 *
 * `stream` is what makes the chunk cadence realistic: the self-speaker is on
 * `mic`, everyone else on `system`, and the gate only flushes when BOTH have
 * been quiet.
 */
export type ScriptSegment = {
  t_ms: number
  speaker: string
  stream: 'mic' | 'system'
  text: string
}

/**
 * One frozen flush window, computed once at authoring time by
 * {@link import('./freeze-chunks').freezeChunks} and replayed at any speed.
 *
 * `text` is the `[speaker]: text` join the gate's own `doFlush` emits, stored
 * so the driver posts BYTE-IDENTICAL windows to what a real meeting would have
 * produced — and so the size floor stays checkable without re-formatting.
 */
export type FrozenChunk = {
  index: number
  t_ms_start: number
  t_ms_end: number
  segment_indices: number[]
  text: string
}

/** One proposal the agent is expected to make. `gist` is prose because the
 *  matcher is an LLM (spec §6.3); `must_have` is structural because those are
 *  fields, not phrasing. */
export type ExpectedProposal = {
  key: string
  entity_type: string
  change_type: string
  gist: string
  must_have?: Record<string, string>
  severity?: Severity
}

/** A proposal that must NOT appear, or any other gist-shaped expectation.
 *  Prose only — a forbidden item has no fields to check. */
export type ExpectedGist = {
  key: string
  gist: string
  severity?: Severity
}

/** A `say_to_user` nudge the agent should give, optionally windowed by chunk
 *  index. Ground truth is the driver's own subscription log, never
 *  `chat_messages` (the broadcast is what the desktop HUD shows). */
export type ExpectedNudge = {
  key: string
  after_chunk?: number
  before_chunk?: number
  about: string
  severity?: Severity
}

/** One free-form judge criterion — the escape hatch for expectations that do
 *  not fit any structured grader. */
export type RubricItem = {
  key: string
  criterion: string
  severity?: Severity
}

/** A window in which the agent must stay quiet, by chunk index, both ends
 *  inclusive. Graded free by `nudge_quiet_window`. */
export type NoNudgeWindow = {
  from_chunk: number
  to_chunk: number
  severity?: Severity
}

/**
 * A directive the driver injects mid-replay: what the user asks the
 * note-taker to record, as they would type it after `@notes`
 * (live-agent messaging L5). It is written through the same writer as the
 * chat's `@notes`, by the run starter, so the route reads it like any other.
 *
 * Graded free: the record (the summary and the proposals) must contain every
 * `must_contain` phrase, matched case-insensitively with whitespace collapsed.
 * Name what must survive (a person, a date, an amount), not the phrasing.
 */
export type ExpectedDirective = {
  key: string
  text: string
  /** Live: injected once this chunk's flush completes, then the record turn
   *  the client runs (L3). Omitted: before the first chunk, so the first
   *  window carries it. Past the last chunk: after the last. Batch: ignored,
   *  every directive is pending when the one pass runs. */
  after_chunk?: number
  must_contain: string[]
  severity?: Severity
}

/** Deterministic tool-call expectations, graded free over the trace's
 *  tool-call log. */
export type ExpectedTools = {
  must_call?: string[]
  must_not_call?: string[]
  max_calls?: number
}

/** `eval_case.expected` — the whole grading contract for one case (spec §6.1).
 *  Everything is optional: a negative control may carry only
 *  `forbidden_proposals`, and a summary-only case only `summary`. */
export type ExpectedOutcomes = {
  proposals?: ExpectedProposal[]
  forbidden_proposals?: ExpectedGist[]
  nudges?: ExpectedNudge[]
  no_nudge_windows?: NoNudgeWindow[]
  summary?: string
  tool_usage?: string
  rubric?: RubricItem[]
  /** Answers the driver feeds back to a pending `ask_user`. A case with no
   *  answers map and a pending question errors the trial, because an
   *  unanswered question changes every later flush's prompt state. */
  answers?: Record<string, string>
  tools?: ExpectedTools
  /** Directives the driver injects mid-replay, and what the record must then
   *  contain. */
  directives?: ExpectedDirective[]
  /** The person's goal for the call, in their words (at most 500 characters,
   *  the `meeting_goal` limit). Each trial writes it as the trial capture's
   *  `meeting_goal` row, so the live agent reads it under "Before the call"
   *  exactly as on a real call, and `judge_nudges` grades timeliness against
   *  it. */
  goal?: string
  /** A ceiling on the trial's nudges (`nudge_count`). Without one the count
   *  is reported, never graded: the sidekick has no quota. */
  max_nudges?: number
  /** True when the case expects an opening brief: a nudge before anyone but
   *  the person has spoken is then allowed. Otherwise it fails
   *  `nudge_after_first_speaker`. */
  opening_brief?: boolean
  /** The most chunks a nudge may land after the chunk it was produced for,
   *  on the script's own clock (`nudge_latency`). Without it the lateness is
   *  reported, never graded. */
  max_nudge_lag_chunks?: number
}

/**
 * One participant of the synthetic meeting. Deliberately NOT a CRM shape: an
 * eval capture's `capture_participant` rows carry no `contact_id` and no
 * `member_id` (except the self row's member link), which is what keeps a mock
 * sales call off a real contact's timeline by construction.
 */
export type EvalParticipant = {
  speaker_label: string
  display: string
  is_self?: boolean
  role?: string
}

// ---------------------------------------------------------------------------
// The trace (spec §4.5)
// ---------------------------------------------------------------------------

/** One tool call the agent made, as recorded from the route's response. */
export type TraceToolCall = {
  tool: string
  args: unknown
}

/** One nudge, as seen on `agent-nudge:<captureId>` by the driver's own
 *  subscription. */
export type TraceNudge = {
  id: string
  kind: string
  message: string
  ts: number
}

/** One flush: the window that went in and everything that came back out.
 *  `finish_reason: 'step-ceiling'` marks the proposals dimension `unknown` for
 *  the trial — a truncated flush measures the budget, not the prompt. */
export type FlushRecord = {
  index: number
  t_ms: number
  chars: number
  chunk_text: string
  response: {
    tool_calls: number
    tool_call_details: TraceToolCall[]
    duration_ms: number
  }
  steps_used?: number
  finish_reason?: string
  /** The turn budget that stopped the flush early (the route's `budget_hit`:
   *  'steps' | 'step-output' | 'turn-output' | 'step-reasoning' | 'deadline'). Like the step
   *  ceiling, a flush cut off at any budget measured the budget, not the prompt. */
  budget_hit?: string
  nudges: TraceNudge[]
  /** Epoch ms the driver sent this flush's POST (it reports `window_age_ms: 0`).
   *  A nudge's `ts` minus this is its time-to-nudge; older traces lack it, and
   *  the latency check falls back to `response.duration_ms` as an upper bound. */
  started_at_ms?: number
  /** `say_to_user` calls the route's time guard dropped as stale (requested,
   *  so in `tool_call_details`, but never broadcast): intentional, not
   *  missing, to the nudge log. */
  stale_nudge_drops?: number
  /** `say_to_user` calls a nudge.worth gate held: like a stale drop, never
   *  broadcast, so intentional to the nudge log. 0 while the gate is shadow. */
  held_nudge_drops?: number
  /** A record-only turn the driver ran after injecting directives (L5): no
   *  new transcript, so `chunk_text` is empty and `index` is the chunk it
   *  followed. */
  record_only?: true
  /** 'notes' when the record turn went to the paired note-taker. */
  live_role?: 'notes'
  /** The directives injected just before this record turn. */
  directive_keys?: string[]
}

/** A directive the driver injected, and what became of it by the end of the
 *  trial (`live_directive.status`): `consumed` means a record-writing turn
 *  read it and completed. */
export type TraceDirective = {
  key: string
  id: string
  text: string
  /** The chunk it followed; null when it went in before the first chunk, or
   *  on a batch trial. */
  after_chunk: number | null
  /** null when the read-back failed. */
  status: 'pending' | 'consumed' | 'expired' | null
  consumed_session: string | null
}

/** A final proposal read back off the capture, with the counterfactual the
 *  report-mode gate recorded: `would_have_applied` is the highest-cost failure
 *  mode a prompt edit can introduce (spec §1). */
export type TraceProposal = {
  id: string
  entity_type: string
  change_type: string
  title: string | null
  display_text: string
  confidence: number | null
  status: string
  assignee_name?: string | null
  gate?: {
    decision: string
    would_have_applied: boolean
  }
}

/** A `record_commitment` call, keyed off the tool's INPUT schema
 *  (`{person_name, commitment, trigger_quote, confidence}`). No `claim` row is
 *  ever written for an eval capture, so the tool call IS the gradeable signal
 *  (spec §5.1) — which means `text` carrying the real commitment matters. */
export type TraceCommitment = {
  /** The commitment itself — `record_commitment`'s `commitment` argument. */
  text: string
  /** Who committed — the tool's `person_name`. */
  subject?: string
  /** The transcript line the model cited, when it cited one. Evidence a reader
   *  (or a judge) can check the detection against. */
  trigger_quote?: string
  confidence?: number
}

export type TraceUsage = {
  tokens_in: number
  tokens_out: number
  cost_usd: number
  model: string
  /** What the GRADERS spent on this trial — the judges' frontier calls and the
   *  matcher's decision call — billed to the run and broken out here so the
   *  target model's own cost stays readable next to it (spec §6.4). Written
   *  after grading, so a trace read before grading legitimately lacks it. */
  grading_cost_usd?: number
  /** Tokens the graders spent, same provenance as `grading_cost_usd`. */
  grading_tokens_in?: number
  grading_tokens_out?: number
}

/** `eval_trial.trace` — the durable record of one trial. Retention deletes
 *  trial CAPTURES, never this. */
export type EvalTrace = {
  mode: EvalMode
  speed: EvalSpeed
  driver: EvalDriver
  flushes: FlushRecord[]
  proposals_final: TraceProposal[]
  summary_final: string | null
  /** `'none'` when the model never wrote one — the batch safety net is skipped
   *  for eval captures, so a missing summary is signal, not a gap. */
  summary_source: 'model' | 'none'
  title_final: string | null
  commitments: TraceCommitment[]
  /** What real workspace data the agent looked at (spec §5.3). */
  reads: TraceToolCall[]
  usage: TraceUsage
  /** Present only when the case injects directives. */
  directives?: TraceDirective[]
}

// ---------------------------------------------------------------------------
// Run progress and scores
// ---------------------------------------------------------------------------

/** `eval_run.progress`. Countable, never a percentage — the run-rail rule. */
export type RunProgress = {
  cases_total: number
  trials_total: number
  trials_done: number
  stage: string
}

/** One dimension's aggregate. `rate` is null when every check was `unknown` or
 *  `skipped`: those are excluded from the denominator, and 0/0 is not a zero. */
export type DimensionScore = {
  pass: number
  fail: number
  unknown: number
  skipped: number
  rate: number | null
}

/** `eval_run.scores`, keyed by {@link EvalDimension}. Typed as a loose record
 *  because a stored run from an older shape must still parse. */
export type RunScores = Record<string, DimensionScore>

// ---------------------------------------------------------------------------
// Row types — one field per column of migration 252
// ---------------------------------------------------------------------------

export type EvalSuiteRow = {
  id: string
  workspace_id: string
  name: string
  description: string | null
  target_kind: EvalTargetKind
  target_recipe_id: string | null
  suite_kind: EvalSuiteKind
  /** Nightly re-run against the live prompt. */
  watch: boolean
  /** Gateway catalog slug; null = the workspace default judge. */
  judge_model: string | null
  created_by: string | null
  created_at: string
  updated_at: string
  // ── Denormalized summary (migration 255) ──
  // Kept current by triggers on eval_case and eval_run. They live on the suite
  // rather than being computed at read time because a views-system list can
  // only filter, group and sort on REAL columns.
  case_count: number
  /** The most recent run by started_at, ANY status. */
  last_run_at: string | null
  last_run_mode: EvalMode | null
  /** The most recent SETTLED run's verdict: its outcome when completed,
   *  'errored' when the run itself failed or was cancelled. A run in flight
   *  does not clear the previous verdict. */
  last_outcome: RunOutcome | 'errored' | null
}

export type EvalCaseRow = {
  id: string
  suite_id: string
  workspace_id: string
  name: string
  /** The TEMPLATE eval capture. Trials clone it; nothing ever runs against it. */
  capture_id: string
  /** Always true. Half of the composite FK that makes "an eval case points at a
   *  real capture" a constraint violation rather than a bug class. */
  capture_is_eval: boolean
  script: ScriptSegment[]
  chunks: FrozenChunk[]
  expected: ExpectedOutcomes
  modes: EvalMode[]
  polarity: EvalPolarity
  seeded_from_capture_id: string | null
  visibility: EvalCaseVisibility
  /** Load-bearing, not decorative: `eval_case`'s SELECT policy is
   *  `visibility = 'workspace' OR created_by = auth.uid()`, so a case seeded
   *  from a private capture stays creator-only. The rule cannot be expressed
   *  without this column. */
  created_by: string | null
  sort_order: number
  created_at: string
  updated_at: string
}

export type RecipePromptVersionRow = {
  id: string
  recipe_id: string
  workspace_id: string | null
  system_prompt: string | null
  agent_config: Record<string, unknown> | null
  model: string | null
  /** sha256(system_prompt || model || agent_config). */
  content_hash: string
  status: PromptVersionStatus
  label: string | null
  rationale: string | null
  created_by: string | null
  created_at: string
}

export type EvalRunRow = {
  id: string
  suite_id: string
  workspace_id: string
  mode: EvalMode
  speed: EvalSpeed
  driver: EvalDriver
  trials_per_case: number
  target_recipe_id: string | null
  target_prompt_version_id: string | null
  /** Computed from the LIVE recipe at queue time. */
  target_prompt_hash: string
  /** Denormalized: a run remembers what it tested, because an FK to a mutable
   *  row would lie the moment someone edits the prompt (spec §9). */
  target_system_prompt: string | null
  target_agent_config: Record<string, unknown> | null
  target_model: string | null
  status: EvalRunStatus
  /** Generated column: `status in ('queued','running')`. The poll contract
   *  gates on this server-authored flag, never on a client guess. */
  is_live: boolean
  progress: RunProgress | Record<string, never>
  outcome: RunOutcome | null
  scores: RunScores
  estimated_cost_usd: number | null
  cost_usd: number
  max_cost_usd: number | null
  tokens_in: number
  tokens_out: number
  duration_ms: number | null
  baseline_run_id: string | null
  started_by: string | null
  started_at: string
  ended_at: string | null
  error_code: string | null
  error_message: string | null
}

export type EvalTrialRow = {
  id: string
  run_id: string
  case_id: string
  workspace_id: string
  trial_index: number
  /** This trial's OWN capture clone — the route re-reads pending proposals
   *  every call, so a shared capture would leak trial 1 into trial 2 (§3.4). */
  capture_id: string
  capture_is_eval: boolean
  status: EvalTrialStatus
  outcome: TrialOutcome | null
  trace: EvalTrace | Record<string, never>
  cost_usd: number
  tokens_in: number
  tokens_out: number
  duration_ms: number | null
  /** Retention (spec decision 5): the nightly sweep deletes UNPINNED trial
   *  captures older than 30 days. It deletes captures, never trials — the
   *  trace is the durable record — so this is where the sweep reads the pin. */
  is_pinned: boolean
  started_at: string
  ended_at: string | null
  error_code: string | null
  error_message: string | null
}

/**
 * The step-ceiling grader's name, shared so the producer and every reader spell
 * it identically.
 *
 * It lives HERE rather than in `graders/deterministic.ts` because the UI needs
 * it and that module imports `run-trial.ts`, which pulls the Supabase service
 * client into any client bundle that touches it. A name matched by hand on the
 * read side is a predicate that can silently match nothing — the always-on gate
 * that surfaces "this turn measured the budget, not the prompt" would then never
 * reach the results table.
 */
export const STEP_CEILING_GRADER = 'no_step_ceiling_hit' as const

export type EvalCheckRow = {
  id: string
  trial_id: string
  workspace_id: string
  dimension: EvalDimension
  /** 'tool_called' | 'proposal_match' | 'judge_summary' | … */
  grader: string
  /** Stable across runs; the compare view joins on it. */
  check_key: string
  label: string
  severity: Severity
  outcome: CheckOutcome
  score: number | null
  threshold: number | null
  rationale: string | null
  /** Mandatory for judges: quotes, proposal ids, chunk indices, match_method. */
  evidence: Record<string, unknown> | null
  human_override: EvalHumanOverride | null
  human_note: string | null
  created_at: string
}
