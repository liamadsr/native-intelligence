/**
 * A Listen brief's words: the few sentences it says, built from the item's
 * facts with plain code, never a model (Liam, 2026-09-28: "I don't want to use
 * an llm for this feature"). Each builder (./builders/*) says its item its own
 * way; the helpers here keep them sounding alike: lists said the way people
 * say them ("Jessa, Jordan and 3 others"), small counts in words ("two
 * follow-ups"), a capture's notes read from their own summary section, and
 * never an email address read out.
 */

import { blockToSpeech, inlineToSpeech, parseSpeechBlocks, splitSentences, type SpeechBlock } from '@/lib/read-aloud/speech-text'

/** The sentences a brief says, in order. A sentence with no words is
 *  skipped, so a builder can say every fact it might have without branching. */
export class Speech {
  private readonly sentences: string[] = []

  /** One sentence from its parts, joined with spaces: capitalised, and ended
   *  with a period unless it already ends a sentence. */
  say(...parts: Array<string | null | undefined | false>): this {
    const text = withoutEmails(parts.filter((p): p is string => typeof p === 'string').join(' '))
      .replace(/\s+/g, ' ')
      .replace(/\s+([,.;:!?])/g, '$1')
      .trim()
    if (!/[\p{L}\p{N}]/u.test(text)) return this
    const capitalised = text[0].toUpperCase() + text.slice(1)
    this.sentences.push(/[.!?…]["'”’)]*$/.test(capitalised) ? capitalised : `${capitalised}.`)
    return this
  }

  /** Sentences as they are (the item's own words, already speakable), bar
   *  their email addresses. */
  sayAll(sentences: readonly string[]): this {
    for (const s of sentences) {
      const said = withoutEmails(s).replace(/\s+/g, ' ').trim()
      if (/[\p{L}\p{N}]/u.test(said)) this.sentences.push(said)
    }
    return this
  }

  get length(): number {
    return this.sentences.length
  }

  toArray(): string[] {
    return [...this.sentences]
  }
}

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']

/** "one", "two", … "ten", then digits (the voice reads those well enough). */
export function numberWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n)
}

/** "one follow-up", "two follow-ups", "12 follow-ups". */
export function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${numberWord(n)} ${n === 1 ? singular : plural}`
}

/** "Jessa", "Jessa and Jordan", "Jessa, Jordan and Sam", "Jessa, Jordan and 3
 *  others" (past `max`). Null for nothing. */
export function listOf(items: ReadonlyArray<string | null | undefined>, max = 3, others = 'others'): string | null {
  const kept = items.map((i) => i?.replace(/\s+/g, ' ').trim()).filter((i): i is string => !!i)
  if (kept.length === 0) return null
  if (kept.length > max) {
    // Past `max`, the last named place goes to "and N others" (N ≥ 2).
    return `${kept.slice(0, max - 1).join(', ')} and ${numberWord(kept.length - (max - 1))} ${others}`
  }
  if (kept.length === 1) return kept[0]
  return `${kept.slice(0, -1).join(', ')} and ${kept[kept.length - 1]}`
}

/** "Jessa Lin" → "Jessa". */
export function firstName(name: string | null | undefined): string | null {
  return name?.trim().split(/\s+/)[0] || null
}

/** A title or a line of text as a clause inside a sentence: whitespace
 *  collapsed, markdown dropped, its own end punctuation removed. */
export function clause(text: string | null | undefined): string | null {
  const plain = inlineToSpeech(text ?? '').replace(/\s+/g, ' ').trim()
  return plain.replace(/[.;:!?]+$/, '') || null
}

/** A person with no name, from their address: "jordan.lee+x@acme.com" →
 *  "Jordan Lee" (never "jordan dot lee"). Null without an address. */
export function nameFromEmail(address: string | null | undefined): string | null {
  const local = address?.split('@')[0]?.split('+')[0]?.trim()
  if (!local) return null
  const words = local.split(/[._-]+/).filter((w) => /\p{L}/u.test(w))
  return words.length ? words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') : local
}

/** An email address in running text: "jessa@gmail.com", "mailto:jordan.lee@acme.co.uk". */
const EMAIL = String.raw`(?:mailto:)?[\p{L}\p{N}._%+'-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}`
const EMAIL_IN_BRACKETS = new RegExp(String.raw`\s*[(<[]\s*${EMAIL}\s*[)>\]]`, 'gu')
const EMAIL_ANYWHERE = new RegExp(EMAIL, 'gu')

/**
 * Text with no email address read out (Liam, 2026-09-28: a brief shouldn't
 * read "people's emails like @gmail.com"). One in brackets after a name
 * ("Jessa Lin <jessa@acme.com>") goes; any other is said as the name in it:
 * "with jessa.lin@gmail.com" → "with Jessa Lin".
 */
export function withoutEmails(text: string): string {
  return text
    .replace(EMAIL_IN_BRACKETS, '')
    .replace(EMAIL_ANYWHERE, (address) => nameFromEmail(address.replace(/^mailto:/i, '')) ?? '')
}

/** "Jessa Lin, Head of Ops at Acme", "Jessa Lin from Acme", "Jessa Lin, Head of
 *  Ops", "Jessa Lin". Null without a name. */
export function personLine(
  name: string | null | undefined,
  role?: string | null,
  company?: string | null,
): string | null {
  const who = clause(name)
  if (!who) return null
  const r = clause(role)
  const c = clause(company)
  if (r && c) return `${who}, ${r} at ${c}`
  if (r) return `${who}, ${r}`
  if (c) return `${who} from ${c}`
  return who
}

/** Whose it is: "assigned to you", "assigned to Jordan Lee". */
export function assignedTo(owner: string | null | undefined): string | null {
  if (!owner) return null
  return `assigned to ${owner === 'the user' ? 'you' : owner}`
}

// ── A capture's notes ────────────────────────────────────────────────────────

/** How a notes section that sums the meeting up is titled. */
const SUMMARY_TITLE = /^(?:meeting |executive |quick )?(?:summary|overview|tl;? ?dr|recap)\b/i

/** A line of nothing but bold text: "**Summary**", "**Next steps:**". */
const LEAD_IN = /^\s*(?:\*\*|__)([^*_]{1,80})(?:\*\*|__)\s*:?\s*$/

/** A block that starts a section: a heading, or a bold lead-in line, as the
 *  section play buttons read anchors (@/lib/read-aloud/sections). Its title,
 *  or null. */
function anchorTitle(block: SpeechBlock): string | null {
  if (block.kind === 'heading') return inlineToSpeech(block.lines.join(' ')) || null
  if (block.kind !== 'text' || block.lines.length !== 1) return null
  return LEAD_IN.exec(block.lines[0])?.[1].trim() ?? null
}

/** A paragraph with lead-in lines in it, the text running straight on with
 *  no blank lines ("**Summary**", its text, "**Next steps**", …): each lead-in
 *  a block of its own, so it starts a section like one set apart. */
function splitLeadIns(blocks: SpeechBlock[]): SpeechBlock[] {
  return blocks.flatMap((b) => {
    if (b.kind !== 'text' || b.lines.length < 2 || !b.lines.some((l) => LEAD_IN.test(l))) return [b]
    const out: SpeechBlock[] = []
    let run: string[] = []
    const flush = () => {
      if (run.length) out.push({ kind: 'text', lines: run })
      run = []
    }
    for (const line of b.lines) {
      if (!LEAD_IN.test(line)) {
        run.push(line)
        continue
      }
      flush()
      out.push({ kind: 'text', lines: [line] })
    }
    flush()
    return out
  })
}

/**
 * The summary at the top of a capture's notes, as sentences (Liam: "captures
 * usually start with a summary section at the top, we should read that"): the
 * section under the first "Summary" (or "Overview", "TL;DR", "Recap") heading
 * or bold lead-in, up to the next one; else whatever comes before the notes'
 * first heading; else their first section. At most `maxSentences`.
 */
export function notesSummary(markdown: string | null | undefined, maxSentences = 8): string[] {
  const blocks = splitLeadIns(parseSpeechBlocks((markdown ?? '').replace(/<!--[\s\S]*?-->/g, '')))
  const titles = blocks.map(anchorTitle)
  const nextAnchor = (from: number) => {
    const i = titles.findIndex((t, at) => at >= from && t !== null)
    return i < 0 ? blocks.length : i
  }

  const summary = titles.findIndex((t) => t !== null && SUMMARY_TITLE.test(t))
  let body: SpeechBlock[]
  if (summary >= 0) body = blocks.slice(summary + 1, nextAnchor(summary + 1))
  else if (titles[0] === null) body = blocks.slice(0, nextAnchor(0))
  else body = blocks.slice(1, nextAnchor(1))

  return body.flatMap((b) => splitSentences(blockToSpeech(b))).slice(0, maxSentences)
}

// ── Rows ─────────────────────────────────────────────────────────────────────

/** Supabase embeds a to-one relation as an object or a one-item array. */
export type OneOrMany<T> = T | T[] | null

export function one<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null)
}

/** A non-empty string from a loose value (a jsonb field), else null. */
export function stringOr(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}
