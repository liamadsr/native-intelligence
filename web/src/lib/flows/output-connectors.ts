/**
 * Output connectors (F3: docs/plans/flows-connectors.md §2.4, eve-alignment.md
 * §5b): where a flow step's output goes. A run_skill step names one in
 * `deliver.to`; P7's `call_tool` step reuses the same set, schemas and
 * delivery (deliver-connector.ts), so a tool's result can land in the same
 * places.
 *
 *   document       today's report, with a settable title (F1's document_title).
 *   notification   the run's notice alone, no document.
 *   post_drafts    For you post cards. The person ALWAYS approves (decision 2):
 *                  nothing here ever publishes. Post opens X's own compose page.
 *   doc_proposals  section edits on one named canon document (P4's section
 *                  edits): applied with one digest line per document per day,
 *                  labelled so when the run read outside text (never a card).
 *   email_drafts   the existing draft path (the review pile). Never sent.
 *
 * The three structured connectors make the skill return a small typed output
 * (the eve session's outputSchema, below) instead of prose. The model never
 * delivers anything itself: deterministic code validates the output here
 * (parseConnectorOutput: junk refused, item by item, with a reason) and
 * delivers it (deliver-connector.ts). The destination is the flow's config,
 * never the model's: a run can't pick which document it edits, which surface
 * it posts to, or that it sends anything.
 *
 * Pure (no I/O), so every rule is unit-testable.
 */
import { z } from 'zod'
import { lintDraft } from '@/lib/writing/lint'
import { writingRulesFor, writingSurface } from '@/lib/writing/surfaces'
import { isNoReplyAddress } from '@/lib/email/reply-policy'
import { normalizeCanonKey } from '@/lib/documents/canon'
import { namedPhrase, namedWord, publicSafeProblem } from '@/lib/content/public-safe'
import { POST_SURFACES, POST_SURFACE_NAME, postLength, type PostDraftNote, type PostSurface } from '@/lib/content/post-draft'

export { POST_SURFACES, type PostSurface }

export const OUTPUT_CONNECTORS = ['document', 'notification', 'post_drafts', 'doc_proposals', 'email_drafts'] as const
export type OutputConnector = (typeof OUTPUT_CONNECTORS)[number]

/** The connectors whose skill returns a typed output instead of prose. */
export const STRUCTURED_CONNECTORS = ['post_drafts', 'doc_proposals', 'email_drafts'] as const
export type StructuredConnector = (typeof STRUCTURED_CONNECTORS)[number]

export function isOutputConnector(value: unknown): value is OutputConnector {
  return typeof value === 'string' && (OUTPUT_CONNECTORS as readonly string[]).includes(value)
}

export function isStructuredConnector(value: unknown): value is StructuredConnector {
  return typeof value === 'string' && (STRUCTURED_CONNECTORS as readonly string[]).includes(value)
}

export function isPostSurface(value: unknown): value is PostSurface {
  return typeof value === 'string' && (POST_SURFACES as readonly string[]).includes(value)
}

// ── Budgets (deterministic, never the model's) ───────────────────────────────

/** Post drafts one run may deliver, by default. */
export const MAX_POST_DRAFTS_PER_RUN = 3
/** The most a weekly post pass may ask for (its `slots`, P9: post-week.ts MAX_POST_SLOTS). */
export const MAX_POST_DRAFTS_CEILING = 5
/** Post cards waiting on one person at once (decision 3: "at most 3 open"). */
export const MAX_OPEN_POST_DRAFTS = 3
/** Section edits one run may deliver to its document. */
export const MAX_DOC_EDITS_PER_RUN = 5
/** Email drafts one run may write (the automatic-draft daily cap still applies on top). */
export const MAX_EMAIL_DRAFTS_PER_RUN = 5
/** Recipients one email draft may name. */
export const MAX_EMAIL_RECIPIENTS = 10

const MAX_SECTION_CHARS = 200
const MAX_EDIT_TEXT_CHARS = 4_000
const MAX_REASON_CHARS = 500
const MAX_BASED_ON_CHARS = 200
const MAX_SUBJECT_CHARS = 200
const MAX_BODY_CHARS = 10_000
/** Reasons kept on a run's ledger. */
const MAX_REFUSED_KEPT = 10

// ── The outputs a skill returns (eve outputSchema) ──────────────────────────

export const postDraftsOutputSchema = z
  .object({
    posts: z
      .array(
        z.object({
          text: z.string().describe('The post exactly as it would be published: plain text, in the person\'s own voice.'),
          based_on: z.string().optional().describe('One line: what it is based on (shipped work, a document, a theme from a call).'),
          idea: z.boolean().optional().describe('True for an idea not grounded in this week\'s work (a slow week): the card says so.'),
          uses: z.array(z.string()).optional().describe('The keys (m1, m2…) of the moments from their calls this post used, when the message lists any.'),
        }),
      )
      .describe(`At most ${MAX_POST_DRAFTS_PER_RUN} posts (or the number the message asks for, up to ${MAX_POST_DRAFTS_CEILING}). Empty when nothing is worth posting.`),
  })
  .describe(
    'Your post drafts. Each becomes a card the person reads; they post it themselves, nothing is published for them. ' +
      'Return an empty list when nothing is worth posting: that is a good outcome.',
  )

export const docProposalsOutputSchema = z
  .object({
    edits: z
      .array(
        z.object({
          section: z.string().describe('The section heading to edit, exactly as the document has it (or a "Parent > Heading" path).'),
          op: z.enum(['replace', 'append', 'remove']).describe('replace its text, append to it, or remove it'),
          text: z.string().optional().describe('The new text (markdown, without the heading); not for remove'),
          reason: z.string().describe('Why, in one line (shown in the history)'),
          removes: z.string().optional().describe('When the document is at its size budget: what this edit cuts'),
        }),
      )
      .describe(`At most ${MAX_DOC_EDITS_PER_RUN} section edits. Empty when nothing needs changing.`),
  })
  .describe(
    'Your section edits to the document this loop keeps. Each applies at once and can be undone from its history. ' +
      'Preserve wording you were not asked to change; resolve an open question by moving it, never by deleting it. ' +
      'Return an empty list when nothing needs changing.',
  )

export const emailDraftsOutputSchema = z
  .object({
    drafts: z
      .array(
        z.object({
          to: z.array(z.string()).describe('Recipient email addresses, exactly as you found them in the workspace.'),
          cc: z.array(z.string()).optional(),
          subject: z.string(),
          body: z.string().describe('Plain-text body in the person\'s voice.'),
        }),
      )
      .describe(`At most ${MAX_EMAIL_DRAFTS_PER_RUN} drafts. Empty when nobody needs an email.`),
  })
  .describe('Your email drafts. Each waits in the person\'s mail for review; nothing is sent for them.')

/** The eve outputSchema a connector's run commits, or null for a prose connector. */
export function connectorOutputSchema(to: OutputConnector | undefined | null) {
  switch (to) {
    case 'post_drafts':
      return postDraftsOutputSchema
    case 'doc_proposals':
      return docProposalsOutputSchema
    case 'email_drafts':
      return emailDraftsOutputSchema
    default:
      return null
  }
}

/**
 * The line a structured connector's run is told, after the skill's own task
 * (rides the run's user message, so the cached system prompt is unchanged).
 */
export function connectorInstruction(to: StructuredConnector, opts: { docKey?: string | null; surface?: PostSurface | null; weekly?: boolean }): string {
  switch (to) {
    case 'post_drafts': {
      const surface = writingSurface(opts.surface ?? 'x')
      return (
        `Your result is post drafts for ${POST_SURFACE_NAME[opts.surface ?? 'x'] ?? 'X'} (the structured result: \`posts\`), not prose. ` +
        `Each one is a card the person reads and posts themselves${surface?.maxChars ? `; at most ${surface.maxChars} characters each` : ''}. ` +
        'Public-safe only: shipped work, published documents and the person\'s own words; never mail, CRM, private captures, or another person\'s words, name, company or numbers. ' +
        // The weekly pass (P9): never an empty week (decision 3), the material block says how.
        (opts.weekly ? 'Never an empty week: what this week lacks, an idea marked `idea: true` fills.\n\n' : 'Nothing worth posting means an empty list.\n\n') +
        // The content playbook's craft, the same lines the chat's writer reads (content C0).
        writingRulesFor(opts.surface ?? 'x', 'short')
      )
    }
    case 'doc_proposals':
      return (
        `Your result is section edits to the canon document \`${opts.docKey ?? ''}\` (the structured result: \`edits\`), not prose. ` +
        'Read it first with read_canon. Each edit applies at once and can be undone. Nothing to change means an empty list.' +
        (opts.docKey === 'product'
          ? " In Who it's for, Positioning and Messaging every bullet ends with its grade: [proven] (calls with two or more companies, or a document a person wrote), [plausible] (it follows from how the product works) or [assumption]. An open question leaves its list only by moving into the section it answers."
          : '')
      )
    case 'email_drafts':
      return (
        'Your result is email drafts (the structured result: `drafts`), not prose. Each waits in the person\'s mail for review; nothing is sent. ' +
        'Use only addresses you found in the workspace (contacts, the call\'s participants, the thread). Nobody to write to means an empty list.'
      )
  }
}

// ── Validation: refuse junk, item by item ────────────────────────────────────

export interface ValidPostDraft {
  text: string
  chars: number
  limit: number | null
  based_on: string | null
  notes: PostDraftNote[]
  /** An idea, not grounded in this week's work (decision 3's slow-week ideas). */
  idea?: boolean
  /** The moment keys (m1…) it used, from the weekly pass's material. */
  uses?: string[]
}

export interface ValidDocEdit {
  section: string
  op: 'replace' | 'append' | 'remove'
  text: string
  reason: string
  removes: string | null
}

export interface ValidEmailDraft {
  to: string[]
  cc: string[]
  subject: string
  body: string
}

export type ConnectorItems = {
  post_drafts: ValidPostDraft
  doc_proposals: ValidDocEdit
  email_drafts: ValidEmailDraft
}

export type ParsedConnectorOutput<C extends StructuredConnector> =
  | { ok: true; items: ConnectorItems[C][]; refused: string[] }
  | { ok: false; error: string }

const EMAIL_RE = /^[^\s@<>()",;:]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i

function clean(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const t = value.trim()
  return t ? t.slice(0, max) : null
}

/** The lint's notes a card shows: the high and medium ones, a few, each quoted. */
function postNotes(text: string, surface: PostSurface, phrases: readonly string[]): PostDraftNote[] {
  const lint = lintDraft(text, { surface })
  const notes: PostDraftNote[] = lint.violations
    .filter((v) => v.severity !== 'low')
    .slice(0, 3)
    .map((v) => ({ rule: v.rule, quote: v.quote, fix: v.fix }))
  // The public-safe screen (review S3), as a note first: the person approves every post.
  const unsafe = publicSafeProblem(text, phrases, { links: true })
  if (unsafe) notes.unshift({ rule: 'public_safe', quote: unsafe.quote, fix: `This ${unsafe.reason}; posts never do.` })
  return notes
}

/** How a weekly post pass reads its posts (P9, post-week.ts). */
export interface PostPassOptions {
  /** A week with no material: every post is an idea, whatever the run says (decision 3). */
  slowWeek?: boolean
  /** Posts this run may deliver (its cadence budget), at most MAX_POST_DRAFTS_CEILING. */
  maxPosts?: number
  /** A post naming one of the blocked phrases is refused, never carded ("never post a private customer's name"). */
  refuseNamed?: boolean
  /** One-word names matched as written (the CRM's one-word companies), refused too. */
  blockedWords?: readonly string[]
}

function parsePosts(raw: unknown, surface: PostSurface, phrases: readonly string[], pass: PostPassOptions = {}): ParsedConnectorOutput<'post_drafts'> {
  const parsed = postDraftsOutputSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: 'The run did not return post drafts in the expected shape.' }
  const limit = writingSurface(surface)?.maxChars ?? null
  const max = Math.min(MAX_POST_DRAFTS_CEILING, Math.max(1, Math.round(pass.maxPosts ?? MAX_POST_DRAFTS_PER_RUN)))
  const items: ValidPostDraft[] = []
  const refused: string[] = []
  const seen = new Set<string>()
  for (const post of parsed.data.posts) {
    const text = (post.text ?? '').trim()
    if (!text) {
      refused.push('an empty post')
      continue
    }
    // Never a private customer's name (P9): the weekly pass refuses a post that
    // names someone from the person's calls before it ever reaches a card.
    if (pass.refuseNamed && (namedPhrase(text, phrases) || namedWord(text, pass.blockedWords ?? []))) {
      refused.push('a post that names someone from outside the workspace')
      continue
    }
    // Counted the platform's way (X: a link is 23 characters), as lint and the card count it.
    const chars = postLength(surface, text)
    if (limit !== null && chars > limit) {
      refused.push(`a post of ${chars} characters (the limit is ${limit})`)
      continue
    }
    const key = text.replace(/\s+/g, ' ').toLowerCase()
    if (seen.has(key)) {
      refused.push('the same post twice')
      continue
    }
    if (items.length >= max) {
      refused.push(`more than ${max} post${max === 1 ? '' : 's'}`)
      continue
    }
    seen.add(key)
    // A slow week's posts are ideas, whatever the run says; otherwise the run's own mark.
    const idea = pass.slowWeek === true || post.idea === true
    const uses = [...new Set((post.uses ?? []).map((u) => u.trim().toLowerCase()).filter((u) => /^m\d{1,2}$/.test(u)))].slice(0, 10)
    items.push({
      text,
      chars,
      limit,
      based_on: clean(post.based_on, MAX_BASED_ON_CHARS),
      notes: postNotes(text, surface, phrases),
      ...(idea ? { idea: true } : {}),
      ...(uses.length ? { uses } : {}),
    })
  }
  return { ok: true, items, refused: refused.slice(0, MAX_REFUSED_KEPT) }
}

function parseDocEdits(raw: unknown): ParsedConnectorOutput<'doc_proposals'> {
  const parsed = docProposalsOutputSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: 'The run did not return section edits in the expected shape.' }
  const items: ValidDocEdit[] = []
  const refused: string[] = []
  for (const edit of parsed.data.edits) {
    const section = clean(edit.section, MAX_SECTION_CHARS)
    if (!section) {
      refused.push('an edit with no section')
      continue
    }
    const text = typeof edit.text === 'string' ? edit.text.trim() : ''
    if (edit.op !== 'remove' && !text) {
      refused.push(`an empty ${edit.op} of ${section}`)
      continue
    }
    if (text.length > MAX_EDIT_TEXT_CHARS) {
      refused.push(`an edit to ${section} longer than ${MAX_EDIT_TEXT_CHARS} characters`)
      continue
    }
    if (items.length >= MAX_DOC_EDITS_PER_RUN) {
      refused.push(`more than ${MAX_DOC_EDITS_PER_RUN} edits`)
      continue
    }
    items.push({
      section,
      op: edit.op,
      text: edit.op === 'remove' ? '' : text,
      reason: clean(edit.reason, MAX_REASON_CHARS) ?? 'From a loop run',
      removes: clean(edit.removes, MAX_REASON_CHARS),
    })
  }
  return { ok: true, items, refused: refused.slice(0, MAX_REFUSED_KEPT) }
}

/** A recipient list, cleaned: valid addresses only, lower-cased, each once. Null when any is invalid. */
function recipients(list: readonly string[] | undefined): string[] | null {
  const out: string[] = []
  for (const raw of list ?? []) {
    const address = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
    if (!EMAIL_RE.test(address)) return null
    if (!out.includes(address)) out.push(address)
  }
  return out
}

function parseEmailDrafts(raw: unknown): ParsedConnectorOutput<'email_drafts'> {
  const parsed = emailDraftsOutputSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: 'The run did not return email drafts in the expected shape.' }
  const items: ValidEmailDraft[] = []
  const refused: string[] = []
  for (const draft of parsed.data.drafts) {
    const to = recipients(draft.to)
    const cc = recipients(draft.cc)
    if (!to || !cc || to.length === 0) {
      refused.push('a draft with a missing or malformed address')
      continue
    }
    if (to.length + cc.length > MAX_EMAIL_RECIPIENTS) {
      refused.push(`a draft to more than ${MAX_EMAIL_RECIPIENTS} people`)
      continue
    }
    if ([...to, ...cc].some((a) => isNoReplyAddress(a))) {
      refused.push('a draft to a no-reply address')
      continue
    }
    const subject = clean(draft.subject, MAX_SUBJECT_CHARS)
    const body = typeof draft.body === 'string' ? draft.body.trim() : ''
    if (!subject || !body) {
      refused.push('a draft with no subject or no body')
      continue
    }
    if (body.length > MAX_BODY_CHARS) {
      refused.push(`a draft longer than ${MAX_BODY_CHARS} characters`)
      continue
    }
    if (items.length >= MAX_EMAIL_DRAFTS_PER_RUN) {
      refused.push(`more than ${MAX_EMAIL_DRAFTS_PER_RUN} drafts`)
      continue
    }
    items.push({ to, cc, subject, body })
  }
  return { ok: true, items, refused: refused.slice(0, MAX_REFUSED_KEPT) }
}

/**
 * Validate what a run returned for its connector. Deterministic: the wrong
 * shape refuses the whole output; within the shape, each bad item is refused
 * with a reason and the rest go on. An empty list is a valid answer (nothing
 * worth delivering: hide empty widgets).
 */
export function parseConnectorOutput<C extends StructuredConnector>(
  to: C,
  raw: unknown,
  /** `blockedPhrases`: a call's outside names (lens-plan.ts), screened in posts drafted from it. `postPass`: the weekly post pass's rules (P9). */
  opts: { surface?: PostSurface | null; blockedPhrases?: readonly string[]; postPass?: PostPassOptions } = {},
): ParsedConnectorOutput<C> {
  if (raw == null || typeof raw !== 'object') return { ok: false, error: 'The run returned no structured output.' }
  switch (to) {
    case 'post_drafts':
      return parsePosts(raw, opts.surface ?? 'x', opts.blockedPhrases ?? [], opts.postPass) as ParsedConnectorOutput<C>
    case 'doc_proposals':
      return parseDocEdits(raw) as ParsedConnectorOutput<C>
    default:
      return parseEmailDrafts(raw) as ParsedConnectorOutput<C>
  }
}

// ── The flow config's delivery block ─────────────────────────────────────────

/**
 * Validate a run_skill `deliver` block's connector fields (queries.ts calls
 * it for the REST route and the chat tools alike). Returns the fields to
 * store, or an Error naming the fix. `doc_key` is required for doc_proposals
 * and a canon key; `surface` defaults to x for post_drafts. A field that
 * doesn't belong to the connector is dropped.
 */
export function validateDeliverConnector(d: Record<string, unknown>): { to?: OutputConnector; doc_key?: string; surface?: PostSurface; slots?: number } | Error {
  if (d.to === undefined || d.to === null) return {}
  if (!isOutputConnector(d.to)) return new Error(`deliver.to must be one of: ${OUTPUT_CONNECTORS.join(', ')}`)
  const out: { to?: OutputConnector; doc_key?: string; surface?: PostSurface; slots?: number } = { to: d.to }
  if (d.to === 'doc_proposals') {
    const key = normalizeCanonKey(d.doc_key)
    if (!key) return new Error('deliver.doc_key must name a canon document (e.g. "product") for doc_proposals')
    out.doc_key = key
  }
  if (d.to === 'post_drafts') {
    if (d.surface !== undefined && d.surface !== null && !isPostSurface(d.surface)) {
      return new Error(`deliver.surface must be one of: ${POST_SURFACES.join(', ')}`)
    }
    out.surface = isPostSurface(d.surface) ? d.surface : 'x'
    // P9: the weekly pass's cadence (decision 3: 3 by default, changeable by asking).
    if (d.slots !== undefined && d.slots !== null) {
      if (typeof d.slots !== 'number' || !Number.isInteger(d.slots) || d.slots < 1 || d.slots > MAX_POST_DRAFTS_CEILING) {
        return new Error(`deliver.slots must be a whole number from 1 to ${MAX_POST_DRAFTS_CEILING} (posts a run brings)`)
      }
      out.slots = d.slots
    }
  }
  return out
}

/** "2 X posts", "1 section edit", "3 email drafts". Pure. */
export function connectorNoun(to: StructuredConnector, n: number, surface: PostSurface = 'x'): string {
  switch (to) {
    case 'post_drafts':
      return `${n} ${POST_SURFACE_NAME[surface] ?? 'X'} post${n === 1 ? '' : 's'}`
    case 'doc_proposals':
      return `${n} section edit${n === 1 ? '' : 's'}`
    default:
      return `${n} email draft${n === 1 ? '' : 's'}`
  }
}
