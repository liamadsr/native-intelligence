/**
 * Steering telemetry (UI-2, docs/plans/always-on-agent.md §2b). A message sent
 * while the main agent works is held above the composer and steers the running
 * turn at the next safe point (src/lib/chat/eve/steer-opening.ts). The
 * turn that adopts the steer carries these facts on its persist body; the
 * eve-persist route forwards them on `ai_chat_message_sent` as `steer_*` and
 * logs one `[chat-steer]` line. Numbers and enums only, never message text.
 *
 * Client-safe: no server imports.
 */

/** How a posted steer landed: inside the running turn, or as the next turn. */
export type SteerOutcome = 'applied' | 'next_turn'

export const STEER_OUTCOMES: readonly SteerOutcome[] = ['applied', 'next_turn']

/** The rule that opened the POST (steer-opening.ts SteerOpeningReason). */
export const STEER_OPENINGS = ['before_output', 'tool_boundary'] as const
export type SteerOpeningTag = (typeof STEER_OPENINGS)[number]

export interface SteerTelemetry {
  outcome: SteerOutcome
  /** Held above the composer before the POST (ms). */
  held_ms?: number
  /** From the POST to the first event of the steer's own response (ms). */
  apply_ms?: number
  opening?: SteerOpeningTag
  /** Steers adopted into this eve turn so far, this one included. */
  steers_in_turn?: number
  /** The person pressed Send now while the steer was posted (the prior reply was stopped). */
  sent_now?: boolean
}

/** A span the telemetry never trusts past (an hour). */
const MAX_STEER_MS = 3_600_000

function ms(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_STEER_MS ? Math.round(v) : undefined
}

/**
 * The steer facts a persist body carries, validated: undefined unless the
 * outcome is known. Bad fields are dropped, never fail the persist.
 */
export function parseSteerTelemetry(raw: unknown): SteerTelemetry | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  if (!STEER_OUTCOMES.includes(r.outcome as SteerOutcome)) return undefined
  const out: SteerTelemetry = { outcome: r.outcome as SteerOutcome }
  const held = ms(r.held_ms)
  if (held !== undefined) out.held_ms = held
  const apply = ms(r.apply_ms)
  if (apply !== undefined) out.apply_ms = apply
  if ((STEER_OPENINGS as readonly unknown[]).includes(r.opening)) out.opening = r.opening as SteerOpeningTag
  if (typeof r.steers_in_turn === 'number' && Number.isInteger(r.steers_in_turn) && r.steers_in_turn > 0 && r.steers_in_turn < 1000) {
    out.steers_in_turn = r.steers_in_turn
  }
  if (r.sent_now === true) out.sent_now = true
  return out
}

/** The `steer_*` event properties for a turn that adopted a steer (empty for none). */
export function steerProperties(steer: SteerTelemetry | undefined): Record<string, number | boolean | string> {
  if (!steer) return {}
  const out: Record<string, number | boolean | string> = { steer_outcome: steer.outcome }
  if (steer.held_ms !== undefined) out.steer_held_ms = steer.held_ms
  if (steer.apply_ms !== undefined) out.steer_apply_ms = steer.apply_ms
  if (steer.opening) out.steer_opening = steer.opening
  if (steer.steers_in_turn !== undefined) out.steer_steers_in_turn = steer.steers_in_turn
  if (steer.sent_now) out.steer_sent_now = true
  return out
}
