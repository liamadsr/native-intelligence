import { getServiceClient } from '@/lib/admin'
// The free-mail list lives in ONE place (enrichment.ts). It used to be copied
// here, and a third copy was about to appear in src/lib/prospecting/keys.ts —
// three lists describing one rule, drifting apart. `enrichment.ts` does not
// import this module (its only mention of contact-dedup is a comment), so
// there is no cycle.
import { isPersonalDomain } from './domains'

// ---------------------------------------------------------------------------
// Contact deduplication & merge engine
// ---------------------------------------------------------------------------
// Identifies contacts that are the same person across multiple email addresses
// and folds them into one — entirely with deterministic string heuristics, no
// LLM. The motivating case: someone joins one meeting from sarah.fletcher@ledgerline.com
// and another from sarah.fletcher@corvanne.com, producing two contacts whose
// captures, emails and history are split apart.
//
// Matching uses cheap, high-signal evidence:
//   * a shared email local-part across different domains (sarah.fletcher@…)
//   * a shared phone number
//   * one contact's address already listed on the other (a known alias)
//   * an exact normalized name (used only for review suggestions, never to
//     auto-merge, since common names collide)
//
// Only identity-level evidence (local-part / phone / alias) plus a compatible
// name triggers an automatic merge. Everything weaker is surfaced as a
// suggestion for one-click review. Every merge is reversible via the
// merge_contacts / unmerge_contacts SQL primitives (migration 132).
// ---------------------------------------------------------------------------

export interface DedupContact {
  id: string
  full_name: string | null
  first_name: string | null
  last_name: string | null
  email: string | null
  secondary_emails: string[]
  phone: string | null
  company_id: string | null
  member_id: string | null
  interaction_count: number
  last_interaction_at: string | null
  created_at: string
}

export type MatchTier = 'auto' | 'suggest'

export interface PairMatch {
  tier: MatchTier
  /** Stored on the merge record: 'auto:local_part' | 'auto:phone' | 'auto:alias' | 'suggest:name' | … */
  matchType: string
  score: number
  reasons: string[]
}

// Generic mailbox local-parts that many different people share — never treat a
// local-part match on these as identity evidence.
const ROLE_LOCAL_PARTS = new Set([
  'info', 'sales', 'support', 'admin', 'hello', 'hi', 'team', 'contact',
  'billing', 'careers', 'jobs', 'marketing', 'press', 'noreply', 'no-reply',
  'donotreply', 'help', 'office', 'hr', 'accounts', 'accounting', 'finance',
  'legal', 'enquiries', 'inquiries', 'general', 'mail', 'email', 'newsletter',
  'notifications', 'notification', 'service', 'services', 'webmaster', 'postmaster',
])

const NAME_TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'sir', 'mx', 'rev'])

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

function allEmails(c: DedupContact): string[] {
  const set = new Set<string>()
  if (c.email) set.add(c.email.toLowerCase().trim())
  for (const e of c.secondary_emails || []) {
    if (e) set.add(e.toLowerCase().trim())
  }
  return [...set].filter((e) => e.includes('@'))
}

function emailDomain(email: string): string | null {
  const parts = email.toLowerCase().split('@')
  return parts.length === 2 ? parts[1] : null
}

/** Normalized local-part for cross-domain identity comparison: lowercase, drop
 *  +tags, strip dots (gmail treats them as insignificant; harmless elsewhere). */
export function emailLocalPart(email: string): string | null {
  const at = email.toLowerCase().indexOf('@')
  if (at <= 0) return null
  let local = email.toLowerCase().slice(0, at)
  const plus = local.indexOf('+')
  if (plus >= 0) local = local.slice(0, plus)
  local = local.replace(/\./g, '')
  return local || null
}

/** Identity-bearing (non-role) local-parts across all of a contact's emails. */
function identityLocalParts(c: DedupContact): Set<string> {
  const out = new Set<string>()
  for (const e of allEmails(c)) {
    const lp = emailLocalPart(e)
    if (lp && !ROLE_LOCAL_PARTS.has(lp)) out.add(lp)
  }
  return out
}

function stripAccents(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '')
}

/** Lowercased, accent-stripped name tokens with titles removed. Returns [] when
 *  the "name" is empty or just the email address (i.e. carries no real name). */
export function nameTokens(c: DedupContact): string[] {
  const raw = (c.full_name || '').trim()
  if (!raw) return []
  // A name that is just the email address tells us nothing extra.
  if (raw.includes('@') && !raw.includes(' ')) return []
  // Strip parenthetical / bracketed qualifiers before tokenizing. Sync sources
  // label the same person with disambiguators like "Sarah Hale (us)",
  // "Sarah Hale (ext)" or "Sarah Hale [Ledgerline]"; without this they tokenize as a
  // bogus surname ("us"/"ext"/"pwc") and namesCompatible() reads them as three
  // different people, blocking an otherwise-valid identity merge.
  const cleaned = raw.replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ')
  return stripAccents(cleaned.toLowerCase())
    .replace(/[^a-z\s'-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/[.'-]/g, '').trim())
    .filter((t) => t.length > 0 && !NAME_TITLES.has(t))
}

function trigrams(s: string): Set<string> {
  const padded = `  ${s.replace(/\s+/g, ' ')} `
  const out = new Set<string>()
  for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3))
  return out
}

/** Trigram Jaccard similarity of two normalized names, 0..1. */
export function nameSimilarity(a: DedupContact, b: DedupContact): number {
  const ta = nameTokens(a).sort().join(' ')
  const tb = nameTokens(b).sort().join(' ')
  if (!ta || !tb) return 0
  if (ta === tb) return 1
  const ga = trigrams(ta)
  const gb = trigrams(tb)
  let inter = 0
  for (const g of ga) if (gb.has(g)) inter++
  return inter / (ga.size + gb.size - inter)
}

function normalizePhone(phone: string | null): string | null {
  if (!phone) return null
  const digits = phone.replace(/\D/g, '')
  return digits.length >= 7 ? digits : null
}

function phonesMatch(a: DedupContact, b: DedupContact): boolean {
  const pa = normalizePhone(a.phone)
  const pb = normalizePhone(b.phone)
  if (!pa || !pb) return false
  if (pa === pb) return true
  // Tolerate differing country-code prefixes by comparing the last 10 digits.
  const sa = pa.slice(-10)
  const sb = pb.slice(-10)
  return sa.length === 10 && sa === sb
}

/** Names that plausibly belong to the same person. Lenient when one side has no
 *  real name (the email already carries the identity), strict when both do. */
export function namesCompatible(a: DedupContact, b: DedupContact): boolean {
  const ta = nameTokens(a)
  const tb = nameTokens(b)
  if (ta.length === 0 || tb.length === 0) return true // no name to conflict with

  const sa = [...ta].sort().join(' ')
  const sb = [...tb].sort().join(' ')
  if (sa === sb) return true

  // Two name parts are compatible if equal or one is the other's initial —
  // so "fletcher"/"f" and "sarah"/"s" match, but "sarah"/"steve" do not.
  const tokenCompat = (x: string, y: string): boolean => {
    if (x === y) return true
    if (x.length === 1 && y.startsWith(x)) return true
    if (y.length === 1 && x.startsWith(y)) return true
    return false
  }

  // Compare first + last tokens. Covers "Sarah Fletcher" vs "Sarah B" / "S Fletcher"
  // and "Sarah Jane Fletcher" vs "Sarah Fletcher", while rejecting "Steve Fletcher".
  const firstA = ta[0]
  const lastA = ta[ta.length - 1]
  const firstB = tb[0]
  const lastB = tb[tb.length - 1]
  return tokenCompat(firstA, firstB) && tokenCompat(lastA, lastB)
}

/** True exact full-name match (≥2 tokens) — strong enough to suggest, not to auto-merge. */
function exactFullName(a: DedupContact, b: DedupContact): boolean {
  const ta = nameTokens(a)
  const tb = nameTokens(b)
  if (ta.length < 2 || tb.length < 2) return false
  return [...ta].sort().join(' ') === [...tb].sort().join(' ')
}

function sharedBusinessDomain(a: DedupContact, b: DedupContact): boolean {
  const da = new Set(allEmails(a).map(emailDomain).filter((d): d is string => !!d && !isPersonalDomain(d)))
  for (const e of allEmails(b)) {
    const d = emailDomain(e)
    if (d && !isPersonalDomain(d) && da.has(d)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Pair scoring
// ---------------------------------------------------------------------------

/**
 * Classify whether two contacts are the same person. Returns null when there
 * is no meaningful evidence they should be linked.
 */
export function scoreContactPair(a: DedupContact, b: DedupContact): PairMatch | null {
  if (a.id === b.id) return null

  // Two distinct internal members are different people — never auto-merge them.
  const bothDistinctMembers = !!a.member_id && !!b.member_id && a.member_id !== b.member_id

  const emailsA = new Set(allEmails(a))
  const aliasKnown = allEmails(b).some((e) => emailsA.has(e))

  const lpA = identityLocalParts(a)
  const sharedLocalPart = [...identityLocalParts(b)].some((lp) => lpA.has(lp))

  const phoneMatch = phonesMatch(a, b)
  const compatible = namesCompatible(a, b)
  const sim = nameSimilarity(a, b)

  // Auto-merging on a shared handle/phone requires a real name on BOTH sides to
  // confirm identity. namesCompatible() is deliberately lenient when one side
  // has no real name (the address is treated as the identity), but a bare
  // email — or an empty name — carries no independent confirmation, so a shared
  // non-role local-part alone (e.g. bob.smith@acme.com vs bob.smith@gmail.com,
  // where the second only has the address as its name) would otherwise
  // auto-merge two possibly-different people. Downgrade those to suggest-tier.
  const bothNamed = nameTokens(a).length > 0 && nameTokens(b).length > 0

  // --- Auto-merge tier: identity-level evidence + a compatible name ----------
  if (aliasKnown) {
    return { tier: 'auto', matchType: 'auto:alias', score: 1, reasons: ['shares an email address'] }
  }
  if (!bothDistinctMembers && phoneMatch && compatible && bothNamed) {
    return { tier: 'auto', matchType: 'auto:phone', score: 0.97, reasons: ['same phone number', 'compatible name'] }
  }
  if (!bothDistinctMembers && sharedLocalPart && compatible && bothNamed) {
    return {
      tier: 'auto',
      matchType: 'auto:local_part',
      score: 0.95,
      reasons: ['same email handle across domains', 'compatible name'],
    }
  }

  // --- Suggestion tier: plausible but needs human confirmation ---------------
  if (sharedLocalPart) {
    return { tier: 'suggest', matchType: 'suggest:local_part', score: 0.7, reasons: ['same email handle across domains'] }
  }
  if (phoneMatch) {
    return { tier: 'suggest', matchType: 'suggest:phone', score: 0.7, reasons: ['same phone number'] }
  }
  if (exactFullName(a, b) && sharedBusinessDomain(a, b)) {
    return { tier: 'suggest', matchType: 'suggest:name_company', score: 0.65, reasons: ['same name', 'same company domain'] }
  }
  if (exactFullName(a, b)) {
    return { tier: 'suggest', matchType: 'suggest:name', score: 0.5, reasons: ['same name'] }
  }
  if (sim >= 0.82 && sharedBusinessDomain(a, b)) {
    return { tier: 'suggest', matchType: 'suggest:fuzzy_name', score: 0.5, reasons: ['similar name', 'same company domain'] }
  }
  return null
}

// ---------------------------------------------------------------------------
// Blocking — only compare contacts that share a cheap key, never O(n²) globally
// ---------------------------------------------------------------------------

function blockingKeys(c: DedupContact): string[] {
  const keys = new Set<string>()
  for (const lp of identityLocalParts(c)) keys.add(`lp:${lp}`)
  const phone = normalizePhone(c.phone)
  if (phone) keys.add(`ph:${phone.slice(-10)}`)
  const tokens = nameTokens(c)
  if (tokens.length >= 2) {
    keys.add(`nm:${[...tokens].sort().join(' ')}`)
    keys.add(`ln:${tokens[tokens.length - 1]}:${tokens[0][0]}`)
  }
  return [...keys]
}

/** Candidate pairs (deduplicated) drawn from shared blocking keys. */
function candidatePairs(contacts: DedupContact[]): Array<[DedupContact, DedupContact]> {
  const blocks = new Map<string, DedupContact[]>()
  for (const c of contacts) {
    for (const key of blockingKeys(c)) {
      const arr = blocks.get(key)
      if (arr) arr.push(c)
      else blocks.set(key, [c])
    }
  }
  const seen = new Set<string>()
  const pairs: Array<[DedupContact, DedupContact]> = []
  for (const group of blocks.values()) {
    if (group.length < 2) continue
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]
        const b = group[j]
        const pk = a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`
        if (seen.has(pk)) continue
        seen.add(pk)
        pairs.push([a, b])
      }
    }
  }
  return pairs
}

// ---------------------------------------------------------------------------
// Matching ONE incoming person against the workspace (imports, track G)
// ---------------------------------------------------------------------------
// An import asks "who is this?" for each record before writing anything, with
// the same evidence and tiers as the workspace run above: an auto-tier match
// is the same person (the import fills in what's missing), a suggest-tier
// match is someone to check, nothing is a new contact. The index is the same
// blocking as candidatePairs, plus every address, so a shared email (the
// alias rule) is found directly.

export interface ContactMatchIndex {
  byKey: Map<string, DedupContact[]>
  byEmail: Map<string, DedupContact>
}

export function buildContactMatchIndex(contacts: DedupContact[]): ContactMatchIndex {
  const index: ContactMatchIndex = { byKey: new Map(), byEmail: new Map() }
  for (const c of contacts) addToContactMatchIndex(index, c)
  return index
}

/** Add (or re-add, after its fields changed) one contact to the index. */
export function addToContactMatchIndex(index: ContactMatchIndex, contact: DedupContact): void {
  for (const key of blockingKeys(contact)) {
    const arr = index.byKey.get(key)
    if (!arr) index.byKey.set(key, [contact])
    else if (!arr.includes(contact)) arr.push(contact)
  }
  for (const e of allEmails(contact)) if (!index.byEmail.has(e)) index.byEmail.set(e, contact)
}

export interface IncomingMatch {
  contact: DedupContact
  match: PairMatch
}

/**
 * The strongest match for an incoming person (an auto-tier match beats any
 * suggestion, then the higher score, then the earlier contact), or null.
 */
export function bestContactMatch(index: ContactMatchIndex, incoming: DedupContact): IncomingMatch | null {
  const candidates = new Set<DedupContact>()
  for (const e of allEmails(incoming)) {
    const hit = index.byEmail.get(e)
    if (hit) candidates.add(hit)
  }
  for (const key of blockingKeys(incoming)) for (const c of index.byKey.get(key) ?? []) candidates.add(c)
  let best: IncomingMatch | null = null
  for (const contact of candidates) {
    if (contact.id === incoming.id) continue
    const match = scoreContactPair(incoming, contact)
    if (!match) continue
    if (
      !best ||
      (match.tier === 'auto' && best.match.tier !== 'auto') ||
      (match.tier === best.match.tier && match.score > best.match.score)
    ) {
      best = { contact, match }
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------

export const DEDUP_COLUMNS =
  'id, full_name, first_name, last_name, email, secondary_emails, phone, company_id, member_id, interaction_count, last_interaction_at, created_at'

async function loadActiveContacts(workspaceId: string): Promise<DedupContact[]> {
  const supabaseAdmin = getServiceClient()
  const rows: DedupContact[] = []
  const pageSize = 1000
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabaseAdmin
      .from('contact')
      .select(DEDUP_COLUMNS)
      .eq('workspace_id', workspaceId)
      .is('merged_into_contact_id', null)
      .order('created_at', { ascending: true })
      // Tiebreaker: a bulk import shares one created_at, and without a unique
      // key the offset pages can skip or repeat rows across a boundary.
      .order('id', { ascending: true })
      .range(offset, offset + pageSize - 1)
    if (error) throw new Error(`loadActiveContacts: ${error.message}`)
    const page = (data || []) as unknown as DedupContact[]
    rows.push(...page)
    if (page.length < pageSize) break
  }
  return rows
}

// ---------------------------------------------------------------------------
// Choosing the surviving contact in a cluster
// ---------------------------------------------------------------------------

/** Pick which contact should survive a merge: prefer an internal member, then
 *  the richest history, then the oldest record. */
export function choosePrimary(a: DedupContact, b: DedupContact): { target: DedupContact; source: DedupContact } {
  const winner = (x: DedupContact, y: DedupContact): boolean => {
    if (!!x.member_id !== !!y.member_id) return !!x.member_id
    const ix = x.interaction_count || 0
    const iy = y.interaction_count || 0
    if (ix !== iy) return ix > iy
    const tx = x.created_at ? new Date(x.created_at).getTime() : Infinity
    const ty = y.created_at ? new Date(y.created_at).getTime() : Infinity
    if (tx !== ty) return tx < ty
    return x.id < y.id
  }
  return winner(a, b) ? { target: a, source: b } : { target: b, source: a }
}

// ---------------------------------------------------------------------------
// Merge primitive
// ---------------------------------------------------------------------------

export async function mergeContactPair(opts: {
  targetId: string
  sourceId: string
  matchType: string
  score?: number | null
  reasons?: string[]
  performedBy?: string
}): Promise<{ ok: true; targetId: string } | { ok: false; error: string }> {
  const supabaseAdmin = getServiceClient()
  const { data, error } = await supabaseAdmin.rpc('merge_contacts', {
    p_target: opts.targetId,
    p_source: opts.sourceId,
    p_match_type: opts.matchType,
    p_score: opts.score ?? null,
    p_reasons: JSON.stringify(opts.reasons ?? []),
    p_performed_by: opts.performedBy ?? 'system',
  })
  if (error) return { ok: false, error: error.message }
  return { ok: true, targetId: (data as string) ?? opts.targetId }
}

// ---------------------------------------------------------------------------
// Workspace dedup run (auto-merge tier)
// ---------------------------------------------------------------------------

export interface DedupRunResult {
  workspaceId: string
  contactsScanned: number
  autoPairs: number
  merged: number
  suggestions: number
  errors: number
}

/**
 * Scan a workspace and automatically merge every cluster joined by
 * auto-tier evidence. Suggestion-tier pairs are only counted (they surface in
 * the per-contact duplicates UI), never merged here.
 */
export async function runContactDeduplication(
  workspaceId: string,
  options: { dryRun?: boolean } = {},
): Promise<DedupRunResult> {
  const contacts = await loadActiveContacts(workspaceId)
  const byId = new Map(contacts.map((c) => [c.id, c]))
  const pairs = candidatePairs(contacts)

  // Union-find over auto-tier edges so a 3-way split collapses to one contact.
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let root = x
    while (parent.get(root) && parent.get(root) !== root) root = parent.get(root)!
    return root
  }
  const union = (x: string, y: string) => {
    parent.set(x, parent.get(x) ?? x)
    parent.set(y, parent.get(y) ?? y)
    parent.set(find(x), find(y))
  }

  const autoEdges: Array<{ a: string; b: string; match: PairMatch }> = []
  let suggestions = 0
  for (const [a, b] of pairs) {
    const match = scoreContactPair(a, b)
    if (!match) continue
    if (match.tier === 'auto') {
      autoEdges.push({ a: a.id, b: b.id, match })
      union(a.id, b.id)
    } else {
      suggestions++
    }
  }

  const result: DedupRunResult = {
    workspaceId,
    contactsScanned: contacts.length,
    autoPairs: autoEdges.length,
    merged: 0,
    suggestions,
    errors: 0,
  }
  if (options.dryRun) return result

  // Group contacts by cluster, pick a primary, and fold the rest into it.
  const clusters = new Map<string, DedupContact[]>()
  for (const id of new Set(autoEdges.flatMap((e) => [e.a, e.b]))) {
    const root = find(id)
    const arr = clusters.get(root)
    const c = byId.get(id)
    if (!c) continue
    if (arr) arr.push(c)
    else clusters.set(root, [c])
  }

  for (const members of clusters.values()) {
    if (members.length < 2) continue
    // Reduce the cluster to a single survivor, one pairwise merge at a time.
    let target = members.reduce((acc, c) => choosePrimary(acc, c).target)
    for (const source of members) {
      if (source.id === target.id) continue
      // Collect the reasons from whichever edge linked these two (best-effort).
      const edge = autoEdges.find(
        (e) => (e.a === source.id || e.b === source.id) && (e.a === target.id || e.b === target.id),
      )
      const res = await mergeContactPair({
        targetId: target.id,
        sourceId: source.id,
        matchType: edge?.match.matchType ?? 'auto',
        score: edge?.match.score ?? null,
        reasons: edge?.match.reasons ?? [],
        performedBy: 'system',
      })
      if (res.ok) result.merged++
      else result.errors++
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// Per-contact duplicate candidates (powers the contact panel "duplicates" UI)
// ---------------------------------------------------------------------------

export interface DuplicateCandidate {
  contact: DedupContact
  tier: MatchTier
  matchType: string
  score: number
  reasons: string[]
}

/** Find likely duplicates of a single contact, ordered strongest first. */
export async function findDuplicateCandidates(
  workspaceId: string,
  contactId: string,
): Promise<DuplicateCandidate[]> {
  const contacts = await loadActiveContacts(workspaceId)
  const self = contacts.find((c) => c.id === contactId)
  if (!self) return []

  const out: DuplicateCandidate[] = []
  for (const other of contacts) {
    if (other.id === contactId) continue
    const match = scoreContactPair(self, other)
    if (!match) continue
    out.push({ contact: other, tier: match.tier, matchType: match.matchType, score: match.score, reasons: match.reasons })
  }
  out.sort((a, b) => b.score - a.score)
  return out
}
