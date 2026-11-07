/**
 * What the desktop's voice has just said, for Interactive mode's echo guard
 * (@/lib/voice/wake-word, isEchoOf). On laptop speakers, before the echo
 * canceller has converged, the mic can still carry the agent's own speech: a
 * sentence of the reading that names the assistant would otherwise wake it,
 * and the reply being read would come back as a follow-up turn. So every
 * reader notes each sentence as it starts speaking (`tts://state` speaking):
 * the section player (a Listen item, a section) and each chat panel's
 * read-aloud (a reply, a line).
 *
 * PRIVACY: the user's own content, in memory only, the last RECENT_SPEECH_MAX
 * sentences for RECENT_SPEECH_MS. Never logged, never sent.
 */

export const RECENT_SPEECH_MAX = 4
export const RECENT_SPEECH_MS = 15_000

let recent: Array<{ text: string; at: number }> = []

/** A sentence started speaking. */
export function noteSpoken(text: string): void {
  if (!text.trim()) return
  recent.push({ text, at: Date.now() })
  if (recent.length > RECENT_SPEECH_MAX) recent = recent.slice(-RECENT_SPEECH_MAX)
}

/** The sentences said in the last RECENT_SPEECH_MS, oldest first. */
export function recentSpeech(now: number = Date.now()): string[] {
  recent = recent.filter((r) => now - r.at <= RECENT_SPEECH_MS)
  return recent.map((r) => r.text)
}

/** Tests only: nothing said. */
export function __resetRecentSpeechForTests(): void {
  recent = []
}
