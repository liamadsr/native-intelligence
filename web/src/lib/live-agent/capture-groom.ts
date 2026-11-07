/**
 * Capture Groom (GEN-135) — keep the captures list clean without a human
 * babysitting it.
 *
 * Two behaviors, each at its natural home:
 *   1. Auto-archive junk (THIS module + the finalize seam): a very short
 *      capture with no transcript is a mis-fire — a recording started and
 *      stopped, a permission glitch, a test. It carries no content and only
 *      clutters the list. We soft-archive it instead of processing it. Pure,
 *      deterministic, reversible (archive is a soft delete — the row and its
 *      audio stay).
 *   2. Auto-title untitled (the batch agent + prompt): a capture left at the
 *      default "Untitled Capture" gets a real title from the batch summary
 *      pass, which already reads the whole transcript. Handled in the prompt,
 *      not here.
 *
 * These predicates are pure so the archive decision is testable and can never
 * depend on model behavior — archiving is destructive-ish (it hides the
 * capture), so the rule that triggers it must be deterministic and tight.
 */

/**
 * A capture is junk-archivable iff it is a genuine mis-fire: very short, no
 * meaningful transcript, AND no other content signal. Every one of these is
 * required — the intersection is what makes it unambiguously junk:
 *   - short: a long recording, even with an empty transcript, may be a
 *     transcription failure worth keeping for a retry.
 *   - transcript-less: a short capture WITH words is a quick real note.
 *   - no summary: a capture can have its transcript cleared/migrated but still
 *     carry a real AI summary (verified on prod: "Live Chat UI Review" had a
 *     291-char summary and zero transcript). A summary is content — keep it.
 *   - no user notes: the batch flow treats hand-typed user_notes as
 *     authoritative; a capture the user annotated is not junk.
 *   - no user-set title: if the user renamed it, they cared about it. Keep it.
 * Missing ANY of these signals-of-emptiness → not junk, don't archive.
 *
 * DURATION IS UNRELIABLE. `duration_seconds` is null at creation and only set
 * by the web stop-flow (with a known clamp bug), so a real long meeting can
 * arrive with a tiny/null duration — exactly the transcription-failure case a
 * user reaches Reprocess to recover. So "short" is computed from the MAX of the
 * reported duration and the wall-clock span (ended_at − started_at), and this
 * predicate must NOT be the last line of defense: the caller also restricts
 * archiving to the end-of-meeting batch (never Reprocess). See the route.
 */
export const JUNK_MAX_DURATION_SECONDS = 60
/** Below this many non-whitespace transcript chars, treat as "no transcript". */
export const JUNK_MAX_TRANSCRIPT_CHARS = 20
/** At/above this many summary chars, the capture has real content — keep it. */
export const MEANINGFUL_SUMMARY_CHARS = 20
/** At/above this many user-notes chars, the user annotated it — keep it. */
export const MEANINGFUL_NOTES_CHARS = 10

export function shouldAutoArchiveCapture(args: {
  durationSeconds: number | null | undefined
  transcript: string | null | undefined
  /** ai_summary — a non-trivial summary means the capture has content. */
  aiSummary?: string | null | undefined
  /** The capture's title — a user-set (non-default) title means they kept it. */
  title?: string | null | undefined
  /** user_notes — hand-typed notes the batch flow treats as authoritative. */
  userNotes?: string | null | undefined
  /** ISO start/end timestamps — the wall-clock span is the reliable duration
   *  fallback when duration_seconds is null/clamped. */
  startedAt?: string | null | undefined
  endedAt?: string | null | undefined
}): boolean {
  // Effective duration = max(reported, wall-clock span). Guards the case where
  // duration_seconds is null/clamped but the meeting genuinely ran for minutes.
  const reported = args.durationSeconds ?? 0
  let spanSeconds = 0
  if (args.startedAt && args.endedAt) {
    const start = Date.parse(args.startedAt)
    const end = Date.parse(args.endedAt)
    if (!Number.isNaN(start) && !Number.isNaN(end) && end > start) {
      spanSeconds = (end - start) / 1000
    }
  }
  const effectiveDuration = Math.max(reported, spanSeconds)

  const transcriptLen = (args.transcript ?? '').trim().length
  const summaryLen = (args.aiSummary ?? '').trim().length
  const notesLen = (args.userNotes ?? '').trim().length

  const isShort = effectiveDuration < JUNK_MAX_DURATION_SECONDS
  const isTranscriptless = transcriptLen < JUNK_MAX_TRANSCRIPT_CHARS
  const hasSummary = summaryLen >= MEANINGFUL_SUMMARY_CHARS
  const hasNotes = notesLen >= MEANINGFUL_NOTES_CHARS
  // A user-set (non-generic) title is a signal the user cared about this row.
  const hasUserTitle = !isUntitledCapture(args.title)

  return isShort && isTranscriptless && !hasSummary && !hasNotes && !hasUserTitle
}

/** The default title assigned at capture creation (captures POST route). */
export const DEFAULT_CAPTURE_TITLE = 'Untitled Capture'

/**
 * True if the capture never got a real title — null, blank, the creation
 * default, or a generic auto-name. These are the captures the batch pass should
 * title from the transcript.
 */
const GENERIC_TITLES = new Set([
  DEFAULT_CAPTURE_TITLE.toLowerCase(),
  'untitled',
  'untitled capture',
  'new capture',
  'recording',
  'new recording',
])

/**
 * Auto-generated timestamp titles like "Capture Jul 1 7:46 PM" / "Capture Jun
 * 28 10:05 AM" — the client's fallback name when the user never titled the
 * capture. These are untitled in spirit.
 */
const TIMESTAMP_TITLE_RE =
  /^capture\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2}\b/i

export function isUntitledCapture(title: string | null | undefined): boolean {
  const raw = (title ?? '').trim()
  if (raw.length === 0) return true
  if (GENERIC_TITLES.has(raw.toLowerCase())) return true
  if (TIMESTAMP_TITLE_RE.test(raw)) return true
  return false
}
