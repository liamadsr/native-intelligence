/**
 * The line a fed capture's notes open with when the producer was gone for a
 * while. (The transcript itself is written once more in the order things
 * were said inside the database, at the lock: 588's capture_feed_lines.)
 * Pure.
 */

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
