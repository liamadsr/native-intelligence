/**
 * Zod schemas shared by the Evals routes.
 *
 * They live in one file rather than beside each handler because three of them
 * describe the SAME nested shapes — a script segment, an expected-outcomes
 * block, a participant — and a case's POST body and its PATCH body must never
 * drift apart. `create_eval_case` and `update_eval_case` in chat write through
 * the same lib functions these routes call, so a rule that lived in only one
 * handler would be enforced on only one of the two doors.
 *
 * Everything is `.strict()`. A typo'd key in an `expected` block ("proposal"
 * for "proposals") would otherwise be accepted, stored, and silently graded as
 * an empty expectation — a case that passes because it expects nothing is the
 * worst failure this feature has, and it is invisible in the UI.
 */
import { z } from 'zod'
import {
  EVAL_MODES,
  EVAL_POLARITIES,
  EVAL_SEVERITIES,
  EVAL_SPEEDS,
  EVAL_SUITE_KINDS,
  EVAL_TARGET_KINDS,
} from '@/lib/evals/types'
import { LIVE_DIRECTIVE_MAX_CHARS } from '@/lib/live-agent/directives'
import { MEETING_GOAL_MAX_CHARS } from '@/lib/meetings/meeting-goal'

const severity = z.enum(EVAL_SEVERITIES)

const scriptSegment = z
  .object({
    t_ms: z.number().int().min(0),
    speaker: z.string().min(1),
    // The mic/system split is not cosmetic: it is what drives a realistic
    // chunk cadence through the frozen-chunk freezer (self on mic, everyone
    // else on system), and a script that put everyone on one stream would
    // flush in windows no real meeting produces.
    stream: z.enum(['mic', 'system']),
    text: z.string().min(1),
  })
  .strict()

const participant = z
  .object({
    speaker_label: z.string().min(1),
    display: z.string().min(1),
    is_self: z.boolean().optional(),
    role: z.string().optional(),
  })
  .strict()

/** The one label position evidence will ever accept as the owner's voice. */
const SELF_SPEAKER_LABEL = 'local_1'

/**
 * A participant list whose self voice is one `positionEvidenceHolds` can
 * actually honour.
 *
 * `seedEvalSelfParticipant` puts the author's `is_self` label on the self row
 * with `self_binding: 'position'`, but `resolveSelfBinding` re-derives that
 * binding on every turn and `positionEvidenceHolds` grants it only when the
 * mic voice is exactly 'local_1'. So a self participant labeled anything else
 * binds nothing: the speaker map never resolves the owner, every
 * assignee-to-self expectation fails, and the case looks like an agent
 * regression rather than a mislabeled script. Rejected rather than normalized —
 * rewriting the label would silently disagree with the script's own speakers.
 */
const participants = z.array(participant).superRefine((list, ctx) => {
  const selfAt = list.findIndex((p) => p.is_self)
  if (selfAt >= 0 && list[selfAt].speaker_label.trim() !== SELF_SPEAKER_LABEL) {
    ctx.addIssue({
      code: 'custom',
      path: [selfAt, 'speaker_label'],
      message: `The participant marked is_self must be labeled '${SELF_SPEAKER_LABEL}'`,
    })
  }
})

const expectedProposal = z
  .object({
    key: z.string().min(1),
    entity_type: z.string().min(1),
    change_type: z.string().min(1),
    gist: z.string().min(1),
    must_have: z.record(z.string(), z.string()).optional(),
    severity: severity.optional(),
  })
  .strict()

const expectedGist = z
  .object({
    key: z.string().min(1),
    gist: z.string().min(1),
    severity: severity.optional(),
  })
  .strict()

// The window is [after_chunk, before_chunk], both inclusive: a window that
// ends before it starts can never be satisfied, so it is refused rather than
// stored as an expectation that always fails.
const expectedNudge = z
  .object({
    key: z.string().min(1),
    after_chunk: z.number().int().min(0).optional(),
    before_chunk: z.number().int().min(0).optional(),
    about: z.string().min(1),
    severity: severity.optional(),
  })
  .strict()
  .refine(
    (n) => n.after_chunk === undefined || n.before_chunk === undefined || n.before_chunk >= n.after_chunk,
    { message: 'before_chunk must be at or after after_chunk', path: ['before_chunk'] },
  )

// A directive the driver injects mid-replay (live-agent messaging L5). The
// text obeys the chat writer's own limit, since the driver writes it through
// that writer; at least one phrase, or the check could only ever pass.
const expectedDirective = z
  .object({
    key: z.string().min(1),
    text: z.string().trim().min(1).max(LIVE_DIRECTIVE_MAX_CHARS),
    after_chunk: z.number().int().min(0).optional(),
    must_contain: z.array(z.string().trim().min(1)).min(1),
    severity: severity.optional(),
  })
  .strict()

const rubricItem = z
  .object({
    key: z.string().min(1),
    criterion: z.string().min(1),
    severity: severity.optional(),
  })
  .strict()

const expectedOutcomes = z
  .object({
    proposals: z.array(expectedProposal).optional(),
    forbidden_proposals: z.array(expectedGist).optional(),
    nudges: z.array(expectedNudge).optional(),
    no_nudge_windows: z
      .array(
        z
          .object({
            from_chunk: z.number().int().min(0),
            to_chunk: z.number().int().min(0),
            severity: severity.optional(),
          })
          .strict(),
      )
      .optional(),
    summary: z.string().optional(),
    tool_usage: z.string().optional(),
    rubric: z.array(rubricItem).optional(),
    // The driver answers a mid-call `ask_user` from this map; a case with no
    // map and a pending question errors the trial rather than silently
    // changing every later flush's prompt state (spec §14).
    answers: z.record(z.string(), z.string()).optional(),
    tools: z
      .object({
        must_call: z.array(z.string()).optional(),
        must_not_call: z.array(z.string()).optional(),
        max_calls: z.number().int().min(0).optional(),
      })
      .strict()
      .optional(),
    directives: z.array(expectedDirective).optional(),
    // The person's goal for the call: each trial writes it as the trial
    // capture's meeting_goal row, so it obeys that table's limit.
    goal: z.string().trim().min(1).max(MEETING_GOAL_MAX_CHARS).optional(),
    max_nudges: z.number().int().min(0).optional(),
    opening_brief: z.boolean().optional(),
    // The most chunks a nudge may land after its moment on the script clock
    // (nudge_latency); without it the lateness is reported, never graded.
    max_nudge_lag_chunks: z.number().int().min(0).optional(),
  })
  .strict()

export const CreateSuiteSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).nullish(),
    target_kind: z.enum(EVAL_TARGET_KINDS),
    target_recipe_id: z.string().uuid().nullish(),
    suite_kind: z.enum(EVAL_SUITE_KINDS).optional(),
    judge_model: z.string().min(1).nullish(),
  })
  .strict()

export const UpdateSuiteSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullish(),
    suite_kind: z.enum(EVAL_SUITE_KINDS).optional(),
    watch: z.boolean().optional(),
    judge_model: z.string().min(1).nullish(),
    target_recipe_id: z.string().uuid().nullish(),
  })
  .strict()

export const CreateCaseSchema = z
  .object({
    name: z.string().min(1).max(200),
    script: z.array(scriptSegment).min(1),
    participants: participants.default([]),
    expected: expectedOutcomes.default({}),
    polarity: z.enum(EVAL_POLARITIES).optional(),
    modes: z.array(z.enum(EVAL_MODES)).min(1).optional(),
  })
  .strict()

export const UpdateCaseSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    script: z.array(scriptSegment).min(1).optional(),
    expected: expectedOutcomes.optional(),
    participants: participants.optional(),
    // Both of these QUALIFY every expectation on the case rather than sitting
    // beside them: a negative control's empty `proposals` list means the exact
    // opposite of a positive case's, and a case that does not run in `live`
    // is never graded on nudges. An author who can write them at create time
    // but not fix them afterwards has to delete and re-author the case.
    polarity: z.enum(EVAL_POLARITIES).optional(),
    modes: z.array(z.enum(EVAL_MODES)).min(1).optional(),
  })
  .strict()

export const StartRunSchema = z
  .object({
    suite_id: z.string().uuid(),
    mode: z.enum(EVAL_MODES),
    // The FULL enum on purpose. `startEvalRun` rejects a speed with no driver
    // behind it (EVAL_SPEED_UNAVAILABLE → 400) with a sentence naming the one
    // that works; narrowing here would answer the same request with an opaque
    // schema error instead. When the client driver ships, only that check moves.
    speed: z.enum(EVAL_SPEEDS).optional(),
    trials_per_case: z.number().int().min(1).max(10).optional(),
    case_ids: z.array(z.string().uuid()).min(1).optional(),
  })
  .strict()

/**
 * Seed a case from a recorded capture (`POST /suites/[id]/cases/from-capture`).
 * Only the capture is named: its transcript becomes the script and the case
 * starts with empty expectations for a person to fill in.
 */
export const CreateCaseFromCaptureSchema = z
  .object({
    capture_id: z.string().uuid(),
    name: z.string().min(1).max(200).optional(),
  })
  .strict()
