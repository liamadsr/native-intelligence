import type { SupabaseClient } from '@supabase/supabase-js'
import { tool } from 'ai'
import { z } from 'zod'
import { recipeIsVisible } from '@/app/api/account/evals/suites/target-recipe'
import { getServiceClient } from '@/lib/admin'
import { createEvalCase, updateEvalCase } from '@/lib/evals/create-case'
import { estimateRunCostUsd } from '@/lib/evals/estimate'
import { getRunDetail, latestCompletedRun, listCases, listSuites } from '@/lib/evals/queries'
import { startEvalRun } from '@/lib/evals/start-run'
import { EVAL_MODES, RUNNABLE_EVAL_SPEEDS } from '@/lib/evals/types'
import { LIVE_DIRECTIVE_MAX_CHARS } from '@/lib/live-agent/directives'
import type {
  EvalCaseRow,
  EvalCheckRow,
  EvalMode,
  EvalTrace,
  EvalTrialRow,
  ExpectedOutcomes,
  ScriptSegment,
} from '@/lib/evals/types'
import { resolveCreateWorkspace, resolveEntityWorkspace, workspaceEcho, type CreateWorkspacePolicy } from './_shared'

/**
 * Eval authoring and running FROM CHAT — the tools behind the `/create-eval`
 * system skill (migration 253).
 *
 * An eval case in Dial8 is not a prompt/output pair, it is a SYNTHETIC MEETING:
 * a timed, speaker-labeled transcript plus the outcomes the agent under test
 * should and should not produce. That is why the interesting steering lives in
 * `create_eval_case`'s description rather than in a route — writing a mock call
 * that looks like real Deepgram output is the hard part of the whole feature
 * (spec §12, risk 2), and the tool description is the only place the model
 * reads before it writes one.
 *
 * NAMING IS LOAD-BEARING. `create_`/`update_`/`start_` are write verbs in
 * `MUTATING_TOOL_NAME_RE`, `list_`/`get_` are read-shaped in
 * `isReadShapedToolName` — so every tool here classifies for report mode and
 * the MCP read-only guard with NO registry allowlist edit. `run_eval` would
 * have matched neither, which is exactly why the verb is `start_`.
 *
 * TWO CLIENTS, deliberately. Reads run on the caller's own RLS client, so a
 * member only ever sees suites their workspace membership admits. The three
 * writes that touch `captures` (create/update a case, start a run and its
 * per-trial clones) run on the SERVICE client, because an eval capture's
 * participant and conversation rows span tables the caller's role cannot always
 * reach — the same split `src/lib/evals/create-case.ts` documents. Workspace
 * membership is established by the chat route before these ever run, and every
 * service-client write carries an explicit `workspace_id`.
 *
 * WORKSPACE ROUTING (see _shared.ts "CREATE-TIME WORKSPACE ROUTING"):
 * `create_eval_suite` is a ROOT create — it takes an optional `workspace_id`
 * and resolves it through `resolveCreateWorkspace`. `create_eval_case` is
 * PARENT-ANCHORED — it takes no `workspace_id` of its own and instead routes
 * by its `suite_id` through `resolveEntityWorkspace` on `eval_suite` (a
 * foreign-but-member suite is fine; under `strictWorkspace` the parent must be
 * in the session workspace). `update_eval_case` and `start_eval_run` route the
 * same way, by `case_id` / `suite_id` respectively. `list_evals` and
 * `get_eval_run` are unconverted reads, pinned to the session workspace.
 */

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const scriptSegmentSchema = z.object({
  t_ms: z
    .number()
    .int()
    .min(0)
    .describe(
      'Milliseconds from the start of the call. Turn boundaries need ≥3000ms gaps — that silence is what makes the agent flush, and a script with no gaps collapses into one giant chunk.',
    ),
  speaker: z.string().describe('Speaker label, matching a participant\'s speaker_label exactly.'),
  stream: z
    .enum(['mic', 'system'])
    .describe(
      'The self participant (the Dial8 user) is on "mic"; every other speaker is on "system". The gate only flushes when BOTH streams have gone quiet, so this split is what produces a realistic chunk cadence.',
    ),
  text: z.string().describe('What was said. Write it the way a transcriber would — see the tool description.'),
})

const participantSchema = z.object({
  speaker_label: z
    .string()
    .describe(
      'The label used in the script. The is_self participant MUST be "local_1" — the engine only binds that one label to the owner, and any other self label is revoked on the first turn, so every "assignee":"self" expectation then silently misses. Everyone else is "remote_1", "remote_2", … in order.',
    ),
  display: z.string().describe('Display name, e.g. "Dana Whitfield".'),
  is_self: z
    .boolean()
    .optional()
    .describe('True for exactly ONE participant — the Dial8 user whose meeting this is.'),
  role: z.string().optional().describe('e.g. "organizer", "attendee", "prospect".'),
})

/**
 * The one label the engine binds to the owner.
 *
 * `seedEvalSelfParticipant` stamps the authored self label with
 * `self_binding: 'position'`, and `resolveSelfBinding` re-derives that evidence
 * from the trial clone's transcript by matching `/\[(local_\d+)\]/` — so a self
 * participant called anything else has its binding REVOKED on the first live
 * turn, the speaker map can no longer resolve the owner, and every
 * `must_have: {"assignee":"self"}` expectation grades as a miss with no error
 * anywhere. Caught here, on both authoring doors, rather than measured as a
 * silently empty case.
 */
export const SELF_SPEAKER_LABEL = 'local_1'

/** The complaint both `create_eval_case` doors return for a mislabeled self. */
export function selfLabelProblem(
  participants: { speaker_label: string; is_self?: boolean }[],
): string | null {
  const self = participants.find((p) => p.is_self)
  if (!self) return null
  if (self.speaker_label.trim() === SELF_SPEAKER_LABEL) return null
  return `The is_self participant must have speaker_label "${SELF_SPEAKER_LABEL}", not "${self.speaker_label}" — the engine only binds that label to the owner, so any other one makes every "assignee":"self" expectation miss. Rename it in both participants and the script, and label everyone else remote_1, remote_2, and so on.`
}

const severitySchema = z
  .enum(['gate', 'soft'])
  .optional()
  .describe('gate = the trial FAILS when this misses. soft = it scores lower. Default soft.')

const expectedSchema = z
  .object({
    proposals: z
      .array(
        z.object({
          key: z.string().describe('Stable identifier, e.g. "send_questionnaire". The compare view joins runs on it, so never renumber it.'),
          entity_type: z.string().describe('e.g. "action", "decision", "contact".'),
          change_type: z.string().describe('e.g. "create", "update".'),
          gist: z.string().describe('Prose — an LLM decides "same item, yes/no", so phrasing need not match.'),
          must_have: z
            .record(z.string(), z.string())
            .optional()
            .describe('Structural fields checked EXACTLY, e.g. {"assignee":"self"}. Fields, not phrasing.'),
          severity: severitySchema,
        }),
      )
      .optional()
      .describe('Proposals the agent SHOULD make.'),
    forbidden_proposals: z
      .array(
        z.object({
          key: z.string(),
          gist: z.string().describe('e.g. "Any commitment with Dana as the owner".'),
          severity: severitySchema,
        }),
      )
      .optional()
      .describe('Proposals the agent must NOT make. A negative-control case may carry only these.'),
    nudges: z
      .array(
        z.object({
          key: z.string(),
          after_chunk: z.number().int().min(0).optional().describe('Earliest chunk index the nudge may fire on.'),
          before_chunk: z.number().int().min(0).optional().describe('Latest chunk index it may fire on.'),
          about: z.string().describe('What the nudge should be about, in prose.'),
          severity: severitySchema,
        }).refine(
          (n) => n.after_chunk === undefined || n.before_chunk === undefined || n.before_chunk >= n.after_chunk,
          { message: 'before_chunk must be at or after after_chunk', path: ['before_chunk'] },
        ),
      )
      .optional()
      .describe('Live-mode say_to_user nudges the agent should give mid-call.'),
    no_nudge_windows: z
      .array(
        z.object({
          from_chunk: z.number().int().min(0),
          to_chunk: z.number().int().min(0),
          severity: severitySchema,
        }),
      )
      .optional()
      .describe('Chunk ranges (both ends inclusive) the agent must stay QUIET through.'),
    goal: z
      .string()
      .max(500)
      .optional()
      .describe('The goal of the call, in their own words. Each trial sets it as the meeting goal, so the live agent sees it under Before the call; judge_nudges grades timeliness against it.'),
    max_nudges: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('A ceiling on live nudges. Without it the count is reported, never graded: the agent has no quota.'),
    opening_brief: z
      .boolean()
      .optional()
      .describe('True when a nudge before anyone but the person has spoken is expected (an opening brief). Otherwise such a nudge fails.'),
    max_nudge_lag_chunks: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('The most chunks a nudge may land after its moment, simulated on the call\'s own clock. Without it lateness is reported, never graded.'),
    summary: z
      .string()
      .optional()
      .describe(
        'Prose, graded by one judge: what the summary must state and must not invent. e.g. "Must state the prospect pushed back on price and must not invent a commitment nobody made."',
      ),
    tool_usage: z
      .string()
      .optional()
      .describe('Prose, graded by one judge. e.g. "Should not call propose_mcp_call; should not draft an email."'),
    rubric: z
      .array(z.object({ key: z.string(), criterion: z.string(), severity: severitySchema }))
      .optional()
      .describe('Free-form judge criteria — the escape hatch for anything the structured graders miss.'),
    answers: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        'Answers the replay driver feeds back to a pending ask_user, keyed loosely by topic. A live case where the agent may ask a question and has NO answers map errors the trial, because an unanswered question changes every later flush.',
      ),
    tools: z
      .object({
        must_call: z.array(z.string()).optional(),
        must_not_call: z.array(z.string()).optional(),
        max_calls: z.number().int().min(1).optional(),
      })
      .optional()
      .describe('Deterministic tool-call assertions, graded free over the trace.'),
    directives: z
      .array(
        z.object({
          key: z.string(),
          text: z
            .string()
            .min(1)
            .max(LIVE_DIRECTIVE_MAX_CHARS)
            .describe('What the user asks the note-taker to record, as typed after @notes. e.g. "Dana owns the budget".'),
          after_chunk: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe('Live: the chunk it lands after (a record turn follows). Omit to land before the first chunk. Batch ignores it.'),
          must_contain: z
            .array(z.string().min(1))
            .min(1)
            .describe('Phrases the summary or a proposal must contain, case-insensitive, e.g. ["Dana", "budget"]. Names and facts, not phrasing.'),
          severity: severitySchema,
        }),
      )
      .optional()
      .describe('Directives the replay driver injects mid-meeting, as the user typing @notes; graded free on whether the record then contains them.'),
  })
  .describe('The grading contract. Every field is optional — see the tool description for a worked example.')

// ---------------------------------------------------------------------------
// Shared shaping helpers
// ---------------------------------------------------------------------------

/** The case shape a tool hands back: everything but the two fat derived
 *  columns, whose SIZE is the useful signal rather than their content. */
export function evalCaseSummary(row: EvalCaseRow) {
  return {
    id: row.id,
    suite_id: row.suite_id,
    name: row.name,
    capture_id: row.capture_id,
    polarity: row.polarity,
    modes: row.modes,
    chunk_count: row.chunks?.length ?? 0,
    segment_count: row.script?.length ?? 0,
    expected_counts: expectedCounts(row.expected),
  }
}

/** How many expectations of each kind a case carries — the number the author
 *  actually wants to see back, not the objects they just typed. */
function expectedCounts(expected: ExpectedOutcomes | null | undefined) {
  const e = expected ?? {}
  return {
    proposals: e.proposals?.length ?? 0,
    forbidden_proposals: e.forbidden_proposals?.length ?? 0,
    nudges: e.nudges?.length ?? 0,
    no_nudge_windows: e.no_nudge_windows?.length ?? 0,
    rubric: e.rubric?.length ?? 0,
    has_summary: Boolean(e.summary),
    has_tool_usage: Boolean(e.tool_usage),
    directives: e.directives?.length ?? 0,
    has_goal: Boolean(e.goal),
  }
}

/** Cadence facts worth quoting back so the author can sanity-check a script
 *  before spending money on it: a 12-minute call that froze into two chunks
 *  has no turn silences and will not exercise live mode at all. */
export function evalCadence(script: ScriptSegment[], chunkCount: number) {
  const last = script.length > 0 ? script[script.length - 1].t_ms : 0
  return {
    chunk_count: chunkCount,
    segment_count: script.length,
    duration_ms: last,
    duration_minutes: Math.round((last / 60000) * 10) / 10,
  }
}

/** The failing checks a run reports, with the rationale that makes them
 *  actionable. Passing checks are the bulk and carry no information here. */
export function evalFailingChecks(trials: (EvalTrialRow & { checks: EvalCheckRow[]; case_name: string })[]) {
  const out: {
    case_name: string
    trial_index: number
    dimension: string
    check_key: string
    label: string
    severity: string
    outcome: string
    rationale: string | null
  }[] = []
  for (const trial of trials) {
    for (const check of trial.checks) {
      if (check.outcome !== 'fail') continue
      out.push({
        case_name: trial.case_name,
        trial_index: trial.trial_index,
        dimension: check.dimension,
        check_key: check.check_key,
        label: check.label,
        severity: check.severity,
        outcome: check.outcome,
        rationale: check.rationale,
      })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

export function createEvalTools(
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  strictWorkspace = false,
  createWorkspacePolicy: CreateWorkspacePolicy = 'session',
) {
  return {
    create_eval_suite: tool({
      description:
        'Create an eval suite — a named set of synthetic-meeting cases that grade ONE agent or skill. ' +
        'Always read the target recipe\'s own prompt first (get_skill, or list_recipes then get_skill) so the ' +
        'cases probe what that prompt actually claims to do, and ask the user what failure prompted this suite: ' +
        'a suite written from a real observed failure beats one written from imagination. ' +
        'Use suite_kind "regression" when the point is that these cases must stay green, "capability" when the ' +
        'point is watching a number climb.',
      inputSchema: z.object({
        name: z.string().describe('Short name, e.g. "Sales Discovery". No trailing punctuation.'),
        target_kind: z
          .enum(['agent', 'skill'])
          .describe('agent = a live-meeting persona; skill = a chat/loop preset.'),
        target_recipe_id: z
          .string()
          .optional()
          .describe('UUID of the agent or skill under test, from list_recipes / list_skills.'),
        description: z.string().optional().describe('One line on what this suite is for.'),
        suite_kind: z
          .enum(['capability', 'regression'])
          .optional()
          .describe('Defaults to "capability".'),
        judge_model: z
          .string()
          .optional()
          .describe('Gateway catalog slug for the judge. Omit to use the workspace default (a frontier model).'),
        workspace_id: z
          .string()
          .optional()
          .describe(
            'Workspace to create in. Defaults to the active workspace. Copy it from the workspace_id on rows you read, or from active_workspace.',
          ),
      }),
      execute: async ({ name, target_kind, target_recipe_id, description, suite_kind, judge_model, workspace_id }) => {
        const trimmed = name.trim()
        if (!trimmed) return { success: false, error: 'Name is required' }

        const ws = await resolveCreateWorkspace(supabase, userId, workspaceId, workspace_id, {
          strictWorkspace,
          policy: createWorkspacePolicy,
        })
        if (!ws.ok) return ws.error
        const targetWs = ws.workspaceId

        // Resolve the target before the insert, against the TARGET workspace —
        // never the session's. The eve executor path builds these tools with
        // the SERVICE client, so the predicate — not RLS — is what keeps
        // another workspace's private agent prompt out of the run snapshot.
        if (target_recipe_id) {
          const visible = await recipeIsVisible(supabase, target_recipe_id, targetWs, userId)
          if (visible === 'error') return { success: false, error: 'Target recipe check failed' }
          if (!visible) {
            return {
              success: false,
              error: 'No agent or skill with that target_recipe_id is visible here — call list_recipes or list_skills and use an id from there.',
            }
          }
        }

        const insert: Record<string, unknown> = {
          workspace_id: targetWs,
          name: trimmed,
          target_kind,
          suite_kind: suite_kind ?? 'capability',
          created_by: userId,
        }
        if (target_recipe_id !== undefined) insert.target_recipe_id = target_recipe_id
        if (description !== undefined) insert.description = description
        if (judge_model !== undefined) insert.judge_model = judge_model

        const { data, error } = await supabase
          .from('eval_suite')
          .insert(insert)
          .select('id, workspace_id, name, description, target_kind, target_recipe_id, suite_kind, watch, judge_model, created_by, created_at, updated_at')
          .single()

        if (error) return { success: false, error: error.message }
        return {
          success: true,
          suite: data,
          ...workspaceEcho(targetWs, ws.workspaceName),
          message:
            'Suite created. Now write ONE case with create_eval_case, show the user the script and the expected outcomes, and confirm before fanning out to the rest.',
        }
      },
    }),

    create_eval_case: tool({
      description:
        'Write one synthetic meeting and the outcomes it should produce. This is the workhorse — everything ' +
        'the suite ever measures comes from the quality of these scripts.\n\n' +
        'THE SCRIPT is an array of {t_ms, speaker, stream, text}, ordered by t_ms:\n' +
        '  • stream — the Dial8 user (the participant with is_self) speaks on "mic"; EVERY other speaker is on ' +
        '"system". The agent only flushes when both streams have been quiet, so getting this wrong destroys the ' +
        'chunk cadence and makes live mode meaningless.\n' +
        '  • t_ms — leave ≥3000ms of silence at turn boundaries (that silence is what triggers a flush) and let ' +
        'lines inside one speaker\'s turn run 400-1500ms apart. A 12-15 minute call is the realistic length.\n' +
        '  • text — write what a TRANSCRIBER would emit, not what a screenwriter would: disfluency ("um", "so, ' +
        'yeah"), self-correction, a sentence someone talks over, occasional crosstalk, no stage directions and no ' +
        'perfect punctuation. Clean dialogue scores high and predicts nothing.\n' +
        '  • Include at least ONE genuinely ambiguous moment per case — a commitment that might be someone else\'s, ' +
        'a date that is "next week sometime", a name said once and never repeated. Those are the moments a prompt ' +
        'edit actually changes.\n\n' +
        'PARTICIPANTS: one entry per speaker_label used in the script, with exactly one is_self. Nothing here ever ' +
        'links to a real CRM contact — these people are synthetic by construction.\n\n' +
        'EXPECTED, worked example:\n' +
        '  {"proposals":[{"key":"send_questionnaire","entity_type":"action","change_type":"create",' +
        '"gist":"Send Dana the security questionnaire","must_have":{"assignee":"self"},"severity":"gate"}],\n' +
        '   "forbidden_proposals":[{"key":"no_dana_owner","gist":"Any commitment with Dana as the owner",' +
        '"severity":"gate"}],\n' +
        '   "summary":"Must state the prospect pushed back on price and must not invent a commitment nobody made.",\n' +
        '   "tools":{"must_call":["propose_change"],"must_not_call":["propose_mcp_call"]}}\n\n' +
        'Write at least two NEGATIVE controls per suite (polarity "negative"): a call where the right behavior is ' +
        'to propose nothing. A suite of only positive cases cannot detect an agent that proposes everything.\n\n' +
        'Returns the case with its frozen chunk_count — check it against the call\'s length before writing more ' +
        'cases. Roughly one chunk per turn-cluster; two chunks for a 15-minute call means the silences are missing.',
      inputSchema: z.object({
        suite_id: z.string().describe('The suite UUID from create_eval_suite or list_evals.'),
        name: z.string().describe('What this case probes, e.g. "Prospect stalls on pricing".'),
        script: z.array(scriptSegmentSchema).min(1).describe('The synthetic meeting, ordered by t_ms.'),
        participants: z.array(participantSchema).min(1).describe('One per speaker_label; exactly one is_self.'),
        expected: expectedSchema,
        polarity: z
          .enum(['positive', 'negative'])
          .optional()
          .describe('"negative" = a control where the agent should do nothing. Defaults to "positive".'),
        modes: z
          .array(z.enum(EVAL_MODES))
          .optional()
          .describe('Which run modes this case is valid for. Defaults to both.'),
      }),
      execute: async ({ suite_id, name, script, participants, expected, polarity, modes }) => {
        const trimmed = name.trim()
        if (!trimmed) return { success: false, error: 'Name is required' }
        if (participants.filter((p) => p.is_self).length !== 1) {
          return {
            success: false,
            error: 'Exactly one participant must have is_self: true — the Dial8 user whose meeting this is.',
          }
        }
        const selfProblem = selfLabelProblem(participants)
        if (selfProblem) return { success: false, error: selfProblem }
        const labels = new Set(participants.map((p) => p.speaker_label))
        const unknownSpeakers = [...new Set(script.map((s) => s.speaker))].filter((s) => !labels.has(s))
        if (unknownSpeakers.length > 0) {
          return {
            success: false,
            error: `Script speakers with no participant entry: ${unknownSpeakers.join(', ')}. Add them to participants or fix the labels.`,
          }
        }

        // PARENT-ANCHORED create: no workspace_id param here — the case lands
        // wherever the suite lives. The read runs on the CALLER's client (it
        // is the membership check that licenses the service-client writes
        // below) and resolves a foreign-but-member suite_id to its OWN
        // workspace, exactly like resolveEntityWorkspace does for any other
        // caller-supplied id; under strictWorkspace the suite must already be
        // in the session workspace.
        const resolved = await resolveEntityWorkspace(
          supabase,
          userId,
          'eval_suite',
          suite_id,
          workspaceId,
          strictWorkspace,
        )
        if (!resolved) return { success: false, error: 'Suite not found in this workspace' }
        const targetWs = resolved.workspaceId

        const ordered = [...script].sort((a, b) => a.t_ms - b.t_ms)

        try {
          const created = await createEvalCase(getServiceClient(), {
            workspaceId: targetWs,
            userId,
            suiteId: suite_id,
            name: trimmed,
            script: ordered,
            participants,
            expected: expected as ExpectedOutcomes,
            polarity,
            modes: modes as EvalMode[] | undefined,
          })
          return {
            success: true,
            case: evalCaseSummary(created),
            capture_id: created.capture_id,
            chunk_count: created.chunks?.length ?? 0,
            cadence: evalCadence(ordered, created.chunks?.length ?? 0),
            message:
              'Case saved. Show the user the chunk count and the expected outcomes before writing the next case.',
          }
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : 'Failed to create eval case' }
        }
      },
    }),

    list_evals: tool({
      description:
        'List this workspace\'s eval suites with case counts, how the last run went, and the ESTIMATED COST of ' +
        'running each suite in each mode. Token-light — no scripts, no expected outcomes. ' +
        'Always call this and quote the estimate to the user before start_eval_run: a twenty-case suite is dollars, ' +
        'not cents, and judges are most of the bill.',
      inputSchema: z.object({
        suite_id: z.string().optional().describe('Narrow to one suite and include its case list.'),
        target_recipe_id: z.string().optional().describe('Only suites targeting this agent or skill.'),
        trials_per_case: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Attempts per case to price for. Defaults to 1.'),
      }),
      execute: async ({ suite_id, target_recipe_id, trials_per_case }) => {
        const trialsPerCase = trials_per_case ?? 1
        const all = await listSuites(supabase, workspaceId)
        const filtered = all.filter(
          (s) =>
            (!suite_id || s.id === suite_id) &&
            (!target_recipe_id || s.target_recipe_id === target_recipe_id),
        )

        const suites = filtered.map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          target_kind: s.target_kind,
          target_recipe_id: s.target_recipe_id,
          suite_kind: s.suite_kind,
          watch: s.watch,
          case_count: s.case_count,
          last_run: s.last_run,
          estimated_cost_usd: {
            batch: estimateRunCostUsd({ caseCount: s.case_count, mode: 'batch', trialsPerCase }),
            live: estimateRunCostUsd({ caseCount: s.case_count, mode: 'live', trialsPerCase }),
          },
        }))

        // listCases filters by suite_id alone and this may run service-role: only
        // list cases for a suite that passed the workspace-scoped read above.
        if (!suite_id || filtered.length === 0) return { success: true, suites, count: suites.length }

        // One suite named → the case list is what the author is asking for.
        const cases = (await listCases(supabase, suite_id)).map((c) => ({
          id: c.id,
          name: c.name,
          polarity: c.polarity,
          modes: c.modes,
        }))
        return { success: true, suites, count: suites.length, cases }
      },
    }),

    start_eval_run: tool({
      description:
        'Queue a run of one suite in one mode. Quote the estimated cost from list_evals FIRST and let the user ' +
        'say go — this spends real money.\n' +
        'batch = one end-of-meeting extraction per case, the cheap sweep. live = the transcript replayed chunk by ' +
        'chunk, which is what grades mid-call nudges. They exercise different prompts, so a prompt edit that helps ' +
        'one can hurt the other.\n' +
        'Returns { run_id, adopted, estimated_cost_usd }. adopted: true means a run of this suite and mode was ' +
        'ALREADY in flight and you are now watching that one — say so rather than claiming you started a new run. ' +
        'Poll get_eval_run for the outcome; a run is not instant.',
      inputSchema: z.object({
        suite_id: z.string().describe('The suite UUID.'),
        mode: z.enum(EVAL_MODES).describe('"batch" or "live".'),
        // Only the speeds that HAVE a driver. The watched replays (fast,
        // realtime) need the client driver and would sleep a live case past the
        // Inngest step ceiling, so the tool must not offer them — a tool
        // description is a recommendation, and this one used to recommend a
        // timeout.
        speed: z
          .enum(RUNNABLE_EVAL_SPEEDS)
          .optional()
          .describe(
            'Live only: "instant" (default, no waiting) — the transcript is replayed with no delay between chunks. ' +
              'The watched speeds (10× and real time) arrive with the replay screen; they cannot be started yet.',
          ),
        trials_per_case: z
          .number()
          .int()
          .min(1)
          .max(5)
          .optional()
          .describe('Attempts per case, for variance. Defaults to 1 and multiplies the cost.'),
        case_ids: z
          .array(z.string())
          .optional()
          .describe('Run only these cases — e.g. re-running just the ones that failed.'),
      }),
      execute: async ({ suite_id, mode, speed, trials_per_case, case_ids }) => {
        // Route by the suite, exactly as create_eval_case does — a run can be
        // started from a foreign-but-member suite_id, and everything it reads
        // or writes (cases, trials, the run row) belongs to THAT workspace.
        const resolved = await resolveEntityWorkspace(
          supabase,
          userId,
          'eval_suite',
          suite_id,
          workspaceId,
          strictWorkspace,
        )
        if (!resolved) return { success: false, error: 'Suite not found in this workspace' }
        const targetWs = resolved.workspaceId

        try {
          const { run, adopted, estimated_cost_usd } = await startEvalRun(getServiceClient(), {
            workspaceId: targetWs,
            userId,
            suiteId: suite_id,
            mode,
            speed,
            trialsPerCase: trials_per_case,
            caseIds: case_ids,
          })
          return {
            success: true,
            run_id: run.id,
            adopted,
            estimated_cost_usd,
            status: run.status,
            mode: run.mode,
            message: adopted
              ? 'A run of this suite and mode was already in flight — watching that one instead of starting a second.'
              : 'Run queued. Call get_eval_run with this run_id to see how it went.',
          }
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : 'Failed to start eval run' }
        }
      },
    }),

    get_eval_run: tool({
      description:
        'Read a run: its outcome, per-dimension scores, and every FAILING check with the grader\'s rationale — ' +
        'which is the part worth reading back to the user, because it says what the prompt actually did wrong. ' +
        'Also reports the baseline run this one should be compared against (the last completed run of the same ' +
        'suite and mode that tested a DIFFERENT prompt — two runs of the same prompt are variance samples, not a ' +
        'before/after).\n' +
        'Pass include_trace with a case_id to pull one trial\'s full flush log when you need to see what the agent ' +
        'saw turn by turn. Traces are large — never pull one speculatively.',
      inputSchema: z.object({
        run_id: z.string().describe('The run UUID from start_eval_run.'),
        include_trace: z
          .boolean()
          .optional()
          .describe('Include one trial\'s full trace. Requires case_id.'),
        case_id: z.string().optional().describe('Which case\'s trace to include.'),
      }),
      execute: async ({ run_id, include_trace, case_id }) => {
        const detail = await getRunDetail(supabase, run_id)
        if (!detail) return { success: false, error: 'Run not found' }
        if (detail.run.workspace_id !== workspaceId) {
          return { success: false, error: 'Run not found' }
        }

        const { run, trials } = detail
        const baseline = await latestCompletedRun(supabase, run.suite_id, run.mode, run.target_prompt_hash)

        const result: Record<string, unknown> = {
          success: true,
          run: {
            id: run.id,
            suite_id: run.suite_id,
            mode: run.mode,
            speed: run.speed,
            status: run.status,
            is_live: run.is_live,
            outcome: run.outcome,
            scores: run.scores,
            progress: run.progress,
            trials_per_case: run.trials_per_case,
            estimated_cost_usd: run.estimated_cost_usd,
            cost_usd: run.cost_usd,
            duration_ms: run.duration_ms,
            target_prompt_hash: run.target_prompt_hash,
            error_code: run.error_code,
            error_message: run.error_message,
          },
          trials: trials.map((t) => ({
            id: t.id,
            case_id: t.case_id,
            case_name: t.case_name,
            trial_index: t.trial_index,
            status: t.status,
            outcome: t.outcome,
            cost_usd: t.cost_usd,
            duration_ms: t.duration_ms,
            error_code: t.error_code,
            check_count: t.checks.length,
          })),
          failing_checks: evalFailingChecks(trials),
          baseline_run: baseline
            ? { id: baseline.id, outcome: baseline.outcome, scores: baseline.scores, started_at: baseline.started_at }
            : null,
        }

        if (include_trace) {
          if (!case_id) {
            result.trace_error = 'include_trace needs a case_id — say which case you want the trace for.'
            return result
          }
          const trial = trials.find((t) => t.case_id === case_id)
          if (!trial) {
            result.trace_error = 'No trial in this run for that case_id.'
            return result
          }
          // getRunDetail omits traces on purpose (a 20-case run's traces are
          // megabytes); read back the ONE that was asked for.
          const { data, error } = await supabase
            .from('eval_trial')
            .select('trace')
            .eq('id', trial.id)
            .maybeSingle()
          if (error) result.trace_error = error.message
          else result.trace = (data?.trace ?? null) as EvalTrace | null
        }

        return result
      },
    }),

    update_eval_case: tool({
      description:
        'Refine an existing case in place — after a run showed the expectation was wrong, or the script did not ' +
        'probe what you thought. Only the fields you pass change.\n' +
        'Editing the script RE-FREEZES the chunk boundaries and rewrites the template capture\'s transcript, so ' +
        'check the returned chunk_count again. Editing `expected` REPLACES the whole grading contract, so pass the ' +
        'complete object, not just the part you are changing — call list_evals with the suite_id, or read the case ' +
        'first, if you are unsure what it currently holds.',
      inputSchema: z.object({
        case_id: z.string().describe('The case UUID.'),
        name: z.string().optional(),
        script: z.array(scriptSegmentSchema).optional().describe('The FULL replacement script, ordered by t_ms.'),
        participants: z.array(participantSchema).optional().describe('The FULL replacement participant list.'),
        expected: expectedSchema.optional().describe('The FULL replacement grading contract.'),
      }),
      execute: async ({ case_id, name, script, participants, expected }) => {
        if (name === undefined && script === undefined && participants === undefined && expected === undefined) {
          return { success: false, error: 'Nothing to update — pass at least one field' }
        }
        if (participants) {
          const selfProblem = selfLabelProblem(participants)
          if (selfProblem) return { success: false, error: selfProblem }
        }

        // Route by the CASE's own workspace — a case_id copied out of another
        // workspace the user belongs to is edited there, never reported
        // not-found just because the read stayed pinned to the session
        // workspace. Membership is checked on the caller's own client before
        // the service write below.
        const resolved = await resolveEntityWorkspace(
          supabase,
          userId,
          'eval_case',
          case_id,
          workspaceId,
          strictWorkspace,
        )
        if (!resolved) return { success: false, error: 'Case not found in this workspace' }
        const targetWs = resolved.workspaceId

        const ordered = script ? [...script].sort((a, b) => a.t_ms - b.t_ms) : undefined

        try {
          const updated = await updateEvalCase(getServiceClient(), {
            caseId: case_id,
            workspaceId: targetWs,
            name,
            script: ordered,
            expected: expected as ExpectedOutcomes | undefined,
            participants,
          })
          return {
            success: true,
            case: evalCaseSummary(updated),
            chunk_count: updated.chunks?.length ?? 0,
            cadence: ordered ? evalCadence(ordered, updated.chunks?.length ?? 0) : undefined,
          }
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : 'Failed to update eval case' }
        }
      },
    }),
  }
}
