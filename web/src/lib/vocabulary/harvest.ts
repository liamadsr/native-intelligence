import type { SupabaseClient } from '@supabase/supabase-js'
import { SoundIndex, isOrdinary, letters } from './sound-match'
import { VOCABULARY_TERM_MAX_CHARS, allRows, automaticVocabulary, listVocabulary } from './store'

/**
 * Automatic vocabulary from what the team writes (Liam, 2026-10-24: "this all
 * should happen automatically" — no AI job, nothing to approve;
 * docs/plans/custom-vocabulary.md §10).
 *
 * The right spellings of a team's jargon are already in its documents, tasks
 * and chats ("Supabase", "pgvector", "Kowalczyk"). A plain scan keeps them as
 * live vocabulary (source 'workspace'), and sound-match then fixes their
 * mishearings ("Superbase") in every meeting and dictation. A word is taken
 * when it is NOT ordinary English (or a name, place, day…: the lexicon), looks
 * like a word rather than code, and repeats: twice when it carries a capital
 * or a digit ("Supabase", "Dial8", "RLS"), four times when all lowercase
 * ("pgvector"), so a one-off typo never qualifies. Harmless when wrong: the
 * corrector never rewrites an ordinary word into one of these.
 *
 * Privacy: the workspace's words come only from what every member can read
 * (workspace documents, confirmed actions; never web-derived documents). A
 * person's own words come from their private documents, and are theirs alone.
 *
 * Never from speech (Liam, 2026-10-25, after "APAM" and "APEM" were learned
 * next to APIM and then protected their own mishearing): text that came out of
 * transcription carries its mistakes. So tasks made from a call
 * (source_type meeting_extraction, or linked to a capture) and chat messages
 * (which may be dictated, and say nothing about it) are not read. Documents
 * the agent writes can't be told from typed ones, so a learned word that
 * sounds like a name Native Intelligence knows or a word someone added is taken for a
 * mishearing of it and left out (dropMishearings).
 */

export const HARVEST_MAX_WORDS = 3000
const MIN_COUNT_MARKED = 2
const MIN_COUNT_LOWER = 4
const DOC_LIMIT = 300
const DOC_CHARS = 20_000
const ACTION_LIMIT = 3000

export interface HarvestText {
  text: string
  source: 'document' | 'action'
}

export interface HarvestedWord {
  term: string
  count: number
  sources: string[]
}

const POSSESSIVE = /['’](s|re|ll|ve|d|m)$/i

/** A token as a candidate word, or null when it is not one (code, ids, urls, numbers). */
function candidate(token: string): string | null {
  let w = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
  w = w.replace(POSSESSIVE, '')
  if (w.length < 3 || w.length > 40) return null
  if (!/\p{L}/u.test(w)) return null
  if (/[^\p{L}\p{N}'’-]/u.test(w)) return null // code, paths, urls, handles, ranges ("L0–L3")
  if (/^\d/.test(w)) return null // "12px", "3x"
  if ((w.match(/\d/g) ?? []).length >= 3) return null // ids, versions, numbers
  if (/^[a-z]{2,}[A-Z]/.test(w)) return null // camelCase identifiers (useEffect, getUserById); iCloud, eBay, tRPC stay
  if (/^[0-9a-f]{8,}$/i.test(w)) return null // hashes
  if (/^(?:[A-Z][a-z]+){3,}$/.test(w)) return null // code types (LocalModuleInfo); two-part names (PostHog, HubSpot) stay
  if (/^[A-Za-z]+\d*-\d+$/.test(w)) return null // identifiers (ENG-42, P1-3, WS-3)
  return w
}

/**
 * The words of a token: a hyphenated one is its parts ("KokoLink-specific"
 * is KokoLink and specific; "Ex-a16z" is Ex and a16z), so a compound is never
 * learned whole. Identifiers (ENG-42) are no words at all.
 */
function tokenWords(token: string): string[] {
  const whole = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
  if (/^[A-Za-z]+\d*-\d+$/.test(whole)) return []
  return whole.split(/[-‐‑–—]+/).map(candidate).filter((w): w is string => !!w)
}

/** The words worth knowing in a set of texts, most frequent first. */
export function harvestWords(texts: readonly HarvestText[], lexicon: ReadonlySet<string>, max = HARVEST_MAX_WORDS): HarvestedWord[] {
  const byKey = new Map<string, { spellings: Map<string, number>; count: number; sources: Set<string>; first: number }>()
  let order = 0
  for (const { text, source } of texts) {
    if (!text) continue
    for (const token of text.split(/\s+/)) {
      for (const w of tokenWords(token)) {
        const key = letters(w)
        if (key.length < 3) continue
        let entry = byKey.get(key)
        if (!entry) {
          if (isOrdinary(w, lexicon)) continue
          entry = { spellings: new Map(), count: 0, sources: new Set(), first: order++ }
          byKey.set(key, entry)
        }
        entry.count++
        entry.sources.add(source)
        entry.spellings.set(w, (entry.spellings.get(w) ?? 0) + 1)
      }
    }
  }
  const out: Array<HarvestedWord & { first: number }> = []
  for (const e of byKey.values()) {
    // The spelling the team uses most (ties: the first one seen).
    let term = ''
    let best = 0
    for (const [s, n] of e.spellings) if (n > best) { term = s; best = n }
    const marked = /[A-Z0-9]/.test(term)
    if (e.count < (marked ? MIN_COUNT_MARKED : MIN_COUNT_LOWER)) continue
    if (term.length > VOCABULARY_TERM_MAX_CHARS) continue
    out.push({ term, count: e.count, sources: [...e.sources].sort(), first: e.first })
  }
  return out
    .sort((a, b) => b.count - a.count || a.first - b.first)
    .slice(0, max)
    .map(({ term, count, sources }) => ({ term, count, sources }))
}

/** How close a learned word must sound to a name or added word to count as its mishearing (the corrector's own bar). */
export const MISHEARING_SCORE = 0.86

/**
 * The words people chose, to check learned words against: each name or added
 * word whole ("APIM (Azure API Management)") and its words that aren't ordinary
 * English ("APIM").
 */
export function trustedSpellings(terms: readonly string[], lexicon: ReadonlySet<string>): string[] {
  const out = new Set<string>()
  for (const t of terms) {
    const term = t.trim()
    if (!term) continue
    out.add(term)
    for (const token of term.split(/\s+/)) {
      for (const w of tokenWords(token)) if (!isOrdinary(w, lexicon)) out.add(w)
    }
  }
  return [...out]
}

/**
 * Learned words minus the mishearings of a trusted word: a different word that
 * sounds close to one ("APAM", "APEM" next to APIM), which, kept, would stop
 * the corrector fixing it. The same word in another casing stays: how the team
 * writes it is evidence for the spelling (store.ts compileVocabulary picks one).
 * Only trusted words outrank: a learned word is never dropped for another
 * learned one, since a transcript can repeat a mishearing more often than the
 * right word.
 */
export function dropMishearings(words: readonly HarvestedWord[], trusted: readonly string[]): HarvestedWord[] {
  if (!words.length || !trusted.length) return [...words]
  const index = new SoundIndex(trusted)
  const keys = new Set(trusted.map(letters))
  return words.filter((w) => {
    const key = letters(w.term)
    if (keys.has(key)) return true
    const c = index.candidates(w.term, 1)[0]
    return !(c && c.score >= MISHEARING_SCORE && letters(c.term) !== key)
  })
}

/**
 * The names and added words a harvest is checked against (dropMishearings): the
 * names Native Intelligence knows and the words people or the agent added. For the
 * workspace's harvest (userId null), only what every member sees.
 */
export async function trustedTerms(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string | null },
  lexicon: ReadonlySet<string>,
): Promise<string[]> {
  const userId = args.userId ?? ''
  const [names, stored] = await Promise.all([
    automaticVocabulary(supabase, { workspaceId: args.workspaceId, userId }),
    listVocabulary(supabase, { workspaceId: args.workspaceId, userId, status: 'active', workspaceOnly: !args.userId }),
  ])
  const added = stored.filter((t) => t.source === 'manual' || t.source === 'agent').map((t) => t.term)
  return trustedSpellings([...names.map((n) => n.term), ...added], lexicon)
}

// ── where the texts come from ───────────────────────────────────────────────

/** What every member can read: workspace documents (never web-derived) and confirmed actions. */
export async function workspaceTexts(supabase: SupabaseClient, workspaceId: string): Promise<HarvestText[]> {
  const [docs, actions] = await Promise.all([
    supabase
      .from('document')
      .select('title, content, visibility, outside_derived')
      .eq('workspace_id', workspaceId)
      // A null visibility is a workspace document (isDocumentVisible, src/lib/ai/tools/_shared.ts).
      .or('visibility.is.null,visibility.neq.private')
      .order('updated_at', { ascending: false })
      .limit(DOC_LIMIT),
    supabase
      .from('actions')
      .select('title, description, source_type, source_capture_id')
      .eq('workspace_id', workspaceId)
      .eq('confirmation', 'confirmed')
      .order('created_at', { ascending: false })
      .limit(ACTION_LIMIT),
  ])
  if (docs.error) throw new Error(docs.error.message)
  if (actions.error) throw new Error(actions.error.message)
  const out: HarvestText[] = []
  for (const d of (docs.data ?? []) as Array<{ title?: string | null; content?: string | null; visibility?: string | null; outside_derived?: boolean | null }>) {
    if (d.visibility === 'private' || d.outside_derived === true) continue
    out.push({ text: `${d.title ?? ''}\n${(d.content ?? '').slice(0, DOC_CHARS)}`, source: 'document' })
  }
  for (const a of (actions.data ?? []) as Array<{ title?: string | null; description?: string | null; source_type?: string | null; source_capture_id?: string | null }>) {
    // A task made from a call carries the call's mishearings.
    if (a.source_type === 'meeting_extraction' || a.source_capture_id) continue
    out.push({ text: `${a.title ?? ''}\n${(a.description ?? '').slice(0, 2000)}`, source: 'action' })
  }
  return out
}

/**
 * What only this person wrote: their private documents in this workspace
 * (document.created_by is their member id). Not their chat messages: those
 * may have been dictated, and nothing records which were.
 */
export async function personalTexts(supabase: SupabaseClient, workspaceId: string, memberId: string): Promise<HarvestText[]> {
  const docs = await supabase
    .from('document')
    .select('title, content, outside_derived')
    .eq('workspace_id', workspaceId)
    .eq('visibility', 'private')
    .eq('created_by', memberId)
    .order('updated_at', { ascending: false })
    .limit(DOC_LIMIT)
  if (docs.error) throw new Error(docs.error.message)
  const out: HarvestText[] = []
  for (const d of (docs.data ?? []) as Array<{ title?: string | null; content?: string | null; outside_derived?: boolean | null }>) {
    if (d.outside_derived === true) continue
    out.push({ text: `${d.title ?? ''}\n${(d.content ?? '').slice(0, DOC_CHARS)}`, source: 'document' })
  }
  return out
}

// ── keeping the rows in step ────────────────────────────────────────────────

/**
 * Make the owner's harvested rows (source 'workspace'; the workspace's when
 * userId is null) match `words`: new ones are added live, ones no longer
 * written anywhere go. Never touches a word a person or the agent added, and
 * never revives or removes one somebody turned off.
 */
export async function syncHarvest(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string | null; words: readonly HarvestedWord[] },
): Promise<{ added: number; removed: number }> {
  const rows = await allRows<{ id: string; term: string; status: string; source: string }>(() => {
    const q = supabase.from('vocabulary_term').select('id, term, status, source').eq('workspace_id', args.workspaceId)
    return (args.userId ? q.eq('user_id', args.userId) : q.is('user_id', null)).order('id', { ascending: true })
  })
  const have = new Set(rows.map((r) => letters(r.term)))
  const want = new Map(args.words.map((w) => [letters(w.term), w]))

  const inserts = [...want.entries()]
    .filter(([key]) => !have.has(key))
    .map(([, w]) => ({
      workspace_id: args.workspaceId,
      user_id: args.userId,
      term: w.term,
      sounds_like: [],
      status: 'active',
      source: 'workspace',
      evidence: { count: w.count, sources: w.sources },
      created_by: null,
    }))
  const stale = rows.filter((r) => r.source === 'workspace' && r.status === 'active' && !want.has(letters(r.term))).map((r) => r.id)

  let added = 0
  for (let i = 0; i < inserts.length; i += 500) {
    const batch = inserts.slice(i, i + 500)
    const { error: e } = await supabase.from('vocabulary_term').insert(batch)
    if (!e) {
      added += batch.length
      continue
    }
    if (e.code !== '23505') throw new Error(e.message)
    // Someone added one of these words meanwhile: insert one by one, skipping that one.
    for (const row of batch) {
      const { error: one } = await supabase.from('vocabulary_term').insert(row)
      if (!one) added++
      else if (one.code !== '23505') throw new Error(one.message)
    }
  }
  for (let i = 0; i < stale.length; i += 200) {
    const { error: e } = await supabase.from('vocabulary_term').delete().eq('workspace_id', args.workspaceId).in('id', stale.slice(i, i + 200))
    if (e) throw new Error(e.message)
  }
  return { added, removed: stale.length }
}
