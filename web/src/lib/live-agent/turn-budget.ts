/**
 * The live agent's per-turn BUDGETS, and the small pure rules around them:
 * which kind a turn is, how much it may do, whether a tick has anything new to
 * process, and when a failed turn is retried once with less context.
 *
 * Why (PROD audit, 2026-10-15, 225 live-agent turns, all of them background
 * windows): p50 15 s, p90 49 s, p95 70 s. The slow tail was not research, it
 * was OUTPUT: single model steps of 11K-53K tokens (1-6 minutes each, finish
 * 'stop' or one giant tool input) on a window of a few hundred words. The
 * client runs windows one at a time, so one such step froze the meeting's
 * agent for minutes while every later window queued behind it. eve 0.79.1 has
 * no per-call output cap and no step-count stop, so the route enforces both
 * while it reads the turn's stream (readLiveTurn): it counts the streamed
 * output of each step and the turn, and cancels the session when a budget is
 * spent, exactly as it already did at the step ceiling.
 *
 * Dependency-free on purpose (the ceiling's names only), so the prompt rider
 * and the tests can import it without the server graph.
 */
import { LIVE_AGENT_STAGING_TOOL_NAMES } from './ceiling'

/**
 * What a live-agent turn is for, which decides its budget:
 *   - 'tick' ..... a transcript window (copilot or paired notes): background,
 *                  nobody waits on it, but the next window queues behind it
 *   - 'record' ... the out-of-cycle turn a person's directive starts ("note
 *                  that Dana owns the budget"): the one live-agent turn a
 *                  person is waiting on, so the smallest budget
 *   - 'batch' .... the end-of-meeting / Reprocess pass over the whole call
 */
export type LiveTurnKind = 'tick' | 'record' | 'batch'

export interface LiveTurnBudget {
  /** Completed model steps before the turn is cancelled (the step ceiling). */
  maxSteps: number
  /** Streamed output (text + tool input) one step may produce. */
  maxStepOutputTokens: number
  /** Streamed output (text + tool input) the whole turn may produce. */
  maxTurnOutputTokens: number
  /** Streamed reasoning one step may produce: its own allowance, never the output's. */
  maxStepReasoningTokens: number
  /** Wall-clock budget from the first event read; null = only the route's own wall. */
  deadlineMs: number | null
}

/**
 * The budgets. A tick's steps used to be 20 and its output unbounded; the
 * healthy tick (p50) is 3 steps and ~1K output tokens, and a window holds a
 * few hundred words, so 4K output tokens in one step is already far past
 * anything a window earns. The record turn does one thing (record the
 * directive). The batch keeps its 50 steps: it reads the whole meeting and
 * writes the full summary (the longest today's captures needed was ~5K tokens).
 *
 * Every turn thinks (Liam, 2026-10-31), so reasoning has an allowance of its
 * own beside the output's, sized to DeepSeek's usual 1-3K tokens a step with
 * room for its 5-8K on a hard one; the deadlines grew to hold it (Flash
 * thinks at ~100 tokens/s on the hosts that reason fully).
 */
export const LIVE_TURN_BUDGETS: Readonly<Record<LiveTurnKind, LiveTurnBudget>> = {
  tick: { maxSteps: 8, maxStepOutputTokens: 4_000, maxTurnOutputTokens: 8_000, maxStepReasoningTokens: 8_000, deadlineMs: 120_000 },
  record: { maxSteps: 3, maxStepOutputTokens: 1_500, maxTurnOutputTokens: 3_000, maxStepReasoningTokens: 4_000, deadlineMs: 60_000 },
  batch: { maxSteps: 50, maxStepOutputTokens: 16_000, maxTurnOutputTokens: 40_000, maxStepReasoningTokens: 16_000, deadlineMs: null },
}

/**
 * Streamed characters per output token, for turning a token budget into a
 * character count the route can measure on the stream (eve reports a step's
 * tokens only once it completes, which is too late to stop a runaway). Prose
 * runs ~4, JSON tool input ~3.5, so 4 errs on the side of letting a step run.
 */
export const OUTPUT_CHARS_PER_TOKEN = 4

/** The character limits readLiveTurn enforces for a budget. */
export function outputCharLimits(budget: LiveTurnBudget): { maxStepOutputChars: number; maxTurnOutputChars: number; maxStepReasoningChars: number } {
  return {
    maxStepOutputChars: budget.maxStepOutputTokens * OUTPUT_CHARS_PER_TOKEN,
    maxTurnOutputChars: budget.maxTurnOutputTokens * OUTPUT_CHARS_PER_TOKEN,
    maxStepReasoningChars: budget.maxStepReasoningTokens * OUTPUT_CHARS_PER_TOKEN,
  }
}

/** The route's request flags → the turn's kind. */
export function liveTurnKind(a: { isBatch: boolean; recordOnly: boolean }): LiveTurnKind {
  if (a.isBatch) return 'batch'
  return a.recordOnly ? 'record' : 'tick'
}

// ── Skipping a tick with nothing new ─────────────────────────────────────────

/**
 * Below this many letters of real speech, a window has nothing to process: it
 * is back-channel only ("yeah", "okay", "mm-hmm"). The transcript gate flushes
 * any non-empty buffer after 60 s even when it holds one "yeah, okay", and
 * each flush cost a full model turn (~19K input tokens). Deliberately the
 * narrowest rule (one real word runs the turn): a short "no" to a question
 * can matter, so anything but pure back-channel is processed. The skipped
 * window is not lost either: the client keeps it in its sliding window, so the
 * next turn still reads it.
 */
export const MIN_TICK_SPEECH_LETTERS = 1

/** Back-channel words that carry nothing to record or act on. */
const FILLER_WORDS = new Set([
  'yeah', 'yep', 'yup', 'ok', 'okay', 'k', 'mm', 'mmm', 'hmm', 'hm', 'mhm', 'uh', 'um', 'umm',
  'uhh', 'ah', 'oh', 'right', 'sure', 'cool', 'nice', 'great', 'thanks', 'thank', 'you', 'so', 'and', 'like', 'well',
  'alright', 'huh', 'got', 'it', 'totally', 'exactly', 'true', 'bye', 'hi', 'hey', 'hello', 'sorry', 'good',
  'sounds', 'perfect', 'awesome', 'gotcha', 'interesting', 'wow',
])

/** A transcript line's speaker label (`[local_1]:`, `Speaker 2:`), stripped before counting. */
const SPEAKER_LABEL = /^\s*(\[[^\]\n]{1,60}\]|[A-Za-z][\w .'-]{0,40}):\s*/gm

/** Letters of non-filler speech in a transcript window. */
export function speechLetters(text: string): number {
  // Hyphens split too, so "mm-hmm" and "uh-huh" read as their filler halves.
  const words = text.replace(SPEAKER_LABEL, ' ').toLowerCase().split(/[^\p{L}\p{N}']+/u)
  let letters = 0
  for (const w of words) {
    const word = w.replace(/^'+|'+$/g, '')
    if (!word || FILLER_WORDS.has(word)) continue
    letters += word.length
  }
  return letters
}

/**
 * Whether a tick should run no model at all: a window (not a record turn, not
 * the batch) whose NEWEST chunk holds no real speech, with no directive to
 * record and no meeting-so-far prime to take in. Only the newest chunk counts:
 * the older ones in the sliding window were processed by earlier turns.
 */
export function tickHasNothingNew(a: {
  kind: LiveTurnKind
  recentChunks: readonly string[] | undefined
  directiveCount: number
  priorTranscript: string | undefined
}): boolean {
  if (a.kind !== 'tick' || a.directiveCount > 0 || a.priorTranscript?.trim()) return false
  const newest = a.recentChunks?.[a.recentChunks.length - 1]
  if (typeof newest !== 'string') return false
  return speechLetters(newest) < MIN_TICK_SPEECH_LETTERS
}

// ── Retrying a failed turn once ──────────────────────────────────────────────

/**
 * The eve failure codes worth one retry: a model call the provider rejected or
 * that failed after eve's own retries. Never a fail-closed refusal (no spec,
 * MODEL_SELECTION_FAILED, a token or auth problem): running those again only
 * fails again, and a refused spec must never run blind.
 *
 * The 2026-10-15 16:55 failure was this code: the upstream host (wafer) ended
 * a DeepSeek V4 Flash stream 67 s in with invalid_request_error /
 * model_request_rejected, isRetryable false, so eve failed the session. The
 * turn carried text only (live turns have no attachments), well inside the 1M
 * window, so it was not a size limit or an image: a provider-side refusal of
 * that one request.
 */
const RETRYABLE_FAILURE_CODES = new Set(['MODEL_CALL_FAILED'])

/**
 * The live agent's staging tools that are safe to run twice: the reads, and
 * load_skill, whose only write (captures.live_playbook) is idempotent. A
 * failed attempt that called only these duplicated nothing, so the turn can
 * run again.
 */
const STAGING_READS = new Set(['search_projects', 'search_contacts', 'get_project_details', 'load_skill'])

/** The staging tools that write the record or speak to the person. */
export const LIVE_TURN_WRITE_TOOLS: ReadonlySet<string> = new Set(
  LIVE_AGENT_STAGING_TOOL_NAMES.filter((name) => !STAGING_READS.has(name)),
)

/** The minimal event shape the retry rule reads (eve's MessageStreamEvent fits it). */
type FailureEvent =
  | { type: 'session.failed' | 'turn.failed' | 'step.failed'; data: { code?: string } }
  | { type: 'actions.requested'; data: { actions: ReadonlyArray<{ kind: string; toolName?: string }> } }
  | { type: string; data?: unknown }

/** The code of the failure that ended a turn ('session.failed' etc.), or null. */
export function liveTurnFailureCode(events: readonly FailureEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev.type === 'session.failed' || ev.type === 'turn.failed' || ev.type === 'step.failed') {
      const code = (ev.data as { code?: unknown } | undefined)?.code
      return typeof code === 'string' ? code : null
    }
  }
  return null
}

/**
 * Whether a failed attempt gets ONE retry: its failure is a retryable model
 * failure, and it requested no tool that writes the record or speaks (a retry
 * after a write could stage the same proposal twice or repeat a heads-up).
 * Requested, not completed: a call announced in a step that then failed may
 * still have run.
 */
export function shouldRetryLiveTurn(events: readonly FailureEvent[]): boolean {
  const code = liveTurnFailureCode(events)
  if (!code || !RETRYABLE_FAILURE_CODES.has(code)) return false
  for (const ev of events) {
    if (ev.type !== 'actions.requested') continue
    const actions = (ev.data as { actions?: ReadonlyArray<{ kind?: string; toolName?: string }> } | undefined)?.actions ?? []
    for (const a of actions) {
      if ((a.kind === 'tool-call' || a.kind === 'workflow-tool-call') && a.toolName && LIVE_TURN_WRITE_TOOLS.has(a.toolName)) {
        return false
      }
    }
  }
  return true
}

/**
 * The least wall clock a retry gets. A turn's deadline covers its retry too
 * (the next window queues behind it), but a retry after a slow failure still
 * gets this long.
 */
export const RETRY_MIN_DEADLINE_MS = 20_000

/** How much of the newest window a reduced-context retry keeps (characters). */
export const RETRY_WINDOW_CHARS = 4_000

/**
 * The transcript window for a reduced-context retry: the newest chunk only,
 * its last RETRY_WINDOW_CHARS characters (cut at a line start when one is
 * near). Whatever in the request the provider refused is most likely in the
 * bulk of it, and the older chunks were processed by earlier turns anyway.
 */
export function reducedRetryChunks(recentChunks: readonly string[]): string[] {
  const newest = recentChunks[recentChunks.length - 1]
  if (typeof newest !== 'string') return []
  if (newest.length <= RETRY_WINDOW_CHARS) return [newest]
  const tail = newest.slice(-RETRY_WINDOW_CHARS)
  const lineStart = tail.indexOf('\n')
  return [lineStart >= 0 && lineStart < 400 ? tail.slice(lineStart + 1) : tail]
}

/** What the person sees in the HUD when their record turn failed twice. */
export const RECORD_TURN_FAILED_NOTE = "Couldn't record that just now. I'll pick it up on the next pass."

// ── Timeliness: a tick's research is worth less once the moment has passed ──

/**
 * How old a tick's window may be (ms since the client flushed it, or since the
 * turn started when the client sent no window age) before the tool route
 * refuses further READ tools on an ASSIST-ONLY copilot (a record-writing
 * copilot keeps its reads; time-guard.ts). Past it the turn should say what it has in one
 * line or stay silent: research that lands after the moment is worse than
 * silence. PROD 10-18: tick nudges land at a median of 10 s into the turn
 * (p90 20 s), 1 of 33 after 25 s, so this is a safety net for slower research.
 */
export const LIVE_RESEARCH_CUTOFF_MS = 25_000

/**
 * How old a tick's window may be before a `say_to_user` is dropped as stale:
 * not persisted, not broadcast (PROD 10-18: none landed after 45 s).
 */
export const LIVE_NUDGE_EXPIRY_MS = 45_000
