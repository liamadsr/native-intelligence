/**
 * The free graders (spec §6.2) — everything decidable from the trace alone, no
 * model call and no embedding.
 *
 * Cheapest-first is not just an optimization here. These checks are the ones a
 * user can reason about: "you said it must never call propose_mcp_call and it
 * did" is a sentence with no judgement in it. Running them first also means a
 * case whose deterministic gates already failed has a `failed` outcome before a
 * cent of judge money is spent.
 *
 * Every function is PURE — trace and expectations in, check rows out. The
 * `trial_id`/`workspace_id`/`id`/`created_at` columns are stamped by the
 * inserter, so these return the check WITHOUT them and the caller cannot get
 * the scoping wrong per-grader.
 */
import { BATCH_STEP_CEILING, LIVE_STEP_CEILING, SUMMARY_TOOL_NAMES } from '../run-trial'
import { STEP_CEILING_GRADER } from '../types'
import type {
  EvalCheckRow,
  EvalTrace,
  ExpectedOutcomes,
  FlushRecord,
  FrozenChunk,
  ScriptSegment,
  Severity,
} from '../types'

/** A check as a grader produces it: everything but the row scoping. */
export type DraftCheck = Omit<EvalCheckRow, 'id' | 'trial_id' | 'workspace_id' | 'created_at'>

/** Every tool the agent called across the whole trial, flattened. */
export function allToolCalls(trace: EvalTrace): string[] {
  return (trace.flushes ?? []).flatMap((f) =>
    f.response.tool_call_details.map((c) => c.tool),
  )
}

/** Build one check row with the defaults every grader shares. */
function check(draft: {
  dimension: EvalCheckRow['dimension']
  grader: string
  check_key: string
  label: string
  severity: Severity
  outcome: EvalCheckRow['outcome']
  rationale: string
  evidence?: Record<string, unknown>
  score?: number | null
  threshold?: number | null
}): DraftCheck {
  return {
    dimension: draft.dimension,
    grader: draft.grader,
    check_key: draft.check_key,
    label: draft.label,
    severity: draft.severity,
    outcome: draft.outcome,
    score: draft.score ?? null,
    threshold: draft.threshold ?? null,
    rationale: draft.rationale,
    evidence: draft.evidence ?? null,
    human_override: null,
    human_note: null,
  }
}

/**
 * Tools the case declared must-call / must-not-call, plus the call ceiling.
 *
 * SEVERITY: a `must_not_call` on `propose_mcp_call` or an email proposal is a
 * GATE — those are the external side effects invariant 5 forbids unattended,
 * and a prompt edit that starts firing them is the failure mode a regression
 * suite exists to catch. Every other tool expectation is soft: a missing
 * `list_projects` call is a style difference, not a defect.
 */
const GATE_MUST_NOT_CALL = new Set(['propose_mcp_call', 'send_email', 'propose_email'])

export function gradeTools(trace: EvalTrace, expected: ExpectedOutcomes): DraftCheck[] {
  const tools = expected.tools
  if (!tools) return []

  const calls = allToolCalls(trace)
  const called = new Set(calls)
  const out: DraftCheck[] = []

  for (const name of tools.must_call ?? []) {
    const hit = called.has(name)
    out.push(
      check({
        dimension: 'tools',
        grader: 'tool_called',
        check_key: `tool_called:${name}`,
        label: `Calls ${name}`,
        severity: 'soft',
        outcome: hit ? 'pass' : 'fail',
        rationale: hit
          ? `${name} was called ${calls.filter((c) => c === name).length} time(s).`
          : `${name} was never called across ${trace.flushes?.length ?? 0} flush(es).`,
        evidence: { called: [...called] },
      }),
    )
  }

  for (const name of tools.must_not_call ?? []) {
    const hit = called.has(name)
    out.push(
      check({
        dimension: 'tools',
        grader: 'tool_not_called',
        check_key: `tool_not_called:${name}`,
        label: `Never calls ${name}`,
        severity: GATE_MUST_NOT_CALL.has(name) ? 'gate' : 'soft',
        outcome: hit ? 'fail' : 'pass',
        rationale: hit
          ? `${name} was called ${calls.filter((c) => c === name).length} time(s) and this case forbids it.`
          : `${name} was never called.`,
        evidence: { called: [...called] },
      }),
    )
  }

  if (typeof tools.max_calls === 'number') {
    const within = calls.length <= tools.max_calls
    out.push(
      check({
        dimension: 'tools',
        grader: 'max_tool_calls',
        check_key: 'max_tool_calls',
        label: `At most ${tools.max_calls} tool calls`,
        severity: 'soft',
        outcome: within ? 'pass' : 'fail',
        score: calls.length,
        threshold: tools.max_calls,
        rationale: `${calls.length} tool call(s) against a ceiling of ${tools.max_calls}.`,
        evidence: { calls },
      }),
    )
  }

  return out
}

/**
 * `model_wrote_summary` — did a `write_summary` / `update_summary` call happen.
 *
 * Read from the TRACE, never from `captures.ai_summary`. The DB column is
 * downstream of the batch safety net, which eval captures skip entirely
 * (spec §5.1) — so the column would be empty for a prompt that summarized
 * perfectly through the tool, and non-empty for one that never called it at all
 * on a real capture. The tool call is the honest signal.
 *
 * GATE in batch: the batch prompt layers `BATCH_SUMMARY_REQUIRED`, so a batch
 * run that produced no summary failed at its primary job. Soft in live, where a
 * summary accumulates over the call and a single flush not writing one is
 * normal.
 */
export function gradeSummaryWritten(trace: EvalTrace): DraftCheck {
  const wrote = trace.summary_source === 'model'
  return check({
    dimension: 'summary',
    grader: 'model_wrote_summary',
    check_key: 'model_wrote_summary',
    label: 'The model wrote a summary',
    severity: trace.mode === 'batch' ? 'gate' : 'soft',
    outcome: wrote ? 'pass' : 'fail',
    rationale: wrote
      ? 'A write_summary/update_summary call is in the trace.'
      : `No ${SUMMARY_TOOL_NAMES.join(' or ')} call appears in any flush.`,
    evidence: { summary_source: trace.summary_source },
  })
}

/**
 * `gate_recorded` — every final proposal carries a gate decision.
 *
 * ALWAYS ON, ALWAYS GATE. This is the isolation canary that replaced the
 * winning design's `no_gate_violation`, which could never fire: under report
 * mode nothing is ever applied, so "did anything get applied" is vacuously
 * true. What CAN silently break is the auto-apply block not running at all —
 * a null `currentMemberId`, a disabled trust policy, an exception before the
 * loop — and then the whole counterfactual, the single highest-value thing an
 * eval measures, is quietly absent while every other check still passes.
 *
 * A trial with NO proposals passes: there was nothing to gate, which is exactly
 * what a negative control expects.
 */
export function gradeGateRecorded(trace: EvalTrace): DraftCheck {
  const proposals = trace.proposals_final ?? []
  const missing = proposals.filter((p) => !p.gate)
  const wouldApply = proposals.filter((p) => p.gate?.would_have_applied)
  return check({
    dimension: 'gate',
    grader: 'gate_recorded',
    check_key: 'gate_recorded',
    label: 'Every proposal has a gate decision',
    severity: 'gate',
    outcome: missing.length === 0 ? 'pass' : 'fail',
    score: proposals.length ? (proposals.length - missing.length) / proposals.length : null,
    rationale:
      missing.length === 0
        ? `${proposals.length} proposal(s) all carry a gate decision; ${wouldApply.length} would have auto-applied on a real capture.`
        : `${missing.length} of ${proposals.length} proposal(s) have no gate decision — the auto-apply block did not run for them.`,
    evidence: {
      total: proposals.length,
      missing_ids: missing.map((p) => p.id),
      would_have_applied_ids: wouldApply.map((p) => p.id),
    },
  })
}

/** True when a flush terminated because it ran out of tool steps rather than
 *  because the model was finished. The AI SDK reports `finishReason:
 *  'tool-calls'` on a step that wanted to keep going; combined with
 *  `steps_used` at the mode's ceiling that is a truncated turn. */
export function hitStepCeiling(flush: FlushRecord, mode: EvalTrace['mode']): boolean {
  // Any turn budget the route reported (output, deadline, steps) truncated the flush.
  if (flush.budget_hit) return true
  const ceiling = mode === 'batch' ? BATCH_STEP_CEILING : LIVE_STEP_CEILING
  return flush.finish_reason === 'tool-calls' && (flush.steps_used ?? 0) >= ceiling
}

/**
 * `no_step_ceiling_hit` — no flush was truncated by the step budget.
 *
 * GATE, because a truncated flush measures the BUDGET and not the prompt: every
 * proposal the agent was about to make is missing for a reason that has nothing
 * to do with the text under test. The caller additionally marks that trial's
 * proposals dimension `unknown` (see {@link gradeDeterministic}'s return), so a
 * budget-bound trial cannot masquerade as a recall regression.
 */
export function gradeStepCeiling(trace: EvalTrace): DraftCheck {
  const flushes = trace.flushes ?? []
  const truncated = flushes.filter((f) => hitStepCeiling(f, trace.mode))
  return check({
    dimension: 'tools',
    grader: STEP_CEILING_GRADER,
    check_key: STEP_CEILING_GRADER,
    label: 'No flush hit the step ceiling',
    severity: 'gate',
    outcome: truncated.length === 0 ? 'pass' : 'fail',
    rationale:
      truncated.length === 0
        ? `All ${flushes.length} flush(es) finished before the ${trace.mode === 'batch' ? BATCH_STEP_CEILING : LIVE_STEP_CEILING}-step ceiling.`
        : `${truncated.length} flush(es) stopped at the step ceiling — those turns measured the budget, not the prompt.`,
    evidence: {
      truncated_indices: truncated.map((f) => f.index),
      ceiling: trace.mode === 'batch' ? BATCH_STEP_CEILING : LIVE_STEP_CEILING,
    },
  })
}

/** Optional cost/latency thresholds. Emitted only when the case sets one — a
 *  check that always passes is a check nobody reads (the non-discriminating
 *  pathology, spec §6.6). */
export function gradeBudgets(
  trace: EvalTrace,
  thresholds: { costUsd?: number; latencyMs?: number },
): DraftCheck[] {
  const out: DraftCheck[] = []

  if (typeof thresholds.costUsd === 'number') {
    const cost = trace.usage?.cost_usd ?? 0
    out.push(
      check({
        dimension: 'cost',
        grader: 'cost_under',
        check_key: 'cost_under',
        label: `Costs under $${thresholds.costUsd}`,
        severity: 'soft',
        outcome: cost <= thresholds.costUsd ? 'pass' : 'fail',
        score: cost,
        threshold: thresholds.costUsd,
        rationale: `This trial cost $${cost.toFixed(4)} against a $${thresholds.costUsd} threshold.`,
      }),
    )
  }

  if (typeof thresholds.latencyMs === 'number') {
    const slowest = Math.max(
      0,
      ...(trace.flushes ?? []).map((f) => f.response.duration_ms ?? 0),
    )
    out.push(
      check({
        dimension: 'latency',
        grader: 'latency_under',
        check_key: 'latency_under',
        label: `Every flush under ${thresholds.latencyMs}ms`,
        severity: 'soft',
        outcome: slowest <= thresholds.latencyMs ? 'pass' : 'fail',
        score: slowest,
        threshold: thresholds.latencyMs,
        rationale: `The slowest flush took ${slowest}ms against a ${thresholds.latencyMs}ms threshold.`,
      }),
    )
  }

  return out
}

/** Lowercase, whitespace collapsed: how a `must_contain` phrase is matched. */
function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

/** What the trial wrote down: the final summary and every final proposal. */
function recordText(trace: EvalTrace): string {
  const proposals = (trace.proposals_final ?? []).flatMap((p) => [p.title ?? '', p.display_text ?? ''])
  return normalizeForMatch([trace.summary_final ?? '', ...proposals].join('\n'))
}

const DIRECTIVE_STATUS_NOTE: Record<string, string> = {
  pending: 'no record-writing turn read it',
  consumed: 'a record-writing turn read it',
  expired: 'the meeting ended before a turn read it',
}

/**
 * `directive_recorded` — a directive the driver injected mid-replay made it
 * into the record (live-agent messaging L5).
 *
 * The record is the final summary plus every final proposal, and every
 * `must_contain` phrase has to appear in it (case-insensitive, whitespace
 * collapsed). Graded under the `summary` dimension, the record's column. The
 * directive's own status rides in the evidence: `consumed` with a phrase
 * missing means a turn read it and wrote it down differently or not at all;
 * `pending` means no record-writing turn ever read it.
 *
 * A directive the trace does not carry (the trial ended before it was due) is
 * `unknown`: there was nothing to record yet.
 */
export function gradeDirectives(trace: EvalTrace, expected: ExpectedOutcomes): DraftCheck[] {
  const wanted = expected.directives ?? []
  if (wanted.length === 0) return []
  const record = recordText(trace)

  return wanted.map((directive) => {
    const label = `Records "${directive.text.length > 60 ? `${directive.text.slice(0, 57)}…` : directive.text}"`
    const base = {
      dimension: 'summary' as const,
      grader: 'directive_recorded',
      check_key: `directive_recorded:${directive.key}`,
      label,
      severity: directive.severity ?? ('soft' as const),
    }
    const injected = (trace.directives ?? []).find((d) => d.key === directive.key)
    if (!injected) {
      return check({
        ...base,
        outcome: 'unknown',
        rationale: 'The trial ended before this directive was injected, so there was nothing to record.',
      })
    }

    const phrases = directive.must_contain
    const missing = phrases.filter((phrase) => !record.includes(normalizeForMatch(phrase)))
    const found = phrases.filter((phrase) => !missing.includes(phrase))
    const statusNote = injected.status
      ? `The directive is ${injected.status}: ${DIRECTIVE_STATUS_NOTE[injected.status]}.`
      : 'Its status could not be read back.'
    return check({
      ...base,
      outcome: missing.length === 0 ? 'pass' : 'fail',
      score: phrases.length ? found.length / phrases.length : null,
      rationale:
        missing.length === 0
          ? `The record contains ${phrases.map((p) => `"${p}"`).join(', ')}. ${statusNote}`
          : `The record is missing ${missing.map((p) => `"${p}"`).join(', ')}. ${statusNote}`,
      evidence: {
        directive_id: injected.id,
        status: injected.status,
        consumed_session: injected.consumed_session,
        after_chunk: injected.after_chunk,
        found,
        missing,
      },
    })
  })
}

// ---------------------------------------------------------------------------
// Nudges (live only)
// ---------------------------------------------------------------------------

/** What the nudge graders read off the case beside the trace: the script and
 *  its frozen chunks, which say who spoke in each window. Optional, so a
 *  caller holding only a trace still grades (from the flush text). */
export type NudgeGradingContext = {
  script?: ScriptSegment[]
  chunks?: FrozenChunk[]
}

/** One nudge where it landed: the chunk whose flush (or the record turn after
 *  it) produced it. A broadcast that arrives after its flush returned lands on
 *  the next one, so the position is the replay's granularity, not a clock. */
export type PlacedNudge = {
  chunk: number
  id: string
  kind: string
  message: string
  record_only?: true
}

/** Every nudge the driver's subscription saw, in order, with its chunk. */
export function placedNudges(trace: EvalTrace): PlacedNudge[] {
  return (trace.flushes ?? []).flatMap((f) =>
    (f.nudges ?? []).map((n) => ({
      chunk: f.index,
      id: n.id,
      kind: n.kind,
      message: n.message,
      ...(f.record_only ? { record_only: true as const } : {}),
    })),
  )
}

/** The label a real solo-desk capture gives the person's own microphone. */
const SELF_LABEL = 'local_1'

/** A `[speaker]: text` / `[speaker] text` line's speaker, or null. */
const CHUNK_LINE_RE = /^\[([^\]]+)\]\s*:?\s*(.*)$/

/**
 * The first chunk in which someone OTHER than the person spoke, or null when
 * nobody else ever does.
 *
 * Read off the case's script when the chunks carry segment indices (a segment
 * on the `system` stream is someone else; the person is on the mic), else off
 * the flush text, where anything but the `local_1` label is someone else.
 */
export function firstOtherSpeakerChunk(
  trace: EvalTrace,
  ctx: NudgeGradingContext = {},
): number | null {
  const script = ctx.script ?? []
  const chunks = ctx.chunks ?? []
  if (script.length > 0 && chunks.length > 0) {
    for (const chunk of [...chunks].sort((a, b) => a.index - b.index)) {
      const other = chunk.segment_indices.some((i) => {
        const seg = script[i]
        return !!seg && seg.text.trim().length > 0 && seg.stream !== 'mic' && seg.speaker !== SELF_LABEL
      })
      if (other) return chunk.index
    }
    return null
  }
  for (const flush of trace.flushes ?? []) {
    if (flush.record_only) continue
    const other = (flush.chunk_text ?? '').split('\n').some((line) => {
      const m = line.trim().match(CHUNK_LINE_RE)
      return !!m && m[1].trim() !== SELF_LABEL && m[2].trim().length > 0
    })
    if (other) return flush.index
  }
  return null
}

/** True for a `say_to_user` call the tool would broadcast: it refuses only an
 *  empty message. */
function isSayCall(call: { tool: string; args: unknown }): boolean {
  if (call.tool !== 'say_to_user') return false
  const message = (call.args as { message?: unknown } | null)?.message
  return typeof message !== 'string' || message.trim().length > 0
}

/**
 * The nudge log against what the route reported: how many `say_to_user`
 * calls it made, how many broadcasts the driver received, and, when some are
 * missing, the chunk from which the log is UNCERTAIN.
 *
 * `said` excludes the calls the route's time guard dropped as stale
 * (`FlushRecord.stale_nudge_drops`) and those a nudge.worth gate held
 * (`held_nudge_drops`, 0 while it runs in shadow): those were never meant to
 * broadcast, so they are intentional silences, not missing nudges.
 *
 * A broadcast arrives after the call that made it (late ones drain into a
 * later flush), so received nudges lag the calls, never lead them. Walking the
 * flushes in order, the last point where received caught up with said is
 * where the log is last known complete; every missing nudge belongs to a chunk
 * after it. `uncertainFromChunk` is the first such chunk, or null when nothing
 * is missing. Pure.
 */
export function nudgeLogGap(trace: EvalTrace): {
  said: number
  received: number
  missing: number
  uncertainFromChunk: number | null
} {
  const flushes = trace.flushes ?? []
  let said = 0
  let received = 0
  let balancedThrough = -1
  flushes.forEach((f, i) => {
    said += Math.max(
      0,
      f.response.tool_call_details.filter(isSayCall).length - (f.stale_nudge_drops ?? 0) - (f.held_nudge_drops ?? 0),
    )
    received += (f.nudges ?? []).length
    if (received >= said) balancedThrough = i
  })
  const missing = Math.max(0, said - received)
  const next = flushes[balancedThrough + 1]
  return { said, received, missing, uncertainFromChunk: missing > 0 && next ? next.index : null }
}

/** One nudge's lateness on the script's own clock. */
export type NudgeLatency = PlacedNudge & {
  /** The chunk of the flush that produced it (a broadcast can drain into a
   *  later flush, so this may sit before `chunk`). */
  produced_chunk: number
  /** Nudge `ts` minus its flush's `started_at_ms`; `response.duration_ms`
   *  (an upper bound) on a trace without send times. */
  time_to_nudge_ms: number
  bound: 'measured' | 'upper'
  /** The chunk being spoken when it would have landed on a real call: the
   *  produced chunk's end plus the time-to-nudge. */
  landed_chunk: number
  /** landed_chunk - produced_chunk. */
  lag_chunks: number
  /** True when it would have landed after the script's last chunk ended. */
  past_end?: true
}

/** Each chunk's script times, from the case's frozen chunks, else from the
 *  flush log (a flush's `t_ms` is its chunk's start; its end is the next
 *  window's start, and the last one's is open). */
function chunkClock(trace: EvalTrace, chunks: FrozenChunk[]): Array<{ index: number; start: number; end: number }> {
  if (chunks.length > 0) {
    return [...chunks]
      .sort((a, b) => a.index - b.index)
      .map((c) => ({ index: c.index, start: c.t_ms_start, end: c.t_ms_end }))
  }
  // The last window's end is unknown here, so it stays open.
  const windows = (trace.flushes ?? []).filter((f) => !f.record_only).sort((a, b) => a.index - b.index)
  return windows.map((f, i) => ({ index: f.index, start: f.t_ms, end: windows[i + 1]?.t_ms ?? Number.POSITIVE_INFINITY }))
}

/**
 * Every nudge's simulated lateness: when it would have landed on a real call.
 *
 * The replay runs at `instant`, so a nudge's place in the flush log says
 * nothing about time. Its time-to-nudge does: the producing flush (the last
 * one sent at or before the nudge's `ts`) ended its chunk at `t_ms_end` on the
 * script clock, so the nudge would have arrived at `t_ms_end + time_to_nudge`,
 * during whichever chunk was being spoken then (the latest one started by
 * that moment). Pure.
 */
export function nudgeLatencies(trace: EvalTrace, ctx: NudgeGradingContext = {}): NudgeLatency[] {
  const flushes = trace.flushes ?? []
  const clock = chunkClock(trace, ctx.chunks ?? [])
  const byIndex = new Map(clock.map((c) => [c.index, c]))
  const out: NudgeLatency[] = []
  flushes.forEach((f, fi) => {
    for (const n of f.nudges ?? []) {
      const sent = flushes.slice(0, fi + 1).filter((p) => typeof p.started_at_ms === 'number')
      let producer: FlushRecord = f
      let ttn: number
      let bound: 'measured' | 'upper'
      if (sent.length > 0) {
        producer = [...sent].reverse().find((p) => (p.started_at_ms as number) <= n.ts) ?? sent[0]
        ttn = Math.max(0, n.ts - (producer.started_at_ms as number))
        bound = 'measured'
      } else {
        ttn = Math.max(0, f.response.duration_ms ?? 0)
        bound = 'upper'
      }
      const produced = producer.index
      const end = byIndex.get(produced)?.end ?? producer.t_ms
      const arrival = end + ttn
      let landed = produced
      for (const c of clock) if (c.index >= produced && c.start <= arrival) landed = Math.max(landed, c.index)
      const last = clock[clock.length - 1]
      out.push({
        chunk: f.index,
        id: n.id,
        kind: n.kind,
        message: n.message,
        ...(f.record_only ? { record_only: true as const } : {}),
        produced_chunk: produced,
        time_to_nudge_ms: Math.round(ttn),
        bound,
        landed_chunk: landed,
        lag_chunks: landed - produced,
        ...(last && arrival > last.end ? { past_end: true as const } : {}),
      })
    }
  })
  return out
}

/** The last chunk the trial reached (a trial that errored stops early). */
function lastChunkReached(trace: EvalTrace): number {
  return Math.max(-1, ...(trace.flushes ?? []).map((f) => f.index))
}

/** The nudge timeline as check evidence: what the UI renders per trial, since
 *  the poll carries checks and not the trace. Messages are capped so one
 *  rambling nudge cannot bloat the row. */
function timelineEvidence(nudges: PlacedNudge[]) {
  return nudges.map((n) => ({
    chunk: n.chunk,
    kind: n.kind,
    message: n.message.length > 400 ? `${n.message.slice(0, 397)}…` : n.message,
    ...(n.record_only ? { record_only: true } : {}),
  }))
}

function chunkRange(from: number, to: number): string {
  return from === to ? `chunk ${from}` : `chunks ${from}–${to}`
}

/**
 * The deterministic nudge checks (dimension `nudges`), live trials only: the
 * nudge ground truth is the driver's own subscription log (`FlushRecord.nudges`),
 * never `chat_messages` (a broadcast lost on the way is a nudge the person
 * never saw on the desktop HUD, and the row lands whatever the broadcast did).
 *
 *   `nudge_count`               always: the count and the whole timeline. Graded
 *                               only against `max_nudges`; without one it is
 *                               reported as `unknown` (no verdict, out of the
 *                               denominator), because the sidekick has no quota.
 *   `nudge_quiet_window:<a>-<b>` per `no_nudge_windows` entry: any nudge on a
 *                               chunk in [a, b] fails.
 *   `nudge_expected:<key>`      per `nudges` entry: passes when some nudge
 *                               landed in [after_chunk, before_chunk] (both
 *                               inclusive, open-ended when omitted). Whether it
 *                               was ABOUT the right thing is judge_nudges' call.
 *                               A window the trial never reached is `unknown`.
 *   `nudge_latency`             when any nudge arrived: each nudge's lateness on
 *                               the script clock (nudgeLatencies), graded only
 *                               against `max_nudge_lag_chunks`; without one it
 *                               is reported as `unknown`.
 *   `nudge_after_first_speaker` a nudge before anyone but the person has spoken
 *                               fails, unless the case sets `opening_brief`
 *                               (then the check is not emitted). Not emitted
 *                               when nobody else ever speaks.
 *
 * When fewer broadcasts arrived than the route reported `say_to_user` calls
 * (a Realtime hiccup, or a last nudge still in flight), the log is uncertain
 * from `nudgeLogGap`'s chunk on. A verdict the missing nudges could flip reads
 * `unknown` rather than grading a silence that may not have happened: a clean
 * quiet window, a missed expected window or a quiet opening that reaches the
 * uncertain chunks, and a count under a ceiling the calls exceed. A verdict
 * they cannot flip (a received nudge in a quiet window, a received expected
 * nudge) stands.
 */
export function gradeNudges(
  trace: EvalTrace,
  expected: ExpectedOutcomes,
  ctx: NudgeGradingContext = {},
): DraftCheck[] {
  if (trace.mode !== 'live') return []
  const nudges = placedNudges(trace)
  const gap = nudgeLogGap(trace)
  // From this chunk on, a nudge may have been sent and never received.
  const unsureFrom = gap.uncertainFromChunk
  const unsureNote =
    unsureFrom === null
      ? ''
      : ` The route reported ${gap.said} say_to_user call(s) but ${gap.received} nudge(s) arrived, so from chunk ${unsureFrom} on the log may be missing ${gap.missing}.`
  const unknown = (draft: DraftCheck, why: string): DraftCheck => ({
    ...draft,
    outcome: 'unknown',
    rationale: `${why}${unsureNote}`.trim(),
  })
  const out: DraftCheck[] = []
  const staleDrops = (trace.flushes ?? []).reduce((n, f) => n + (f.stale_nudge_drops ?? 0), 0)

  const max = expected.max_nudges
  const counted = typeof max === 'number'
  const countCheck = check({
    dimension: 'nudges',
    grader: 'nudge_count',
    check_key: 'nudge_count',
    label: counted ? `At most ${max} nudge${max === 1 ? '' : 's'}` : 'Nudges sent',
    severity: 'soft',
    outcome: counted ? (nudges.length <= max ? 'pass' : 'fail') : 'unknown',
    score: nudges.length,
    threshold: counted ? max : null,
    rationale: counted
      ? `${nudges.length} nudge(s) against a ceiling of ${max}.`
      : `${nudges.length} nudge(s). Reported, not graded: the case sets no max_nudges.`,
    evidence: {
      count: nudges.length,
      say_to_user_calls: gap.said,
      ...(staleDrops > 0 ? { stale_drops: staleDrops } : {}),
      ...(unsureFrom !== null ? { missing: gap.missing, uncertain_from_chunk: unsureFrom } : {}),
      nudges: timelineEvidence(nudges),
    },
  })
  // A pass under the ceiling that the missing nudges could tip over is unsure.
  out.push(
    counted && countCheck.outcome === 'pass' && gap.said > max
      ? unknown(countCheck, `${nudges.length} nudge(s) arrived against a ceiling of ${max}.`)
      : countCheck,
  )

  for (const window of expected.no_nudge_windows ?? []) {
    const from = Math.min(window.from_chunk, window.to_chunk)
    const to = Math.max(window.from_chunk, window.to_chunk)
    const inside = nudges.filter((n) => n.chunk >= from && n.chunk <= to)
    const quiet = check({
      dimension: 'nudges',
      grader: 'nudge_quiet_window',
      check_key: `nudge_quiet_window:${from}-${to}`,
      label: `Quiet during ${chunkRange(from, to)}`,
      severity: window.severity ?? 'soft',
      outcome: inside.length === 0 ? 'pass' : 'fail',
      rationale:
        inside.length === 0
          ? `No nudge landed in ${chunkRange(from, to)}.`
          : `${inside.length} nudge(s) landed in ${chunkRange(from, to)}, which this case keeps quiet.`,
      evidence: { from_chunk: from, to_chunk: to, nudges: timelineEvidence(inside) },
    })
    // A received nudge inside is a real fail; a clean window that reaches the
    // uncertain tail may have held a nudge that never arrived.
    out.push(
      quiet.outcome === 'pass' && unsureFrom !== null && to >= unsureFrom
        ? unknown(quiet, `No received nudge landed in ${chunkRange(from, to)}.`)
        : quiet,
    )
  }

  const reached = lastChunkReached(trace)
  const lastScripted = Math.max(-1, ...(ctx.chunks ?? []).map((c) => c.index))
  for (const want of expected.nudges ?? []) {
    const after = want.after_chunk ?? 0
    const before = want.before_chunk ?? Number.POSITIVE_INFINITY
    const inside = nudges.filter((n) => n.chunk >= after && n.chunk <= before)
    const where = Number.isFinite(before)
      ? chunkRange(after, before)
      : after > 0
        ? `chunk ${after} or later`
        : 'any chunk'
    const base = {
      dimension: 'nudges' as const,
      grader: 'nudge_expected',
      check_key: `nudge_expected:${want.key}`,
      label: `Speaks up about ${want.about.length > 60 ? `${want.about.slice(0, 57)}…` : want.about}`,
      severity: want.severity ?? ('soft' as const),
    }
    const windowEvidence = { after_chunk: want.after_chunk ?? null, before_chunk: want.before_chunk ?? null }
    if (inside.length === 0 && reached < after) {
      // A window past the script's own end is an authoring mistake, not a
      // trial that stopped early: say which.
      const pastScript = lastScripted >= 0 && after > lastScripted
      out.push(
        check({
          ...base,
          outcome: 'unknown',
          rationale: pastScript
            ? `The window (${where}) starts past the script's last chunk (${lastScripted}), so no trial can reach it. Fix the case.`
            : `The trial stopped at chunk ${reached} before the window (${where}) opened.`,
          evidence: { ...windowEvidence, reached, ...(pastScript ? { last_chunk: lastScripted } : {}) },
        }),
      )
      continue
    }
    const expectedCheck = check({
      ...base,
      outcome: inside.length > 0 ? 'pass' : 'fail',
      rationale:
        inside.length > 0
          ? `${inside.length} nudge(s) landed in ${where}; judge_nudges decides whether one was about it.`
          : `No nudge landed in ${where}.`,
      evidence: {
        ...windowEvidence,
        // How many chunks after the window opened the first nudge in it landed.
        ...(inside.length > 0 ? { lag_chunks: inside[0].chunk - after } : {}),
        nudges: timelineEvidence(inside),
      },
    })
    // A miss whose window reaches the uncertain tail may be a nudge that was
    // sent and never received.
    out.push(
      expectedCheck.outcome === 'fail' && unsureFrom !== null && before >= unsureFrom
        ? unknown(expectedCheck, `No received nudge landed in ${where}.`)
        : expectedCheck,
    )
  }

  const latencies = nudgeLatencies(trace, ctx)
  if (latencies.length > 0) {
    const maxLag = Math.max(...latencies.map((l) => l.lag_chunks))
    const upper = latencies.some((l) => l.bound === 'upper')
    const allowed = expected.max_nudge_lag_chunks
    const gated = typeof allowed === 'number'
    const late = gated ? latencies.filter((l) => l.lag_chunks > allowed) : []
    const latency = check({
      dimension: 'nudges',
      grader: 'nudge_latency',
      check_key: 'nudge_latency',
      label: gated ? `Nudges land within ${allowed} chunk${allowed === 1 ? '' : 's'}` : 'Nudge lateness',
      severity: 'soft',
      outcome: gated ? (late.length === 0 ? 'pass' : 'fail') : 'unknown',
      score: maxLag,
      threshold: gated ? allowed : null,
      rationale: `${
        gated
          ? late.length === 0
            ? `Every nudge would have landed within ${allowed} chunk(s) of its moment (at most ${maxLag}).`
            : `${late.length} nudge(s) would have landed more than ${allowed} chunk(s) after their moment (at most ${maxLag}).`
          : `At most ${maxLag} chunk(s) late on the call's clock. Reported, not graded: the case sets no max_nudge_lag_chunks.`
      }${upper ? ' Some times are upper bounds (the trace has no send times).' : ''}`,
      evidence: {
        max_lag_chunks: maxLag,
        ...(upper ? { bound: 'upper' } : {}),
        nudges: latencies.map((l) => ({
          ...timelineEvidence([l])[0],
          produced_chunk: l.produced_chunk,
          landed_chunk: l.landed_chunk,
          lag_chunks: l.lag_chunks,
          time_to_nudge_ms: l.time_to_nudge_ms,
          ...(l.past_end ? { past_end: true } : {}),
        })),
      },
    })
    // A fail measured on upper bounds may not be real, and a pass the missing
    // nudges could tip over is unsure.
    out.push(
      gated && latency.outcome === 'fail' && upper
        ? unknown(latency, `${late.length} nudge(s) may have landed late, but the times are upper bounds.`)
        : gated && latency.outcome === 'pass' && unsureFrom !== null
          ? unknown(latency, `Every received nudge landed within ${allowed} chunk(s).`)
          : latency,
    )
  }

  const firstOther = firstOtherSpeakerChunk(trace, ctx)
  if (!expected.opening_brief && firstOther !== null) {
    const early = nudges.filter((n) => n.chunk < firstOther)
    const opening = check({
      dimension: 'nudges',
      grader: 'nudge_after_first_speaker',
      check_key: 'nudge_after_first_speaker',
      label: 'Quiet until someone else speaks',
      severity: 'soft',
      outcome: early.length === 0 ? 'pass' : 'fail',
      rationale:
        early.length === 0
          ? `No nudge before chunk ${firstOther}, where someone other than the person first spoke.`
          : `${early.length} nudge(s) before anyone but the person had spoken (first at chunk ${firstOther}), and this case expects no opening brief.`,
      evidence: { first_other_speaker_chunk: firstOther, nudges: timelineEvidence(early) },
    })
    out.push(
      opening.outcome === 'pass' && unsureFrom !== null && unsureFrom < firstOther
        ? unknown(opening, `No received nudge before chunk ${firstOther}.`)
        : opening,
    )
  }

  return out
}

/**
 * Every deterministic check for one trial.
 *
 * @returns the checks, plus `proposalsUnknown` — true when a flush was
 *          truncated, which the proposal matcher reads to downgrade its own
 *          verdicts to `unknown` instead of reporting a recall miss the prompt
 *          did not cause.
 */
export function gradeDeterministic(
  trace: EvalTrace,
  expected: ExpectedOutcomes,
  ctx: NudgeGradingContext = {},
): { checks: DraftCheck[]; proposalsUnknown: boolean } {
  const stepCeiling = gradeStepCeiling(trace)
  const checks: DraftCheck[] = [
    ...gradeTools(trace, expected),
    gradeSummaryWritten(trace),
    gradeGateRecorded(trace),
    stepCeiling,
    ...gradeBudgets(trace, {}),
    ...gradeDirectives(trace, expected),
    ...gradeNudges(trace, expected, ctx),
  ]
  return { checks, proposalsUnknown: stepCeiling.outcome === 'fail' }
}
