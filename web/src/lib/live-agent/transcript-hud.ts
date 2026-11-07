/**
 * The live transcript in the live agent's HUD: what the recording window sends
 * the `agent-hud` window (its sender: components/capture/voice-id-hud-publisher;
 * the HUD's terminal: app/hud/agent).
 *
 * Not the whole transcript — the HUD's terminal is one line, the latest words
 * of whoever's page is on the card (each voice has its own page) — but its
 * TAIL PER SPEAKER: each speaker's last TRANSCRIPT_HUD_LINES lines, the
 * still-forming one included, in transcript order. (A still-forming line's id
 * changes with every guess the transcriber sends; a finished one's never
 * does.) Per speaker, so turning to
 * someone who spoke a while ago still finds their words. Each message replaces the last, so a dropped or
 * reordered one heals on the next, and the HUD needs no history of its own.
 * Sent at most every TRANSCRIPT_HUD_EMIT_MS while someone talks, and whole
 * when the HUD says it's listening.
 */
import type { TranscriptSegment } from '@/lib/deepgram-stream'

export const TRANSCRIPT_HUD_EVENT = 'transcript-hud:tail'
/** How many of each speaker's latest lines the HUD is sent: the words being
 *  spoken and the last few finished chunks (the terminal's line folds each
 *  finished chunk in once, by id, so none may slip by between two sends). */
export const TRANSCRIPT_HUD_LINES = 4
/** The most lines a tail can hold (a call with a crowd of speakers). */
const MAX_TAIL_LINES = 400
/** At most one message this often while the transcript streams (ms). */
export const TRANSCRIPT_HUD_EMIT_MS = 120

export interface TranscriptHudLine {
  id: string
  speaker: string
  text: string
  /** False while it's still forming (an interim result). */
  final: boolean
}

export interface TranscriptHudTail {
  captureId: string
  lines: TranscriptHudLine[]
}

/** The tail of `segments` to send: each speaker's latest lines with any text,
 *  in transcript order. */
export function transcriptHudTail(captureId: string, segments: readonly TranscriptSegment[]): TranscriptHudTail {
  const lines: TranscriptHudLine[] = []
  const counts = new Map<string, number>()
  for (let i = segments.length - 1; i >= 0 && lines.length < MAX_TAIL_LINES; i--) {
    const s = segments[i]
    const text = s.text.trim()
    const n = counts.get(s.speaker) ?? 0
    if (!text || n >= TRANSCRIPT_HUD_LINES) continue
    counts.set(s.speaker, n + 1)
    lines.push({ id: s.id, speaker: s.speaker, text, final: s.isFinal })
  }
  return { captureId, lines: lines.reverse() }
}

/** `payload` as a tail, or null if it isn't one (it crossed a window boundary). */
export function readTranscriptHudTail(payload: unknown): TranscriptHudTail | null {
  if (!payload || typeof payload !== 'object') return null
  const { captureId, lines } = payload as Record<string, unknown>
  if (typeof captureId !== 'string' || !Array.isArray(lines)) return null
  const ok = lines.every(
    (l) =>
      !!l &&
      typeof l === 'object' &&
      typeof (l as TranscriptHudLine).id === 'string' &&
      typeof (l as TranscriptHudLine).speaker === 'string' &&
      typeof (l as TranscriptHudLine).text === 'string' &&
      typeof (l as TranscriptHudLine).final === 'boolean',
  )
  return ok ? { captureId, lines: lines.slice(-MAX_TAIL_LINES) as TranscriptHudLine[] } : null
}
