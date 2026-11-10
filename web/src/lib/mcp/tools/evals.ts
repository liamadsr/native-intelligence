import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { UpdateCaseSchema } from '@/app/api/account/evals/schemas'
import { recipeIsVisible } from '@/app/api/account/evals/suites/target-recipe'
import { getServiceClient } from '@/lib/admin'
import {
  evalCadence,
  evalCaseSummary,
  evalFailingChecks,
  selfLabelProblem,
} from '@/lib/ai/tools/evals'
import { createEvalCase, updateEvalCase } from '@/lib/evals/create-case'
import { estimateRunCostUsd } from '@/lib/evals/estimate'
import {
  CASE_LIST_FIELDS,
  getRunDetail,
  latestCompletedRun,
  listCases,
  listSuites,
} from '@/lib/evals/queries'
import { startEvalRun } from '@/lib/evals/start-run'
import { EVAL_MODES, RUNNABLE_EVAL_SPEEDS } from '@/lib/evals/types'
import type { EvalMode, ExpectedOutcomes, ScriptSegment } from '@/lib/evals/types'
import { withActiveWorkspace } from './envelope'

/**
 * MCP tools for Evals — authoring synthetic-meeting cases and running suites
 * over the wire.
 *
 * These are the hand-registered twins of the chat tools in
 * `src/lib/ai/tools/evals.ts`. They win the `ni_*` name against the
 * auto-adapted chat versions (see the claimedNames skip in ./index.ts), which
 * is deliberate: the SHAPING helpers are shared with the chat file so the two
 * surfaces return the same case summaries and failing-check lists, while the
 * MCP variants keep the conventions this directory has settled on — `ok`/`fail`
 * envelopes with machine-readable codes, and owner (`userId` / `workspaceId`)
 * derived from the authenticated session rather than taken as an argument.
 *
 * Tool naming follows the `ni_<verb>_<noun>` convention documented at
 * ./library.ts. It matters more here than usual: `classifyToolAccess` in
 * ../guard.ts strips the `ni_` prefix and classifies by verb shape, so
 * `ni_list_evals` and `ni_get_eval_run` are reachable by a READ-ONLY
 * token while the four writers are not — with no allowlist entry anywhere.
 *
 * Reads run on the caller's RLS client; the writes that touch `captures` run on
 * the SERVICE client after an explicit workspace-membership read, exactly as in
 * the chat file. Never accepts a capture id: an eval always runs against a
 * clone of a case's own template capture, never against a real meeting.
 */

// ────────────────────────────────────────────────────────────────
// Shared helpers
// ────────────────────────────────────────────────────────────────

/** Wrap an error message as an MCP error response. */
function fail(message: string, code?: string) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message, code }, null, 2) }],
    isError: true,
  }
}

const ScriptSegmentSchema = z.object({
  t_ms: z.number().int().min(0).describe('Milliseconds from the start of the call. Leave ≥3000ms silences at turn boundaries.'),
  speaker: z.string().describe('Speaker label, matching a participant\'s speaker_label exactly.'),
  stream: z.enum(['mic', 'system']).describe('The self participant is on "mic"; every other speaker is on "system".'),
  text: z.string().describe('What was said, written the way a transcriber would emit it.'),
})

const ParticipantSchema = z.object({
  speaker_label: z
    .string()
    .describe(
      'The label used in the script. The is_self participant MUST be "local_1" — the engine only binds that label to the owner, and any other one is revoked on the first turn, so every "assignee":"self" expectation silently misses. Everyone else is "remote_1", "remote_2", … in order.',
    ),
  display: z.string(),
  is_self: z.boolean().optional().describe('True for exactly ONE participant.'),
  role: z.string().optional(),
})

/**
 * `expected` is the ROUTE's schema, unwrapped — not a second hand-maintained
 * copy and not an open record.
 *
 * An open record was the old shape, on the theory that an MCP caller is
 * replaying something it already holds. But every key in the contract is
 * optional, so a misspelled one ("proposal" for "proposals") validated, stored,
 * and graded as an EMPTY expectation: the case passes because it expects
 * nothing, and no screen shows the discrepancy. That is the exact failure
 * `src/app/api/account/evals/schemas.ts` made everything `.strict()` to catch,
 * and reusing it here closes the last door rather than mirroring the tree a
 * second time.
 */
const ExpectedSchema = UpdateCaseSchema.shape.expected
  .unwrap()
  .describe(
    'The grading contract: {proposals[], forbidden_proposals[], nudges[], no_nudge_windows[], summary, tool_usage, rubric[], answers{}, tools{}, directives[], goal, max_nudges, opening_brief, max_nudge_lag_chunks}. Every key optional, but UNKNOWN keys are rejected — a typo would otherwise grade as an empty expectation. See ni_get_eval_run for what each one grades.',
  )

// ────────────────────────────────────────────────────────────────
// Registration
// ────────────────────────────────────────────────────────────────

export function registerEvalTools(
  server: McpServer,
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  workspaceName?: string | null,
) {
  /**
   * Wrap a result object as a text MCP response, stamped with `active_workspace`.
   *
   * These tools are hand-registered, so the adapter loop in ./index.ts — which
   * stamps every BRIDGED result — never sees them; without this they were the
   * only results in the catalog that didn't name their workspace. Same helper,
   * same shape, so a caller can't tell how a tool was registered. `fail` is
   * untouched: error payloads keep their exact existing text.
   */
  const active = { id: workspaceId, name: workspaceName ?? null }
  const ok = (payload: unknown) => ({
    content: [{
      type: 'text' as const,
      text: JSON.stringify(withActiveWorkspace(payload, active), null, 2),
    }],
  })

  server.tool(
    'ni_create_eval_suite',
    'Create an eval suite in the active workspace — a named set of synthetic-meeting cases that grade one Agent or Skill. Read the target recipe\'s own system_prompt first (ni_get_agent / ni_get_skill) so the cases probe what it actually claims to do. suite_kind "regression" = these cases must stay green; "capability" = watch the number climb.',
    {
      name: z.string().describe('Short name, e.g. "Sales Discovery".'),
      target_kind: z.enum(['agent', 'skill']).describe('agent = a live-meeting persona; skill = a chat/loop preset.'),
      target_recipe_id: z.string().optional().describe('UUID of the Agent or Skill under test.'),
      description: z.string().optional(),
      suite_kind: z.enum(['capability', 'regression']).optional().describe('Defaults to "capability".'),
      judge_model: z.string().optional().describe('Gateway catalog slug for the judge. Omit for the workspace default.'),
    },
    async ({ name, target_kind, target_recipe_id, description, suite_kind, judge_model }) => {
      const trimmed = name.trim()
      if (!trimmed) return fail('Name is required', 'INVALID_NAME')

      // Resolve the target before the insert. The registrar hands these tools
      // the SERVICE client, so the predicate — not RLS — is what keeps another
      // workspace's private agent prompt out of the run snapshot.
      if (target_recipe_id) {
        const visible = await recipeIsVisible(supabase, target_recipe_id, workspaceId, userId)
        if (visible === 'error') return fail('Target recipe check failed')
        if (!visible) {
          return fail(
            'No Agent or Skill with that target_recipe_id is visible here — use an id from ni_list_agents or ni_list_skills.',
            'TARGET_NOT_FOUND',
          )
        }
      }

      const insert: Record<string, unknown> = {
        workspace_id: workspaceId,
        name: trimmed,
        target_kind,
        suite_kind: suite_kind || 'capability',
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

      if (error) return fail(error.message)
      return ok({ suite: data })
    },
  )

  server.tool(
    'ni_create_eval_case',
    'Write one synthetic meeting and the outcomes it should produce. The script is [{t_ms, speaker, stream, text}] ordered by t_ms: the Native Intelligence user (the participant with is_self) speaks on "mic" and everyone else on "system" — the agent only flushes when BOTH streams go quiet, so that split is what produces a realistic chunk cadence. Leave ≥3000ms silences at turn boundaries, run lines inside one turn 400-1500ms apart, and target a 12-15 minute call. Write what a TRANSCRIBER would emit — disfluency, self-correction, crosstalk, no stage directions — and include at least one genuinely ambiguous moment per case. Give every suite at least two polarity:"negative" controls, where the right behavior is to propose nothing. Returns the case with its frozen chunk_count: check it before authoring more, since two chunks for a 15-minute call means the silences are missing.',
    {
      suite_id: z.string().describe('The suite UUID.'),
      name: z.string().describe('What this case probes, e.g. "Prospect stalls on pricing".'),
      script: z.array(ScriptSegmentSchema).describe('The synthetic meeting, ordered by t_ms.'),
      participants: z.array(ParticipantSchema).describe('One per speaker_label; exactly one is_self.'),
      expected: ExpectedSchema,
      polarity: z.enum(['positive', 'negative']).optional().describe('Defaults to "positive".'),
      modes: z.array(z.enum(EVAL_MODES)).optional().describe('Run modes this case is valid for. Defaults to both.'),
    },
    async ({ suite_id, name, script, participants, expected, polarity, modes }) => {
      const trimmed = name.trim()
      if (!trimmed) return fail('Name is required', 'INVALID_NAME')
      if (script.length === 0) return fail('A script with at least one segment is required', 'EMPTY_SCRIPT')
      if (participants.filter((p) => p.is_self).length !== 1) {
        return fail('Exactly one participant must have is_self: true', 'INVALID_PARTICIPANTS')
      }
      const selfProblem = selfLabelProblem(participants)
      if (selfProblem) return fail(selfProblem, 'INVALID_SELF_LABEL')
      const labels = new Set(participants.map((p) => p.speaker_label))
      const unknownSpeakers = [...new Set(script.map((s) => s.speaker))].filter((s) => !labels.has(s))
      if (unknownSpeakers.length > 0) {
        return fail(`Script speakers with no participant entry: ${unknownSpeakers.join(', ')}`, 'UNKNOWN_SPEAKER')
      }

      // The membership read that licenses the service-client write below.
      const { data: suite, error: suiteError } = await supabase
        .from('eval_suite')
        .select('id')
        .eq('id', suite_id)
        .eq('workspace_id', workspaceId)
        .maybeSingle()
      if (suiteError) return fail(suiteError.message)
      if (!suite) return fail('Suite not found in this workspace', 'NOT_FOUND')

      const ordered = [...(script as ScriptSegment[])].sort((a, b) => a.t_ms - b.t_ms)

      try {
        const created = await createEvalCase(getServiceClient(), {
          workspaceId,
          userId,
          suiteId: suite_id,
          name: trimmed,
          script: ordered,
          participants,
          expected: expected as ExpectedOutcomes,
          polarity,
          modes: modes as EvalMode[] | undefined,
        })
        return ok({
          case: evalCaseSummary(created),
          capture_id: created.capture_id,
          chunk_count: created.chunks?.length ?? 0,
          cadence: evalCadence(ordered, created.chunks?.length ?? 0),
        })
      } catch (err) {
        return fail(err instanceof Error ? err.message : 'Failed to create eval case')
      }
    },
  )

  server.tool(
    'ni_list_evals',
    'List the workspace\'s eval suites with case counts, last-run outcome, and the ESTIMATED COST of running each suite in each mode. Token-light — no scripts, no expected outcomes. Quote the estimate before ni_start_eval_run: judges are most of the bill and a twenty-case suite is dollars, not cents. Pass suite_id to also get that suite\'s case list.',
    {
      suite_id: z.string().optional().describe('Narrow to one suite and include its cases.'),
      target_recipe_id: z.string().optional().describe('Only suites targeting this Agent or Skill.'),
      trials_per_case: z.number().int().min(1).optional().describe('Attempts per case to price for. Defaults to 1.'),
    },
    async ({ suite_id, target_recipe_id, trials_per_case }) => {
      const trialsPerCase = trials_per_case ?? 1
      const all = await listSuites(supabase, workspaceId)
      const filtered = all.filter(
        (s) => (!suite_id || s.id === suite_id) && (!target_recipe_id || s.target_recipe_id === target_recipe_id),
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

      if (!suite_id) return ok({ suites })
      // `supabase` is the service client: list cases only for a suite this
      // workspace's listing returned, never for an id from another workspace.
      if (!all.some((s) => s.id === suite_id)) return ok({ suites, cases: [] })

      const cases = (await listCases(supabase, suite_id)).map((c) => ({
        id: c.id,
        name: c.name,
        polarity: c.polarity,
        modes: c.modes,
      }))
      return ok({ suites, cases })
    },
  )

  server.tool(
    'ni_start_eval_run',
    'Queue a run of one suite in one mode. Spends real money — quote the ni_list_evals estimate and get a go-ahead first. batch = one end-of-meeting extraction per case (the cheap sweep); live = the transcript replayed chunk by chunk, which is the only mode that grades mid-call nudges. Returns {run_id, adopted, estimated_cost_usd}: adopted=true means a run of this suite and mode was ALREADY in flight and you are watching that one, not a new one. Never takes a capture id — a run always executes against fresh clones of the cases\' own template captures. Poll ni_get_eval_run for the outcome.',
    {
      suite_id: z.string().describe('The suite UUID.'),
      mode: z.enum(EVAL_MODES).describe('"batch" or "live".'),
      // Only the speeds with a driver — see the AI tool's note; the watched
      // replays would sleep past the Inngest step ceiling.
      speed: z
        .enum(RUNNABLE_EVAL_SPEEDS)
        .optional()
        .describe('Live only: "instant" (default). The watched speeds arrive with the replay screen.'),
      trials_per_case: z.number().int().min(1).max(5).optional().describe('Attempts per case. Defaults to 1; multiplies the cost.'),
      case_ids: z.array(z.string()).optional().describe('Run only these cases — e.g. retrying the failures.'),
    },
    async ({ suite_id, mode, speed, trials_per_case, case_ids }) => {
      const { data: suite, error: suiteError } = await supabase
        .from('eval_suite')
        .select('id')
        .eq('id', suite_id)
        .eq('workspace_id', workspaceId)
        .maybeSingle()
      if (suiteError) return fail(suiteError.message)
      if (!suite) return fail('Suite not found in this workspace', 'NOT_FOUND')

      try {
        const { run, adopted, estimated_cost_usd } = await startEvalRun(getServiceClient(), {
          workspaceId,
          userId,
          suiteId: suite_id,
          mode,
          speed,
          trialsPerCase: trials_per_case,
          caseIds: case_ids,
        })
        return ok({
          run_id: run.id,
          adopted,
          estimated_cost_usd,
          status: run.status,
          mode: run.mode,
        })
      } catch (err) {
        return fail(err instanceof Error ? err.message : 'Failed to start eval run')
      }
    },
  )

  server.tool(
    'ni_get_eval_run',
    'Read a run: outcome, per-dimension scores, and every FAILING check with the grader\'s rationale — the part that says what the prompt actually did wrong. Also reports the baseline run to compare against: the last completed run of the same suite and mode that tested a DIFFERENT prompt, since two runs of the same prompt are variance samples rather than a before/after. Pass include_trace with a case_id to pull one trial\'s full flush log; traces are large, so never pull one speculatively.',
    {
      run_id: z.string().describe('The run UUID.'),
      include_trace: z.boolean().optional().describe('Include one trial\'s full trace. Requires case_id.'),
      case_id: z.string().optional().describe('Which case\'s trace to include.'),
    },
    async ({ run_id, include_trace, case_id }) => {
      const detail = await getRunDetail(supabase, run_id)
      if (!detail) return fail('Run not found', 'NOT_FOUND')
      if (detail.run.workspace_id !== workspaceId) return fail('Run not found', 'NOT_FOUND')

      const { run, trials } = detail
      const baseline = await latestCompletedRun(supabase, run.suite_id, run.mode, run.target_prompt_hash)

      const payload: Record<string, unknown> = {
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
          payload.trace_error = 'include_trace needs a case_id'
        } else {
          const trial = trials.find((t) => t.case_id === case_id)
          if (!trial) {
            payload.trace_error = 'No trial in this run for that case_id'
          } else {
            // getRunDetail omits traces on purpose; read back the one asked for.
            const { data, error } = await supabase
              .from('eval_trial')
              .select('trace')
              .eq('id', trial.id)
              .maybeSingle()
            if (error) payload.trace_error = error.message
            else payload.trace = data?.trace ?? null
          }
        }
      }

      return ok(payload)
    },
  )

  server.tool(
    'ni_update_eval_case',
    'Refine an existing case in place — after a run showed the expectation was wrong, or the script did not probe what you thought. Only the fields you pass change. Editing the script RE-FREEZES the chunk boundaries and rewrites the template capture\'s transcript, so check the returned chunk_count again. `expected` and `participants` REPLACE wholesale, so pass the complete object rather than a partial one.',
    {
      case_id: z.string().describe('The case UUID.'),
      name: z.string().optional(),
      script: z.array(ScriptSegmentSchema).optional().describe('The FULL replacement script, ordered by t_ms.'),
      participants: z.array(ParticipantSchema).optional().describe('The FULL replacement participant list.'),
      expected: ExpectedSchema.optional().describe('The FULL replacement grading contract.'),
    },
    async ({ case_id, name, script, participants, expected }) => {
      if (name === undefined && script === undefined && participants === undefined && expected === undefined) {
        return fail('Nothing to update — pass at least one field', 'NOTHING_TO_UPDATE')
      }
      if (participants) {
        const selfProblem = selfLabelProblem(participants)
        if (selfProblem) return fail(selfProblem, 'INVALID_SELF_LABEL')
      }

      const { data: existing, error: readError } = await supabase
        .from('eval_case')
        .select(CASE_LIST_FIELDS)
        .eq('id', case_id)
        .eq('workspace_id', workspaceId)
        .maybeSingle()
      if (readError) return fail(readError.message)
      if (!existing) return fail('Case not found in this workspace', 'NOT_FOUND')

      const ordered = script ? [...(script as ScriptSegment[])].sort((a, b) => a.t_ms - b.t_ms) : undefined

      try {
        const updated = await updateEvalCase(getServiceClient(), {
          caseId: case_id,
          workspaceId,
          name,
          script: ordered,
          expected: expected as ExpectedOutcomes | undefined,
          participants,
        })
        return ok({
          case: evalCaseSummary(updated),
          chunk_count: updated.chunks?.length ?? 0,
          cadence: ordered ? evalCadence(ordered, updated.chunks?.length ?? 0) : undefined,
        })
      } catch (err) {
        return fail(err instanceof Error ? err.message : 'Failed to update eval case')
      }
    },
  )
}
