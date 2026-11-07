/**
 * The deterministic check on one post draft (content C0; content-skill-set.md
 * §2 rows 2, 3 and 5, §4 "Public-safe"): what lint_post returns, and the floor
 * under review_post. No model call, and the same answer for the same input.
 *
 *   - lint: the house rules plus the surface's own (lintDraft), on every part
 *     of a thread, each against the surface's limit counted its way;
 *   - public-safe: the content screen (./public-safe.ts) over the whole text:
 *     the names a post never carries (the cited calls' outside people, their
 *     first names, the CRM's companies and contacts: post-sources.ts), and a
 *     price or a deal size unless the post cites the product doc or a
 *     document a person wrote (their own public pricing: then a note they
 *     see; P8 review S4); plus the problems its sources carry (a private
 *     call, an email, a row not in this workspace);
 *   - cited: a post rests on the person's own work, named in `sources` and
 *     found in this workspace (P10, the evidence boundary: never an unseen
 *     claim), or it is marked an idea (decision 3's slow-week ideas), which
 *     the person sees as such;
 *   - the post link: the platform's compose page with the text filled in,
 *     only when the screen passed and it cites something (or is an idea).
 *     The person's click there is the only thing that posts (decision 2).
 *
 * Pure and client-safe.
 */
import { lintDraft, surfaceLength, type LintViolation } from '@/lib/writing/lint'
import { writingSurface } from '@/lib/writing/surfaces'
import { POST_SURFACE_NAME, postIntentUrl, type PostSurface } from './post-draft'
import { MONEY_RE, namedPhrase, namedWord } from './public-safe'

/** One problem the public-safe screen found. */
export interface PublicSafeFinding {
  reason: string
  quote: string
}

export interface PostCheckInput {
  surface: PostSurface
  /** A single post, or the parts of a thread (in order). */
  parts: readonly string[]
  /** How many sources the draft names. */
  sourceCount: number
  /** Marked as an idea, not grounded in the person's recent work. */
  idea?: boolean
  /** Names to keep out of a public post, folded (multi-word names, the cited calls' last names). */
  blockedPhrases?: readonly string[]
  /** One-word names to keep out, matched as written (first names, one-word companies). */
  blockedWords?: readonly string[]
  /** Problems the sources themselves carry (post-sources.ts). */
  sourceProblems?: readonly PublicSafeFinding[]
  /** It cites the product doc or a document a person wrote: a price may be their own public pricing. */
  ownPricingSource?: boolean
}

export interface PostPartCheck {
  chars: number
  limit: number | null
  over: boolean
}

export interface PostLintNote {
  rule: string
  severity: LintViolation['severity']
  quote: string
  fix: string
  /** The thread part (1-based), for a thread. */
  part?: number
}

export interface PostCheck {
  surface: PostSurface
  platform: string
  /** Clean enough to show the person: no high or medium lint, public-safe, cited (or an idea), within the thread limit. */
  ok: boolean
  parts: PostPartCheck[]
  lint: PostLintNote[]
  public_safe: { ok: true } | { ok: false; problems: PublicSafeFinding[] }
  sources: { count: number; idea: boolean; unsourced: boolean }
  /** The compose page with the (first) post filled in; null until the screen passes. */
  post_link: string | null
  /** What to do next, in one line. */
  next: string
}

/** Most lint notes one check returns. */
const MAX_NOTES = 12

/** Check one post draft. See the module doc. Pure; never throws. */
export function checkPost(input: PostCheckInput): PostCheck {
  const surface = writingSurface(input.surface)
  const platform = POST_SURFACE_NAME[input.surface] ?? 'X'
  const parts = input.parts.map((p) => p.trim()).filter(Boolean)
  const limit = surface?.maxChars ?? null
  const thread = parts.length > 1
  const maxParts = surface?.maxThreadParts ?? 1

  const partChecks: PostPartCheck[] = parts.map((p) => {
    const chars = surfaceLength(p, surface)
    return { chars, limit, over: limit !== null && chars > limit }
  })

  const lint: PostLintNote[] = []
  parts.forEach((p, i) => {
    for (const v of lintDraft(p, { surface: input.surface }).violations) {
      lint.push({ rule: v.rule, severity: v.severity, quote: v.quote, fix: v.fix, ...(thread ? { part: i + 1 } : {}) })
    }
  })
  if (thread && parts.length > maxParts) {
    lint.unshift({
      rule: 'length',
      severity: 'high',
      quote: `${parts.length} parts`,
      fix: maxParts === 1 ? `${platform} posts here are single posts: one idea, one post` : `at most ${maxParts} parts in a thread`,
    })
  }
  const order = { high: 0, medium: 1, low: 2 } as const
  lint.sort((a, b) => order[a.severity] - order[b.severity])

  const problems: PublicSafeFinding[] = [...(input.sourceProblems ?? [])]
  const whole = parts.join('\n\n')
  const named = namedPhrase(whole, input.blockedPhrases ?? []) ?? namedWord(whole, input.blockedWords ?? [])
  if (named) problems.push({ reason: 'It names someone from outside the workspace; a public post never does.', quote: named })
  const found = MONEY_RE.exec(whole)
  // The whole amount for the quote ("$20", not the "$2" the screen stops at).
  const money = found ? [whole.slice(found.index).match(/^\S*?[\d.,]*\d[\d.,]*(?:\s?(?:k|m|bn|thousand|million|billion|usd|eur|gbp))?\b/i)?.[0] ?? found[0]] : null
  if (money) {
    // A price stands only on the person's own published pricing (the product
    // doc, or a document a person wrote): then a note they see. Anything else
    // may be a customer's price or a deal: never public.
    if (input.ownPricingSource) lint.push({ rule: 'public_safe', severity: 'low', quote: money[0].trim(), fix: 'a price or an amount: fine only if it is your own public pricing, never a customer’s or a deal' })
    else problems.push({ reason: 'It gives a price or an amount; a post may only state your own pricing, cited from the product doc or a document you wrote.', quote: money[0].trim() })
  }

  const idea = input.idea === true
  const unsourced = input.sourceCount === 0 && !idea
  const blocking = lint.some((n) => n.severity !== 'low')
  const ok = parts.length > 0 && !blocking && problems.length === 0 && !unsourced

  const post_link = parts.length > 0 && problems.length === 0 && !unsourced ? postIntentUrl(input.surface, parts[0]) : null
  const next = !parts.length
    ? 'The draft is empty.'
    : problems.length
      ? 'Fix what the public-safe screen found, then check it again. No post link until it passes.'
      : unsourced
        ? 'Name what it is based on in `sources` (an action, PR, document, call or this chat), or mark it `idea: true` and say so to the person.'
        : blocking
          ? 'Fix the high and medium notes, then check it again.'
          : thread
            ? `Show the person the thread with this link for the first part; they post the rest as replies on ${platform}.`
            : `Show the person the draft, what it is based on, and this link. Nothing posts until they post it on ${platform}.`

  return {
    surface: input.surface,
    platform,
    ok,
    parts: partChecks,
    lint: lint.slice(0, MAX_NOTES),
    public_safe: problems.length ? { ok: false, problems: problems.slice(0, 5) } : { ok: true },
    sources: { count: input.sourceCount, idea, unsourced },
    post_link,
    next,
  }
}
