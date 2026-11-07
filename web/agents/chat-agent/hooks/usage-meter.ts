/**
 * usage-meter — SERVER-SIDE billing of every eve main-chat turn (WS-5a).
 *
 * Before this hook, eve chat was billed from the BROWSER: the EveChatTransport
 * posted the turn's events + model to /api/account/chat/eve-persist and the
 * server billed what the client said — a client could under-report its own
 * bill, and the cost it relayed could include Exa web-search spend. Now the
 * runtime meters itself: this hook folds the turn's usage-relevant stream
 * events as eve emits them and, when the turn ends, posts ONE summed report to
 * POST /api/internal/chat/usage (internal secret + the chat-run token), which
 * calls logUsage exactly once per turn (durable idempotency on
 * conversation + eve session + turn). eve-persist no longer bills.
 *
 * ── What it folds (lib/turn-usage.ts, the pure accumulator) ─────────────────
 *   turn.started      → a fresh accumulator for the turn (+ its start time)
 *   step.started      → the model slug the step actually runs on
 *   step.completed    → tokens (incl. cache read/write), eve's cost, generation id
 *   actions.requested → tool calls / search_tools discoveries
 *   action.result     → Exa `costDollars.total` from a web_search result
 * Each is stored in a slot keyed by its eve coordinates (sequence:stepIndex /
 * callId), never added on arrival, so a step eve re-runs is counted once.
 *
 * ── Compaction ──────────────────────────────────────────────────────────────
 *   compaction.requested → capture the model + eve's input estimate
 *   compaction.completed → one list-priced report under its own key
 * eve's summarization call emits no step.completed, so without these it was
 * free. Only a MANUAL compaction (/compact, between turns — it may never be
 * followed by a turn.* event) is billed, and it is sent at once. An AUTOMATIC
 * one (inside a step) is not billed: eve (0.66.3 through 0.79.1) emits the same
 * pair when it made no model call, and the events cannot say which (turn-usage.ts
 * compactionFromRequested has the evidence, the key and the estimate).
 * Under a device-ask (surface) token a manual compaction is NOT reported
 * either (the surface rule below) — and /api/device/ask's stream read does not
 * see compactions, so it is unbilled there (a known follow-up, pinned by a test).
 *
 * ── Telemetry ───────────────────────────────────────────────────────────────
 * Every settled report also logs ONE `[chat-context]` line (turn-usage.ts
 * chatContextLogLine): input, cached input and the hit rate (`-` when no step
 * reported cache reads), the largest step's input, and the turn's automatic
 * compactions with their input size. Counts and ids only.
 * The cached tokens are already billed metadata (cache_read_input_tokens).
 *
 * The cost rule is eve-usage.ts's: eve's step cost is the Gateway's BILLED cost
 * (BYOK tokens $0, Exa included), so it is reported only when every
 * token-spending step carried a positive cost and no Exa spend was seen.
 *
 * ── When it bills: every terminal turn event ────────────────────────────────
 * turn.completed, turn.failed and turn.cancelled each settle the turn: tokens
 * spent on completed steps are real spend whatever the ending (the transport
 * persisted failed turns too). Since eve 0.70 a turn that parks for human
 * input (ask_user / approval) is HELD at `turn.waiting` and the answer resumes
 * the SAME turn id with no new turn.started, so the whole turn, both sides of
 * the question, settles once at its one terminal event. (On eve 0.66 the park
 * ended the turn and the answer ran as a new turn id, each billed on its own.)
 * A steer continues the same turn too, so it bills once.
 *
 * ── Durability ──────────────────────────────────────────────────────────────
 * The accumulator lives in `defineState` (durable per-session state, committed
 * at workflow step boundaries), not module memory: a turn's steps can run in
 * different processes. Whether eve discards a hook's uncommitted state when an
 * interrupted step re-runs is NOT documented, so the fold does not rely on it:
 * the keyed slots make a re-emitted event overwrite, not add (turn-usage.ts).
 * Hooks are at-least-once (docs/guides/hooks.md): a re-fired settle re-sends
 * the same (session, turn) report, which the route's durable key turns into a
 * no-op.
 *
 * A report whose POST failed with a retryable error (network / timeout / 5xx /
 * the route's 401 secret-rejected / 409 session-unregistered) after its
 * attempts is written to the `chat_usage_outbox` table (lib/usage-outbox.ts)
 * under the route's idempotency key, and the Next app's sweeper
 * (src/lib/inngest/chat-usage-outbox.ts) bills it server-side — so a session's
 * LAST turn, which has no later turn to re-send it, is still billed (and the
 * sweeper alerts Sentry whenever it bills one). Only when that write fails too
 * is the report kept in state and re-sent at a later turn's end (bounded to
 * MAX_PENDING; the drop beyond it is logged). Only a 400 (malformed report) is
 * dropped outright.
 *
 * ── Billing never depends on the browser's token ────────────────────────────
 * The report is sent with the session's run token when it has one, and without
 * it otherwise: the route bills the user of a token whose HMAC verifies (an
 * expired one included — a long turn outlives the TTL), or — no verifiable
 * token — the eve session's owner (chat_conversations.eve_session_id). A
 * missing token is never a reason to drop a bill.
 *
 * ── Bounded + never throws ──────────────────────────────────────────────────
 * Since eve 0.68 a throwing hook is only logged (it no longer escalates to
 * session.failed or fails a turn the user already saw), but a throw would
 * still skip the rest of the handler and lose the report. So every handler
 * swallows its own errors (logged), a throwing POST counts as a
 * retryable failure (the report is kept, never lost), each POST times out
 * (spec-client USAGE_REPORT_TIMEOUT_MS), and one settle spends at most
 * SETTLE_BUDGET_MS on the network and re-tries at most PENDING_PER_SETTLE old
 * reports — so metering can never break or stall a chat.
 *
 * ── Quick helpers ───────────────────────────────────────────────────────────
 * A helper's child session (subagents/helper/, A4 slice 3) runs this same hook
 * and bills each of its turns under its own session id, so nothing is billed
 * twice (the parent folds only its own steps). Its reports carry `helperOf`,
 * the parent session (ctx.session.parent), which the route stores as
 * `helper_of` so a conversation's cost includes its helpers.
 *
 * ── Device asks ─────────────────────────────────────────────────────────────
 * A SURFACE run token ('device_ask') is not reported: /api/device/ask bills its
 * own run under 'device_ask' from the events it reads, and the route refuses to
 * bill a surface token anyway. This also keeps an extra POST off the device's
 * 60s budget. The surface is honored only when the token's HMAC verifies
 * (expiry ignored — the run already happened): a forged surface claim is not a
 * free turn.
 */
import { defineHook } from 'eve/hooks'
import { defineState } from 'eve/context'
import { isLocalBrowserHandoffStep } from '../lib/browser-permission-handoff.js'
import { reportTurnUsage, runTokenFromAuth } from '../lib/spec-client.js'
import { verifyChatRunClaims } from '../lib/auth.js'
import { writeUsageOutbox } from '../lib/usage-outbox.js'
import { cardContextSizeFor } from '../lib/card-context-size.js'
import { contextPartsFor } from '../lib/context-parts.js'
import { currentTurnModelRoute } from '../lib/turn-model-route.js'
import { browserDispatchUsageFor, clearBrowserDispatchStep, clearBrowserDispatchUsage } from '../lib/browser-dispatch-usage-state.js'
import { planReportModelId, turnChatGptPlan } from '../lib/chatgpt-plan-model.js'
import {
  buildCompactionReport,
  buildTurnUsageReport,
  chatContextLogLine,
  compactionFromRequested,
  emptyTurnUsage,
  foldTurnUsageEvent,
  type CompactionUsage,
  type TurnUsageAcc,
  type TurnUsageReport,
} from '../lib/turn-usage.js'

/** Reports awaiting a re-send after a retryable failure (oldest dropped beyond this). */
export const MAX_PENDING = 10
/** Attempts for the just-finished turn's report (pending ones get one per settle). */
export const CURRENT_REPORT_ATTEMPTS = 3
/** Old (pending) reports re-tried per settle; the rest wait for a later one. */
export const PENDING_PER_SETTLE = 3
/** The most one settle spends on the network before keeping the rest for later. */
export const SETTLE_BUDGET_MS = 12_000
/** Backoff between attempts, ms (× attempt number). */
const RETRY_BASE_MS = 250

interface MeterState {
  acc: TurnUsageAcc
  pending: TurnUsageReport[]
  /** The manual compaction whose compaction.requested arrived and whose completed has not. */
  compaction: CompactionUsage | null
}

const freshState = (): MeterState => ({ acc: emptyTurnUsage(), pending: [], compaction: null })
const meter = defineState<MeterState>('chat-agent.usage-meter', freshState)

/** The stored state (older shapes upgraded), or a fresh one when the slot holds anything unexpected. */
function sane(s: MeterState | null | undefined): MeterState {
  if (!s || typeof s !== 'object' || !Array.isArray(s.pending)) return freshState()
  const acc = s.acc && typeof s.acc === 'object' && s.acc.steps && typeof s.acc.steps === 'object' ? s.acc : emptyTurnUsage()
  return {
    acc,
    pending: s.pending,
    compaction: s.compaction && typeof s.compaction === 'object' ? s.compaction : null,
  }
}

type SettleOutcome = TurnUsageReport['outcome']
type HookCtx = {
  session: { id: string; auth: Parameters<typeof runTokenFromAuth>[0]; parent?: { sessionId?: unknown } }
}

/**
 * The parent eve session of a quick helper's child session (A4 slice 3), or
 * null on the main chat's own sessions. The helper re-exports this hook
 * (subagents/helper/hooks/usage-meter.ts); eve's callback context carries the
 * child's parent lineage (build-callback-context.js `parent`).
 */
export function helperOfSession(ctx: HookCtx): string | null {
  const id = ctx.session.parent?.sessionId
  return typeof id === 'string' && id.length > 0 && id !== ctx.session.id ? id : null
}

/**
 * A report of a turn on the person's ChatGPT plan, under the plan's own model
 * name: eve names a plan step on the search model `openai/<model>`
 * (../lib/chat-model.ts), and the app logs only `chatgpt-plan/<model>` at no
 * cost. Any other report is unchanged.
 */
export function underPlanName<R extends { modelId: string | null }>(report: R): R {
  const modelId = planReportModelId(report.modelId, turnChatGptPlan.get())
  return modelId === report.modelId ? report : { ...report, modelId }
}

/** A report with the helper's parent session on it, when there is one. */
function withHelperOf(report: TurnUsageReport, ctx: HookCtx): TurnUsageReport {
  const helperOf = helperOfSession(ctx)
  return helperOf ? { ...report, helperOf } : report
}

function fold(event: unknown): void {
  try {
    meter.update((raw) => {
      const s = sane(raw)
      return { ...s, acc: foldTurnUsageEvent(s.acc, event) }
    })
  } catch (err) {
    console.error(`[chat-agent] usage meter fold failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** The report's `[chat-context]` line; a logging failure never touches billing. */
function logContext(report: TurnUsageReport, acc: TurnUsageAcc | null): void {
  try {
    console.log(chatContextLogLine(report, acc))
  } catch {
    /* Telemetry only. */
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Send one report; true when it is settled (billed, duplicate, surface, or a
 * final 400). Never throws: a throw from the POST counts as retryable. Stops
 * early (unsettled) once `deadline` passes.
 */
async function send(runToken: string, report: TurnUsageReport, attempts: number, deadline: number): Promise<boolean> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (Date.now() >= deadline) return false
    let res: Awaited<ReturnType<typeof reportTurnUsage>>
    try {
      res = await reportTurnUsage(runToken, report)
    } catch (err) {
      console.error(`[chat-agent] usage report threw: ${err instanceof Error ? err.message : String(err)}`)
      res = { ok: false, status: 'network', retryable: true }
    }
    if (res.ok) return true
    if (!res.retryable) {
      console.error(
        `[chat-agent] usage report for ${report.sessionId}/${report.turnId} dropped (${res.status}) — not retryable`,
      )
      return true
    }
    if (attempt < attempts) await sleep(RETRY_BASE_MS * attempt)
  }
  return false
}

/**
 * Deliver the just-finished reports (first — they are the freshest), then up to
 * PENDING_PER_SETTLE older ones, all inside SETTLE_BUDGET_MS. Whatever is still
 * unsent goes to the outbox (the server-side sweep bills it); only what the
 * outbox could not take is returned, oldest first, to keep in state. Never throws.
 */
async function deliver(
  runToken: string,
  pending: TurnUsageReport[],
  current: TurnUsageReport[],
): Promise<TurnUsageReport[]> {
  const deadline = Date.now() + SETTLE_BUDGET_MS
  const currentUnsent: TurnUsageReport[] = []
  for (const r of current) {
    if (!(await send(runToken, r, CURRENT_REPORT_ATTEMPTS, deadline))) currentUnsent.push(r)
  }
  const kept: TurnUsageReport[] = []
  for (const [i, r] of pending.entries()) {
    if (i >= PENDING_PER_SETTLE || !(await send(runToken, r, 1, deadline))) kept.push(r)
  }
  return writeUsageOutbox([...kept, ...currentUnsent], runToken)
}

/** The session's run token, or '' when the principal carries none. */
function runTokenOf(ctx: HookCtx): string {
  try {
    return runTokenFromAuth(ctx.session.auth)
  } catch {
    return '' // No readable principal: send without a token — the route bills the owner.
  }
}

/** A device ask (a VERIFIED 'device_ask' token, expiry ignored) bills itself. */
function isSurfaceRun(runToken: string): boolean {
  // Only the device ask bills itself; a channel turn ('slack', 'sms') is metered
  // here as `ai_chat`, like any turn of the person's.
  return Boolean(runToken && verifyChatRunClaims(runToken, { allowExpired: true })?.surface === 'device_ask')
}

/** Keep what is still unsent (bounded) and reset the per-turn slots as `next` says. */
function keep(unsent: TurnUsageReport[], next: Omit<MeterState, 'pending'>): void {
  if (unsent.length > MAX_PENDING) {
    console.error(`[chat-agent] usage meter dropping ${unsent.length - MAX_PENDING} unsent report(s)`)
  }
  meter.update(() => ({ ...next, pending: unsent.slice(-MAX_PENDING) }))
}

async function settle(event: unknown, ctx: HookCtx, outcome: SettleOutcome): Promise<void> {
  try {
    const data = (event as { data?: { turnId?: unknown } }).data
    const turnId = typeof data?.turnId === 'string' ? data.turnId : ''
    const endedAt = (event as { meta?: { at?: unknown } }).meta?.at
    const state = sane(meter.get())
    const report = turnId
      ? buildTurnUsageReport(state.acc, {
          sessionId: ctx.session.id,
          turnId,
          outcome,
          endedAt: typeof endedAt === 'string' ? endedAt : null,
        })
      : null
    if (report) logContext(report, state.acc)
    // What the cards note cost this turn rides next to its usage.
    const cardTokens = turnId ? cardContextSizeFor(turnId) : null
    // The agent's own parts of the turn's context (the side panel's Context card).
    const contextParts = turnId ? contextPartsFor(turnId) : null
    // How the turn's model was chosen (auto model selection), for the usage row.
    const modelRoute = report ? currentTurnModelRoute() : null
    const current = report
      ? [
          withHelperOf(
            underPlanName({
              ...report,
              ...(cardTokens === null ? {} : { cardContextTokens: cardTokens }),
              ...(contextParts ? { contextParts } : {}),
              ...(modelRoute ? { modelRoute } : {}),
            }),
            ctx,
          ),
        ]
      : []

    const runToken = runTokenOf(ctx)
    // A device ask bills itself ('device_ask'): report nothing, keep the queue.
    const unsent = isSurfaceRun(runToken) ? state.pending : await deliver(runToken, state.pending, current)
    keep(unsent, { acc: emptyTurnUsage(), compaction: null })
  } catch (err) {
    console.error(`[chat-agent] usage meter settle failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function compactionRequested(event: unknown): void {
  try {
    meter.update((raw) => {
      const s = sane(raw)
      return { ...s, compaction: compactionFromRequested(s.acc, event) }
    })
  } catch (err) {
    console.error(`[chat-agent] usage meter compaction capture failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function compactionCompleted(event: unknown, ctx: HookCtx): Promise<void> {
  try {
    const e = event as { data?: { turnId?: unknown }; meta?: { at?: unknown } }
    const state = sane(meter.get())
    if (!state.compaction) return
    const report = buildCompactionReport(state.compaction, {
      sessionId: ctx.session.id,
      turnId: typeof e.data?.turnId === 'string' ? e.data.turnId : null,
      endedAt: typeof e.meta?.at === 'string' ? e.meta.at : null,
    })
    if (!report) {
      meter.update(() => ({ ...state, compaction: null }))
      return
    }
    logContext(report, null)
    // Manual (/compact): between turns, maybe never followed by a turn.* event — send now.
    const runToken = runTokenOf(ctx)
    const unsent = isSurfaceRun(runToken) ? state.pending : await deliver(runToken, state.pending, [withHelperOf(underPlanName(report), ctx)])
    keep(unsent, { acc: state.acc, compaction: null })
  } catch (err) {
    console.error(`[chat-agent] usage meter compaction settle failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export default defineHook({
  events: {
    async 'turn.started'(event) {
      try { clearBrowserDispatchUsage() } catch { /* Meter state failures must never break a turn. */ }
      fold(event)
    },
    async 'step.started'(event) {
      try { clearBrowserDispatchStep(event.data) } catch { /* The completed hook marks unreadable state as unknown. */ }
      fold(event)
    },
    async 'step.completed'(event) {
      try {
        // A deterministic browser handoff reports no history token estimate to
        // Eve (zero would corrupt compaction accounting), but it is known to
        // have used no provider tokens or spend. Only its exact runtime scope
        // can fill those billing zeros; this never changes the persisted event.
        if (isLocalBrowserHandoffStep(event.data)) {
          fold({ ...event, data: { ...event.data, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 } } })
          return
        }
        // Eve projects provider metadata down to gateway.generationId. Read
        // our exact step's bounded recovery metadata from durable state.
        const recovery = browserDispatchUsageFor(event.data)
        fold(recovery ? {
          ...event,
          data: { ...event.data, providerMetadata: { ...event.data.providerMetadata, browserDispatch: recovery } },
        } : event)
      } catch {
        // Keep known spend, but never turn unreadable retry state into a claim
        // that all attempts reported usage. No prompts or errors are logged.
        console.error('[chat-agent] browser dispatch usage state unreadable; usage incomplete')
        fold({ ...event, data: { ...event.data, providerMetadata: {
          ...event.data.providerMetadata, browserDispatch: { version: 1, usageUnknown: true, attempts: [] },
        } } })
      }
    },
    async 'actions.requested'(event) {
      fold(event)
    },
    async 'action.result'(event) {
      fold(event)
    },
    async 'compaction.requested'(event) {
      fold(event)
      compactionRequested(event)
    },
    async 'compaction.completed'(event, ctx) {
      fold(event)
      await compactionCompleted(event, ctx)
    },
    async 'turn.completed'(event, ctx) {
      await settle(event, ctx, 'completed')
    },
    async 'turn.failed'(event, ctx) {
      await settle(event, ctx, 'failed')
    },
    async 'turn.cancelled'(event, ctx) {
      await settle(event, ctx, 'cancelled')
    },
  },
})
