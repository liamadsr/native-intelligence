/**
 * A fed capture's transcript as it is kept once the call is over: every
 * segment in the order it was said (live, they were appended in the order
 * they arrived), each speaker's stretches with nobody between them run
 * together as one line, as a call's notes have always been written
 * (src/lib/team-calls/notes.ts mergeNotes, reused). And the line the notes
 * open with when the producer was gone for a while. Pure.
 */
import { mergeNotes, type NotesFile } from '@/lib/team-calls/notes'
import type { StoredSegment } from './store'

/** `[Label] words` lines, in the order said. */
export function orderedTranscript(segments: readonly StoredSegment[]): { text: string; lines: number } {
  if (segments.length === 0) return { text: '', lines: 0 }
  const labels = new Map<string, string>()
  const files: NotesFile[] = []
  let first = Number.POSITIVE_INFINITY
  for (const s of segments) {
    labels.set(s.speakerKey, s.label)
    const at = Date.parse(s.saidAt)
    if (Number.isFinite(at) && at < first) first = at
    files.push({ memberId: s.speakerKey, startedAt: s.saidAt, utterances: [{ start: 0, end: Math.max(0, (s.endMs - s.startMs) / 1000), text: s.text }] })
  }
  const merged = mergeNotes(new Date(Number.isFinite(first) ? first : 0).toISOString(), files, labels)
  return { text: merged.text, lines: merged.lines.length }
}

export interface FeedGap {
  /** When the producer went quiet (ISO). */
  from: string
  /** When it came back (ISO), or never (the call ended first). */
  to?: string
}

/** How long, and how far into the call, each gap was: "Notes missed about 3 min from 12 min into the call (the recorder stopped hearing it)." */
export function gapLines(gaps: readonly FeedGap[], callStartedAt: string, callEndedAt: string | null): string[] {
  const t0 = Date.parse(callStartedAt)
  const end = callEndedAt ? Date.parse(callEndedAt) : Number.NaN
  const out: string[] = []
  for (const g of gaps) {
    const from = Date.parse(g.from)
    const to = g.to ? Date.parse(g.to) : end
    if (!Number.isFinite(from) || !Number.isFinite(t0)) continue
    const into = Math.max(0, Math.round((from - t0) / 60_000))
    const where = into === 0 ? 'from the start of the call' : `from ${into} min into the call`
    // A gap still open when the call ended ran to its end (the finish closes it later than that).
    const toTheEnd = !Number.isFinite(to) || (Number.isFinite(end) && to >= end)
    out.push(
      toTheEnd
        ? `Notes missed the rest of the call ${where} (the recorder stopped hearing it).`
        : `Notes missed about ${Math.max(1, Math.round((to - from) / 60_000))} min ${where} (the recorder stopped hearing it).`,
    )
  }
  return out
}
