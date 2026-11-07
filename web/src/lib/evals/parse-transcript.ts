/**
 * Pasting a REAL transcript into an eval case.
 *
 * An eval case's value is bounded by how real its meeting is, and the most real
 * meeting available is one that already happened. Three shapes of our own
 * transcript are already copyable, and a person pasting one does not know or
 * care which of the three they hold:
 *
 *   1. The HUD's Copy button (`live-capture-header.tsx` `handleCopy`) —
 *      `Speaker: text` per line, where Speaker is the DISPLAY name
 *      `getSpeakerDisplayName` resolved: `You` for the local mic, `Remote 1`,
 *      or an assigned contact's real name.
 *   2. The stored transcript (`captures.transcript`, the share page, and what
 *      `get_capture_transcript` returns) — `[local_1] text` per line, RAW
 *      speaker labels, with continuation lines carrying no prefix at all.
 *   3. The eval authoring shape (`scriptToTranscript`) — `[speaker]: text`,
 *      which is also what a frozen chunk's `text` holds, so a chunk copied out
 *      of a run's trace pastes straight back in.
 *
 * Plus, tolerantly, a leading timestamp in any of the four shapes tools emit —
 * `[mm:ss]`, `(mm:ss)`, a bare `mm:ss `, or `hh:mm:ss`. Deepgram does not write
 * them, but a person cleaning up a transcript by hand or exporting from another
 * tool often does, and a paste that fails on a timestamp is a paste that fails.
 *
 * WHY THIS FILE IS PURE. The three formats are one regex chain, the timing
 * model has to line up exactly with `freezeChunks`' silence rule, and the
 * speaker → `local_1`/`remote_N` mapping is what decides whether self-binding
 * works on the resulting case. All three are worth testing directly, and none
 * of them want a React tree around them to be tested.
 */
import type { EvalParticipant, ScriptSegment } from './types'

/** One parsed utterance, before any label or timing decision is made.
 *  `speaker` is verbatim as pasted — `You`, `Remote 1`, `local_1`, `Dana`. */
export interface ParsedLine {
  speaker: string
  text: string
  /** The offset the paste carried, or null when it carried none. */
  t_ms: number | null
}

export interface ParsedTranscript {
  lines: ParsedLine[]
  /** Distinct speakers in ORDER OF FIRST APPEARANCE — which is the order the
   *  "You are" picker renders and the order `remote_N` is handed out in. */
  speakers: string[]
  /** Human-readable parse complaints, one per unusable line. Never thrown:
   *  half a pasted transcript is worth more than an error. */
  problems: string[]
}

// ---------------------------------------------------------------------------
// Timing
//
// A pasted transcript usually carries NO timestamps, and `freezeChunks` reads
// nothing but `t_ms` — so the offsets synthesized here are what decide the
// case's flush boundaries. The two gaps below are chosen against the gate's
// silence rule (both streams quiet for `SILENCE_MS`, which is 3000): a turn
// change clears it, a same-speaker continuation does not.
//
// That does NOT mean one flush per turn, and it should not: the gate's size
// floor (`GATE_MIN_FLUSH_CHARS`, 1200) holds the buffer open until a window is
// worth extracting from, so a short exchange stays ONE window exactly as it
// would have on the real call. What the gaps buy is that every boundary the
// floor does allow lands on a turn boundary rather than mid-utterance — which
// is the only property a synthesized timeline can honestly claim.
// ---------------------------------------------------------------------------

/** Speaking time for a line, as a rough 170 wpm (350ms/word), floored so a
 *  one-word "Sure." still occupies a beat. */
export const MS_PER_WORD = 350
export const MIN_LINE_MS = 1000
/** The gap inserted at a SPEAKER CHANGE: past the gate's 3s silence rule, so
 *  the window closes on the turn boundary. */
export const TURN_GAP_MS = 3500
/** The gap inserted when the SAME speaker continues: under the rule, so a
 *  monologue stays in one window rather than being chopped per line. */
export const SAME_SPEAKER_GAP_MS = 900
/** The minimum forward step applied when a pasted transcript's own timestamps
 *  go BACKWARDS (two tools' clocks, or a hand edit). */
export const BACKWARDS_BUMP_MS = 400

/** The offset an APPENDED paste starts at, measured from the last existing
 *  line — a full turn gap, so the seam is a flush boundary rather than a
 *  window that spans the join. */
export const APPEND_GAP_MS = TURN_GAP_MS

// ---------------------------------------------------------------------------
// Line parsing
// ---------------------------------------------------------------------------

/**
 * A leading timestamp in any of the four shapes, captured as h?/m/s.
 * Anchored and non-greedy about what follows, so `12:30` in the middle of a
 * sentence is left alone — only the head of the line is a timestamp.
 */
const TIMESTAMP_RE = /^[[(]?(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:\.\d+)?[\])]?\s+/

/**
 * The same four shapes when the timestamp is BRACKETED or PARENTHESIZED, with
 * no whitespace requirement after it.
 *
 * `[00:12]` alone on its own line — the very common export where the timestamp
 * precedes the speaker line — carries no trailing space, so TIMESTAMP_RE's
 * mandatory `\s+` misses it and BRACKET_RE below would claim it as a SPEAKER
 * named "00:12": a phantom participant, an empty-text segment, and a Save the
 * route then rejects. Delimiters are required here precisely so a bare `12:30`
 * with no space after it is still left alone as ordinary text.
 */
const DELIMITED_TIMESTAMP_RE =
  /^(?:\[(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:\.\d+)?\]|\((?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:\.\d+)?\))\s*/

/** `[label]: text` and `[label] text` — formats 2 and 3 share one regex,
 *  because the colon after the bracket is optional in exactly one of them. */
const BRACKET_RE = /^\[([^\]]+)\]\s*:?\s*(.*)$/

/** `Speaker: text` — format 1. The speaker is everything before the FIRST
 *  `:`, so "You: Well, here's the thing: we need it by Friday" keeps its
 *  second colon in the spoken text. Bounded in length so a sentence that
 *  happens to contain a colon is not mistaken for a speaker line. */
const SPEAKER_RE = /^([^:]{1,60}):\s+(.*)$/

/** Strip a leading timestamp, returning the offset it encoded (or null). */
function takeTimestamp(line: string): { rest: string; t_ms: number | null } {
  const match = line.match(TIMESTAMP_RE) ?? line.match(DELIMITED_TIMESTAMP_RE)
  if (!match) return { rest: line, t_ms: null }
  // The delimited pattern has two alternations, so the h/m/s groups land in
  // 1-3 or 4-6 depending on which bracket the line used.
  const [h, m, s] = match[3] !== undefined
    ? [match[1], match[2], match[3]]
    : [match[4], match[5], match[6]]
  const hours = h ? Number(h) : 0
  const minutes = Number(m)
  const seconds = Number(s)
  return {
    rest: line.slice(match[0].length),
    t_ms: ((hours * 60 + minutes) * 60 + seconds) * 1000,
  }
}

/**
 * Parse pasted text into utterances.
 *
 * A line that matches none of the three shapes and follows a line that did is
 * a CONTINUATION — the stored format wraps long utterances that way, and so
 * does anything that went through a text editor. It is appended with a SPACE
 * rather than a newline: the case editor renders one auto-growing textarea per
 * utterance, so an embedded newline would be invisible in the editor and then
 * show up inside the replayed chunk text.
 *
 * A line matching nothing with no previous line is a problem, reported and
 * skipped. Nothing here throws.
 */
export function parseTranscriptText(input: string): ParsedTranscript {
  const lines: ParsedLine[] = []
  const problems: string[] = []
  const speakers: string[] = []

  const raw = (input ?? '').split(/\r?\n/)
  for (let i = 0; i < raw.length; i++) {
    const trimmed = raw[i].trim()
    if (!trimmed) continue

    const { rest, t_ms } = takeTimestamp(trimmed)
    const body = rest.trim()
    if (!body) continue

    // A bracket whose label is only whitespace (`[ ] text`) is not a labelled
    // line: `[^\]]+` matches the space, and taking it would mint a speaker
    // with an empty display, which the route's participant schema rejects and
    // which 400s the whole Save. Drop the empty bracket and treat what follows
    // as an unlabelled line — a continuation of whoever spoke last.
    const bracketMatch = body.match(BRACKET_RE)
    const bracket = bracketMatch && bracketMatch[1].trim() ? bracketMatch : null
    const unlabelled = bracketMatch && !bracket ? bracketMatch[2].trim() : null
    const speakerMatch = bracketMatch ? null : body.match(SPEAKER_RE)
    const match = bracket ?? speakerMatch

    if (match) {
      const speaker = match[1].trim()
      const text = match[2].trim()
      // A bracketed label with no text (`[local_1]` alone on a line) is a real
      // shape in the stored format when an utterance wrapped; keep the line so
      // the continuation below has somewhere to land.
      if (!speakers.includes(speaker)) speakers.push(speaker)
      lines.push({ speaker, text, t_ms })
      continue
    }

    const carry = unlabelled ?? body
    if (!carry) continue
    if (lines.length > 0) {
      const previous = lines[lines.length - 1]
      previous.text = previous.text ? `${previous.text} ${carry}` : carry
      continue
    }

    problems.push(`Line ${i + 1} has no speaker: "${truncate(carry)}"`)
  }

  if (lines.length === 0 && problems.length === 0 && (input ?? '').trim() === '') {
    problems.push('Nothing to import yet.')
  }

  return { lines, speakers, problems }
}

function truncate(value: string): string {
  return value.length > 48 ? `${value.slice(0, 48)}…` : value
}

// ---------------------------------------------------------------------------
// Script construction
// ---------------------------------------------------------------------------

/**
 * The label a real solo-desk capture's mic stream carries, and — per
 * `create-case.ts` `selfSpeakerLabel` and `seed-self-participant.ts` — the ONLY
 * label the engine will bind to the owner's member row. An eval capture is
 * written as `capture_mode='desktop_dual'`, so exactly one `local_*` speaker on
 * the `mic` stream is the contract; everyone else must be a `remote_N` on
 * `system` or self-binding silently does not happen.
 */
export const SELF_LABEL = 'local_1'

/** The label assigned to each pasted speaker: the chosen self becomes
 *  `local_1`, everyone else `remote_N` in first-appearance order. */
export function assignLabels(
  speakers: string[],
  selfSpeaker: string | null,
  /** Labels already spoken for — used by Append so a second paste does not
   *  reuse `remote_1` for a different person. */
  taken: ReadonlySet<string> = new Set(),
): Record<string, string> {
  const labels: Record<string, string> = {}
  let next = 1
  for (const speaker of speakers) {
    if (selfSpeaker !== null && speaker === selfSpeaker) {
      labels[speaker] = SELF_LABEL
      continue
    }
    let candidate = `remote_${next}`
    while (taken.has(candidate)) {
      next += 1
      candidate = `remote_${next}`
    }
    labels[speaker] = candidate
    next += 1
  }
  return labels
}

/**
 * Turn parsed lines into a case script.
 *
 * TIMING. If EVERY line carried a timestamp the paste's own clock is used, made
 * monotonic (a line that goes backwards is bumped to previous + 400ms) because
 * `freezeChunks` sorts by `t_ms` and a backwards line would silently reorder
 * the meeting. Otherwise offsets are synthesized from the word count and the
 * two gap constants above — a mixed paste (some lines timed, some not) is
 * treated as untimed, since interleaving real and invented offsets produces a
 * timeline that is neither.
 *
 * @param selfSpeaker the display name whose lines are the owner's microphone,
 *                    or null for "Nobody" — in which case every speaker is a
 *                    `remote_N` on the system stream and the case has no self.
 */
export function toScript(
  parsed: ParsedTranscript,
  selfSpeaker: string | null,
  options: { startMs?: number; takenLabels?: ReadonlySet<string> } = {},
): ScriptSegment[] {
  const { lines } = parsed
  if (lines.length === 0) return []

  const labels = assignLabels(parsed.speakers, selfSpeaker, options.takenLabels)
  const startMs = options.startMs ?? 0
  const allTimed = lines.every((line) => line.t_ms !== null)

  const offsets: number[] = []
  if (allTimed) {
    // The paste's own clock, rebased to `startMs` and forced monotonic.
    const base = lines[0].t_ms as number
    let previous = -1
    for (const line of lines) {
      let at = startMs + ((line.t_ms as number) - base)
      if (at <= previous) at = previous + BACKWARDS_BUMP_MS
      offsets.push(at)
      previous = at
    }
  } else {
    let at = startMs
    for (let i = 0; i < lines.length; i++) {
      offsets.push(at)
      const words = lines[i].text.split(/\s+/).filter(Boolean).length
      const duration = Math.max(MIN_LINE_MS, words * MS_PER_WORD)
      const next = lines[i + 1]
      const gap =
        next && next.speaker === lines[i].speaker ? SAME_SPEAKER_GAP_MS : TURN_GAP_MS
      at = at + duration + gap
    }
  }

  return lines.map((line, index) => {
    const label = labels[line.speaker] ?? `remote_${index + 1}`
    return {
      t_ms: offsets[index],
      speaker: label,
      stream: label === SELF_LABEL ? ('mic' as const) : ('system' as const),
      text: line.text,
    }
  })
}

/**
 * The participant rows a paste implies, which is the only place the pasted
 * DISPLAY names survive: the script carries `local_1`/`remote_2`, and without
 * this the agent would be shown a meeting between two anonymous labels when the
 * transcript said `Dana` and `Priya`. `UpdateCaseSchema` accepts `participants`
 * and `updateEvalCase` writes them to both the capture's jsonb and its
 * `capture_participant` rows, so this goes out with the same PATCH as the
 * script.
 */
export function toParticipants(
  parsed: ParsedTranscript,
  selfSpeaker: string | null,
  options: { takenLabels?: ReadonlySet<string> } = {},
): EvalParticipant[] {
  const labels = assignLabels(parsed.speakers, selfSpeaker, options.takenLabels)
  return parsed.speakers.map((speaker) => ({
    speaker_label: labels[speaker],
    display: speaker,
    is_self: labels[speaker] === SELF_LABEL,
  }))
}

/**
 * The speaker preselected in the "You are" picker: the HUD's own word for the
 * local mic, then any raw `local_*` label, then simply the first person to
 * speak — which on a sales call is usually the person who pasted it.
 */
export function defaultSelfSpeaker(speakers: string[]): string | null {
  if (speakers.length === 0) return null
  const you = speakers.find((s) => s.toLowerCase() === 'you')
  if (you) return you
  const local = speakers.find((s) => s.toLowerCase().startsWith('local'))
  if (local) return local
  return speakers[0]
}
