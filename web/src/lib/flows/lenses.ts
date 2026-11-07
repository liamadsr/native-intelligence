/**
 * Lenses: every post-call feature reads the call through Triage's ONE read
 * (flows F3; eve-alignment.md §5b and §6 decision 6's amendment: "Triage is
 * the ONE post-call reader … every future post-call feature must be a lens,
 * not a new job").
 *
 * A lens flow is a capture_processed flow whose skill is lens-capable
 * (recipe.agent_config.lens, migration 382). It does not get a run of its
 * own. On each call, the dispatcher (lens-plan.ts) checks the lens's
 * condition deterministically; when it holds, the lens adds:
 *   - a prompt section to the Triage run's message, after the base prompt and
 *     the triage task, in a stable order (lens key, then flow), so the cached
 *     system prompt is untouched; and
 *   - a small output schema, the `lenses.<key>` part of Triage's verdict.
 * Triage reads the call once, and deterministic code (lens-deliver.ts) routes
 * each lens's section through its own connector. With Triage off, a lens flow
 * falls back to its own run of its skill, with the same section and schema.
 * Ten call flows still means one read of the call.
 *
 * Two lenses ship, both OFF unless a flow turns them on (§5b: capabilities,
 * not defaults). P8 and P9 build on them as recipes:
 *   content    post-worthy moments in the person's own words, from calls they
 *              were on → tags kept for the weekly post pass (lens_finding).
 *   marketing  objections, competitors, customer language, contradictions and
 *              testimonial candidates, on external calls only → section edits
 *              on the product doc (doc_proposals), at most one batch a day;
 *              testimonials stay internal (decision 8).
 *
 * Pure (no I/O): definitions, conditions, sections and validation.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { foldText, isOwnWords, publicSafeProblem, type OwnerSpeech } from '@/lib/content/public-safe'
import { gradeClaim } from '@/lib/marketing/grade'

export const LENS_KEYS = ['content', 'marketing'] as const
export type LensKey = (typeof LENS_KEYS)[number]

export function isLensKey(value: unknown): value is LensKey {
  return typeof value === 'string' && (LENS_KEYS as readonly string[]).includes(value)
}

/** What the dispatcher knows about the call, read once (lens-plan.ts). Serializable. */
export interface LensCallFacts {
  captureId: string
  captureTitle: string | null
  /** The member rows of workspace members who were on the call (its owner and member participants). */
  memberIdsOnCall: string[]
  /** People on the call from outside the workspace (a contact, an outside address). */
  external: boolean
  /**
   * The phrases no moment may name (src/lib/content/public-safe.ts
   * blockedPhrases, already folded): the non-members on the call and the CRM
   * contacts and companies linked to it, full names, last names and company
   * names.
   */
  outsideNames: string[]
}

/** One lens flow on one call: whose it is and which step names the lens. Serializable. */
export interface LensRide {
  flowId: string
  actionId: string
  lens: LensKey
  ownerUserId: string
  ownerMemberId: string
  ownerName: string | null
}

// ── The two lenses' output schemas ──────────────────────────────────────────

export const MAX_CONTENT_MOMENTS_PER_PERSON = 3
export const MAX_MARKETING_ITEMS = 6
const MAX_MOMENT_CHARS = 280
const MAX_THEME_CHARS = 60
const MAX_MARKETING_TEXT_CHARS = 300
const MAX_SPEAKER_CHARS = 80

export const MARKETING_ITEM_KINDS = ['objection', 'competitor', 'customer_language', 'contradiction', 'testimonial'] as const
export type MarketingItemKind = (typeof MARKETING_ITEM_KINDS)[number]

/*
 * The ADVERTISED lens schemas (F3 review S2): what the run's outputSchema
 * asks for. Every field is optional and `kind` is a plain string, so a
 * malformed lens item can never make the committed result fail eve's schema
 * check, and so never fail or retry the Triage verdict it rides on. The real
 * checks are in code, item by item (parseContentMoments, parseMarketingItems).
 */
export const contentLensSchema = z
  .object({
    moments: z
      .array(
        z.object({
          member_id: z.string().optional().describe('Whose moment: the member id the lens names.'),
          text: z.string().optional().describe('The moment in that person\'s own words, or a close paraphrase of what they said. At most 280 characters.'),
          theme: z.string().optional().describe('A few words: the theme it belongs to.'),
        }),
      )
      .optional(),
  })
  .describe('content lens: post-worthy moments. Leave it out when the call had none.')

export const marketingLensSchema = z
  .object({
    items: z
      .array(
        z.object({
          kind: z.string().optional().describe(`One of: ${MARKETING_ITEM_KINDS.join(', ')}.`),
          text: z.string().optional().describe('The line for the product doc, in our own words, never quoting them (for a testimonial: what it shows).'),
          quote: z.string().optional().describe('What the customer said, word for word (kept internal).'),
          speaker: z.string().optional().describe('Who said it, as the call names them.'),
        }),
      )
      .optional(),
  })
  .describe('marketing lens: what the customer side said. Leave it out when nothing is new.')

export const LENS_SCHEMAS = { content: contentLensSchema, marketing: marketingLensSchema } as const

/** A lens section's item list, whatever shape it came in: an array of objects, or null when it isn't one. Pure. */
function sectionItems(raw: unknown, field: string): Array<Record<string, unknown>> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const list = (raw as Record<string, unknown>)[field]
  if (list === undefined) return []
  if (!Array.isArray(list)) return null
  return list.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x))
}

// ── Conditions: deterministic, from the call's facts ─────────────────────────

/** Why a lens does not apply to this call, or null when it does. Pure. */
export function lensSkipReason(ride: Pick<LensRide, 'lens' | 'ownerMemberId'>, facts: LensCallFacts): string | null {
  switch (ride.lens) {
    case 'content':
      // The person's own words: only from a call they were on.
      return facts.memberIdsOnCall.includes(ride.ownerMemberId) ? null : "Skipped: this loop's owner wasn't on the call"
    case 'marketing':
      return facts.external ? null : 'Skipped: not an external call'
  }
}

/** Person lenses ride once per flow; a workspace lens once per workspace (its first flow, by id). */
export function lensScope(lens: LensKey): 'person' | 'workspace' {
  return lens === 'content' ? 'person' : 'workspace'
}

// ── The prompt sections ──────────────────────────────────────────────────────

/** Rides in stable order: lens key, then flow id. Pure. */
export function sortRides<T extends Pick<LensRide, 'lens' | 'flowId'>>(rides: readonly T[]): T[] {
  return [...rides].sort((a, b) => (a.lens === b.lens ? a.flowId.localeCompare(b.flowId) : LENS_KEYS.indexOf(a.lens) - LENS_KEYS.indexOf(b.lens)))
}

const LENS_INTRO = [
  '## Lenses',
  'Besides the triage, read this call through each lens below and fill `lenses.<key>` in your result. The lenses never change the triage: decide the proposals exactly as you would without them.',
  'For the lenses, read the call itself (get_capture_content, and get_capture_transcript when you need the exact words). A lens with nothing worth keeping is left out; that is a good outcome.',
].join('\n')

const CONTENT_SECTION = [
  '### Lens: content',
  'Post-worthy moments for the people named below, from what THEY said on this call: a lesson learned, a decision and why, a surprising result, a strong opinion, something they built.',
  `- At most ${MAX_CONTENT_MOMENTS_PER_PERSON} per person, each in their own words or a close paraphrase, at most 280 characters, with a few words of theme.`,
  "- Public-safe: never another speaker's words, never a name, company, customer, price or deal, nothing said in confidence.",
  '- Return `lenses.content.moments`: [{ member_id, text, theme }], with the member id exactly as given.',
].join('\n')

const MARKETING_SECTION = [
  '### Lens: marketing',
  'What the customer side of this call said (never our own pitch), for the product doc:',
  '- objection: a concern or reason not to buy that the doc should answer;',
  '- competitor: a product or "what we use today" they compared us with;',
  '- customer_language: a phrase they used for the problem or the product, worth reusing;',
  '- contradiction: something they said that the product doc gets wrong;',
  '- testimonial: a strong outcome in their words (stays internal).',
  `- At most ${MAX_MARKETING_ITEMS} items. Each with a line in our own words (\`text\`, never quoting them: only it can reach the product doc) and their exact words (\`quote\`, kept internal). Only what is new; nothing new means leave it out.`,
  '- Return `lenses.marketing.items`: [{ kind, text, quote, speaker }].',
].join('\n')

/** The people line a person lens names (who its moments are for). */
function peopleLine(rides: readonly LensRide[]): string {
  return `People: ${rides.map((r) => `${(r.ownerName ?? 'a member').replace(/[\r\n]+/g, ' ').slice(0, 60)} (member_id ${r.ownerMemberId})`).join('; ')}.`
}

/**
 * The lens block a run's message ends with: the intro, then each lens that
 * rides, in stable order. Empty when nothing rides. Pure.
 */
export function lensPromptBlock(rides: readonly LensRide[]): string {
  if (rides.length === 0) return ''
  const sorted = sortRides(rides)
  const sections: string[] = [LENS_INTRO]
  const content = sorted.filter((r) => r.lens === 'content')
  if (content.length) sections.push(`${CONTENT_SECTION}\n${peopleLine(content)}`)
  if (sorted.some((r) => r.lens === 'marketing')) sections.push(MARKETING_SECTION)
  return sections.join('\n\n')
}

/** The keys that ride, each once, in stable order. Pure. */
export function ridingLensKeys(rides: readonly Pick<LensRide, 'lens'>[]): LensKey[] {
  return LENS_KEYS.filter((k) => rides.some((r) => r.lens === k))
}

/** The `lenses` part of a verdict's outputSchema for the keys that ride. */
export function lensesOutputSchema(keys: readonly LensKey[]) {
  const shape: Record<string, z.ZodType> = {}
  for (const key of LENS_KEYS) if (keys.includes(key)) shape[key] = LENS_SCHEMAS[key].optional()
  return z.object(shape).describe('Your lens sections: one per lens named in the message, each left out when it found nothing.')
}

// ── Validation: refuse junk, item by item ────────────────────────────────────

export interface ContentMoment {
  text: string
  theme: string | null
}

export interface MarketingItem {
  kind: MarketingItemKind
  text: string
  quote: string
  speaker: string | null
}

export type ParsedLens<T> = { ok: true; items: T[]; refused: string[] } | { ok: false; error: string }


function clean(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const t = value.replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, max) : null
}

/**
 * One person's content moments from the raw section, screened in code (F3
 * review S3): public-safe (no outside name or company, no price or deal size,
 * no address or link) and the person's OWN words: most of a moment's content
 * words must be ones their own voice said on the call (`ownWords`, from their
 * speaker-labelled transcript lines). That also stops a guest's line being
 * filed as the owner's through a model-chosen member_id. `ownWords` null:
 * their lines can't be told apart, so no moment is kept. Pure.
 */
export function parseContentMoments(
  raw: unknown,
  ride: Pick<LensRide, 'ownerMemberId'>,
  facts: Pick<LensCallFacts, 'outsideNames'>,
  ownWords: OwnerSpeech | null,
): ParsedLens<ContentMoment> {
  const moments = sectionItems(raw, 'moments')
  if (!moments) return { ok: false, error: 'The content lens came back in the wrong shape.' }
  const items: ContentMoment[] = []
  const refused: string[] = []
  const seen = new Set<string>()
  for (const m of moments) {
    if (m.member_id !== ride.ownerMemberId) continue
    const text = typeof m.text === 'string' ? m.text.replace(/\s+/g, ' ').trim() : ''
    if (!text) continue
    if ([...text].length > MAX_MOMENT_CHARS) {
      refused.push('a moment longer than 280 characters')
      continue
    }
    const problem = publicSafeProblem(text, facts.outsideNames, { links: false })
    if (problem) {
      refused.push(`a moment that ${problem.reason}`)
      continue
    }
    if (!ownWords) {
      refused.push("a moment that couldn't be checked against your own lines on the call")
      continue
    }
    if (!isOwnWords(text, ownWords)) {
      refused.push("a moment that isn't in your own words on the call")
      continue
    }
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    if (items.length >= MAX_CONTENT_MOMENTS_PER_PERSON) {
      refused.push(`more than ${MAX_CONTENT_MOMENTS_PER_PERSON} moments`)
      continue
    }
    seen.add(key)
    items.push({ text, theme: clean(m.theme, MAX_THEME_CHARS) })
  }
  return { ok: true, items, refused: refused.slice(0, 10) }
}

/** Whether two texts share a run of `n` words, after folding (accents, case, punctuation). Pure. */
export function sharesWordRun(a: string, b: string, n: number): boolean {
  const runs = (t: string) => {
    const w = foldText(t).split(' ').filter(Boolean)
    const out = new Set<string>()
    for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' '))
    return out
  }
  const theirs = runs(b)
  for (const r of runs(a)) if (theirs.has(r)) return true
  return false
}

/** The marketing items from the raw section. Pure. */
export function parseMarketingItems(raw: unknown): ParsedLens<MarketingItem> {
  const list = sectionItems(raw, 'items')
  if (!list) return { ok: false, error: 'The marketing lens came back in the wrong shape.' }
  const items: MarketingItem[] = []
  const refused: string[] = []
  const seen = new Set<string>()
  for (const it of list) {
    const kind = typeof it.kind === 'string' ? it.kind.trim().toLowerCase() : ''
    if (!(MARKETING_ITEM_KINDS as readonly string[]).includes(kind)) {
      refused.push('an item of an unknown kind')
      continue
    }
    const k = kind as MarketingItemKind
    const text = clean(it.text, MAX_MARKETING_TEXT_CHARS + 1)
    const quote = clean(it.quote, MAX_MARKETING_TEXT_CHARS + 1)
    if (!text || !quote) {
      refused.push(`a ${k.replace('_', ' ')} with no line or no quote`)
      continue
    }
    if (text.length > MAX_MARKETING_TEXT_CHARS || quote.length > MAX_MARKETING_TEXT_CHARS) {
      refused.push(`a ${k.replace('_', ' ')} longer than ${MAX_MARKETING_TEXT_CHARS} characters`)
      continue
    }
    // Our words, not theirs (review B2): a line that repeats any 5-word run of
    // the quote would carry the guest's words into canon.
    if (sharesWordRun(text, quote, 5)) {
      refused.push(`a ${k.replace('_', ' ')} whose line repeats the customer's words`)
      continue
    }
    const key = `${k}:${quote.toLowerCase()}`
    if (seen.has(key)) continue
    if (items.length >= MAX_MARKETING_ITEMS) {
      refused.push(`more than ${MAX_MARKETING_ITEMS} items`)
      continue
    }
    seen.add(key)
    items.push({ kind: k, text, quote, speaker: clean(it.speaker, MAX_SPEAKER_CHARS) })
  }
  return { ok: true, items, refused: refused.slice(0, 10) }
}

// ── Marketing → the product doc ──────────────────────────────────────────────

/** Which product-doc section each kind lands in (the brand-context skeleton, canon.ts). Testimonials don't. */
export const MARKETING_SECTION_FOR: Record<Exclude<MarketingItemKind, 'testimonial'>, string> = {
  objection: 'Messaging',
  customer_language: 'Messaging',
  competitor: 'Positioning',
  contradiction: 'Open questions',
}

/**
 * Our own words for an item: its `text` with any quoted segment taken out, so
 * a guest's exact words never ride into the canon even inside our line (F3
 * review B2). Empty when nothing of ours is left. Pure.
 */
export function ourWords(text: string): string {
  return text
    .replace(/[“"][^“”"]*[”"]/g, ' ')
    .replace(/‘[^‘’']{12,}[’']/g, ' ')
    // A straight `'` is usually an apostrophe (don't, customers'): only a span
    // that opens after a space and closes before one is a quote. Apostrophes
    // inside a word stay part of the quoted span.
    .replace(/(^|[\s(\[])'(?:[^']|(?<=\w)'(?=\w)){12,}'(?=$|[\s,.;:!?)\]])/g, '$1 ')
    .replace(/\(\s*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:)])/g, '$1')
    .trim()
}

/**
 * The line a marketing item appends to its section: OUR words only (F3
 * review B2, a founder call for the morning). A guest on a recorded call can
 * say anything, and the product doc is what every agent reads as ground
 * truth, so their exact quote is never written into it: it stays on the
 * lens_finding row, which only the lens flow's owner reads. A contradiction
 * becomes an open question in our words. Null when nothing of ours is left.
 *
 * A line in a graded section (Messaging, Positioning: marketing M0) carries
 * the grade one call allows, gradeClaim of one outside company: an
 * assumption, until more calls or a published document back it and an edit
 * regrades it. Writers hedge on it. Pure.
 */
export function marketingLine(item: MarketingItem): string | null {
  // The grade is the code's, never the model's: a marker in the text is dropped.
  const text = ourWords(item.text).replace(/\s*\[(?:proven|plausible|assumption)\]/gi, '').trim()
  if (!text) return null
  const grade = `[${gradeClaim({ companies: 1, documents: 0, metrics: 0 })}]`
  switch (item.kind) {
    case 'objection':
      return `- Objection heard: ${text} ${grade}`
    case 'customer_language':
      return `- How customers put it: ${text} ${grade}`
    case 'competitor':
      return `- Compared with: ${text} ${grade}`
    default:
      return `- Open question: a customer's view doesn't match the doc: ${text}`
  }
}

/** A stable hash of an item's normalized text: lens_finding's dedupe key. Pure. */
export function lensItemHash(parts: readonly string[]): string {
  return createHash('sha256').update(parts.map((p) => p.replace(/\s+/g, ' ').trim().toLowerCase()).join('\u001f')).digest('hex').slice(0, 32)
}
