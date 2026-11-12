/**
 * The line a fed capture's notes open with when the producer was gone for a
 * while, and whether a person may write a capture's transcript now (not
 * while the call recorder fills it). (The transcript itself is written once
 * more in the order things were said inside the database, at the lock: 588's
 * capture_feed_lines.) Pure.
 */

/** The answer's code when a person writes the transcript of a call capture the recorder is filling. */
export const TRANSCRIPT_FROM_CALL = 'TRANSCRIPT_FROM_CALL'

/**
 * Is this capture's transcript the call recorder's to write now: a call's
 * capture the feed fills while the call runs (588 writes metadata
 * notes_recorder 'live' or 'lost'), not ended, not locked? Then no person
 * writes it (their edits would be undone when the call ends and the
 * transcript is written once more from what was said); typed notes stay
 * theirs.
 */
export function feedOwnsTranscript(row: { ended_at?: string | null; is_transcript_locked?: boolean | null; metadata?: unknown } | null | undefined): boolean {
  if (!row || row.ended_at || row.is_transcript_locked) return false
  const meta = row.metadata && typeof row.metadata === 'object' ? (row.metadata as Record<string, unknown>) : null
  return meta?.notes_recorder === 'live' || meta?.notes_recorder === 'lost'
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
