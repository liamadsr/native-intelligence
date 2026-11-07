/**
 * Writing surfaces: where a draft will be read, and that place's own limits on
 * top of the house rules (./rules.ts). lintDraft and the reviewer's prompt read
 * them.
 *
 * `email` and the four post surfaces (content C0, docs/plans/content-skill-set.md
 * §2 row 2 and §8: X, LinkedIn, Threads, Bluesky) ship here. One source of
 * truth: lint_post, the reviewer's rubric (content_review) and the post card's
 * character counter all read these entries. registerWritingSurface is the hook
 * for more: each registers its limits once at load, and every consumer sees
 * the same entry.
 *
 * The post limits and rules, with where they come from (plan §8, from the
 * Vercel typefully/content templates' sourced specs, 2026):
 *   X         280 characters for a standard account (the in-feed preview is
 *             ~280 even with Premium; aim for about 240-259). A URL counts as
 *             23 (t.co). 0-2 hashtags. A link cuts reach: last line, or the
 *             first reply.
 *   LinkedIn  3,000 characters; about 140 show on mobile before "see more",
 *             so the hook lives there.
 *   Threads   500 characters and one topic tag.
 *   Bluesky   300 graphemes; links are rich text and don't count.
 */
import {
  BARE_LINK_RULE_FULL,
  BARE_LINK_RULE_SHORT,
  HOUSE_WRITING_RULES_FULL,
  HOUSE_WRITING_RULES_SHORT,
  LINK_RULE_FULL,
  LINK_RULE_SHORT,
  POST_RULES_FULL,
  POST_RULES_SHORT,
} from './rules'

export interface WritingSurface {
  /** Stable id: rides the reviewer's token params and the stored quality record. */
  id: string
  /** What the reviewer is told the draft is ("a reply email"). */
  label: string
  /** One or two lines the writer and the reviewer both read. Optional. */
  notes?: string
  /** Hard length limit in characters (code points). Absent: no limit. */
  maxChars?: number
  /** Most hashtags allowed. Absent: no limit. */
  maxHashtags?: number
  /** Most links allowed. Absent: no limit. */
  maxLinks?: number
  /** Where links may go: anywhere (default), only on the last line, or nowhere. */
  linkPlacement?: 'anywhere' | 'end' | 'none'
  /**
   * How a link must be written. 'markdown' (default): [name](url) or a bare
   * URL, never HTML. 'bare': the bare URL only, for plain-text surfaces where
   * markdown shows as raw brackets.
   */
  linkStyle?: 'markdown' | 'bare'
  /** Fixed em-dash limit. Absent: the house limit (houseEmDashLimit). */
  maxEmDashes?: number
  /** 'post': a public post (the post rubric, the bait phrases, the public-safe screen). Absent: a private message. */
  kind?: 'post'
  /** How the length limit counts: code points (default) or graphemes (Bluesky). */
  countBy?: 'codepoints' | 'graphemes'
  /** Each URL counts as this many characters toward maxChars (X: 23; Bluesky: 0, links don't count). Absent: as written. */
  urlChars?: number
  /** Characters of the first line shown before "see more" (LinkedIn): a longer first line is a low note. */
  hookChars?: number
  /** Most parts in a thread; absent: no threads on this surface. */
  maxThreadParts?: number
}

const SURFACES = new Map<string, WritingSurface>()

/**
 * Add (or replace) a surface. Ids are lower-case words with `_` or `-`; a bad
 * entry throws at registration, so it fails at load, never mid-draft.
 */
export function registerWritingSurface(surface: WritingSurface): void {
  if (!/^[a-z][a-z0-9_-]{0,39}$/.test(surface.id)) throw new Error(`[writing] bad surface id: ${surface.id}`)
  for (const key of ['maxChars', 'maxHashtags', 'maxLinks', 'maxEmDashes', 'urlChars', 'hookChars', 'maxThreadParts'] as const) {
    const value = surface[key]
    if (value !== undefined && !(Number.isInteger(value) && value >= 0)) {
      throw new Error(`[writing] surface ${surface.id}: ${key} must be a whole number`)
    }
  }
  SURFACES.set(surface.id, Object.freeze({ ...surface }))
}

/** The surface registered under `id`, or undefined. */
export function writingSurface(id: string | null | undefined): WritingSurface | undefined {
  return typeof id === 'string' ? SURFACES.get(id) : undefined
}

/** Ids of every registered surface. */
export function writingSurfaceIds(): string[] {
  return [...SURFACES.keys()]
}

/**
 * Email drafts (replies and outreach). The body is plain text: the app turns
 * it into HTML line by line (plainTextToHtml), so a markdown link would arrive
 * as raw brackets. Hashtags never belong in an email.
 */
export const EMAIL_SURFACE: WritingSurface = {
  id: 'email',
  label: 'an email the person will send from their own mailbox',
  notes: 'Plain-text email: no markdown formatting and no hashtags.',
  maxHashtags: 0,
  linkStyle: 'bare',
}

registerWritingSurface(EMAIL_SURFACE)

/**
 * A post on X (output connector `post_drafts`, src/lib/flows/output-connectors.ts,
 * and lint_post in the chat). Plain text: X shows markdown as raw characters,
 * so a link is the bare URL, and only on the last line.
 */
export const X_SURFACE: WritingSurface = {
  id: 'x',
  label: 'a post on X the person will publish themselves',
  notes: 'Plain text for X: no markdown, no thread numbering. Aim for about 240-259 characters. A link cuts reach: put it on the last line, or say it goes in the first reply.',
  kind: 'post',
  maxChars: 280,
  urlChars: 23,
  maxHashtags: 2,
  maxLinks: 1,
  linkPlacement: 'end',
  linkStyle: 'bare',
  maxThreadParts: 10,
}

/** A LinkedIn post: long enough for a short story, with the hook in the first ~140 characters. */
export const LINKEDIN_SURFACE: WritingSurface = { // gitleaks:allow (not a client id)
  id: 'linkedin',
  label: 'a LinkedIn post the person will publish themselves',
  notes: 'Plain text for LinkedIn: short paragraphs with a blank line between them, no markdown. About 140 characters show before "see more": the hook goes there. Hashtags, if any, at the end.',
  kind: 'post',
  maxChars: 3_000,
  hookChars: 140,
  maxHashtags: 3,
  maxLinks: 1,
  linkPlacement: 'end',
  linkStyle: 'bare',
}

/** A post on Threads: conversational, one topic tag. */
export const THREADS_SURFACE: WritingSurface = {
  id: 'threads',
  label: 'a post on Threads the person will publish themselves',
  notes: 'Plain text for Threads: conversational, no markdown, one topic tag at most.',
  kind: 'post',
  maxChars: 500,
  maxHashtags: 1,
  maxLinks: 1,
  linkPlacement: 'end',
  linkStyle: 'bare',
  maxThreadParts: 10,
}

/** A post on Bluesky: 300 graphemes, and a link doesn't count toward them. */
export const BLUESKY_SURFACE: WritingSurface = {
  id: 'bluesky',
  label: 'a post on Bluesky the person will publish themselves',
  notes: "Plain text for Bluesky: no markdown. A link doesn't count toward the 300 characters. An image needs alt text.",
  kind: 'post',
  maxChars: 300,
  countBy: 'graphemes',
  urlChars: 0,
  maxHashtags: 2,
  maxLinks: 1,
  linkPlacement: 'end',
  linkStyle: 'bare',
  maxThreadParts: 10,
}

registerWritingSurface(X_SURFACE)
registerWritingSurface(LINKEDIN_SURFACE)
registerWritingSurface(THREADS_SURFACE)
registerWritingSurface(BLUESKY_SURFACE)

/** Whether a surface is a public post (the post rubric and the public-safe screen apply). Pure. */
export function isPostWritingSurface(id: string | null | undefined): boolean {
  return writingSurface(id)?.kind === 'post'
}

/**
 * The house rules for a surface, prompt-ready: the short lines for a writer's
 * system prompt, or the full rubric for the reviewer, each followed by the
 * surface's own notes and limits. A plain-text surface (linkStyle 'bare')
 * gets the bare-URL link rule IN PLACE of the markdown one, never both. A post
 * surface (kind 'post') also gets the post rules: the short lines for the
 * writer, the post rubric for the reviewer (content_review). An unknown
 * surface gets the house rules alone.
 */
export function writingRulesFor(surfaceId: string | null | undefined, size: 'short' | 'full'): string {
  const surface = writingSurface(surfaceId)
  let base = size === 'short' ? HOUSE_WRITING_RULES_SHORT : HOUSE_WRITING_RULES_FULL
  if (surface?.linkStyle === 'bare') {
    base = size === 'short'
      ? base.replace(LINK_RULE_SHORT, BARE_LINK_RULE_SHORT)
      : base.replace(LINK_RULE_FULL, BARE_LINK_RULE_FULL)
  }
  if (surface?.kind === 'post') base = `${base}\n\n${size === 'short' ? POST_RULES_SHORT : POST_RULES_FULL}`
  const extra = surface ? surfaceLines(surface) : []
  return extra.length > 0 ? `${base}\n${extra.map((line) => `- ${line}`).join('\n')}` : base
}

function surfaceLines(surface: WritingSurface): string[] {
  const lines: string[] = []
  if (surface.notes) lines.push(surface.notes)
  if (surface.maxChars !== undefined) lines.push(`At most ${surface.maxChars.toLocaleString('en-US')} characters${surface.countBy === 'graphemes' ? ' (graphemes)' : ''}.`)
  if (surface.urlChars !== undefined) lines.push(surface.urlChars === 0 ? "A link doesn't count toward the limit." : `A link counts as ${surface.urlChars} characters.`)
  if (surface.hookChars !== undefined) lines.push(`The first ${surface.hookChars} characters show before "see more".`)
  if (surface.maxHashtags !== undefined && surface.maxHashtags > 0) lines.push(`At most ${surface.maxHashtags} hashtag${surface.maxHashtags === 1 ? '' : 's'}.`)
  if (surface.maxLinks !== undefined) lines.push(`At most ${surface.maxLinks} link${surface.maxLinks === 1 ? '' : 's'}.`)
  if (surface.linkPlacement === 'end') lines.push('Links only on the last line.')
  if (surface.linkPlacement === 'none') lines.push('No links.')
  if (surface.maxEmDashes !== undefined) lines.push(`At most ${surface.maxEmDashes} em dash${surface.maxEmDashes === 1 ? '' : 'es'}.`)
  return lines
}
