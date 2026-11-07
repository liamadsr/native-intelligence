/**
 * Chat time-to-first-token telemetry (docs/plans/chat-ttft.md, Phase 0): the
 * per-turn phases the eve chat transport measures in the browser
 * (`deriveTurnTimings` in src/lib/chat/eve/eve-chat-transport.ts) and
 * POSTs with the turn's persist body. The eve-persist route forwards them as
 * `ttft_<key>` properties on `ai_chat_message_sent` and one `[chat-ttft]` log
 * line. Analytics only: nothing here is billed or stored.
 *
 * The wire keys live here, once, so the browser's derivation and the server's
 * whitelist cannot drift apart. No imports: the transport is a client module.
 *
 * Each span is measured on ONE clock. `client_*` spans are differences of two
 * browser `performance.now()` marks; `server_*` spans are differences of two
 * eve `meta.at` stamps (the server clock). No span subtracts across the two.
 */

/** The millisecond spans, in the order they happen. */
export const TURN_TIMING_MS_KEYS = [
  // submit (sendMessages entry) → the first reasoning, text or tool input.
  'client_first_output_ms',
  // submit → the first answer text.
  'client_first_text_ms',
  // submit → run token minted (a JWT refresh before the mint included).
  'client_mint_ms',
  // → eve accepted the create / send POST.
  'client_create_ms',
  // → eve_session_id registered on the conversation (a new session only).
  'client_register_ms',
  // → the first stream event arrived.
  'client_stream_open_ms',
  // session.started → turn.started: session-scoped resolvers (a new session only).
  'server_session_setup_ms',
  // turn.started → message.received: turn hooks and resolvers.
  'server_turn_setup_ms',
  // step.started → the first output of any kind: step resolvers + model first token.
  'server_first_output_ms',
  // the first reasoning → the first text or tool input after it: thinking time.
  'server_thinking_ms',
] as const

export type TurnTimingMsKey = (typeof TURN_TIMING_MS_KEYS)[number]

/** The boolean context keys. */
const TURN_TIMING_FLAG_KEYS = ['new_session', 'prewarmed'] as const

/** One turn's timings. Every key is optional: a phase the turn never reached is absent. */
export type ChatTurnTimings = Partial<Record<TurnTimingMsKey, number>> & {
  /** The turn's dispatch created its eve session. */
  new_session?: boolean
  /** The eve session was prewarmed before the send. */
  prewarmed?: boolean
  /** The model eve resolved for the turn's first model call (`step.started`). */
  model?: string
}

/** Spans are clamped to [0, this]: a turn longer than 10 minutes is not a TTFT sample. */
export const MAX_TURN_TIMING_MS = 600_000

/**
 * A gateway model id (`deepseek/deepseek-v4-flash`), at most 100 chars. The
 * charset keeps anything that reads like message text out of the log line.
 */
const MODEL_ID_PATTERN = /^[\w.:/@+-]{1,100}$/

/**
 * Shape-guard the client-reported timings. Keeps only the known keys: spans
 * that are finite numbers (rounded, clamped to [0, MAX_TURN_TIMING_MS]),
 * boolean flags, and a model id. Everything else is dropped. Undefined when
 * nothing valid is left. Never throws, so bad timings can never fail a persist.
 */
export function parseTurnTimings(raw: unknown): ChatTurnTimings | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const t = raw as Record<string, unknown>
  const out: ChatTurnTimings = {}
  for (const key of TURN_TIMING_MS_KEYS) {
    const v = t[key]
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[key] = Math.min(MAX_TURN_TIMING_MS, Math.max(0, Math.round(v)))
    }
  }
  for (const key of TURN_TIMING_FLAG_KEYS) {
    const v = t[key]
    if (typeof v === 'boolean') out[key] = v
  }
  if (typeof t.model === 'string' && MODEL_ID_PATTERN.test(t.model)) out.model = t.model
  return Object.keys(out).length > 0 ? out : undefined
}

/** The timings as analytics event properties, each key prefixed `ttft_`. */
export function ttftProperties(timings: ChatTurnTimings | undefined): Record<string, number | boolean | string> {
  const props: Record<string, number | boolean | string> = {}
  for (const [key, value] of Object.entries(timings ?? {})) {
    if (value !== undefined) props[`ttft_${key}`] = value
  }
  return props
}
