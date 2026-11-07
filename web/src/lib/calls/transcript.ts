/**
 * A call's live transcript, from GPT-Live's sideband fragments (the spike).
 * GPT-Live sends `session.input_transcript.delta` (the caller) and
 * `session.output_transcript.delta` (itself) with `start_ms` / `end_ms`, and
 * the fragments "do not define complete turns or include a transcript-done
 * event", and a hand-off (`session.delegation.created`) carries no task text,
 * only its `offset_ms` on the same timeline. So the bridge keeps the caller's
 * words here and, at each hand-off, takes what they said before it that no
 * earlier hand-off took: that is the request. Hand-offs queue (one turn at a
 * time), so a later one never takes words said after it.
 *
 * Pure. Held in memory for the call only; what is handed over is written to
 * the person's home thread as their message (./call-turn-server.ts).
 */

interface Fragment {
  text: string
  startMs: number
  endMs: number
}

/** The most of the caller's words one hand-off carries (a turn's message cap is 16,000). */
export const CALL_HANDOFF_MAX_CHARS = 4_000

/**
 * GPT-Live's special tokens (`<|SpawnThinking|>` and the like) can leak into
 * its transcript, whole or in pieces split across fragments (a call carried a
 * stray "|>"). They are never the caller's words.
 */
function withoutSpecialTokens(text: string): string {
  return text.replace(/<\|[^|<>]*\|>/g, ' ').replace(/<\||\|>/g, ' ')
}

/** Join fragments into words: a space between two that don't already have one, no special tokens, then single spaces. */
function joinFragments(fragments: readonly Fragment[]): string {
  let out = ''
  for (const f of fragments) {
    if (out && !/\s$/.test(out) && !/^[\s.,!?;:'’)]/.test(f.text)) out += ' '
    out += f.text
  }
  return withoutSpecialTokens(out).replace(/\s+/g, ' ').trim()
}

export class CallTranscript {
  private readonly input: Fragment[] = []
  private readonly output: Fragment[] = []
  /** Which of the caller's fragments a hand-off already took (parallel to `input`). */
  private readonly taken: boolean[] = []

  addInput(delta: unknown, startMs: unknown, endMs: unknown): void {
    if (this.add(this.input, delta, startMs, endMs)) this.taken.push(false)
  }

  addOutput(delta: unknown, startMs: unknown, endMs: unknown): void {
    this.add(this.output, delta, startMs, endMs)
  }

  private add(list: Fragment[], delta: unknown, startMs: unknown, endMs: unknown): boolean {
    if (typeof delta !== 'string' || !delta) return false
    const start = typeof startMs === 'number' && Number.isFinite(startMs) ? startMs : list.at(-1)?.endMs ?? 0
    const end = typeof endMs === 'number' && Number.isFinite(endMs) ? endMs : start
    list.push({ text: delta, startMs: start, endMs: end })
    return true
  }

  /** True when an untaken fragment of the caller's starts before `beforeMs`. */
  hasCallerWordsBefore(beforeMs: number): boolean {
    return this.input.some((f, i) => !this.taken[i] && f.startMs < beforeMs)
  }

  /**
   * What the caller said that no earlier hand-off took, and (with `beforeMs`,
   * a hand-off's offset) only what they began saying before it; the newest
   * {@link CALL_HANDOFF_MAX_CHARS}; '' when nothing. Marks them taken.
   */
  takeCallerWords(beforeMs?: number | null): string {
    const fresh: Fragment[] = []
    this.input.forEach((f, i) => {
      if (this.taken[i] || (beforeMs != null && f.startMs >= beforeMs)) return
      this.taken[i] = true
      fresh.push(f)
    })
    const words = joinFragments(fresh)
    return words.length > CALL_HANDOFF_MAX_CHARS ? words.slice(words.length - CALL_HANDOFF_MAX_CHARS).replace(/^\S*\s/, '') : words
  }

  /** The newest caller fragment's end, or null before they said anything. */
  lastCallerEndMs(): number | null {
    return this.input.at(-1)?.endMs ?? null
  }

  /** Counts for the call's log line (never a word). */
  counts(): { callerChars: number; agentChars: number } {
    const chars = (list: Fragment[]) => list.reduce((n, f) => n + f.text.length, 0)
    return { callerChars: chars(this.input), agentChars: chars(this.output) }
  }
}
