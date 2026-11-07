/**
 * Who said a proposal's trigger quote (followups issue 11).
 *
 * A desktop capture's transcript is one line per turn, opened by the voice's
 * diarization label: `[local_N]` for the recording machine's own microphone,
 * `[remote_N]` for the meeting's audio (src/lib/deepgram-stream.ts mints them;
 * the channel is kept nowhere else). A proposal's trigger_quote carries no
 * label, so triage could not tell a first-person "I'll ping you the status"
 * said on the user's own microphone from one said on the call — and when the
 * room had several voices on the microphone and none was identified as the
 * user, it dismissed the user's own commitments as "not yours".
 *
 * This places the quote in the transcript (verbatim as the auto-attempt gate
 * grounds one, quote-match.ts, else by aligning its words: quoteLabels) and
 * reports the voices it was said under: the label, its channel, who the capture's participant rows
 * identify it as, and `possibly_you` — an unidentified voice on the caller's
 * own microphone said it, on a capture where the caller's own voice has not
 * been identified. Triage cards those instead of dismissing them (migration
 * 287). Pure except `loadQuoteSpeakers`, which reads and never throws.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { applyCaptureVisibility, type CaptureRequester } from '@/lib/ai/tools/_shared'
import { locateQuote, normalizeForQuote } from './quote-match'

/** The recorder's channel a voice came in on. */
export type SpeakerChannel = 'microphone' | 'meeting_audio'

/** `local_*` is the recording machine's own microphone, `remote_*` the meeting's audio; any other label has no channel. */
export function channelOf(label: string): SpeakerChannel | null {
  if (/^local_\d+$/.test(label)) return 'microphone'
  if (/^remote_\d+$/.test(label)) return 'meeting_audio'
  return null
}

/** The label that opens a transcript line (the recorder's, not anyone's words). */
const LINE_LABEL = /^[ \t]*\[([^\]\n]{1,40})\]/

/**
 * The labels of the turns a span of the transcript covers, in order, each
 * once. A line with no label continues the turn above it.
 */
export function labelsForSpan(transcript: string, span: { start: number; end: number }): string[] {
  const out: string[] = []
  let current: string | null = null
  let lineStart = 0
  for (;;) {
    const nl = transcript.indexOf('\n', lineStart)
    const lineEnd = nl < 0 ? transcript.length : nl
    const m = LINE_LABEL.exec(transcript.slice(lineStart, lineEnd))
    if (m) current = m[1].trim()
    if (current && lineEnd > span.start && !out.includes(current)) out.push(current)
    if (nl < 0 || nl + 1 >= span.end) break
    lineStart = nl + 1
  }
  return out
}

/**
 * The parts of a quote that were said apart: a writer joins two lines with
 * " / " (`"if you share a screenshot…" / "I can add that"`). Each part is
 * placed on its own; elisions inside a part are quote-match's.
 */
export function quoteParts(quote: string): string[] {
  return quote
    .split(/\s+\/\s+/)
    .map((part) => part.trim())
    .filter(Boolean)
}

// ── Where a quote was said, when it is not verbatim ──────────────────────────
//
// The auto-attempt gate grounds a quote verbatim (quote-match.ts): it must be
// PROOF the words were said. Placing a quote under its speaker needs less, and
// verbatim fails on most real quotes: the extractor drops the fillers ("um",
// "uh"), tidies repeats ("I I submitted"), and a turn is often cut by someone
// else's interjection ("…I'll ping you / [remote_3] sure / the status of
// that"). So when the verbatim match fails, the quote's words are aligned to
// the transcript's (a local alignment: in order, a skipped word costs one, a
// matched word earns two), fillers left out of both, and the alignment counts
// only when most of the quote's words line up. It locates; it never grounds.

/** Spoken fillers the extractor leaves out of a quote. */
const FILLERS: ReadonlySet<string> = new Set(['um', 'umm', 'uh', 'uhm', 'er', 'erm', 'ah', 'hmm', 'mm', 'mhm'])
/** A piece shorter than this (after fillers) is too common to place. */
export const MIN_ALIGNED_WORDS = 5
/** The share of a piece's words that must line up, in order. */
export const MIN_ALIGNED_SHARE = 0.7

/** Where a writer elided words inside a quote ("...", "…"). */
const ELISION = /(?:\.\s*){3,}|…/

interface SpokenWord {
  word: string
  label: string | null
}

/** The transcript as words, each with the label of the turn it was said in. */
export function spokenWords(transcript: string): SpokenWord[] {
  const out: SpokenWord[] = []
  let current: string | null = null
  for (const line of transcript.split('\n')) {
    const m = LINE_LABEL.exec(line)
    if (m) current = m[1].trim()
    for (const word of normalizeForQuote(m ? line.slice(m[0].length) : line).split(' ')) {
      if (word && !FILLERS.has(word)) out.push({ word, label: current })
    }
  }
  return out
}

function quoteWords(text: string): string[] {
  return normalizeForQuote(text)
    .split(' ')
    .filter((word) => word && !FILLERS.has(word))
}

/**
 * The indexes in `words` a quote's words line up with (a Smith-Waterman local
 * alignment), or null when fewer than MIN_ALIGNED_WORDS, or under
 * MIN_ALIGNED_SHARE of the quote's words, line up.
 */
export function alignQuote(words: readonly SpokenWord[], quote: readonly string[]): number[] | null {
  const m = quote.length
  const n = words.length
  if (n === 0) return null
  const w = n + 1
  const score = new Int32Array((m + 1) * w)
  const step = new Uint8Array((m + 1) * w) // 0 start, 1 diagonal, 2 skip a quote word, 3 skip a transcript word
  let best = 0
  let bi = 0
  let bj = 0
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const diag = score[(i - 1) * w + j - 1] + (quote[i - 1] === words[j - 1].word ? 2 : -1)
      const up = score[(i - 1) * w + j] - 1
      const left = score[i * w + j - 1] - 1
      let v = 0
      let d = 0
      if (diag > v) (v = diag), (d = 1)
      if (up > v) (v = up), (d = 2)
      if (left > v) (v = left), (d = 3)
      score[i * w + j] = v
      step[i * w + j] = d
      if (v > best) (best = v), (bi = i), (bj = j)
    }
  }
  const matched: number[] = []
  let i = bi
  let j = bj
  while (i > 0 && j > 0 && step[i * w + j] !== 0) {
    const d = step[i * w + j]
    if (d === 1) {
      if (quote[i - 1] === words[j - 1].word) matched.push(j - 1)
      i--
      j--
    } else if (d === 2) i--
    else j--
  }
  if (matched.length < Math.max(MIN_ALIGNED_WORDS, Math.ceil(MIN_ALIGNED_SHARE * m))) return null
  return matched.reverse()
}

/**
 * The labels a quote was said under, in order, each once: each " / " part
 * placed verbatim when it can be, else each of its elided pieces aligned.
 * Empty when nothing places.
 */
export function quoteLabels(transcript: string, quote: string): string[] {
  const labels: string[] = []
  const add = (label: string | null) => {
    if (label && !labels.includes(label)) labels.push(label)
  }
  let words: SpokenWord[] | null = null
  for (const part of quoteParts(quote)) {
    const span = locateQuote(transcript, part)
    if (span) {
      for (const label of labelsForSpan(transcript, span)) add(label)
      continue
    }
    words ??= spokenWords(transcript)
    for (const piece of part.split(ELISION)) {
      const hit = alignQuote(words, quoteWords(piece))
      if (hit) for (const at of hit) add(words[at].label)
    }
  }
  return labels
}

/** What a capture's participant rows say about its voices. */
export interface CaptureVoices {
  /** The capture was recorded by the caller (its microphone is theirs). */
  recordedByCaller: boolean
  /** The recorder's own voice is identified: their participant row carries a label. */
  recorderVoiceIdentified: boolean
  /** label → who it was identified as: "the user" for the caller's own voice, else a name or "a participant". */
  identified: Map<string, string>
}

export interface QuoteSpeaker {
  speakers: Array<{ label: string; channel: SpeakerChannel | null; identified_as: string | null }>
  /**
   * An unidentified voice on the caller's own microphone said (part of) the
   * quote, and the caller's own voice is not identified on this capture: it
   * may be the caller. False whenever any of that does not hold.
   */
  possibly_you: boolean
}

/** Who said `quote` in `transcript`; null when it is not found there. */
export function quoteSpeaker(transcript: string, quote: string, voices: CaptureVoices): QuoteSpeaker | null {
  const labels = quoteLabels(transcript, quote)
  if (labels.length === 0) return null
  const speakers = labels.map((label) => ({
    label,
    channel: channelOf(label),
    identified_as: voices.identified.get(label) ?? null,
  }))
  const possibly_you =
    voices.recordedByCaller &&
    !voices.recorderVoiceIdentified &&
    speakers.some((s) => s.channel === 'microphone' && s.identified_as === null)
  return { speakers, possibly_you }
}

interface ParticipantRow {
  capture_id: string
  speaker_label: string | null
  is_self: boolean | null
  self_binding: string | null
  external_name: string | null
  member: { display_name: string | null } | null
}

/**
 * `spoken_by` for each row that has a trigger quote and a capture, keyed by
 * the row's id. Reads the captures' transcripts (through the same visibility
 * fence the caller's proposal list used: `requester`, eval captures excluded)
 * and their labelled participant rows. A failed read leaves rows out; it
 * never throws.
 */
export async function loadQuoteSpeakers(
  supabase: SupabaseClient,
  rows: ReadonlyArray<{ id: string; capture_id: string | null; trigger_quote: string | null }>,
  callerUserId: string,
  requester: CaptureRequester,
): Promise<Map<string, QuoteSpeaker>> {
  const out = new Map<string, QuoteSpeaker>()
  const quoted = rows.filter((r) => r.capture_id && typeof r.trigger_quote === 'string' && r.trigger_quote.trim())
  const captureIds = [...new Set(quoted.map((r) => r.capture_id as string))]
  if (captureIds.length === 0) return out
  try {
    const [capRes, partRes] = await Promise.all([
      applyCaptureVisibility(supabase.from('captures').select('id, user_id, transcript').in('id', captureIds), requester),
      supabase
        .from('capture_participant')
        .select('capture_id, speaker_label, is_self, self_binding, external_name, member:member!member_id(display_name)')
        .in('capture_id', captureIds)
        .not('speaker_label', 'is', null),
    ])
    if (capRes.error || partRes.error) {
      console.warn('[quote-speakers] read failed:', capRes.error?.message ?? partRes.error?.message)
      return out
    }
    const voices = new Map<string, CaptureVoices>()
    const transcripts = new Map<string, string>()
    for (const c of (capRes.data ?? []) as Array<{ id: string; user_id: string | null; transcript: string | null }>) {
      if (typeof c.transcript === 'string' && c.transcript) transcripts.set(c.id, c.transcript)
      voices.set(c.id, { recordedByCaller: c.user_id === callerUserId, recorderVoiceIdentified: false, identified: new Map() })
    }
    for (const p of (partRes.data ?? []) as unknown as ParticipantRow[]) {
      const v = voices.get(p.capture_id)
      const label = p.speaker_label?.trim()
      if (!v || !label) continue
      if (p.is_self === true) {
        if ((p.self_binding ?? 'none') === 'none') continue
        v.recorderVoiceIdentified = true
        v.identified.set(label, v.recordedByCaller ? 'the user' : p.member?.display_name || 'the recorder')
      } else {
        v.identified.set(label, p.member?.display_name || p.external_name || 'a participant')
      }
    }
    for (const r of quoted) {
      const transcript = transcripts.get(r.capture_id as string)
      const v = voices.get(r.capture_id as string)
      if (!transcript || !v) continue
      const speaker = quoteSpeaker(transcript, r.trigger_quote as string, v)
      if (speaker) out.set(r.id, speaker)
    }
  } catch (err) {
    console.warn('[quote-speakers] failed:', err instanceof Error ? err.message : err)
  }
  return out
}
