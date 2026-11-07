/**
 * The evidence rule (always-on plan decision 3, A2 review): what the person
 * TELLS the agent saves; everything else is a proposal. "Told" is checked, not
 * claimed. A fact (a remembered profile fact, a capture-pass stated item, a
 * replacement or a removal) carries a quote of the person's own words, and it
 * counts only when the quote
 *   1. appears in one of the person's messages (never the assistant's, never a
 *      tool's result, which is where injected text lives); and
 *   2. is RELEVANT: at least EVIDENCE_MIN_WORDS words, and at least
 *      EVIDENCE_RELEVANCE (60%) of the fact's content words appear among the
 *      quote's words. A real but unrelated quote ("can you read my latest
 *      email") never verifies an injected fact ("sign replies as CEO").
 *
 * Normalisation: Unicode NFKC, lower-cased, whitespace runs as one space,
 * trimmed. Words: runs of letters or digits, a trailing plural "s" dropped
 * (answers → answer). Content words: words of 3+ letters not in STOPWORDS.
 *
 * TWIN: agents/chat-agent/lib/evidence.ts holds the same code (the eve
 * runtime cannot import the app); a drift test compares every function's
 * source, so there is one normaliser in two places.
 */

export const EVIDENCE_MIN_CHARS = 8
export const EVIDENCE_MIN_WORDS = 3
export const EVIDENCE_RELEVANCE = 0.6
export const REMOVAL_RELEVANCE = 0.5

export const STOPWORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'these', 'those', 'from', 'have', 'has', 'had', 'are', 'was', 'were', 'been', 'being',
  'you', 'your', 'yours', 'they', 'them', 'their', 'his', 'her', 'hers', 'she', 'him', 'our', 'ours', 'its', 'not', 'but', 'all',
  'any', 'can', 'will', 'would', 'should', 'could', 'about', 'into', 'over', 'also', 'just', 'very', 'more', 'most', 'some', 'such',
  'than', 'then', 'there', 'here', 'what', 'when', 'where', 'which', 'who', 'whom', 'why', 'how', 'only', 'own', 'same', 'too',
  'person', 'user', 'prefer', 'prefers', 'preferred', 'like', 'likes', 'want', 'wants', 'please', 'does', 'did', 'doing', 'get',
  'gets', 'got', 'let', 'make', 'makes', 'one', 'each', 'every', 'thing', 'things', 'way', 'really', 'always',
])

export function normalizeEvidenceText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
}

/** A text's words, normalised, a trailing plural "s" dropped. */
export function evidenceWords(text: string): string[] {
  return normalizeEvidenceText(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0)
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
}

/** A fact's content words: words of 3+ letters, not stopwords, once each. */
export function contentWords(text: string): string[] {
  const out: string[] = []
  for (const w of evidenceWords(text)) {
    if ((w.match(/\p{L}/gu) ?? []).length < 3 || STOPWORDS.has(w) || out.includes(w)) continue
    out.push(w)
  }
  return out
}

/** Whether `quote` appears in one of `personTexts` (the person's messages only). Pure. */
export function evidenceFoundIn(quote: unknown, personTexts: readonly string[]): boolean {
  if (typeof quote !== 'string') return false
  const q = normalizeEvidenceText(quote)
  if (q.length < EVIDENCE_MIN_CHARS) return false
  return personTexts.some((t) => normalizeEvidenceText(t).includes(q))
}

/** Whether `quote` states `fact`: 3+ words, and at least `share` of the fact's content words among them. Pure. */
export function evidenceRelevant(quote: unknown, fact: string, share: number = EVIDENCE_RELEVANCE): boolean {
  if (typeof quote !== 'string') return false
  const words = evidenceWords(quote)
  if (words.length < EVIDENCE_MIN_WORDS) return false
  const content = contentWords(fact)
  if (content.length === 0) return false
  const said = new Set(words)
  return content.filter((w) => said.has(w)).length / content.length >= share
}

/** The whole rule: found in the person's messages AND relevant to the fact. Pure. */
export function evidenceVerified(quote: unknown, fact: string, personTexts: readonly string[], share: number = EVIDENCE_RELEVANCE): boolean {
  return evidenceFoundIn(quote, personTexts) && evidenceRelevant(quote, fact, share)
}
