/**
 * Extraction-time priority + due-date calibration (GEN-138).
 *
 * The extractor inflates priority and fabricates dates — in one real workspace
 * 107 of 252 active actions were "high" (the signal became meaningless), and an
 * action carried a due date BEFORE its project existed. The Meeting agent's
 * prompt already asks for restraint; the graveyard proves prompt-alone isn't
 * enough. These pure functions are the deterministic backstop, applied to the
 * staged values in propose_change.execute regardless of what the model set.
 *
 * Governing bias (docs/loop-engine/EXTRACTION-GUARDRAIL-DESIGN.md): only ever
 * DAMP, never invent. Priority is only ever lowered, and only from the two
 * inflated tiers; a due date is only ever dropped, never added or shifted. The
 * worst case is a real high-priority item damped to medium — recoverable from
 * the note, and far cheaper than a board where "high" means nothing.
 */

export type Priority = 'none' | 'low' | 'medium' | 'high' | 'urgent'

/**
 * Blocking/urgency language that JUSTIFIES a high/urgent priority when it
 * appears in the trigger quote. A small, closed lexicon — matched as substrings
 * against the lowercased quote, so "blocker"/"blocking" both hit "block". Kept
 * deliberately tight AND boundary-safe: every entry is a stem that can't hide
 * inside an unrelated common word. We avoid stems like "down" (download,
 * shutdown, countdown), "fire" (Firefox, confirmed), "break" (breakfast) —
 * those would falsely justify inflation (a recall miss that keeps a bogus
 * "high"). Phrases are safe because they can't accidentally embed. These are
 * words people actually say when something is genuinely urgent, not soft
 * intensifiers ("important", "soon") that inflate.
 */
export const URGENCY_LEXICON = [
  'block', // blocks, blocker, blocking, blocked
  'urgent',
  'asap',
  'critical',
  'deadline',
  'hard stop',
  'hard deadline',
  'must ship',
  'must be done',
  'must have',
  'can\'t proceed',
  'cannot proceed',
  'waiting on',
  'depends on',
  'dependency',
  'escalat', // escalate, escalation
  'on fire', // phrase — can't embed in an unrelated word
  'firefight',
  'is down', // "prod is down", "site is down" — phrase, boundary-safe
  'went down',
  'outage',
  'p0',
  'p1',
] as const

/**
 * Date-like tokens that indicate the trigger quote actually named a time. If a
 * proposal has a due_date but NONE of these appear in its quote, the date was
 * invented. Substring-matched against the lowercased quote.
 *
 * Covers: month names (+abbr), weekday names (+abbr), relative-date phrases, and
 * a numeric-date regex checked separately. This is intentionally broad on the
 * KEEP side — a false "quote has a date" (keeping a real date) is harmless; the
 * expensive mistake is dropping a date the user actually gave, so we err toward
 * detecting a date when the quote plausibly contains one.
 */
const DATE_WORD_TOKENS = [
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri', 'sat', 'sun',
  'today', 'tomorrow', 'tonight', 'yesterday',
  'next week', 'this week', 'next month', 'end of', 'eod', 'eow', 'cob',
  'by ', 'due ', 'deadline', 'week', 'month', 'quarter', 'q1', 'q2', 'q3', 'q4',
  'morning', 'afternoon', 'evening', 'noon', 'midnight',
] as const

/** Numeric dates: 2026-07-02, 7/2, 07/02/2026, 2nd, 15th, etc. */
const NUMERIC_DATE_RE = /\b(\d{1,4}[/-]\d{1,2}([/-]\d{1,4})?|\d{1,2}(st|nd|rd|th))\b/

function quoteMentionsADate(quote: string): boolean {
  const q = quote.toLowerCase()
  if (DATE_WORD_TOKENS.some((t) => q.includes(t))) return true
  return NUMERIC_DATE_RE.test(q)
}

export interface CalibrationResult<T> {
  value: T
  /** Human-readable note (appended to propose_change's returned note), or null. */
  note: string | null
  /** True iff the value was changed from the input. */
  changed: boolean
}

/**
 * Lower an unjustified high/urgent priority to medium.
 *
 * Justified iff the proposal has a hard due date OR the trigger quote contains
 * blocking/urgency language. low/medium/none always pass through unchanged.
 */
export function calibratePriority(
  priority: Priority | null | undefined,
  dueDate: string | null | undefined,
  triggerQuote: string | null | undefined,
): CalibrationResult<Priority | null> {
  const p = priority ?? null
  if (p !== 'high' && p !== 'urgent') return { value: p, note: null, changed: false }

  const hasHardDate = !!(dueDate && dueDate.trim())
  const q = (triggerQuote ?? '').toLowerCase()
  const hasBlockingLanguage = q.length > 0 && URGENCY_LEXICON.some((w) => q.includes(w))

  if (hasHardDate || hasBlockingLanguage) return { value: p, note: null, changed: false }

  return {
    value: 'medium',
    note: `priority lowered ${p}→medium: no blocking dependency or hard date in the quote`,
    changed: true,
  }
}

/**
 * How many days a due date may fall before the capture's UTC calendar day
 * before we treat it as impossible-as-a-commitment. A 1-day grace absorbs the
 * timezone skew between the capture's UTC-stored started_at and a due date
 * resolved on the user's LOCAL calendar: an evening meeting west of UTC is
 * stored on the next UTC day, so a genuine same-day ("by today") deadline can
 * read as one calendar day earlier. We only want to catch dates that are
 * clearly, grossly in the past (the "date before the project existed" case is
 * months off), not a one-day boundary artifact.
 */
const PREDATES_GRACE_DAYS = 1
const DAY_MS = 86_400_000

/**
 * Drop a fabricated due date.
 *
 * Dropped iff: (a) a date is set but the trigger quote names no date at all, OR
 * (b) the date is more than PREDATES_GRACE_DAYS before the capture's own date
 * (impossible as a commitment — catches the "date before the project existed"
 * case without tripping on a timezone-boundary day skew). Otherwise kept.
 *
 * `captureDate` is the capture's start/created date as an ISO string (YYYY-MM-DD
 * or full ISO); only its date part matters. Pass null to skip the predates check
 * (e.g. when the capture date is unknown) — the quote check still applies.
 */
export function calibrateDueDate(
  dueDate: string | null | undefined,
  triggerQuote: string | null | undefined,
  captureDate: string | null | undefined,
): CalibrationResult<string | null> {
  const d = dueDate && dueDate.trim() ? dueDate.trim() : null
  if (!d) return { value: null, note: null, changed: false }

  // (b) grossly predates the meeting → impossible as a commitment. The 1-day
  // grace keeps a genuine same-day deadline from being dropped when the
  // capture's UTC day is one ahead of the user's local day (evening meeting
  // west of UTC).
  if (captureDate) {
    const due = Date.parse(d.slice(0, 10))
    const cap = Date.parse(captureDate.slice(0, 10))
    if (!Number.isNaN(due) && !Number.isNaN(cap) && due < cap - PREDATES_GRACE_DAYS * DAY_MS) {
      return {
        value: null,
        note: 'due date dropped: predates the meeting',
        changed: true,
      }
    }
  }

  // (a) quote names no date → the date was invented.
  const quote = triggerQuote ?? ''
  if (quote.trim().length === 0 || !quoteMentionsADate(quote)) {
    return {
      value: null,
      note: 'due date dropped: nothing dated in the quote',
      changed: true,
    }
  }

  return { value: d, note: null, changed: false }
}
