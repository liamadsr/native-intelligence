/**
 * A post draft as its For you card carries it (output connector `post_drafts`,
 * src/lib/flows/output-connectors.ts): a `question` card whose payload holds
 * `post_draft`. The person always approves (decision 2): nothing
 * publishes a post. The card's Post opens X's own compose page with the text
 * filled in, and the person's click there is the send; Copy puts the text on
 * the clipboard. Typefully posting comes later (P9), behind its own card.
 *
 * The same post link is what lint_post hands the chat (content C0): a draft in
 * the conversation ends with it, and nothing is posted until the person posts
 * it on the platform's own page.
 *
 * Pure and client-safe: the For you column, the full card and the server's
 * delivery read the same words.
 */
import { surfaceLength } from '@/lib/writing/lint'
import { writingSurface } from '@/lib/writing/surfaces'

/** Surfaces a post draft can be for: each a post surface in src/lib/writing/surfaces.ts with its own compose page. */
export const POST_SURFACES = ['x', 'linkedin', 'threads', 'bluesky'] as const
export type PostSurface = (typeof POST_SURFACES)[number]

export function isPostSurfaceId(value: unknown): value is PostSurface {
  return typeof value === 'string' && (POST_SURFACES as readonly string[]).includes(value)
}

/**
 * Each platform's own compose page; the text rides the `text` parameter and
 * the person posts it there. No API, no account link, no cost: their click on
 * the platform is the send.
 */
export const POST_INTENT_BASES: Readonly<Record<PostSurface, string>> = {
  x: 'https://x.com/intent/post',
  linkedin: 'https://www.linkedin.com/feed/?shareActive=true',
  threads: 'https://www.threads.net/intent/post',
  bluesky: 'https://bsky.app/intent/compose',
}

/** X's own compose page (kept for the X card and its tests). */
export const X_INTENT_BASE = POST_INTENT_BASES.x

/** The URL that opens a platform's compose page with `text` filled in. Pure. */
export function postIntentUrl(surface: PostSurface, text: string): string {
  const base = POST_INTENT_BASES[surface] ?? POST_INTENT_BASES.x
  return `${base}${base.includes('?') ? '&' : '?'}text=${encodeURIComponent(text)}`
}

/** The URL that opens X's compose page with `text` filled in. Pure. */
export function xIntentUrl(text: string): string {
  return postIntentUrl('x', text)
}

/** A post's length on its surface, the way the platform counts it (X: a link is 23). Pure. */
export function postLength(surface: PostSurface, text: string): number {
  return surfaceLength(text, surface)
}

/** A surface's character limit, or null. Pure. */
export function postLimit(surface: PostSurface): number | null {
  return writingSurface(surface)?.maxChars ?? null
}

/** One lint note the card shows ("Check: …"), from lintDraft's violations. */
export interface PostDraftNote {
  rule: string
  quote: string
  fix: string
}

/** The post draft a card's payload carries. */
export interface PostDraft {
  text: string
  surface: PostSurface
  /** Characters (code points), against the surface's limit. */
  chars: number
  limit: number | null
  /** One line: what it's based on (shipped work, a document, a theme from a call). */
  based_on: string | null
  /** The deterministic lint's notes (src/lib/writing/lint.ts). It informs, it never blocks. */
  notes: PostDraftNote[]
  /**
   * An idea, not grounded in this week's work (decision 3: a slow week is
   * never an empty week). The card says so; the person still posts it, or not.
   */
  idea: boolean
  /**
   * C2a (P9): the person had Typefully connected when the card was made, so
   * the card also offers "Post now" and "Add to queue" through it. Their click
   * is the approval (settle-card.ts); the connection is checked again then.
   */
  typefully: boolean
  /** C2a: the Typefully account it posts as ("@liam"), resolved when the card was made. */
  typefully_account: string | null
  /** That account's id, so the click posts as exactly it (never a guess). */
  typefully_account_id: string | number | null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/** The post draft on a card's payload, or null when the card isn't one. Pure. */
export function postDraftFromPayload(payload: unknown): PostDraft | null {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>
  const d = p.post_draft as Record<string, unknown> | undefined
  if (!d || typeof d !== 'object') return null
  const text = typeof d.text === 'string' ? d.text : ''
  if (!text.trim()) return null
  // An unknown or missing surface reads as X, the connector's default.
  const surface: PostSurface = isPostSurfaceId(d.surface) ? d.surface : 'x'
  const notes = Array.isArray(d.notes)
    ? (d.notes as unknown[]).flatMap((n) => {
        const r = (n && typeof n === 'object' ? n : {}) as Record<string, unknown>
        const quote = str(r.quote)
        const fix = str(r.fix)
        return quote && fix ? [{ rule: str(r.rule) ?? 'style', quote, fix }] : []
      })
    : []
  return {
    text,
    surface,
    chars: typeof d.chars === 'number' ? d.chars : postLength(surface, text),
    limit: typeof d.limit === 'number' ? d.limit : null,
    based_on: str(d.based_on),
    notes,
    idea: d.idea === true,
    typefully: d.typefully === true,
    typefully_account: str(d.typefully_account),
    typefully_account_id: typeof d.typefully_account_id === 'string' || typeof d.typefully_account_id === 'number' ? d.typefully_account_id : null,
  }
}

/** What a post card says: the For you column's verb and sentence, its details, the toast. */
export interface PostCardCopy {
  verb: string
  sentence: string
  details: string[]
  /** The toast once the person posts it. */
  done: string
}

/** The platform's own name, as the card says it. */
export const POST_SURFACE_NAME: Readonly<Record<PostSurface, string>> = { x: 'X', linkedin: 'LinkedIn', threads: 'Threads', bluesky: 'Bluesky' }
const SURFACE_NAME = POST_SURFACE_NAME

/** “text”, on one line, cut to `max` characters. Pure. */
function quotedLine(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return `“${t.length > max ? `${t.slice(0, max - 1)}…` : t}”`
}

/** A post card's words, or null for any other card. Pure. */
export function postCardCopy(payload: unknown): PostCardCopy | null {
  const draft = postDraftFromPayload(payload)
  if (!draft) return null
  const where = SURFACE_NAME[draft.surface]
  const count = draft.limit ? `${draft.chars}/${draft.limit} characters` : `${draft.chars} characters`
  // The whole text is the sentence (the column clamps it to two lines; the
  // focus view shows it once, in full: review N4), so the details don't repeat it.
  return {
    verb: 'Post',
    // An idea (a slow week) says so up front, never passing as this week's work.
    sentence: `${draft.idea ? 'an idea ' : ''}on ${where}: ${quotedLine(draft.text, 400)}`,
    details: [
      [count, draft.idea ? 'An idea, not this week’s work' : null, draft.based_on ? `Based on: ${draft.based_on}` : null].filter(Boolean).join(' · '),
      ...(draft.notes.length ? [`Check: ${draft.notes.map((n) => `“${n.quote}”: ${n.fix}`).join(' ')}`] : []),
      draft.typefully
        ? `Post opens ${where} with the text filled in. Post now and Add to queue go out through your Typefully, once, when you click.`
        : `Post opens ${where} in your browser with the text filled in; nothing is posted until you post it there.`,
    ],
    done: `Opened ${where} with your post`,
  }
}

/** A post card's title: "Post on X: “…”", or "Idea for X: “…”" for a slow week's idea. Pure. */
export function postCardTitle(text: string, surface: PostSurface, idea = false): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return `${idea ? 'Idea for' : 'Post on'} ${POST_SURFACE_NAME[surface] ?? 'X'}: “${line.length > 80 ? `${line.slice(0, 79)}…` : line}”`
}
