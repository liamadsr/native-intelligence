/**
 * A document revision as the history list and the tools show it
 * (src/lib/documents/revision.ts reads them). Client-safe: no server imports.
 */
import { domainOf, outsideSourceLabel } from '@/lib/safety/outside-label'

export interface RevisionSummary {
  revision_number: number
  title: string | null
  /** 'human' | 'agent' | 'system', or null for a baseline (the state before tracked changes). */
  author_kind: string | null
  author_id: string | null
  author_name: string | null
  change_summary: string | null
  /** The section a section edit touched, its reason and sources (migration 376); absent for other changes. */
  section?: string
  reason?: string
  sources?: Array<Record<string, unknown>>
  /** The outside text an agent's edit rested on, in a few words ("a web page on acme.com"): its quiet label. */
  outside?: string
  created_at: string
  /** When the row last took a change (a person's autosaves fold into one row). */
  updated_at: string
}

export interface RevisionDetail extends RevisionSummary {
  content: string | null
  frontmatter: unknown
}

/** Who a revision was by, in a word or two: "Dial8 (for Ana)", "Ana", "Dial8 (system)". */
export function describeRevisionAuthor(r: Pick<RevisionSummary, 'author_kind' | 'author_name'>): string {
  const name = r.author_name?.trim() || null
  if (r.author_kind === 'agent') return name ? `Dial8 (for ${name})` : 'Dial8'
  if (r.author_kind === 'system') return name ? `Dial8 (system, for ${name})` : 'Dial8 (system)'
  if (r.author_kind === 'human') return name ?? 'Someone'
  return name ? `${name} (before history)` : 'Before history'
}

const SOURCE_WORDS: Record<string, string> = {
  capture: 'a call',
  chat: 'the chat',
  document: 'a document',
  claim: 'a claim',
  action: 'an action',
  project: 'a project',
}

/**
 * What an edit came from, in words, as the history shows it: "a call and a
 * web page on acme.com". Only a kind and a domain, never an address or a full
 * link (P4 S6). Null when it named none. Pure.
 */
export function describeRevisionSources(sources: RevisionSummary['sources']): string | null {
  if (!Array.isArray(sources) || sources.length === 0) return null
  const words: string[] = []
  for (const s of sources) {
    const kind = typeof s.kind === 'string' ? s.kind : ''
    const domain = typeof s.domain === 'string' && s.domain ? s.domain : typeof s.url === 'string' ? domainOf(s.url) : null
    const said = SOURCE_WORDS[kind] ?? (kind === 'email' ? (domain ? `an email from ${domain}` : 'an email') : outsideSourceLabel({ kind, ...(domain ? { domain } : {}) }))
    if (!words.includes(said)) words.push(said)
  }
  if (words.length === 1) return words[0]
  const shown = words.slice(0, 3)
  const rest = words.length - shown.length
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`
}
