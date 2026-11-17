/**
 * Is a call's notes being written? What the recorder tells the app with each
 * heartbeat (web/src/lib/capture-feed/contract.ts, `health`), so the members
 * in the call read a plain line instead of "Notes are on" over nothing.
 *
 *   ok         words arrive, or nobody is speaking.
 *   down       a microphone's Deepgram socket has been closed for DOWN_AFTER_MS
 *              (a reconnect's blip never shows), and Deepgram's REST answer
 *              does not say why (unreachable, or a 5xx).
 *   refused    the same, and Deepgram refuses the key (401).
 *   no_credit  the same, and Deepgram says the account cannot pay (402).
 *   no_words   every socket is open, but someone has been speaking (their
 *              microphone's sound above VOICE_RMS) for NO_WORDS_AFTER_MS of
 *              audio since their last words came back: the failure that would
 *              otherwise show only after the call.
 *
 * Pure: the call (./call.ts) hands in its listeners' numbers, the main loop
 * (./main.ts) the last Deepgram verdict (./deepgram-check.ts).
 */

export const FEED_HEALTH_STATES = ['ok', 'down', 'refused', 'no_credit', 'no_words'] as const
export type FeedHealth = (typeof FEED_HEALTH_STATES)[number]

/** A socket closed this long is a failure, not a reconnect. */
export const DOWN_AFTER_MS = 10_000
/** Voiced audio since a speaker's last words, past which their words are missing. */
export const NO_WORDS_AFTER_MS = 25_000
/** A frame's loudness (RMS of 16-bit samples) above which it counts as someone speaking: about -33 dBFS, over room noise. */
export const VOICE_RMS = 700

/** What Deepgram's REST API said of the key, when last asked. */
export type DeepgramVerdict = 'ok' | 'refused' | 'no_credit' | 'unreachable' | 'unknown'

/** Is this frame someone speaking (loud enough to be speech)? */
export function voiced(pcm: Int16Array): boolean {
  if (pcm.length === 0) return false
  let sum = 0
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i]
  return Math.sqrt(sum / pcm.length) >= VOICE_RMS
}

export interface ListenerHealth {
  /** How long its socket has been closed (0 while open). */
  downForMs: number
  /** Voiced audio heard (unmuted) since its last words came back. */
  voicedSinceWordsMs: number
}

/** The call's health from its listeners' and Deepgram's last verdict. A call nobody is heard in is ok. */
export function callHealth(listeners: readonly ListenerHealth[], verdict: DeepgramVerdict | null): FeedHealth {
  if (listeners.some((l) => l.downForMs >= DOWN_AFTER_MS)) {
    if (verdict === 'refused') return 'refused'
    if (verdict === 'no_credit') return 'no_credit'
    return 'down'
  }
  if (listeners.some((l) => l.voicedSinceWordsMs >= NO_WORDS_AFTER_MS)) return 'no_words'
  return 'ok'
}

/** Does this call need Deepgram's verdict (a socket down long enough to name why)? */
export function needsVerdict(listeners: readonly ListenerHealth[]): boolean {
  return listeners.some((l) => l.downForMs >= DOWN_AFTER_MS)
}

/** How often a state the app already has is sent again (an app process that restarted, a write that failed). */
export const HEALTH_RESEND_MS = 30_000

/**
 * Which sessions' health goes with this heartbeat: those whose state changed
 * since it was last sent, or that were last sent HEALTH_RESEND_MS ago. Pure.
 */
export function healthToSend(
  now: Map<string, FeedHealth>,
  sent: ReadonlyMap<string, { state: FeedHealth; at: number }>,
  at: number,
): Array<{ id: string; state: FeedHealth }> {
  const out: Array<{ id: string; state: FeedHealth }> = []
  for (const [id, state] of now) {
    const last = sent.get(id)
    if (!last || last.state !== state || at - last.at >= HEALTH_RESEND_MS) out.push({ id, state })
  }
  return out
}
