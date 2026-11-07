/**
 * Canon documents (docs/plans/documents-as-ground-truth.md §3, eve-alignment.md
 * §4 and §6 decisions 10, 15, 16): the few named documents every agent is
 * grounded in. A canon document is an ordinary document with a `canon_key`
 * (migration 366): the key agents address it by. It is a system document, so
 * it can be edited but never deleted, archived or made private.
 *
 * Two kinds of key:
 *   workspace canon   `product` (the brand context, decision 10: the product
 *                     doc grows into it), `team-playbook`, or any key an admin
 *                     gives a document. One per workspace; its owners are the
 *                     workspace's admins.
 *   personal canon    `person:voice`, `content-brief:<channel>`. One per
 *                     person (migration 375); its owner is its creator.
 *
 * The registry (renderCanonRegistry) is the few stable lines every agent's
 * system prompt carries beside "Available skills": the key, title, a
 * one-sentence description, owner and the day it last changed. The content
 * is read on demand (read_canon), never pasted into the prompt.
 *
 * Pure and client-safe: no I/O.
 */

/** A canon key (migration 366's format check). */
export const CANON_KEY_RE = /^[a-z0-9][a-z0-9:._-]{0,63}$/

/** The prefixes of a personal key (migration 375 pins the same pattern). */
export const PERSONAL_CANON_PREFIXES = ['person:', 'content-brief:'] as const

export function isCanonKey(value: unknown): value is string {
  return typeof value === 'string' && CANON_KEY_RE.test(value)
}

/** One per person (its creator owns it), not one per workspace. Pure. */
export function isPersonalCanonKey(key: string | null | undefined): boolean {
  return typeof key === 'string' && PERSONAL_CANON_PREFIXES.some((p) => key.startsWith(p))
}

/** A key as the agent may write it: trimmed and lower-cased (`Product` → `product`). Pure. */
export function normalizeCanonKey(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const key = value.trim().toLowerCase()
  return isCanonKey(key) ? key : null
}

/** One fixed `##` section of a template. */
export interface CanonSectionSpec {
  heading: string
  /** What belongs in it, for the agent writing it (never written into the document). */
  hint: string
}

/** Which template a key is made from. */
export type CanonTemplateId = 'product' | 'content-brief' | 'team-playbook' | 'person-voice'

export interface CanonTemplate {
  id: CanonTemplateId
  /** The registry's one sentence. */
  description: string
  /** Whose it is: the workspace's admins, or the person who created it. */
  owner: 'admins' | 'creator'
  sections: readonly CanonSectionSpec[]
}

/**
 * The templates. Their `##` headings are fixed: a canon document made from
 * one keeps them, and section edits address them by name. The text lives
 * here, in code, never in the database.
 */
export const CANON_TEMPLATES: Readonly<Record<CanonTemplateId, CanonTemplate>> = {
  // Decision 10: the product doc grows into the brand context, with the six
  // sections of the marketing template (marketing-skill-set.md §4.1). The
  // bullets of Who it's for, Positioning and Messaging are graded claims
  // (src/lib/marketing/grade.ts): each ends with [proven], [plausible] or
  // [assumption], and an agent's edit is held to it.
  product: {
    id: 'product',
    description: 'What the product is, who it is for, how we position it and how we talk about it: the source of truth for product facts.',
    owner: 'admins',
    sections: [
      { heading: 'What the product is', hint: 'What it does, the main features, pricing, limits and integrations: the facts a call or an email may state.' },
      { heading: "Who it's for", hint: 'Who buys it and who uses it, and a "Not for" line from the calls that went nowhere. Each bullet ends with its grade: [proven], [plausible] or [assumption].' },
      { heading: 'Positioning', hint: 'The real alternative (what customers use today) and the differentiators, each with its proof. Each bullet ends with its grade: [proven], [plausible] or [assumption].' },
      { heading: 'Messaging', hint: 'The core message and 3-4 pillars, each: benefit, mechanism, proof, and its grade at the end: [proven], [plausible] or [assumption].' },
      { heading: 'Voice', hint: 'How we sound: 2-3 real examples and the anti-list (words and claims we never use).' },
      { heading: 'Open questions', hint: 'What is not settled yet, and what would settle it. Resolve one by moving it, never by deleting it.' },
    ],
  },
  'content-brief': {
    id: 'content-brief',
    description: 'What you post about on this channel: audience, themes, voice, what never to post, and cadence.',
    owner: 'creator',
    sections: [
      { heading: 'Audience', hint: 'Who reads the posts and what they care about.' },
      { heading: 'Themes', hint: '3-5 themes the posts come back to.' },
      { heading: 'Voice', hint: 'How the posts sound, with a real example or two.' },
      { heading: 'Never post', hint: 'Topics, names and claims that never go public.' },
      { heading: 'Cadence', hint: 'How often to post (default 3 a week).' },
    ],
  },
  'team-playbook': {
    id: 'team-playbook',
    description: 'How the team works: durable conventions, repo and tool quirks, and how we handle customers.',
    owner: 'admins',
    sections: [
      { heading: 'How we work', hint: 'Durable team conventions: reviews, releases, who decides what. Never one-off task details.' },
      { heading: 'Repos and code', hint: 'Repo-level facts a coding run needs: layout, commands, quirks, what not to touch.' },
      { heading: 'Customers', hint: 'How we handle customers and deals: tone, escalation, what we promise and what we never promise.' },
      { heading: 'Tools', hint: 'The tools we use and how we use them.' },
      { heading: 'Open questions', hint: 'What is not settled yet.' },
    ],
  },
  'person-voice': {
    id: 'person-voice',
    description: 'How you write: your tone, the words you use and the ones you avoid.',
    owner: 'creator',
    sections: [
      { heading: 'How I write', hint: 'Tone and length, in a few lines.' },
      { heading: 'Words I use', hint: 'Phrases and sign-offs that sound like you.' },
      { heading: 'Words I avoid', hint: 'What never sounds like you.' },
    ],
  },
}

/** The channel a content brief's key names (`content-brief:x` → `x`), or null. Pure. */
export function contentBriefChannel(key: string): string | null {
  if (!key.startsWith('content-brief:')) return null
  const channel = key.slice('content-brief:'.length)
  return channel ? channel : null
}

/** The template a key is made from, or null for a key with none (any key an admin sets). Pure. */
export function templateForKey(key: string | null | undefined): CanonTemplate | null {
  if (!key) return null
  if (key === 'product') return CANON_TEMPLATES.product
  if (key === 'team-playbook') return CANON_TEMPLATES['team-playbook']
  if (key === 'person:voice') return CANON_TEMPLATES['person-voice']
  if (contentBriefChannel(key)) return CANON_TEMPLATES['content-brief']
  return null
}

/** The keys a template can be created under: the fixed ones, and content-brief:<channel>. */
export const TEMPLATE_KEYS = ['product', 'team-playbook', 'person:voice', 'content-brief:<channel>'] as const

/** A channel name as a key part: lower-case letters, digits, dot, dash, underscore. */
const CHANNEL_RE = /^[a-z0-9][a-z0-9._-]{0,40}$/

/**
 * The key to create a template under, from what the agent asked for
 * (`product`, `team-playbook`, `person:voice`, `content-brief:x`, or
 * `content-brief` plus a channel), or null for one no template makes. Pure.
 */
export function templateKey(asked: string, channel?: string | null): string | null {
  const key = asked.trim().toLowerCase()
  if (key === 'product' || key === 'team-playbook' || key === 'person:voice') return key
  if (key === 'content-brief' || key === 'content-brief:') {
    const c = (channel ?? '').trim().toLowerCase()
    return CHANNEL_RE.test(c) ? `content-brief:${c}` : null
  }
  const c = contentBriefChannel(key)
  return c && CHANNEL_RE.test(c) ? key : null
}

/** The default title of a new canon document. Pure. */
export function canonDefaultTitle(key: string): string {
  if (key === 'product') return 'Product'
  if (key === 'team-playbook') return 'Team playbook'
  if (key === 'person:voice') return 'My voice'
  const channel = contentBriefChannel(key)
  if (channel) return `${channel === 'x' ? 'X' : channel.charAt(0).toUpperCase() + channel.slice(1)}: what I post about`
  return key
}

/** A template's skeleton: its fixed `##` headings, each with an empty body. Pure. */
export function canonSkeleton(template: CanonTemplate): string {
  return template.sections.map((s) => `## ${s.heading}\n`).join('\n')
}

// ── The registry ─────────────────────────────────────────────────────────────

/** One canon document as the registry lists it. */
export interface CanonEntry {
  key: string
  title: string
  /** Whose it is: 'admins' for workspace canon, 'you' for the reader's own personal canon. */
  owner: 'admins' | 'you'
  /** When it last changed (ISO); only its day is shown. */
  updatedAt: string | null
}

/** The registry's description of an entry: its template's sentence, else a generic one. Pure. */
export function canonDescription(key: string): string {
  return templateForKey(key)?.description ?? 'A workspace canon document: read it by key before you state what it covers.'
}

/** An ISO time as its UTC day (YYYY-MM-DD), or null. Pure. */
export function canonDay(iso: string | null | undefined): string | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null
}

/** A title on one line, at most 80 characters, with no prompt markup. Pure. */
function oneLine(text: string, max = 80): string {
  const clean = text.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean
}

/** Entries in the registry's order: by key, once each. Pure. */
export function sortCanonEntries(entries: readonly CanonEntry[]): CanonEntry[] {
  const seen = new Set<string>()
  return [...entries]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .filter((e) => (seen.has(e.key) ? false : (seen.add(e.key), true)))
}

/** The registry's heading. */
export const CANON_REGISTRY_HEADING = '## Canon documents'

/**
 * The "Canon documents" system-prompt section: one line per canon document,
 * sorted by key, dated to the day (so it stays byte-identical turn to turn and
 * the prompt cache holds). Empty string when there are none (hide empty: a
 * workspace without canon pays nothing). Pure.
 */
export function renderCanonRegistry(entries: readonly CanonEntry[]): string {
  const sorted = sortCanonEntries(entries)
  if (sorted.length === 0) return ''
  const lines = sorted.map((e) => {
    const day = canonDay(e.updatedAt)
    const owner = e.owner === 'you' ? 'yours' : 'admins'
    return `- \`${e.key}\`: ${oneLine(e.title) || e.key}. ${canonDescription(e.key)} Owner: ${owner}.${day ? ` Updated ${day}.` : ''}`
  })
  return [
    CANON_REGISTRY_HEADING,
    'The workspace\'s ground truth. Before you state, draft or decide something one of these covers, read it with `read_canon` (by key, one section at a time when you only need part). Never guess what they say.',
    ...lines,
  ].join('\n')
}

/**
 * The refusal for a caller who may not edit a canon document (#774's write
 * rules): plain words, no card. Pure.
 */
export function canonEditForbidden(key: string, title: string | null): string {
  if (isPersonalCanonKey(key)) return `Only its owner can change \`${key}\`. Say what you'd change instead.`
  const doc = key === 'product' ? 'the product doc' : (title?.trim() || `\`${key}\``)
  return `Only admins can change ${doc}. Say what you'd change instead, so an admin can make the edit.`
}
