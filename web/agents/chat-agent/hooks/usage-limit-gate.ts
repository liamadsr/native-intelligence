/**
 * usage-limit-gate — DEFENSE-IN-DEPTH billing gate for the eve chat path.
 *
 * ── eve 0.79: THE GATE CANCELS THE TURN (ctx.cancel()), IT NO LONGER THROWS ──
 * Since eve 0.68 a stream-event hook that throws is logged and IGNORED: "the
 * current turn, subagent notification, and session continue", for turn.started
 * and step.started too (docs/guides/hooks.md "What happens when a hook
 * throws"). The throws this hook once used would have let a billing-blocked
 * or ended turn run on. Every stop is now `ctx.cancel()`:
 * eve cancels the turn the way `session.cancel()` does, BEFORE that model call
 * ("A cancel from turn.started or step.started takes effect before that model
 * call"), and the turn ends with `turn.cancelled` then `session.waiting`. No
 * failure event is emitted and the session stays alive (the next message
 * starts a new turn, which this gate checks again). The stop reason reaches
 * the server log; the chat transport, seeing a turn it sent cancelled with no
 * answer and no Stop, asks the app's usage check (`{ action: 'usage' }` on
 * /api/account/chat/eve-session), whose 429 opens the usage-limit dialog, so
 * the person sees why. An ask_user answer resumes a held turn with no new
 * turn.started (eve 0.70), so this hook never sees it; the transport checks
 * usage before that resume itself.
 *
 * ── THE PRIMARY GATE LIVES AT THE MINT ROUTE, NOT HERE ──────────────────────
 * /api/account/chat/eve-session (action 'mint') runs checkUsageLimits BEFORE
 * minting the run token, so a usage-limited user normally never gets a token
 * and never starts a turn — the transport surfaces the 429's composed copy
 * ("Usage limit exceeded: <reason>. Resets <date>.") as the chat toast, and the
 * durable eve session is untouched. THIS hook covers only the RESIDUAL RACE:
 * limits flipping between a successful mint and turn.started (the token is
 * already in hand when the allowance runs out).
 *
 * ── WHY A HOOK (and not a resolver) ────────────────────────────────────────
 * Every dynamic resolver SOFT-degrades on a spec-fetch failure: the model
 * resolver returns its FALLBACK_SELECTION (lib/chat-model.ts), a throwing
 * instructions resolver is skipped, workspace_tools degrades to no tools. So
 * without a hook a billing-blocked turn still runs to completion. A hook's
 * `ctx.cancel()` is the one authored hard stop that leaves the session alive.
 *
 * History (eve 0.22-0.66): the stop used to be a THROW from this hook. eve
 * retried the throwing step, then emitted a terminal `session.failed`, so the
 * durable chat session died and the client showed a generic failure; the
 * throws carried a `fatal: true` own property so eve's workflow retry gate
 * (FatalError.is) skipped the retries. eve 0.68 made hooks observe-only (a
 * throw is logged and the turn runs on), which is why every stop below is now
 * `ctx.cancel()`.
 *
 * ── WHAT HARD-FAILS vs WHAT SOFT-DEGRADES ───────────────────────────────────
 * HARD STOP (`ctx.cancel()` → the turn ends `turn.cancelled`, the session lives):
 *   - 429 Usage limit exceeded — the mint-to-turn race's billing block.
 *   - 503 BILLING_UNAVAILABLE — billing is fail-closed (the check itself failed
 *     AND BILLING_FAIL_OPEN is off); denying AI is the fail-closed intent.
 *   - the run has ENDED — 403 SURFACE_RUN_ENDED, or 401 on a surface token (see
 *     SURFACE RUNS below).
 * SOFT-DEGRADE (return, do NOT cancel — leave it to the existing resolver paths):
 *   - no run token — the model/instructions/tools resolvers already degrade.
 *   - a browser token's 401 / 500 / any OTHER 503 / network throw — a TRANSIENT outage (spec route
 *     down, secret misconfig, blip) must NEVER block a paying user's chat. The
 *     model falls back, the persona holds last turn's prompt, tools drop — the
 *     turn still runs. Blocking here on a transient fault would be worse than the
 *     degrade it replaces.
 *
 * ── SURFACE RUNS: THE RUN-ENDED STOP (/api/device/ask) ──────────────────────
 * A SURFACE token ('device_ask') is minted server-side for ONE one-shot session
 * whose life is bracketed by an ephemeral ownership row; the spec + tool routes
 * answer 403 SURFACE_RUN_ENDED once that row is deleted (surface-run-guard.ts).
 * A refused spec fetch alone does NOT stop a run — the model resolver would
 * fall back to FALLBACK_SELECTION, instructions would hold, and the native
 * web_search / web_fetch tools never pass the spec or tool route — so a session
 * whose cancel failed (or whose create answered after the device ask gave up)
 * would keep making model + Exa calls, unmetered, after the device was answered.
 * So this hook makes "the run has ended" a HARD STOP:
 *   - turn.started: a 403 SURFACE_RUN_ENDED, or a 401 on a surface token (its
 *     short `exp` passed — the backstop when the row delete itself failed),
 *     cancels the turn. A late-created session stops before its first model
 *     call.
 *   - step.started (surface tokens only): probes GET /api/internal/chat/spec
 *     ?live=1 (gates only, no rebuild) before EVERY model step and cancels on
 *     the same two answers, so a turn whose cancel failed stops at its next
 *     model call. Browser tokens (no surface) skip this — no extra fetch per
 *     step.
 * A network error / 5xx on the probe stays soft (a transient app outage, not a
 * revocation) — including the routes' own 503 SURFACE_RUN_UNVERIFIED, which is
 * what a failed ownership-row LOOKUP answers (a DB blip is not a deleted row).
 * The token's `exp` still bounds that case at the next probe.
 * The `surface` claim is read UNVERIFIED as a routing hint only
 * (spec-client.ts surfaceFromRunToken); the probe itself is verified server-side.
 *
 * ── COST ────────────────────────────────────────────────────────────────────
 * Nothing extra. This hook's fetch IS the turn's spec fetch: fetchChatSpecResult
 * memoizes one superset fetch per (run token, turn ctx) (spec-client.ts), and
 * the model, persona and tool resolvers that run after this hook reuse it. The
 * gate still branches on a real answer for this turn: it makes the turn's first
 * fetch, or on a new session reads the one the tools resolver's session.started
 * made moments earlier, and a 429 / 503 / run-ended answer is never memoized,
 * so nothing reuses a block. One edge: a HITL answer resumes the held turn
 * (eve 0.70+) with no new turn.started, so this hook does not re-check it; the
 * transport checks usage before that resume, and the next send re-checks at
 * the mint route.
 *
 * ── FAIL-SAFE ───────────────────────────────────────────────────────────────
 * We only ever cancel DELIBERATELY (the billing cases and the run-ended stop):
 * the fetch is result-typed (never rejects out of fetchChatSpecResult) and
 * every other branch returns. A throw here would only be logged (eve 0.68+).
 */
import { defineHook } from 'eve/hooks'
import {
  fetchChatSpecResult,
  probeChatRunLive,
  runTokenFromAuth,
  surfaceFromRunToken,
  turnCtxFromAuth,
  SURFACE_RUN_ENDED,
} from '../lib/spec-client.js'
import { isMacHost } from '../lib/host.js'
import { judgeMacLiveness, markMacStopped, type MacLivenessStop } from '../lib/mac-host.js'

/** The hook context this gate uses (eve's HookContext: session + cancel()). */
interface GateContext {
  readonly session: { readonly id?: string; readonly auth: unknown }
  cancel(): void
}

/**
 * Stop the running turn before its model call. eve 0.68+ ignores a hook throw,
 * so `ctx.cancel()` is the only hard stop (see the header). The reason goes to
 * the server log, never to the model or the client.
 */
function stopTurn(ctx: GateContext, reason: string): void {
  console.warn('[chat-agent] usage-limit-gate: cancelling the turn', { sessionId: ctx.session.id, reason })
  ctx.cancel()
}

/**
 * The device ask's model-step cap — main's `stopWhen: isStepCount(12)`. Must
 * equal DEVICE_ASK_MAX_STEPS (src/lib/chat/device-ask-eve.ts; the eve bundle
 * cannot import it — a parity test pins the two). The server read stops at the
 * 13th step.started, but only this hook stops the SESSION before that 13th
 * model call: a cancel issued after the read lands after the call has started,
 * and that step would be billed by nobody.
 */
export const DEVICE_ASK_MAX_STEPS = 12

/** Step-cap copy (reaches the server log only). */
export const STEP_CAP_MESSAGE = `This ask reached its ${DEVICE_ASK_MAX_STEPS}-step limit.`

/** End-of-run copy (reaches the server log only). */
export const RUN_ENDED_MESSAGE = 'This run has ended: the request that started it is over.'

/** The Mac body's end-of-session copy (reaches the eve server's log, as the others do). */
export const MAC_SESSION_ENDED_MESSAGE = 'The app no longer accepts this Mac job (its session ended, or its token is no longer valid).'

/** Why a Mac turn stopped, by lib/mac-host.ts judgeMacLiveness's verdict. */
export const MAC_STOP_MESSAGES: Readonly<Record<MacLivenessStop, string>> = {
  ended: MAC_SESSION_ENDED_MESSAGE,
  unreachable: 'The app could not be reached to confirm this Mac job is still on, three times in a row: stopping until it can.',
  expired: "This Mac job's token has expired and could not be confirmed: stopping until the app renews it.",
  misconfigured: 'This Mac job has a session token but no way to reach the app: stopping.',
}

/**
 * True when a failed spec/liveness answer means the RUN IS OVER (not an
 * outage): 403 SURFACE_RUN_ENDED on any token, or a 401 on a SURFACE token —
 * a surface token is short-lived by design, so its expiry is a revocation,
 * whereas a browser token's 401 stays a soft-degrade (see the header).
 */
export function isRunEnded(
  result: { ok: false; status: number | 'network' | 'no-token' | 'misconfigured'; body?: unknown },
  surface: string | undefined,
): boolean {
  if (result.status === 403 && (result.body as { code?: string } | null)?.code === SURFACE_RUN_ENDED) return true
  return result.status === 401 && surface !== undefined
}

/** The parsed 429 body from the spec route's usage-limit response. */
interface UsageLimitBody {
  error?: string
  reason?: string
  usageResetDate?: string
}

/**
 * Build the end-user copy for a 429 usage-limit block. Kept as the mint route
 * gate's twin (usageLimitMintMessage in src/lib/chat/eve/
 * eve-chat-transport.ts — same formatting rules, so both gates produce
 * IDENTICAL copy; the client bundle can't import this module). On THIS path
 * the message reaches the server log only (stopTurn); the client shows the
 * usage-limit dialog from its own usage check (see the header). Clean prose
 * anyway; never raw JSON.
 *
 * Shapes (examples):
 *   { error:'Usage limit exceeded', reason:'monthly allowance reached',
 *     usageResetDate:'2026-08-01' }
 *     → "Usage limit exceeded: monthly allowance reached. Resets 2026-08-01."
 *   { error:'Usage limit exceeded' }
 *     → "Usage limit exceeded."
 */
export function buildUsageLimitMessage(body: UsageLimitBody): string {
  const headline = (body.error && body.error.trim()) || 'Usage limit exceeded'
  const reason = body.reason && body.reason.trim()
  const resetDate = body.usageResetDate && body.usageResetDate.trim()

  // No free tier (migration 243): the one reason with a clear next step.
  if (reason === 'subscription_required') {
    return "Your Native Intelligence trial or subscription isn't active. Start a free trial or update billing in Settings → Billing to keep going."
  }

  let message = reason ? `${headline}: ${reason}` : headline
  // Ensure the reason/headline clause ends with a period before the reset note.
  if (!/[.!?]$/.test(message)) message += '.'
  if (resetDate) message += ` Resets ${resetDate}.`
  return message
}

/**
 * The 503 fail-closed billing-check-unavailable copy — a transient condition the
 * user can retry, distinct from a real allowance block.
 */
const BILLING_UNAVAILABLE_MESSAGE = 'Usage check unavailable — please try again in a moment.'

export default defineHook({
  events: {
    async 'turn.started'(_event, ctx) {
      const runToken = runTokenFromAuth(ctx.session.auth)
      const turnCtx = turnCtxFromAuth(ctx.session.auth)
      // No token → leave it to the existing soft-degrade paths (this is not an
      // authorization signal; the resolvers already handle a token-less session).
      if (!runToken) return

      // The turn's shared (memoized) spec fetch. We only need its status.
      const result = await fetchChatSpecResult(runToken, turnCtx)
      if (result.ok) return

      // 429 — the mint→turn race's billing block. HARD STOP.
      if (result.status === 429) {
        const body = (result.body ?? {}) as UsageLimitBody
        return stopTurn(ctx, buildUsageLimitMessage(body))
      }

      // 503 BILLING_UNAVAILABLE — billing fail-closed. HARD-FAIL (deny AI).
      if (
        result.status === 503 &&
        (result.body as { code?: string } | null)?.code === 'BILLING_UNAVAILABLE'
      ) {
        return stopTurn(ctx, BILLING_UNAVAILABLE_MESSAGE)
      }

      // The run has ended (surface row deleted / surface token expired) — the
      // soft paths below would keep it running on the fallback model. STOP.
      if (isRunEnded(result, surfaceFromRunToken(runToken))) {
        return stopTurn(ctx, RUN_ENDED_MESSAGE)
      }

      // The Mac body (lib/host.ts): C1 answers 401 for a bad or expired
      // session token and 403 for a session that is no longer live or the
      // person's. The job must not go on working in the folder without the
      // app (a model on the Mac would let it). STOP.
      if (isMacHost() && (result.status === 401 || result.status === 403)) {
        markMacStopped('ended')
        return stopTurn(ctx, MAC_SESSION_ENDED_MESSAGE)
      }
      if (isMacHost() && result.status === 'misconfigured') {
        markMacStopped('misconfigured')
        return stopTurn(ctx, MAC_STOP_MESSAGES.misconfigured)
      }

      // Everything else — a browser token's 401 / 500 / any other 503 /
      // 'network' / 'no-token' — is a TRANSIENT outage. Do NOT block chat; the
      // existing resolver soft paths degrade the turn. Return without stopping.
      return
    },

    // Surface runs only: re-check liveness before EVERY model step, so a run
    // whose cancel failed stops at its next model call (see the header).
    // And the Mac body: C1's liveness answer before every model step, so a
    // Stop (C1 answers 403 at once) or an expired token ends a long turn at
    // its next model call, not at the next turn.
    async 'step.started'(event, ctx) {
      const runToken = runTokenFromAuth(ctx.session.auth)
      if (!runToken) return
      if (isMacHost()) {
        // Fails closed (lib/mac-host.ts judgeMacLiveness): 401/403 at once,
        // three misses in a row, or a miss after the token's own expiry.
        const stop = judgeMacLiveness(await probeChatRunLive(runToken))
        if (stop) stopTurn(ctx, MAC_STOP_MESSAGES[stop])
        return
      }
      const surface = surfaceFromRunToken(runToken)
      // Browser chat, and a text turn (its conversation is the durable home
      // thread, no ephemeral row to lose): no per-step probe.
      if (surface !== 'device_ask') return
      // Device-ask step cap: stepIndex is 0-based per turn, so index 12 is the
      // 13th model call. Stop it here, before it runs (no fetch needed). The
      // surface claim is read unverified, but a forged one can only shorten
      // the forger's own run.
      const stepIndex = (event as { data?: { stepIndex?: unknown } } | undefined)?.data?.stepIndex
      if (surface === 'device_ask' && typeof stepIndex === 'number' && stepIndex >= DEVICE_ASK_MAX_STEPS) {
        return stopTurn(ctx, STEP_CAP_MESSAGE)
      }
      const result = await probeChatRunLive(runToken)
      if (result.ok) return
      if (isRunEnded(result, surface)) stopTurn(ctx, RUN_ENDED_MESSAGE)
    },
  },
})
