/**
 * The server runtime of the run_skill executor: a durable eve TASK session on
 * the `skill-runner` agent.
 *
 * Sits BETWEEN assembleSkillRun and deliverSkillOutput/deliverVerdictRun (the
 * caller, runSpecViaEve in run-skill.ts, owns delivery):
 *
 *   - The run's system prompt + ceiling tools + model are delivered to the eve
 *     resolvers by REBUILDING them server-side from a small HMAC-signed run token
 *     (see skill-run-token.ts / skill-run-rebuild.ts) — nothing crosses a Vercel
 *     function boundary as in-process state.
 *   - The fire-ephemeral userMessage rides as the eve task MESSAGE (its natural
 *     role).
 *   - report/prose runs: await result().message → deliverSkillOutput.
 *   - verdict runs: request an outputSchema (the structured verdict contract,
 *     verdict-schema.ts); read the committed result as a RunVerdict →
 *     deliverVerdictRun (server-side applyVerdict).
 *   - WS-4c salvage: a verdict run whose session fails / aborts / times out AFTER
 *     the model committed its verdict still returns that verdict (flagged
 *     `salvaged`) instead of throwing it away. NARROW on eve: the committed
 *     verdict is the `result.completed` event, which eve emits once, as the
 *     finalized payload just before the turn boundary (docs
 *     guides/client/output-schema, concepts/sessions-runs-and-streaming). So
 *     salvage covers only a failure in that short gap. A run that hits the wall
 *     mid-sweep has committed nothing and still loses the whole sweep. The
 *     retired gateway salvage also covered that case, because its
 *     submit_run_verdict tool call landed mid-run.
 *   - The wall stops the SERVER session too: aborting the stream only detaches
 *     locally (eve turns survive disconnects), so a wall that fires is
 *     followed by cancelTaskSession, whether the stream threw or (eve's actual
 *     behaviour on an aborted signal) just ended. The run token expires shortly
 *     after the wall as a backstop.
 *   - Usage/cost: summed from the stream's step.completed events under eve's
 *     cost rule (sumEveUsage → mapEveTurnUsage: BYOK-0 / Exa-contaminated cost
 *     → null → RPC list price), Exa spend carried as webSearchCostUsd.
 *
 * Requires RUN_SKILL_INTERNAL_SECRET (it signs the run token); without it the run
 * throws and the caller marks it failed.
 *
 * Bots v3 Phase 4 (`park`): a run a loop's bot fronts runs as a CONVERSATION
 * session instead (createParkingRunSession), so it can be continued from the
 * bot's bubble once it's over. Same dispatch, same wall, same step cap, same
 * salvage, same delivery (the caller's, once). The differences: a clean end is
 * a park at `session.waiting`, and the result then carries `parked` (the
 * session id and the read cursor) for the caller to keep; a turn that parked
 * on a failure or on a prompt for input fails the run and cancels the
 * session, as task mode would have failed it. Every outcome other than a
 * clean end cancels the session, so only a delivered run can be continued.
 */
import { Client } from 'eve/client'
import type {
  ClientSession,
  HandleMessageStreamEvent,
  MessageResponse,
  MessageResult,
  MessageStreamEvent,
} from 'eve/client'
import { cancelTaskSession, createParkingRunSession, createTaskSession, retireTaskSession } from '@/lib/eve/task-session'
import { classifyOneShot, createTurnBoundary, TURN_CANCELLED_CODE } from '@/lib/eve/turn-boundary'
import { eveDispatchOrigin } from '@/lib/eve/dispatch-origin'
import { mapEveTurnUsage } from '@/lib/chat/eve-usage'
import { normalizeVerdict, verdictOutputSchema, verdictOutputSchemaFor } from './verdict-schema'
import { connectorOutputSchema } from './output-connectors'
import { LENS_SCHEMAS, ridingLensKeys } from './lenses'
import { toolReadOf, type ToolRead } from '@/lib/safety/outside-text'
import { randomUUID } from 'node:crypto'
import { getServiceClient } from '@/lib/admin'
import { NATIVE_OUTSIDE_TOOLS, noteRunReadOutside } from './skill-run-reads'
import { mintRunToken, internalSecret } from './skill-run-token'
import type { SkillRunSpec } from './run-skill'
import type { RunVerdict } from './verdict-apply'

/**
 * The model-step cap: main's run_skill ran generateText with
 * `stopWhen: isStepCount(12)`. eve has no step-count limit (its session limits
 * are token/cost budgets), so runViaEve counts `step.started` on the stream: the
 * 13th ends the run. The session is cancelled and what exists is delivered: a
 * verdict run its committed verdict (normally none, since eve commits only at
 * the turn boundary, so the verdict walk records it missing), a prose run the
 * text of the LAST started step ('' when that step only called tools), exactly
 * generateText's final-step `result.text` at the cap. The usage of every
 * completed step is still billed. The 13th model call itself never runs: the
 * skill-runner's step-cap hook (agents/skill-runner/hooks/step-cap.ts, same
 * constant, parity-tested) cancels the turn at that step.started (ctx.cancel(): eve
 * 0.68+ ignores a hook throw).
 */
export const SKILL_RUN_MAX_STEPS = 12

/** The named eve mount for the skill-runner agent (see next.config.mjs). */
const SKILL_RUNNER_MOUNT = '/eve/skill-runner'

/** Header names — kept in sync with skill-run-token.ts. */
const RUN_SKILL_SECRET_HEADER = 'x-skill-run-secret'
const RUN_SKILL_TOKEN_HEADER = 'x-skill-run-token'
const RUN_SKILL_WORKSPACE_HEADER = 'x-skill-run-workspace'
const RUN_SKILL_USER_HEADER = 'x-skill-run-user'

/**
 * The eve client for the skill-runner mount, authenticated as the trusted
 * internal caller (bearer = the internal secret) with the run token's headers.
 * Used by runViaEve and by the loop-run chat route (bots v3 Phase 4), which
 * mints a fresh token per turn.
 */
export function skillRunnerClient(args: { secret: string; runToken: string; workspaceId: string; userId: string }): Client {
  return new Client({
    host: `${eveDispatchOrigin()}${SKILL_RUNNER_MOUNT}`,
    auth: { bearer: args.secret },
    headers: {
      [RUN_SKILL_SECRET_HEADER]: args.secret,
      [RUN_SKILL_TOKEN_HEADER]: args.runToken,
      [RUN_SKILL_WORKSPACE_HEADER]: args.workspaceId,
      [RUN_SKILL_USER_HEADER]: args.userId,
    },
    redirect: 'error',
  })
}

/** What an eve run produced, in the shape deliverSkillOutput/deliverVerdictRun expect. */
export interface EveRunResult {
  text: string
  /** Cached share of inputTokens (optional: not every provider reports it). */
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  costUsd: number | null
  /** Exa web-search spend (action.result costDollars.total), null when none — metadata only. */
  webSearchCostUsd: number | null
  toolCalls: number
  steps: number
  /** For verdict runs: the structured verdict, or null if none was produced. */
  verdict: RunVerdict | null
  /** True when the model produced neither text nor (for verdict) a verdict. */
  empty: boolean
  /**
   * WS-4c: set ONLY when the session did not complete (failed status, or the
   * stream threw — abort / timeout / transport) but a verdict run had already
   * committed its structured verdict. `verdict` then carries that verdict and
   * usage covers the steps observed before the failure. `partial` is true when
   * the failure was the wall-clock abort/timeout (the ledger is stamped
   * "[partial: run timed out]"), mirroring the retired gateway salvage's
   * /abort|timeout/ test; `error` is the underlying failure message.
   */
  salvaged?: { partial: boolean; error: string }
  /**
   * The run hit SKILL_RUN_MAX_STEPS: its session was cancelled at the 13th model
   * step and this result is what existed (see SKILL_RUN_MAX_STEPS).
   */
  stepCapped?: boolean
  /**
   * F3 output connectors: the structured output a connector run committed
   * (its outputSchema result, unvalidated: output-connectors.ts
   * parseConnectorOutput checks it), or undefined. Never set on a verdict run.
   */
  structured?: unknown
  /**
   * F3 lens flows: the `lenses` part of a verdict run's committed result, raw
   * (lenses.ts validates each section), when lenses rode the run.
   */
  lensOutput?: unknown
  /**
   * What each tool call of this run read, judged by the server from the
   * stream's action.result events (the call's name and output; never
   * reported by the model): run-outside-reads.ts decides from these whether
   * the run read outside text.
   */
  toolReads?: ToolRead[]
  /**
   * Bots v3 Phase 4: a run dispatched with `park` that ended cleanly left its
   * session PARKED at `session.waiting`, and this is the follow-up chat's
   * handle (the caller stores it: skill-run-session.ts). Absent on every other
   * outcome: a wall, a step cap, a failed turn, a prompt for input and a
   * salvage all cancel the session instead, so nothing can continue it.
   */
  parked?: ParkedSkillSession
}

/** Where a parked skill-run session is: its id, and the read cursor past the run's own turn. */
export interface ParkedSkillSession {
  sessionId: string
  streamIndex: number
}

/**
 * A run stopped at its wall-clock wall with no committed verdict to salvage.
 * The server session is already cancelled when this is thrown. It carries
 * what the completed steps spent, so the caller still bills them (the tokens
 * were used even though the run produced nothing). Its message matches the
 * executor's /abort|timeout/ test, so the run is reported as timed out.
 */
export class EveRunTimeoutError extends Error {
  constructor(
    readonly timeoutMs: number,
    readonly spent: Pick<EveRunResult, 'usage' | 'costUsd' | 'webSearchCostUsd' | 'toolCalls' | 'steps'>,
  ) {
    super(`Skill run timeout: stopped at its ${timeoutMs}ms wall`)
    this.name = 'EveRunTimeoutError'
  }
}

/**
 * The eve session ended failed (session.failed) with nothing to salvage. The
 * message carries eve's reason when it gave one, e.g. the skill-runner's
 * refusal to run without its spec (agents/skill-runner/agent.ts NO_SPEC). The
 * executor reports it as it is, never as a timeout, whatever words the
 * reason happens to contain.
 */
export class EveSessionFailedError extends Error {
  constructor(readonly reason: string | null) {
    super(reason ? `eve session failed: ${reason}` : 'eve session failed')
    this.name = 'EveSessionFailedError'
  }
}

/**
 * The outputSchema a run's session requests: the verdict contract for a
 * verdict run, a structured connector's typed output (F3), or none (prose).
 */
export function runOutputSchema(spec: Pick<SkillRunSpec, 'outputContract' | 'outputConnector' | 'lenses' | 'lensRun'>) {
  // A verdict run carries the sections of the lenses riding it (F3).
  if (spec.outputContract === 'verdict') return verdictOutputSchemaFor(ridingLensKeys(spec.lenses ?? []))
  // A lens flow's own run (Triage off) commits its lens's section itself.
  if (spec.lensRun) return LENS_SCHEMAS[spec.lensRun.ride.lens]
  return connectorOutputSchema(spec.outputConnector ?? null)
}

/** Longest failure reason a run records: a provider error can run long. */
const MAX_FAILURE_REASON_CHARS = 500

/** Why eve failed the session: the last failure event's message, if it gave one. */
function sessionFailureReason(events: readonly MessageStreamEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev.type !== 'session.failed' && ev.type !== 'turn.failed' && ev.type !== 'step.failed') continue
    const message = typeof ev.data.message === 'string' ? ev.data.message.trim() : ''
    if (message) return message.slice(0, MAX_FAILURE_REASON_CHARS)
  }
  return null
}

/**
 * Sum usage across the run's step.completed events, with eve's cost rule of
 * record (src/lib/chat/eve-usage.ts — this delegates to mapEveTurnUsage so the
 * skill runner and chat can never drift):
 *
 *   - eve 0.66.3's step `costUsd` is the Gateway's BILLED cost: $0 for the
 *     tokens under BYOK, and it INCLUDES the Exa charge of a provider-executed
 *     web_search (the skill-runner mounts eve's Exa web_search).
 *   - So the cost is trusted only when every token-spending step carried a
 *     positive cost, the sum is > 0, and NO action.result carried an Exa
 *     `costDollars.total`. Otherwise null → logUsage OMITS costUsd → the
 *     log_ai_usage RPC list-prices the summed tokens from ai_model_costs.
 *   - The Exa spend comes back as `webSearchCostUsd` (null when none) for the
 *     usage row's metadata.
 */
export function sumEveUsage(events: readonly HandleMessageStreamEvent[]): {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number | null
  webSearchCostUsd: number | null
  steps: number
} {
  const m = mapEveTurnUsage(events)
  return {
    inputTokens: m.inputTokens,
    outputTokens: m.outputTokens,
    cacheReadTokens: m.cacheReadTokens,
    cacheWriteTokens: m.cacheWriteTokens,
    costUsd: m.costUsd,
    webSearchCostUsd: m.webSearchCostUsd,
    steps: m.steps,
  }
}

/** Count tool calls across the turn's actions.requested events. */
export function countEveToolCalls(events: readonly HandleMessageStreamEvent[]): number {
  let n = 0
  for (const ev of events) {
    if (ev.type === 'actions.requested') {
      n += ev.data.actions.length
    }
  }
  return n
}

/**
 * The structured result the model COMMITTED in these events — the last
 * `result.completed` event's payload, exactly what eve's own
 * `MessageResult.data` is built from — or undefined when none was committed.
 * Works on a partial event list (an aborted stream), which `result()` cannot.
 */
export function committedResult(events: readonly MessageStreamEvent[]): unknown {
  let committed: unknown
  for (const ev of events) {
    if (ev.type === 'result.completed') committed = ev.data.result
  }
  return committed
}

/**
 * How long the run token outlives the wall. The token gates every internal
 * spec/tool route, so a session that survives its wall (a cancel that failed,
 * or a caller killed mid-run before it could cancel) loses its tools at most
 * this long after the wall.
 */
export const RUN_TOKEN_WALL_MARGIN_MS = 60_000

/** The only event types a salvage reads (sumEveUsage / countEveToolCalls /
 *  committedResult). `action.result` carries the Exa web_search spend the cost
 *  rule reads. */
const SALVAGE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'step.completed',
  'actions.requested',
  'action.result',
  'result.completed',
])

/** What one action.result event read (outside-text.ts toolReadOf, shared with work runs). */
export { toolReadOf }

/** The phrasable tool names in one actions.requested event (tool calls only). */
function requestedToolNames(ev: MessageStreamEvent): string[] {
  if (ev.type !== 'actions.requested') return []
  return ev.data.actions.flatMap((a) => (a.kind === 'tool-call' && a.toolName ? [a.toolName] : []))
}

/**
 * Run one assembled skill spec as a durable eve task session and await the result.
 *
 * @param spec        the assembled run spec (from assembleSkillRun)
 * @param hasCapture  whether this fire has a triggering capture (drives the ceiling
 *                    rebuild's capture-read force-add; carried in the signed token)
 * @param timeoutMs   the wall (240s prose / up to 480s verdict)
 * @param onToolCalls optional live-progress hook: called with the tool NAMES of
 *                    each model step's tool calls (never arguments) as they
 *                    stream — feeds the Activity panel's step text.
 *
 * Throws on transport/route error, a failed session, or timeout — EXCEPT a
 * verdict run that already committed its verdict, which returns it with
 * `salvaged` set (WS-4c). A timeout throws EveRunTimeoutError, after the server
 * session is cancelled, carrying what the run spent. The caller's catch marks a
 * thrown run failed.
 */
export async function runViaEve(args: {
  spec: SkillRunSpec
  hasCapture: boolean
  timeoutMs: number
  onToolCalls?: (toolNames: string[]) => void
  /** Automation depth of this run's writes (loop guard) — see RunTokenClaims. */
  originDepth?: number
  /** The fire's work-ledger row id, for work_touch recording — see RunTokenClaims. */
  workItemId?: string
  /**
   * Bots v3 Phase 4: leave the session parked when the run ends cleanly
   * (`parked` on the result), so the loop's bot can carry on the exact chat
   * that did the work. Off (the default): a one-shot, retired after its turn,
   * as every run was before. Delivery is the caller's either way, and unchanged.
   */
  park?: boolean
  /** F1 test_flow: a dry run. Carried in the token; the tool route runs no write (dry-run-tools.ts). */
  dryRun?: boolean
}): Promise<EveRunResult> {
  const { spec, hasCapture, timeoutMs, onToolCalls, originDepth, workItemId, park = false, dryRun = false } = args
  // Every run tracks its outside reads (R2, skill-run-reads.ts): a run with
  // the owner's connected apps is held to them, and a canon edit any run
  // makes is labelled by them.
  const runId = randomUUID()
  const secret = internalSecret()
  if (!secret) throw new Error('eve runtime requested but RUN_SKILL_INTERNAL_SECRET is not set')

  const isVerdict = spec.outputContract === 'verdict'
  // F3: a connector run commits its connector's typed output; a verdict run
  // with lenses riding it commits the verdict plus their sections.
  const outputSchema = runOutputSchema(spec)
  const isStructured = !isVerdict && outputSchema !== null

  // Mint the signed run token carrying ONLY the routing facts. The spec's
  // systemPrompt/ceiling/ceilingTools are re-derived server-side from these on the
  // internal spec/tool routes — nothing large crosses the boundary.
  const runToken = mintRunToken({
    workspaceId: spec.workspaceId,
    runAsUserId: spec.runAsUserId,
    skillId: spec.skillId,
    mode: spec.mode,
    hasCapture,
    outputContract: isVerdict ? 'verdict' : 'prose',
    model: spec.model,
    ...(originDepth !== undefined ? { originDepth } : {}),
    ...(workItemId ? { workItemId } : {}),
    ...(dryRun ? { dryRun: true as const } : {}),
    // F4: the owner's connections this step may use, and the step itself.
    ...(spec.connections?.length ? { connections: spec.connections } : {}),
    ...(spec.flowStep && !dryRun ? { flowStep: spec.flowStep } : {}),
    // F4 review R2: whether the run has read outside text, tracked for real
    // (skill-run-reads.ts) under this run id; earlier steps' flag rides along.
    runId,
    ...(spec.readOutsideBefore ? { readOutsideBefore: true as const } : {}),
  }, { ttlMs: timeoutMs + RUN_TOKEN_WALL_MARGIN_MS })

  // Server-to-server client at the app's own address (eveDispatchOrigin). The
  // shared secret authenticates us as the trusted internal caller; the run token
  // scopes the session; redirect:'error' stops the credentialed headers from
  // following a cross-origin redirect.
  const client = skillRunnerClient({ secret, runToken, workspaceId: spec.workspaceId, userId: spec.runAsUserId })

  // Arm the timeout BEFORE send so it covers the POST + the whole stream.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  // The salvage-relevant events as they stream (usage, tool calls, the committed
  // result — not the text deltas): result() only returns the events on a clean
  // end, so this copy is what a timed-out verdict run is salvaged from.
  const seen: MessageStreamEvent[] = []
  // Step cap (SKILL_RUN_MAX_STEPS): the (MAX + 1)th step.started ends the run.
  let stepsStarted = 0
  let stepCapHit = false
  // The text of the LAST started step only — the cap's prose answer. Reset on
  // every step.started (eve emits message.completed only for a step with text).
  let lastStepText: string | null = null
  // What each call read, judged as its result streams in (run-outside-reads.ts).
  const toolReads: ToolRead[] = []
  // The outside-read notes in flight (the stream callback can't await them):
  // settled before the run returns, so nothing after it reads a stale record.
  const notes: Array<Promise<void>> = []
  const onEvent = (ev: MessageStreamEvent) => {
    if (stepCapHit) return
    if (ev.type === 'step.started') {
      stepsStarted += 1
      if (stepsStarted > SKILL_RUN_MAX_STEPS) {
        // Not recorded: that step never finishes for us. Aborting detaches the
        // stream; the catch below cancels the server session.
        stepCapHit = true
        controller.abort()
        return
      }
      lastStepText = null
    }
    if (ev.type === 'message.completed') lastStepText = ev.data.message ?? null
    if (SALVAGE_EVENT_TYPES.has(ev.type)) seen.push(ev)
    const read = toolReadOf(ev)
    if (read) toolReads.push(read)
    // R2: note the run's outside reads the tool route never sees (eve's web
    // tools, a subagent), at the REQUEST, so the note lands before their
    // result reaches the model; and any result judged outside.
    {
      const native = requestedToolNames(ev).find((name) => NATIVE_OUTSIDE_TOOLS.has(name))
      const outside = native ?? (read && (read.outside || (read.senders?.length ?? 0) > 0) ? read.tool : null)
      if (outside) notes.push(noteRunReadOutside(getServiceClient(), { runId, workspaceId: spec.workspaceId, tool: outside }))
    }
    if (onToolCalls) {
      const names = requestedToolNames(ev)
      if (names.length > 0) onToolCalls(names)
    }
  }
  /** The structured extras a result carries: a connector's output, a verdict's lens sections, the tools called. */
  const extras = (data: unknown): Pick<EveRunResult, 'structured' | 'lensOutput' | 'toolReads'> => ({
    ...(isStructured && data !== undefined ? { structured: data } : {}),
    ...(isVerdict && data && typeof data === 'object' && 'lenses' in data ? { lensOutput: (data as { lenses?: unknown }).lenses } : {}),
    toolReads: [...toolReads],
  })
  /** What a step-capped run delivers: see SKILL_RUN_MAX_STEPS. */
  const stepCapped = (): EveRunResult => {
    const usage = sumEveUsage(seen)
    const committed = committedResult(seen)
    const verdict = isVerdict ? normalizeVerdict(committed) : null
    const text = isVerdict ? '' : (lastStepText ?? '')
    return {
      ...extras(committed),
      text,
      usage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
      },
      costUsd: usage.costUsd,
      webSearchCostUsd: usage.webSearchCostUsd,
      toolCalls: countEveToolCalls(seen),
      steps: usage.steps,
      verdict,
      empty: isVerdict ? verdict === null : isStructured ? committed === undefined : text.trim().length === 0,
      stepCapped: true,
    }
  }
  /** The session reached the cap, whether our tap saw the 13th step.started or
   *  the skill-runner's step-cap hook cancelled the turn on it first. */
  const reachedStepCap = (events: readonly MessageStreamEvent[]): boolean =>
    stepCapHit || events.filter((ev) => ev.type === 'step.completed').length >= SKILL_RUN_MAX_STEPS
  /**
   * WS-4c salvage: a verdict run that committed its verdict before the failure
   * returns it instead of losing the model's decisions. Prose runs, and verdict
   * runs with nothing committed, return null → the caller throws.
   */
  const salvage = (
    events: readonly MessageStreamEvent[],
    error: string,
    partial: boolean,
  ): EveRunResult | null => {
    if (!isVerdict) return null
    const committed = committedResult(events)
    const verdict = normalizeVerdict(committed)
    if (!verdict) return null
    const usage = sumEveUsage(events)
    return {
      ...extras(committed),
      text: '',
      usage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
      },
      costUsd: usage.costUsd,
      webSearchCostUsd: usage.webSearchCostUsd,
      toolCalls: countEveToolCalls(events),
      steps: usage.steps,
      verdict,
      empty: false,
      salvaged: { partial, error },
    }
  }
  /** The wall fired with nothing to salvage: what the completed steps spent. */
  const timedOut = (events: readonly MessageStreamEvent[]): EveRunTimeoutError => {
    const usage = sumEveUsage(events)
    return new EveRunTimeoutError(timeoutMs, {
      usage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
      },
      costUsd: usage.costUsd,
      webSearchCostUsd: usage.webSearchCostUsd,
      toolCalls: countEveToolCalls(events),
      steps: usage.steps,
    })
  }
  // The session to retire once the run is over (retireTaskSession: eve 0.67+
  // parks every session for the skill runner's 30-day timeout). Cleared only
  // for a parking run whose session is kept as the follow-up chat's handle.
  let retireId: string | null = null
  try {
    // A headless, unattended run that must finish within this dispatch. Since
    // eve 0.67 removed run modes, EVERY session parks after its turn: a clean
    // end is `waiting`, a failed turn parks after turn.failed, and a HITL /
    // token-limit prompt parks the turn on input.requested instead of failing
    // closed. Both helpers cut the stream at the turn's boundary, so this await
    // ends; the checks after it read a park on a failure or on a prompt as the
    // run's failure and cancel the session, as task mode used to fail it. The
    // verdict schema rides as the create outputSchema, replacing
    // submit_run_verdict; applyVerdict (server-side) is identical.
    //
    // Bots v3 Phase 4 (`park`): the parked session is also kept as the
    // follow-up chat's handle once the run is over.
    let result: MessageResult<RunVerdict>
    let response: MessageResponse<RunVerdict> | undefined
    let parking: ClientSession | null = null
    try {
      const sessionArgs = {
        message: spec.userMessage,
        signal: controller.signal,
        onEvent,
        // Typed as the verdict's for the session helpers' generic; a connector's
        // result is read as unknown and validated before anything is delivered.
        ...(outputSchema ? { outputSchema: outputSchema as unknown as typeof verdictOutputSchema } : {}),
      }
      if (park) {
        const created = await createParkingRunSession<RunVerdict>(client, sessionArgs)
        response = created.response
        parking = created.session
      } else {
        response = await createTaskSession<RunVerdict>(client, sessionArgs)
      }
      retireId = response.sessionId
      result = await response.result()
    } catch (err) {
      // The stream threw (our wall-clock abort, or a transport/route error). The
      // abort only detached us: the durable session keeps running server-side
      // and would keep calling ceiling tools (external writes on an act run)
      // after this run is reported over. Stop it before salvaging or failing.
      // (No response → the create POST itself failed; the short token TTL is
      // the backstop for a session it may have started.)
      if (response) await cancelTaskSession(client, response.sessionId)
      // Step cap: deliver what exists (and bill every completed step).
      if (stepCapHit) return stepCapped()
      // A verdict committed before the failure is still the model's decision —
      // salvage it.
      const message = err instanceof Error ? err.message : String(err)
      const salvaged = salvage(seen, message, controller.signal.aborted || /abort|timeout/i.test(message))
      if (salvaged) return salvaged
      if (controller.signal.aborted) throw timedOut(seen)
      throw err
    }

    if (stepCapHit) {
      // The stream ended cleanly despite the cap (a race at the boundary):
      // still stop the session and deliver the capped result.
      await cancelTaskSession(client, response.sessionId)
      return stepCapped()
    }

    if (controller.signal.aborted) {
      // The wall. eve's client does NOT throw when its signal aborts: the
      // reader just ends, the stream skips its "ended before the turn
      // boundary" error for an aborted signal (client/session.js), and
      // result() reads the partial events as a 'completed' turn, because
      // with no boundary event summarizeTurnEvents defaults to 'completed'
      // (client/session-utils.js, eve 0.66.3). So a wall that fires mid-run
      // lands HERE, not in the catch above. Until this check, it came back as a
      // successful run with no output ("No verdict was submitted."), and the
      // durable session was never cancelled. Treat it as the timeout it is:
      // stop the server session, salvage a committed verdict, else fail.
      await cancelTaskSession(client, response.sessionId)
      const salvaged = salvage(result.events, `Skill run timeout: stopped at its ${timeoutMs}ms wall`, true)
      if (salvaged) return salvaged
      throw timedOut(result.events)
    }

    // No session fails closed (eve 0.67+): the turn's own end says how the run
    // went (classifyOneShot). A failed turn parks after turn.failed, a cancelled
    // one (a hook's ctx.cancel(), such as the step cap) after turn.cancelled,
    // and a HITL or session-limit prompt holds the turn on input.requested.
    // Each is this run's failure, exactly as task mode would have reported it.
    const endsTurn = createTurnBoundary()
    const boundaryAt = result.events.findIndex((ev) => endsTurn(ev))
    const outcome = boundaryAt < 0 ? null : classifyOneShot(result.events[boundaryAt], result.events.slice(0, boundaryAt + 1))
    const parkedOnInput = result.inputRequests.length > 0 || (outcome?.status === 'waiting' && !outcome.turnEnded)
    const cancelledTurn = outcome?.failureCode === TURN_CANCELLED_CODE
    const failedTurn =
      outcome?.status === 'failed' || result.events.some((ev) => ev.type === 'turn.failed' || ev.type === 'session.failed')
    if (result.status === 'failed' || failedTurn || parkedOnInput) {
      // A turn held on a prompt is still open: stop it (task mode used to fail
      // it closed). A parking session is stopped either way, so nothing can
      // continue a failed run; a one-shot whose turn already ended is left be.
      if (park || parkedOnInput) await cancelTaskSession(client, response.sessionId)
      // The step-cap hook stopped the turn at its 13th step.started.
      if (reachedStepCap(seen)) return stepCapped()
      // A failed session can still carry a committed verdict (result.data is the
      // last result.completed payload) — salvage it; not a timeout, so not partial.
      const failure = new EveSessionFailedError(
        sessionFailureReason(result.events) ??
          (parkedOnInput ? PARKED_ON_INPUT_REASON : cancelledTurn ? CANCELLED_TURN_REASON : null),
      )
      const salvaged = salvage(result.events, failure.message, false)
      if (salvaged) return salvaged
      throw failure
    }

    // The follow-up handle of a session that parked at the end of its turn. A
    // parking session whose handle can't be read (no cursor) can never be
    // continued, so it's stopped here rather than left parked for good.
    const handle = parking && result.status === 'waiting' ? parkedHandle(parking, response.sessionId) : {}
    if (park && !('parked' in handle)) await cancelTaskSession(client, response.sessionId)
    // Kept for the follow-up chat: never retired here (cancelParkedSkillSession
    // retires it later if its handle can't be kept).
    if ('parked' in handle) retireId = null

    const usage = sumEveUsage(result.events)
    const toolCalls = countEveToolCalls(result.events)
    // normalizeVerdict, not a bare cast: needs_user is optional in the
    // outputSchema, and a sparse-but-valid eve result must not reach the apply
    // walk with a missing array (the Jul-13 "needs_user is not iterable" crash).
    const verdict = isVerdict ? normalizeVerdict(result.data) : null
    const text = result.message ?? ''

    return {
      ...extras(result.data),
      text,
      usage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
      },
      costUsd: usage.costUsd,
      webSearchCostUsd: usage.webSearchCostUsd,
      toolCalls,
      steps: usage.steps,
      verdict,
      empty: isVerdict ? verdict === null : isStructured ? result.data === undefined : text.trim().length === 0,
      ...handle,
    }
  } finally {
    clearTimeout(timer)
    // noteRunReadOutside never throws.
    await Promise.all(notes)
    if (retireId) await retireTaskSession(client, retireId)
  }
}

/**
 * Stop a parked skill-run session whose handle won't be kept (bots v3 Phase 4):
 * its delivery threw, its handle couldn't be stored, or a later run on the same
 * row replaced it. Nothing could ever continue it, so it isn't left parked in
 * eve storage. A fresh short token (the run's facts, no chat claim) authenticates
 * the cancel. Never throws; resolves whether eve took the cancel.
 */
export async function cancelParkedSkillSession(
  spec: Pick<SkillRunSpec, 'workspaceId' | 'runAsUserId' | 'skillId' | 'mode' | 'outputContract' | 'model'>,
  hasCapture: boolean,
  sessionId: string,
): Promise<boolean> {
  const secret = internalSecret()
  if (!secret || !sessionId) return false
  try {
    const runToken = mintRunToken(
      {
        workspaceId: spec.workspaceId,
        runAsUserId: spec.runAsUserId,
        skillId: spec.skillId,
        mode: spec.mode,
        hasCapture,
        outputContract: spec.outputContract === 'verdict' ? 'verdict' : 'prose',
        model: spec.model,
      },
      { ttlMs: RUN_TOKEN_WALL_MARGIN_MS },
    )
    const client = skillRunnerClient({ secret, runToken, workspaceId: spec.workspaceId, userId: spec.runAsUserId })
    // eve 0.69+: a cancel only stops a running turn; a parked session stays
    // until the agent's session timeout. Retire it: nothing can continue it.
    const cancelled = await cancelTaskSession(client, sessionId)
    const retired = await retireTaskSession(client, sessionId)
    return cancelled && retired
  } catch {
    return false
  }
}

/** Why a parking run failed when it stopped on a prompt for input (no failure event names one). */
export const PARKED_ON_INPUT_REASON = 'the run stopped to wait for input, and an unattended run has no one to give it'

/** Why a run failed when its turn was cancelled before it finished (no failure event names one). */
export const CANCELLED_TURN_REASON = 'the run was stopped before it finished'

/**
 * The follow-up handle of a session parked at the end of its turn: its id and
 * the read cursor the drained stream left on it (eve advances
 * `ClientSession.state` once the stream reaches the turn boundary).
 */
function parkedHandle(session: ClientSession, sessionId: string): { parked: ParkedSkillSession } | Record<string, never> {
  const state = session.state
  const id = typeof state?.sessionId === 'string' && state.sessionId ? state.sessionId : sessionId
  const streamIndex = typeof state?.streamIndex === 'number' ? state.streamIndex : null
  if (!id || streamIndex === null || streamIndex <= 0) return {}
  return { parked: { sessionId: id, streamIndex } }
}
