import type { SupabaseClient } from '@supabase/supabase-js'
import { filterVisibleContacts, isContactVisibleTo } from '@/lib/crm/contact-visibility'
import { toIlikeSearchTerm } from '@/lib/crm/ilike-search-term'
import { fetchAllRows } from '@/lib/supabase/paging'

// ---------------------------------------------------------------------------
// Fuzzy person-name matching
// ---------------------------------------------------------------------------
// Resolves a spoken/extracted name to a workspace member (or CRM contact).
//
// Names arriving from meeting transcripts rarely equal the stored
// display_name: people use nicknames ("Cat" for Katrina), bare first names,
// and the transcriber respells what it hears ("Katrena Ray"). The old
// exact → first-name → substring match missed all of these, leaving proposals
// with assignee_name set but assignee_member_id null — an item that can never
// land on the right person's board.
//
// Matching runs tiered from strict to loose so a precise match always beats a
// fuzzy one. Within a tier the first candidate in the caller's order wins, so
// callers must pass a deterministically ordered list (created_at, then id) —
// the same rationale as the live agent's member query ordering.
// ---------------------------------------------------------------------------

/**
 * Irregular nickname → formal given names. Only forms that share no usable
 * prefix with the formal name belong here — regular short forms ("Sam",
 * "Jess", "Alex") are covered by the prefix/phonetic rules below.
 */
const NICKNAMES: Record<string, string[]> = {
  beth: ['elizabeth', 'bethany'],
  betty: ['elizabeth'],
  bill: ['william'],
  billy: ['william'],
  bob: ['robert'],
  bobby: ['robert'],
  chuck: ['charles'],
  dick: ['richard'],
  hank: ['henry'],
  harry: ['harold', 'henry'],
  jack: ['john', 'jackson'],
  jim: ['james'],
  jimmy: ['james'],
  kathy: ['katherine', 'kathleen'],
  larry: ['lawrence'],
  liz: ['elizabeth'],
  lizzie: ['elizabeth'],
  meg: ['megan', 'margaret'],
  ned: ['edward'],
  peggy: ['margaret'],
  polly: ['mary'],
  rick: ['richard'],
  ricky: ['richard'],
  sally: ['sarah'],
  ted: ['theodore', 'edward'],
  teddy: ['theodore'],
  tony: ['anthony'],
  trish: ['patricia'],
}

function stripAccents(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '')
}

function normalize(s: string): string {
  return stripAccents(s.toLowerCase())
    .replace(/[^a-z\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokenize(s: string): string[] {
  return normalize(s)
    .split(' ')
    .map((t) => t.replace(/['-]/g, ''))
    .filter(Boolean)
}

/**
 * Crude sound-alike key: same transform on both sides, so "Cat" and
 * "Katrina" both land on a "kat…" key and prefix-match. Not a full phonetic
 * algorithm — just the substitutions transcription actually confuses.
 */
function phoneticKey(token: string): string {
  return token
    .replace(/ph/g, 'f')
    .replace(/c/g, 'k')
    .replace(/z/g, 's')
    .replace(/(.)\1+/g, '$1')
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  const prev = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]
      prev[j] = Math.min(
        prev[j] + 1,
        prev[j - 1] + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
      diag = tmp
    }
  }
  return prev[b.length]
}

/** One-typo tolerance, but only for names long enough that a single edit is
 *  noise rather than a different name ("sara"/"sarah" yes, "dan"/"don" no). */
function withinTypoDistance(a: string, b: string): boolean {
  return Math.max(a.length, b.length) >= 4 && levenshtein(a, b) <= 1
}

/** Do two given-name tokens plausibly name the same person? */
export function givenNamesMatch(a: string, b: string): boolean {
  if (!a || !b) return false
  if (a === b) return true
  // Short form: "kat" → "katrina", "sam" → "samantha". Min 3 chars so
  // initials don't match everyone.
  if (a.length >= 3 && b.startsWith(a)) return true
  if (b.length >= 3 && a.startsWith(b)) return true
  const pa = phoneticKey(a)
  const pb = phoneticKey(b)
  if (pa === pb) return true
  if (pa.length >= 3 && pb.startsWith(pa)) return true
  if (pb.length >= 3 && pa.startsWith(pb)) return true
  if (NICKNAMES[a]?.includes(b) || NICKNAMES[b]?.includes(a)) return true
  return withinTypoDistance(pa, pb)
}

/**
 * Surname guard for fuzzy given-name tiers: when the needle carries a surname,
 * it must not contradict the candidate's ("Cat Smith" never matches
 * "Katrina Rae"). Lenient on initials and one-typo transcription wobble
 * ("Ray"/"Rae"); trivially true when either side has no surname.
 */
function surnamesCompatible(needleTokens: string[], candTokens: string[]): boolean {
  if (needleTokens.length < 2 || candTokens.length < 2) return true
  const a = needleTokens[needleTokens.length - 1]
  const b = candTokens[candTokens.length - 1]
  if (a === b) return true
  if (a.length === 1 && b.startsWith(a)) return true
  if (b.length === 1 && a.startsWith(b)) return true
  if (a.length >= 3 && b.startsWith(a)) return true
  if (b.length >= 3 && a.startsWith(b)) return true
  if (phoneticKey(a) === phoneticKey(b)) return true
  // One-edit tolerance ("Ray"/"Rae") — safe to allow at length 3 because this
  // guard only runs after the given name already matched.
  return a.length >= 3 && b.length >= 3 && levenshtein(a, b) <= 1
}

function trigrams(s: string): Set<string> {
  const padded = `  ${s.replace(/\s+/g, ' ')} `
  const out = new Set<string>()
  for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3))
  return out
}

/** Trigram Jaccard similarity of two normalized names, 0..1. */
export function nameTrigramSimilarity(a: string, b: string): number {
  const ta = tokenize(a).sort().join(' ')
  const tb = tokenize(b).sort().join(' ')
  if (!ta || !tb) return 0
  if (ta === tb) return 1
  const ga = trigrams(ta)
  const gb = trigrams(tb)
  let inter = 0
  for (const g of ga) if (gb.has(g)) inter++
  return inter / (ga.size + gb.size - inter)
}

const TRIGRAM_MATCH_THRESHOLD = 0.65

export interface NamedCandidate {
  id: string
  name: string | null
}

export interface NameMatchOptions {
  /**
   * When true, a tier that matches MORE THAN ONE candidate resolves to null
   * (ambiguous) instead of silently picking the first in list order. Used for
   * member resolution feeding ASSIGNMENT: with two "Liam"s in a workspace, a
   * bare "Liam" must not deterministically land on whichever member is older —
   * that assigns one person's task to the other forever. Display-oriented
   * callers (contacts) keep the pick-first behavior.
   */
  requireUnambiguous?: boolean
}

/**
 * Find the candidate best matching a free-text person name, or null.
 *
 * Tiers, strict → loose (first tier with a hit wins; within a tier the first
 * candidate in list order wins — unless `requireUnambiguous`, where a
 * multi-hit tier returns null instead):
 *   1. exact normalized full name
 *   2. exact first-name token (with surname guard)
 *   3. nickname / short-form / sound-alike first name (with surname guard)
 *   4. substring containment (legacy behavior, kept as a safety net)
 *   5. whole-name trigram similarity ≥ 0.65 (transcription respellings)
 */
export function findBestNameMatch<T extends NamedCandidate>(
  candidates: T[],
  rawName: string,
  options: NameMatchOptions = {},
): T | null {
  const needleTokens = tokenize(rawName)
  if (needleTokens.length === 0) return null
  const needle = needleTokens.join(' ')

  const parsed = candidates
    .map((c) => ({ c, tokens: c.name ? tokenize(c.name) : [] }))
    .filter((p) => p.tokens.length > 0)

  // First tier with any hit decides. Under requireUnambiguous a multi-hit tier
  // is a dead end (null), NOT a fall-through — the looser tiers below it would
  // match the same colliding candidates anyway.
  const pick = (matches: { c: T }[]): T | null | undefined => {
    if (matches.length === 0) return undefined // tier empty — try next tier
    if (options.requireUnambiguous && matches.length > 1) return null
    return matches[0].c
  }

  const exact = pick(parsed.filter((p) => p.tokens.join(' ') === needle))
  if (exact !== undefined) return exact

  const firstNameExact = pick(
    parsed.filter(
      (p) => p.tokens[0] === needleTokens[0] && surnamesCompatible(needleTokens, p.tokens),
    ),
  )
  if (firstNameExact !== undefined) return firstNameExact

  const firstNameFuzzy = pick(
    parsed.filter(
      (p) =>
        givenNamesMatch(needleTokens[0], p.tokens[0]) &&
        surnamesCompatible(needleTokens, p.tokens),
    ),
  )
  if (firstNameFuzzy !== undefined) return firstNameFuzzy

  const contains = pick(
    parsed.filter((p) => {
      const full = p.tokens.join(' ')
      return full.includes(needle) || needle.includes(full)
    }),
  )
  if (contains !== undefined) return contains

  const similar = pick(
    parsed.filter(
      (p) => nameTrigramSimilarity(needle, p.tokens.join(' ')) >= TRIGRAM_MATCH_THRESHOLD,
    ),
  )
  return similar ?? null
}

/**
 * Resolve a free-text name to a workspace member id using the tiered fuzzy
 * match above. Members are ordered deterministically (created_at, then id).
 *
 * requireUnambiguous: member resolution feeds ASSIGNMENT (whose board an item
 * lands on, and whether it auto-applies to the current user), so a name that
 * matches two members at the same tier resolves to nobody rather than
 * silently picking the older member — the same-first-name-teammate case.
 */
export async function resolveMemberIdByName(
  supabase: SupabaseClient,
  workspaceId: string,
  name: string,
): Promise<string | null> {
  const { data: members } = await supabase
    .from('member')
    .select('id, display_name')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })

  if (!members?.length) return null
  const match = findBestNameMatch(
    members.map((m) => ({ id: m.id as string, name: (m.display_name as string | null) ?? null })),
    name,
    { requireUnambiguous: true },
  )
  return match?.id ?? null
}

/** How many hidden best matches the fuzzy contact fallback skips before giving up (fail closed). */
const MAX_HIDDEN_CONTACT_SKIPS = 5

/**
 * Resolve a free-text name to a CRM contact id. Tries the cheap ilike
 * substring first (the pre-existing behavior), then falls back to the same
 * in-memory fuzzy match so nicknames and respellings resolve too.
 *
 * Only contacts `requesterUserId` may see resolve: callers may run on a
 * SERVICE-ROLE client, where the contact table's RLS (mig 058) does not hide
 * another member's private/team contact, and the resolved id becomes an
 * assignee / claim subject. A hidden contact is skipped as if absent; the
 * check fails closed (src/lib/crm/contact-visibility.ts).
 */
export async function resolveContactIdByName(
  supabase: SupabaseClient,
  workspaceId: string,
  name: string,
  requesterUserId: string,
  // `grants: false` on a guest's or a linked agent's turn: a contact only a grant shows the requester never resolves.
  opts: { grants?: boolean } = {},
): Promise<string | null> {
  // The name is model-supplied: `.or()` takes a raw PostgREST logic tree, so
  // commas / parens / wildcards in it could add conditions or match everyone.
  const term = toIlikeSearchTerm(name)
  if (term) {
    const { data: bySubstring } = await supabase
      .from('contact')
      .select('id, full_name')
      .eq('workspace_id', workspaceId)
      // A merged contact is a tombstone: its references now point at the survivor.
      .is('merged_into_contact_id', null)
      .or(`full_name.ilike.%${term}%`)
      .limit(10)
    const [firstVisible] = await filterVisibleContacts(supabase, requesterUserId, bySubstring ?? [], opts)
    if (firstVisible) return firstVisible.id as string
  }

  // Every contact, paged (a response stops at 1000 rows: later contacts were
  // invisible to the fuzzy match).
  const { data: contacts, error } = await fetchAllRows(
    () =>
      supabase
        .from('contact')
        .select('id, full_name')
        .eq('workspace_id', workspaceId)
        .is('merged_into_contact_id', null)
        .order('created_at', { ascending: true })
        .order('id', { ascending: true }),
    { orderBy: null },
  )
  if (error || !contacts.length) return null
  // Fence only the winner (not every row): a hidden best match is dropped
  // and the match re-run, a bounded number of times.
  let candidates = contacts.map((c) => ({ id: c.id as string, name: (c.full_name as string | null) ?? null }))
  for (let i = 0; i <= MAX_HIDDEN_CONTACT_SKIPS; i++) {
    const match = findBestNameMatch(candidates, name)
    if (!match) return null
    if (await isContactVisibleTo(supabase, match.id, requesterUserId, opts)) return match.id
    candidates = candidates.filter((c) => c.id !== match.id)
  }
  return null
}
