/**
 * What a post's sources say about whether it can go public (content-skill-set.md
 * §4 "Source rules (code, not prompt)", decision 2), and the names a public
 * post never carries.
 *
 * Sources:
 *   - never mail, an outside message or a connected app's data (a CRM, a
 *     mailbox): a problem, so the post link is withheld until the post stops
 *     resting on it;
 *   - never a private call or a private document;
 *   - every cited row must exist in this workspace (an action, a project, a
 *     claim, a document, a call): one that doesn't is a problem, and only
 *     verified sources count toward "it cites something" (review nit). A web
 *     page or a file never counts: the model names it, and nothing here can
 *     tell whether the turn read it;
 *   - a call the person may use only for themes in their own words.
 *   - with `userId` (P9): the outside people and companies of the person's
 *     own recent calls, private ones included (recent-call-names.ts), are
 *     kept out too, even when the post cites only shipped work.
 *
 * Names (P8 review S3), never in a public post:
 *   - the cited calls' outside people and companies (lens-plan.ts
 *     loadCallFacts, the same names the content lens screens), and those
 *     people's first names;
 *   - the workspace's CRM: its companies (the most recent MAX_CRM_NAMES, not
 *     our own) and its contacts' full names.
 * Multi-word names are matched folded (namedPhrase); one-word names only
 * capitalized, as written (capitalizedNames), so "Linear" the customer
 * blocks and "linear progress" doesn't.
 *
 * The person's own pricing (review S4): a price may stand only when the post
 * cites the product doc or a document a person wrote (human-authored.ts).
 *
 * Bounded reads, and the CRM's names are cached per workspace for a minute,
 * so the checks a turn runs on its drafts read them once. A failed read never
 * passes what it could not check.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CanonSource } from '@/lib/documents/canon-sources'
import { documentFacts } from '@/lib/documents/human-authored'
import { loadCallFacts } from '@/lib/flows/lens-plan'
import { blockedPhrases, capitalizedNames, foldCompanyName, foldText } from './public-safe'
import type { PublicSafeFinding } from './post-check'
import { recentCallNames } from './recent-call-names'

/** Calls and documents read per check. */
export const MAX_SCREENED = 5
/** CRM companies and contacts screened, the most recently updated first. */
export const MAX_CRM_NAMES = 500
/** How long a workspace's CRM names are reused. */
export const CRM_NAMES_TTL_MS = 60_000

/** Source kinds a public post never rests on. */
const NEVER_PUBLIC: Readonly<Partial<Record<CanonSource['kind'], string>>> = {
  email: 'It rests on an email; mail never goes public.',
  message: 'It rests on a message from outside the workspace; that never goes public.',
  // A connected app may be a CRM or a mailbox: never a post's ground.
  connected_app: "It rests on a connected app's data; use the shipped work or a published document instead.",
}

/** The id-backed kinds and their tables. */
const ID_TABLES: Readonly<Partial<Record<CanonSource['kind'], string>>> = {
  action: 'actions',
  project: 'projects',
  claim: 'claim',
}

export interface PostSourceScreen {
  problems: PublicSafeFinding[]
  /** Folded multi-word names (and the cited calls' last names) a post never carries. */
  blockedPhrases: string[]
  /** One-word names matched as written: first names, one-word companies. */
  blockedWords: string[]
  /** It cites a call. */
  fromCall: boolean
  /** Sources that are real: rows found in this workspace, plus the chat and web pages. */
  verifiedCount: number
  /** It cites the product doc or a document a person wrote: a price may be their own public pricing. */
  ownPricingSource: boolean
}

interface CrmNames {
  phrases: string[]
  words: string[]
  at: number
  /** The read failed: nothing was screened, so the post link is withheld (never cached). */
  failed?: true
}

const crmCache = new Map<string, CrmNames>()

const LEGAL_SUFFIX = /^(inc|incorporated|llc|ltd|limited|corp|corporation|co|gmbh|sa|plc|ag|bv|pty|srl)\.?,?$/i

/** A one-word company as written, without its leading "The" or legal suffix ("Acme Corp." → "Acme"). Pure. */
export function companyWord(name: string): string {
  const tokens = name.trim().replace(/[.,]+$/, '').split(/\s+/).filter(Boolean)
  if (tokens.length > 1 && /^the$/i.test(tokens[0])) tokens.shift()
  while (tokens.length > 1 && LEGAL_SUFFIX.test(tokens[tokens.length - 1])) tokens.pop()
  return tokens.length === 1 ? tokens[0].replace(/[.,]+$/, '') : ''
}

/**
 * The CRM's names for the screen, cached per workspace (see the module doc).
 * Never throws. A failed read (an error or a throw) is marked `failed`, never
 * cached, and the screen withholds the link: an empty list must never pass
 * a post for a minute (P8 verification nit).
 */
export async function crmNames(supabase: SupabaseClient, workspaceId: string, now = Date.now()): Promise<CrmNames> {
  const hit = crmCache.get(workspaceId)
  if (hit && now - hit.at < CRM_NAMES_TTL_MS) return hit
  let phrases: string[] = []
  let words: string[] = []
  try {
    const [{ data: companies, error: companyError }, { data: contacts, error: contactError }, { data: members, error: memberError }] = await Promise.all([
      supabase.from('company').select('name, is_workspace_company').eq('workspace_id', workspaceId).order('updated_at', { ascending: false }).limit(MAX_CRM_NAMES),
      supabase.from('contact').select('full_name').eq('workspace_id', workspaceId).order('updated_at', { ascending: false }).limit(MAX_CRM_NAMES),
      // The workspace's own people may be contacts too: their names are theirs to post.
      supabase.from('member').select('display_name').eq('workspace_id', workspaceId).limit(500),
    ])
    if (companyError || contactError || memberError) return { phrases: [], words: [], at: now, failed: true }
    const rows = (companies ?? []) as Array<{ name: string | null; is_workspace_company: boolean | null }>
    const ours = new Set(rows.filter((c) => c.is_workspace_company).map((c) => foldCompanyName(c.name)))
    const theirs = rows.filter((c) => !c.is_workspace_company && c.name && !ours.has(foldCompanyName(c.name))).map((c) => c.name as string)
    const team = new Set(((members ?? []) as Array<{ display_name: string | null }>).map((m) => foldText(m.display_name ?? '')).filter(Boolean))
    const people = ((contacts ?? []) as Array<{ full_name: string | null }>).filter((c) => !team.has(foldText(c.full_name ?? ''))).map((c) => ({ full: c.full_name }))
    // Multi-word company names and full names fold; one-word company names match only as written.
    phrases = blockedPhrases({ people, companies: theirs.filter((n) => foldCompanyName(n).includes(' ')) }, { lastNames: false, max: MAX_CRM_NAMES * 2 })
    words = capitalizedNames(theirs.filter((n) => !foldCompanyName(n).includes(' ')).map(companyWord))
  } catch {
    return { phrases: [], words: [], at: now, failed: true }
  }
  const entry = { phrases, words, at: now }
  crmCache.set(workspaceId, entry)
  if (crmCache.size > 500) crmCache.delete(crmCache.keys().next().value as string)
  return entry
}

/** Forget the cached CRM names (tests). */
export function clearCrmNamesCache(): void {
  crmCache.clear()
}

/** Screen a post's sources and gather the names it must not carry. Never throws. */
export async function screenPostSources(
  supabase: SupabaseClient,
  workspaceId: string,
  sources: readonly CanonSource[],
  /** The person whose recent calls' names are kept out too (P9). */
  opts: { userId?: string | null } = {},
): Promise<PostSourceScreen> {
  const problems: PublicSafeFinding[] = []
  const seen = new Set<string>()
  for (const s of sources) {
    const reason = NEVER_PUBLIC[s.kind]
    if (reason && !seen.has(s.kind)) {
      seen.add(s.kind)
      problems.push({ reason, quote: s.from ?? s.note ?? s.kind })
    }
  }

  const idsOf = (kind: CanonSource['kind']) => [...new Set(sources.filter((s) => s.kind === kind && s.id).map((s) => s.id as string))].slice(0, MAX_SCREENED)
  const captureIds = idsOf('capture')
  const documentIds = idsOf('document')
  const phrases = new Set<string>()
  const firstNames: string[] = []
  // Only rows found in this workspace and the person's own words in this chat
  // count as citations. A web page or a file is named by the model and this
  // check can't see what the turn read, so neither counts (P8 verification
  // nit): cite the shipped work, the document or the call behind it.
  let verified = sources.filter((s) => s.kind === 'chat').length
  let ownPricingSource = false

  try {
    // The other id-backed sources: each must be a row in this workspace.
    for (const [kind, table] of Object.entries(ID_TABLES) as Array<[CanonSource['kind'], string]>) {
      const ids = idsOf(kind)
      if (!ids.length) continue
      const { data, error } = await supabase.from(table).select('id').eq('workspace_id', workspaceId).in('id', ids)
      if (error) throw error
      const found = new Set(((data ?? []) as Array<{ id: string }>).map((r) => r.id))
      verified += found.size
      const missing = ids.filter((id) => !found.has(id))
      if (missing.length) problems.push({ reason: `It cites ${missing.length === 1 ? `a ${kind}` : `${missing.length} ${kind}s`} not in this workspace.`, quote: missing[0] })
    }

    if (captureIds.length) {
      const { data, error } = await supabase.from('captures').select('id, title, visibility').eq('workspace_id', workspaceId).neq('is_eval', true).in('id', captureIds)
      if (error) throw error
      const rows = (data ?? []) as Array<{ id: string; title: string | null; visibility: string | null }>
      for (const id of captureIds) {
        const row = rows.find((r) => r.id === id)
        if (!row) {
          problems.push({ reason: 'It cites a call that is not in this workspace.', quote: id })
          continue
        }
        if (row.visibility === 'private') {
          problems.push({ reason: 'It rests on a private call; a private call never goes public.', quote: row.title ?? id })
          continue
        }
        const facts = await loadCallFacts(supabase, workspaceId, id)
        if (!facts) {
          problems.push({ reason: 'Its call could not be read to screen it.', quote: row.title ?? id })
          continue
        }
        verified++
        for (const p of facts.outsideNames) phrases.add(p)
      }
      // The outside people's first names (review S3): "Priya" alone names her too.
      const { data: parts } = await supabase.from('capture_participant').select('member_id, is_self, external_name').in('capture_id', captureIds).limit(200)
      for (const p of (parts ?? []) as Array<{ member_id: string | null; is_self: boolean | null; external_name: string | null }>) {
        if (p.member_id || p.is_self || !p.external_name) continue
        firstNames.push(p.external_name.trim().split(/\s+/)[0])
      }
    }

    if (documentIds.length) {
      const { data, error } = await supabase.from('document').select('id, title, visibility, canon_key').eq('workspace_id', workspaceId).in('id', documentIds)
      if (error) throw error
      const rows = (data ?? []) as Array<{ id: string; title: string | null; visibility: string | null; canon_key: string | null }>
      const facts = await documentFacts(supabase, workspaceId, rows.map((r) => r.id))
      for (const id of documentIds) {
        const row = rows.find((r) => r.id === id)
        if (!row) problems.push({ reason: 'It cites a document that is not in this workspace.', quote: id })
        else if (row.visibility === 'private') problems.push({ reason: 'It rests on a private document; that never goes public.', quote: row.title ?? id })
        else {
          verified++
          if (row.canon_key === 'product' || facts.get(id)?.humanAuthored) ownPricingSource = true
        }
      }
    }
  } catch {
    problems.push({ reason: 'Its sources could not be read to screen them; check it again.', quote: 'sources' })
  }
  if (opts.userId) for (const p of await recentCallNames(supabase, { workspaceId, userId: opts.userId })) phrases.add(p)

  const crm = await crmNames(supabase, workspaceId)
  if (crm.failed) problems.push({ reason: "The CRM's names could not be read to screen it; check it again.", quote: 'CRM' })
  for (const p of crm.phrases) phrases.add(p)
  return {
    problems,
    blockedPhrases: [...phrases],
    blockedWords: [...new Set([...capitalizedNames(firstNames), ...crm.words])],
    fromCall: captureIds.length > 0,
    verifiedCount: verified,
    ownPricingSource,
  }
}
