/**
 * An edition's words, read (manifest.ts `EditionWords`): what this workspace
 * calls a thing, what its pages are named, and the section of the agent's
 * prompt that tells it to say them.
 *
 * Every consumer reads words through here, never the manifest field, so an
 * edition that says nothing (`APP_WORDS`) is the app's own words by
 * construction: no rename, no prompt section.
 *
 * The business's own word for a booking (a rug cleaner's "pickup", a
 * plumber's "visit") lives on its business profile (roadmap track B,
 * `business_profile.booking_kind`), so it is an input here, not manifest data:
 * once a caller has the profile it passes `{ bookingKind }`, and the word wins
 * in an edition that names bookings at all.
 *
 * Pure and client-safe.
 */
import {
  APP_TERMS,
  APP_WORDS,
  type EditionDefinition,
  type EditionTerm,
  type EditionView,
  type EditionWords,
  type PageWords,
  type TermWords,
} from './manifest'

/** What the business itself calls things, from its profile (track B). */
export interface BusinessWords {
  /** `business_profile.booking_kind`: "pickup", "visit", "walk". */
  bookingKind?: string | null
}

/** The prompt section's key (STABLE_SECTION_KEYS in src/lib/ai/chat-system-prompt.ts). */
export const EDITION_WORDS_SECTION_KEY = 'words'

/** The edition's words, or the app's own for a definition that predates them. */
export function editionWords(edition: Pick<EditionDefinition, 'words'> | null | undefined): EditionWords {
  return edition?.words ?? APP_WORDS
}

/**
 * A booking word a business gave, made safe for a label and the prompt: at
 * most three plain words ("pickup", "dog walk"), else null. It reaches the
 * prompt quoted, as the business's own word, never as an instruction.
 */
export function cleanBookingKind(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const word = raw.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!word || word.length > 30 || !/^[a-z][a-z'-]*( [a-z][a-z'-]*){0,2}$/.test(word)) return null
  return word
}

/** "pickup" → "pickups", "delivery" → "deliveries", "brush" → "brushes". English nouns, the common rules. */
export function pluralWord(word: string): string {
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`
  if (/(s|x|z|ch|sh)$/.test(word)) return `${word}es`
  return `${word}s`
}

/**
 * A term in this edition: the edition's word, else the app's. A business's
 * booking word wins where the edition names bookings (it would be the
 * business's own word for an app word the edition never shows otherwise).
 */
export function termWords(
  edition: Pick<EditionDefinition, 'words'> | null | undefined,
  term: EditionTerm,
  business?: BusinessWords,
): TermWords {
  const own = editionWords(edition).terms[term]
  if (term === 'booking' && own) {
    const kind = cleanBookingKind(business?.bookingKind)
    if (kind) return { one: kind, many: pluralWord(kind) }
  }
  return own ?? APP_TERMS[term]
}

/** "1 job", "12 jobs". */
export function countTerm(edition: Pick<EditionDefinition, 'words'> | null | undefined, term: EditionTerm, count: number): string {
  const { one, many } = termWords(edition, term)
  return `${count} ${count === 1 ? one : many}`
}

/** A page's name in this edition: its words, else `fallback` (the app's own name and line). */
export function pageWords(edition: Pick<EditionDefinition, 'words'> | null | undefined, view: EditionView | undefined, fallback: PageWords): PageWords {
  const own = view ? editionWords(edition).pages[view] : undefined
  if (!own) return fallback
  return { label: own.label, description: own.description ?? fallback.description, slug: own.slug ?? fallback.slug }
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? 'an' : 'a'
}

/** The terms the agent is told about, in APP_TERMS order: each one the edition says differently, or explains. */
function translatedTerms(edition: Pick<EditionDefinition, 'words'>, business?: BusinessWords): string[] {
  const lines: string[] = []
  for (const term of Object.keys(APP_TERMS) as EditionTerm[]) {
    if (!editionWords(edition).terms[term]) continue
    const app = APP_TERMS[term]
    const own = termWords(edition, term, business)
    // The business's word (its profile's), quoted: data, not a rule. Every
    // profile has one (the column defaults to "pickup"), and it is the word
    // the business's booking page shows its customers, so the agent says the
    // same, and follows the owner's own word when it differs.
    if (term === 'booking' && cleanBookingKind(business?.bookingKind)) {
      lines.push(`- ${article(app.one)} ${app.one} is a “${own.one}” (the word the business’s booking page uses; if they call it something else, use theirs)`)
      continue
    }
    const same = own.one === app.one
    if (same && !own.note) continue
    lines.push(
      same
        ? `- ${article(app.one)} ${app.one} is ${own.note}`
        : `- ${article(app.one)} ${app.one} is ${article(own.one)} ${own.one}${own.note ? ` (${own.note})` : ''}`,
    )
  }
  return lines
}

/**
 * The agent's words section: who the workspace is, and the owner's words for
 * the app's. `null` for an edition that says nothing, so the prompt is today's
 * byte for byte. Rides every prompt that speaks to the person (the chat, its
 * texts and calls, a helper's run), never a tool's description: the tools keep
 * the app's names in every edition. Pure.
 */
export function renderEditionWordsSection(edition: Pick<EditionDefinition, 'words'>, business?: BusinessWords): string | null {
  const words = editionWords(edition)
  const terms = translatedTerms(edition, business)
  if (!words.agentLead && terms.length === 0 && words.avoid.length === 0) return null
  const lines = ['## Words to use']
  if (words.agentLead) lines.push(words.agentLead)
  lines.push(
    'Speak to them in their words: in the chat, in texts, on calls, and in anything you write for them or their customers. ' +
      'The app’s own names (in these instructions, tool names and tool results) stay as they are; translate when you speak.',
  )
  lines.push(...terms)
  if (words.avoid.length > 0) {
    lines.push(`Keep these out of what you say unless they use them first: ${words.avoid.join(', ')}.`)
  }
  return lines.join('\n')
}
