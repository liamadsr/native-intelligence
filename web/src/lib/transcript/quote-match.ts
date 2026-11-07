/**
 * Matching a quoted line against a capture's transcript, exactly as the
 * auto-attempt gate grounds a work proposal (#487): the speaker label that
 * opens each transcript line is not speech, case, punctuation and whitespace
 * do not count, and a quote whose writer elided words ("...", "…") matches
 * when its pieces appear in order. There is no fuzzy matching: a paraphrase
 * does not match. Moved here from src/lib/work/auto-attempt.ts so the triage
 * tool can place a proposal's quote under its speaker without importing the
 * attempt path (issue 11); auto-attempt re-exports every name.
 */

/**
 * A piece of an elided quote ("I can send it... by Friday") shorter than this
 * is too common to place ("so", "by Friday") and is not matched. The pieces
 * kept must appear in the transcript in order, and together they must reach
 * the caller's own minimum (auto-attempt's MIN_GROUNDING_QUOTE_CHARS).
 */
export const MIN_QUOTE_PIECE_CHARS = 12

/** The spans inside straight or curly double quotes. */
export function quotedSpans(text: string): string[] {
  const out: string[] = []
  const re = /["“]([^"“”]+)["”]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text ?? '')) !== null) out.push(m[1])
  return out
}

/** Case-, whitespace- and punctuation-insensitive form for a verbatim-quote check. */
export function normalizeForQuote(text: string): string {
  return normalizeWithOffsets(text).text
}

/** What a quote is made of; every run of anything else is one space. */
const QUOTE_WORD_CHAR = /[\p{L}\p{N}']/u

/**
 * normalizeForQuote's form, with the offset in `text` each of its characters
 * came from, so a match in the normalised text can be cut from the original
 * (the brief's excerpt, provenance.ts). Lower case, curly apostrophes made
 * straight, every run of anything but letters, digits and apostrophes one
 * space, trimmed.
 */
function normalizeWithOffsets(text: string): { text: string; at: number[] } {
  let out = ''
  const at: number[] = []
  for (let i = 0; i < text.length; ) {
    const ch = String.fromCodePoint(text.codePointAt(i) as number)
    for (const c of ch.toLowerCase().replace(/[’‘]/g, "'")) {
      if (QUOTE_WORD_CHAR.test(c)) {
        out += c
        at.push(i)
      } else if (out.length > 0 && !out.endsWith(' ')) {
        out += ' '
        at.push(i)
      }
    }
    i += ch.length
  }
  if (out.endsWith(' ')) {
    out = out.slice(0, -1)
    at.pop()
  }
  return { text: out, at }
}

/**
 * The label a capture's transcript opens each turn with: `[local_1]`,
 * `[remote_2]`, `[Me]` (a colon after it is punctuation, which normalising
 * drops anyway). It is the recorder's, not anyone's words.
 */
const SPEAKER_LABEL = /^[ \t]*\[[^\]\n]{1,40}\]/gm

/** Blank the speaker labels out, keeping every other character where it was. */
function withoutSpeakerLabels(transcript: string): string {
  return transcript.replace(SPEAKER_LABEL, (label) => ' '.repeat(label.length))
}

/** The transcript as a quote is matched against: speaker labels removed, then normalised. */
export function transcriptForQuote(transcript: string): string {
  return normalizeForQuote(withoutSpeakerLabels(transcript))
}

/**
 * A quote's pieces, split where its writer elided words ("...", ". . .", "…"),
 * each normalised; a piece under MIN_QUOTE_PIECE_CHARS is dropped. A quote
 * with no elision is one piece.
 */
export function quotePieces(quote: string): string[] {
  return quote
    .split(/(?:\.\s*){3,}|…/)
    .map(normalizeForQuote)
    .filter((piece) => piece.length >= MIN_QUOTE_PIECE_CHARS)
}

/**
 * Where every piece is found in the (normalised) transcript, each after the
 * one before it: from the first piece's start to the last piece's end. Null
 * when one is missing or out of order, or there are no pieces.
 */
export function matchPiecesInOrder(transcript: string, pieces: readonly string[]): { start: number; end: number } | null {
  if (pieces.length === 0) return null
  let start = -1
  let from = 0
  for (const piece of pieces) {
    const at = transcript.indexOf(piece, from)
    if (at < 0) return null
    if (start < 0) start = at
    from = at + piece.length
  }
  return { start, end: from }
}

/**
 * Where `quote` sits in `transcript`, matched exactly as the gate grounds it
 * (speaker labels aside, pieces in order), as offsets into the ORIGINAL
 * transcript: [start, end). Null when it does not match.
 */
export function locateQuote(transcript: string, quote: string): { start: number; end: number } | null {
  const norm = normalizeWithOffsets(withoutSpeakerLabels(transcript))
  const span = matchPiecesInOrder(norm.text, quotePieces(quote))
  if (!span) return null
  const last = norm.at[span.end - 1]
  return { start: norm.at[span.start], end: last + String.fromCodePoint(transcript.codePointAt(last) as number).length }
}
