/**
 * The public-safe screen in code (F3 review S3; content-skill-set.md "Source
 * rules (code, not prompt)"): what a post-worthy moment or a post draft must
 * never carry, checked deterministically before it is kept or carded.
 *
 *   - another person's or company's name: the people on the call who aren't
 *     workspace members, the CRM contacts and companies linked to it. A full
 *     name or a last name, a company's full name, each matched as whole words
 *     after folding accents (NFKD) and case, with a company's leading "the"
 *     and legal suffix dropped. Never split into short words: "The Browser
 *     Company" must not block "the". Diarization labels ("Speaker 2",
 *     "Guest", "remote_1") are not names;
 *   - a price or a deal size: a currency sign or word with a number, or a
 *     number with k / m / bn / thousand / million / billion;
 *   - an email address or a link (moments only: a post may end on a link).
 * And a moment must be the person's OWN words: matched within one of their
 * own utterances, or sharing most of its word pairs with their own lines
 * (isOwnWords).
 *
 * Pure and client-safe.
 */

/** Fold for matching: accents off (NFKD), lower case, every non-letter-or-digit run one space. Pure. */
export function foldText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** A diarization label, not a name. */
const DIARIZATION_LABEL = /^(speaker|guest|unknown|participant|person|attendee|remote|local|caller|host|user)(\s*\d+)?$/i

/** A company's leading article and trailing legal suffixes. */
const COMPANY_LEAD = /^(the)\s+/
const COMPANY_SUFFIX = /\s+(inc|incorporated|llc|ltd|limited|corp|corporation|co|gmbh|sa|plc|ag|bv|pty|srl)$/

/** Words too common to block alone (a last name like "Will" or "May"). */
const COMMON_WORDS: ReadonlySet<string> = new Set(['the', 'and', 'for', 'with', 'from', 'you', 'all', 'will', 'may', 'can', 'new', 'one', 'our', 'your', 'team', 'call', 'meeting'])

/**
 * A company's name as screens and counts compare it: folded, its leading
 * "the" and trailing legal suffix dropped ("The Acme Corp." → "acme"). Pure.
 */
export function foldCompanyName(name: string | null | undefined): string {
  return foldText(name ?? '').replace(COMPANY_LEAD, '').replace(COMPANY_SUFFIX, '').trim()
}

/**
 * The phrases a screen blocks, folded: each person's full name and last name,
 * each company's full name. Labels and blanks are dropped. `lastNames: false`
 * keeps full names only (a whole CRM's last names would block ordinary
 * words); `max` caps the list (default 200). Pure.
 */
export function blockedPhrases(
  input: { people?: ReadonlyArray<{ full?: string | null; last?: string | null }>; companies?: ReadonlyArray<string | null> },
  opts: { lastNames?: boolean; max?: number } = {},
): string[] {
  const out = new Set<string>()
  const add = (raw: string | null | undefined, opts: { single?: boolean } = {}) => {
    if (!raw) return
    const trimmed = raw.trim()
    if (!trimmed || DIARIZATION_LABEL.test(trimmed) || /^\[?(local|remote)_\d+\]?$/i.test(trimmed)) return
    const folded = foldText(trimmed)
    if (!folded) return
    // A one-word phrase must be a real word: 3+ letters, not a common one.
    if (!folded.includes(' ') && (folded.length < 3 || COMMON_WORDS.has(folded))) return
    if (opts.single && folded.includes(' ')) return
    out.add(folded)
  }
  for (const p of input.people ?? []) {
    add(p.full)
    if (opts.lastNames === false) continue
    const last = p.last ?? (p.full && p.full.trim().split(/\s+/).length > 1 ? p.full.trim().split(/\s+/).pop() : null)
    add(last, { single: true })
  }
  for (const c of input.companies ?? []) {
    if (!c) continue
    const folded = foldCompanyName(c)
    if (folded) add(folded)
  }
  return [...out].slice(0, opts.max ?? 200)
}

/** The first blocked phrase the text names, as whole words, or null. Pure. */
export function namedPhrase(text: string, phrases: readonly string[]): string | null {
  const hay = ` ${foldText(text)} `
  for (const p of phrases) if (p && hay.includes(` ${p} `)) return p
  return null
}

/**
 * One-word names matched as written (P8 review S3): a first name ("Priya"),
 * or a one-word company from the CRM ("Linear"). Folded, they would block
 * ordinary words ("linear progress"), so they match only capitalized, exactly
 * as the name is spelled. Keeps capitalized single words of 3+ letters that
 * aren't a diarization label or a common word. Pure.
 */
export function capitalizedNames(names: ReadonlyArray<string | null | undefined>, max = 1_000): string[] {
  const out = new Set<string>()
  for (const raw of names) {
    const word = (raw ?? '').trim()
    if (!word || /\s/.test(word) || word.length < 3) continue
    if (!/^\p{Lu}/u.test(word) || DIARIZATION_LABEL.test(word) || COMMON_WORDS.has(word.toLowerCase())) continue
    out.add(word)
    if (out.size >= max) break
  }
  return [...out]
}

/** The first of `names` the text writes as a whole word, case and all, or null. Linear in the text. Pure. */
export function namedWord(text: string, names: readonly string[]): string | null {
  if (!names.length) return null
  const set = new Set(names)
  for (const m of text.normalize('NFC').matchAll(/[\p{L}\p{N}_]+/gu)) if (set.has(m[0])) return m[0]
  return null
}

/** A price or a deal size. */
export const MONEY_RE = /[$€£¥₹]\s?\d|\b\d[\d,.]*\s?(k|m|mm|bn|b|thousand|million|billion)\b|\b\d[\d,.]*\s?(usd|eur|gbp|dollars?|euros?|pounds?|bucks)\b|\b(usd|eur|gbp)\s?\d/i

/** An email address or a link. */
export const ADDRESS_OR_LINK_RE = /[^\s@]+@[^\s@]+\.[a-z]{2,}|https?:\/\/|www\./i

/** Why the text isn't public-safe, or null. `links` false: a link is a problem too (a moment). Pure. */
export function publicSafeProblem(text: string, phrases: readonly string[], opts: { links: boolean }): { reason: string; quote: string } | null {
  const named = namedPhrase(text, phrases)
  if (named) return { reason: 'names someone from outside the workspace', quote: named }
  const money = MONEY_RE.exec(text)
  if (money) return { reason: 'gives a price or a deal size', quote: money[0].trim() }
  if (!opts.links) {
    const address = ADDRESS_OR_LINK_RE.exec(text)
    if (address) return { reason: 'has an address or a link in it', quote: address[0] }
  }
  return null
}

/** Words that carry no meaning on their own (for the own-words check). */
const STOPWORDS: ReadonlySet<string> = new Set(
  'the a an and or but if of to in on at for with from by as is are was were be been being it its this that these those i we you he she they them our your my me us so do did does not no yes just really very can could would should will about into out up down over then than there here what which who when where why how all any some more most much many also too only own same such'.split(
    ' ',
  ),
)

/** The content words of a text (folded, 3+ letters, no stopwords). Pure. */
export function contentWords(text: string): string[] {
  return foldText(text)
    .split(' ')
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
}

/**
 * What a person said on a call: each of their utterances (a turn under their
 * voice's label) as its content words, in order. Built by lens-plan.ts
 * loadOwnerSpeech from their own speaker-labelled transcript lines.
 */
export interface OwnerSpeech {
  utterances: string[][]
}

/** A moment counts as one utterance's words at this share. */
export const MIN_UTTERANCE_SHARE = 0.6
/** A moment counts as the person's phrasing at this share of its word pairs. */
export const MIN_BIGRAM_SHARE = 0.5

const pairsOf = (words: readonly string[]) => words.slice(1).map((w, i) => `${words[i]} ${w}`)

/**
 * Whether a moment is the person's own words (F3 review R3): most of its
 * content words come from ONE of their utterances, or at least half of its
 * content-word pairs appear as pairs in their own lines. Scattered words
 * pulled from across a call don't pass either. A moment with fewer than 3
 * content words never does. Pure.
 */
export function isOwnWords(text: string, speech: OwnerSpeech): boolean {
  const words = contentWords(text)
  if (words.length < 3) return false
  for (const u of speech.utterances) {
    const set = new Set(u)
    if (words.filter((w) => set.has(w)).length / words.length >= MIN_UTTERANCE_SHARE) return true
  }
  const ownPairs = new Set(speech.utterances.flatMap(pairsOf))
  const pairs = pairsOf(words)
  return pairs.length > 0 && pairs.filter((p) => ownPairs.has(p)).length / pairs.length >= MIN_BIGRAM_SHARE
}
