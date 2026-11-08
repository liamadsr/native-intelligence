import type { SupabaseClient } from '@supabase/supabase-js'
import { loadLexicon } from './lexicon'
import { isOrdinary, letters, type VocabularyEntry } from './sound-match'

/**
 * Custom vocabulary storage (migration 430, docs/plans/custom-vocabulary.md
 * §10): the words a workspace and each person teach transcription, and the
 * names Native Intelligence adds automatically. The API route, the settings page, the agent
 * tools and the learning job all go through here.
 *
 * Ownership: a row with no user_id is the workspace's (every member may add,
 * edit, approve or remove it); one with a user_id is that person's own. Every
 * query fences on the workspace AND on "the workspace's or mine", so a
 * service-role client (device token, eve tool route, Inngest) gets the same
 * answer RLS would give on a user session.
 */

export const VOCABULARY_TERM_MAX_CHARS = 60
export const SOUNDS_LIKE_MAX = 20
/** Automatic names (contacts and companies, most recently active first) kept per compile. */
export const AUTOMATIC_TERM_LIMIT = 2000

export type VocabularyScope = 'workspace' | 'personal'
export type VocabularyStatus = 'active' | 'dismissed'
/** manual: a person added it; agent: Native Intelligence did, when asked; workspace: harvested from
 *  what the team writes (./harvest.ts); auto: a person turned an automatic name off. */
export type VocabularySource = 'manual' | 'agent' | 'workspace' | 'auto'

export const VOCABULARY_STATUSES: readonly VocabularyStatus[] = ['active', 'dismissed']
export const VOCABULARY_SOURCES: readonly VocabularySource[] = ['manual', 'agent', 'workspace', 'auto']

/** A harvested word's counts (source 'workspace'). */
export interface VocabularyEvidence {
  count?: number
  sources?: string[]
}

export interface VocabularyTerm {
  id: string
  workspaceId: string
  scope: VocabularyScope
  term: string
  soundsLike: string[]
  status: VocabularyStatus
  source: VocabularySource
  evidence: VocabularyEvidence
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

export type AutomaticKind = 'contact' | 'company' | 'teammate' | 'project'

export interface AutomaticTerm {
  term: string
  kind: AutomaticKind
}

const ROW_COLUMNS = 'id, workspace_id, user_id, term, sounds_like, status, source, evidence, created_by, created_at, updated_at'

// ── validation ──────────────────────────────────────────────────────────────

export type TermCheck =
  | { ok: true; term: string }
  | { ok: false; reason: 'not_text' | 'empty' | 'too_long' | 'no_letters' }

/** A term as it should be written: trimmed, inner whitespace collapsed, 1-60 chars, with a letter or digit. */
export function normalizeTerm(raw: unknown): TermCheck {
  if (typeof raw !== 'string') return { ok: false, reason: 'not_text' }
  const term = raw.replace(/\s+/g, ' ').trim()
  if (!term) return { ok: false, reason: 'empty' }
  if (term.length > VOCABULARY_TERM_MAX_CHARS) return { ok: false, reason: 'too_long' }
  if (!letters(term)) return { ok: false, reason: 'no_letters' }
  return { ok: true, term }
}

export function termProblem(reason: Exclude<TermCheck, { ok: true }>['reason']): string {
  switch (reason) {
    case 'too_long':
      return `A word is at most ${VOCABULARY_TERM_MAX_CHARS} characters`
    case 'no_letters':
      return 'A word needs at least one letter or digit'
    case 'empty':
      return 'Type the word as it should be written'
    default:
      return 'The word must be text'
  }
}

/** "Sounds like" spellings: trimmed, deduped (by letters), never the term itself, at most 20. */
export function normalizeSoundsLike(raw: unknown, term: string): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,\n]/) : []
  const seen = new Set([letters(term)])
  const out: string[] = []
  for (const item of list) {
    if (typeof item !== 'string') continue
    const s = item.replace(/\s+/g, ' ').trim()
    if (!s || s.length > VOCABULARY_TERM_MAX_CHARS) continue
    const key = letters(s)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(s)
    if (out.length >= SOUNDS_LIKE_MAX) break
  }
  return out
}

/** The unique key's notion of "the same word": case- and space-insensitive. */
export const sameTerm = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

function toTerm(row: Record<string, unknown>): VocabularyTerm {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    scope: row.user_id ? 'personal' : 'workspace',
    term: row.term as string,
    soundsLike: Array.isArray(row.sounds_like) ? (row.sounds_like as string[]) : [],
    status: row.status as VocabularyStatus,
    source: row.source as VocabularySource,
    evidence: (row.evidence as VocabularyEvidence | null) ?? {},
    createdBy: (row.created_by as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}

const ownerFilter = (userId: string) => `user_id.is.null,user_id.eq.${userId}`

/** PostgREST answers at most 1,000 rows a request (the hosted default): page through. */
export const PAGE_ROWS = 1000
const MAX_ROWS = 20_000

export async function allRows<T>(
  build: () => { range: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }> },
): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; from < MAX_ROWS; from += PAGE_ROWS) {
    const { data, error } = await build().range(from, from + PAGE_ROWS - 1)
    if (error) throw new Error(error.message)
    out.push(...((data ?? []) as T[]))
    if (!data || data.length < PAGE_ROWS) break
  }
  return out
}

// ── reads ───────────────────────────────────────────────────────────────────

/** The workspace's rows and the person's own, every status. */
export async function listVocabulary(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; status?: VocabularyStatus; workspaceOnly?: boolean },
): Promise<VocabularyTerm[]> {
  const rows = await allRows<Record<string, unknown>>(() => {
    let q = supabase.from('vocabulary_term').select(ROW_COLUMNS).eq('workspace_id', args.workspaceId)
    q = args.workspaceOnly ? q.is('user_id', null) : q.or(ownerFilter(args.userId))
    if (args.status) q = q.eq('status', args.status)
    return q.order('term', { ascending: true }).order('id', { ascending: true })
  })
  return rows.map(toTerm)
}

export async function getVocabularyTerm(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; id: string },
): Promise<VocabularyTerm | null> {
  const { data, error } = await supabase
    .from('vocabulary_term')
    .select(ROW_COLUMNS)
    .eq('id', args.id)
    .eq('workspace_id', args.workspaceId)
    .or(ownerFilter(args.userId))
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data ? toTerm(data as Record<string, unknown>) : null
}

const escapeIlike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`)

async function findByText(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; scope: VocabularyScope; term: string },
): Promise<VocabularyTerm | null> {
  let q = supabase.from('vocabulary_term').select(ROW_COLUMNS).eq('workspace_id', args.workspaceId).ilike('term', escapeIlike(args.term))
  q = args.scope === 'personal' ? q.eq('user_id', args.userId) : q.is('user_id', null)
  const { data, error } = await q.limit(5)
  if (error) throw new Error(error.message)
  const row = (data ?? []).find((r) => sameTerm(String((r as Record<string, unknown>).term), args.term))
  return row ? toTerm(row as Record<string, unknown>) : null
}

// ── writes ──────────────────────────────────────────────────────────────────

export type WriteResult =
  | { ok: true; term: VocabularyTerm; created: boolean; note?: 'already_active' | 'merged' }
  | { ok: false; status: 400 | 404 | 409 | 500; message: string }

export interface AddTermInput {
  workspaceId: string
  userId: string
  scope: VocabularyScope
  term: unknown
  soundsLike?: unknown
  source: VocabularySource
  status?: VocabularyStatus
  evidence?: VocabularyEvidence
}

/**
 * Add a word, or fold it into the one already there (same owner, same word
 * ignoring case): its "sounds like" forms are merged, and an `active` add
 * turns a dismissed word back on (as the adder's: manual or agent).
 */
export async function addVocabularyTerm(supabase: SupabaseClient, input: AddTermInput): Promise<WriteResult> {
  const checked = normalizeTerm(input.term)
  if (!checked.ok) return { ok: false, status: 400, message: termProblem(checked.reason) }
  const term = checked.term
  const soundsLike = normalizeSoundsLike(input.soundsLike, term)
  const status = input.status ?? 'active'
  const key = { workspaceId: input.workspaceId, userId: input.userId, scope: input.scope, term }

  try {
    const existing = await findByText(supabase, key)
    if (existing) return await mergeInto(supabase, existing, { soundsLike, status, source: input.source, evidence: input.evidence })

    const { data, error } = await supabase
      .from('vocabulary_term')
      .insert({
        workspace_id: input.workspaceId,
        user_id: input.scope === 'personal' ? input.userId : null,
        term,
        sounds_like: soundsLike,
        status,
        source: input.source,
        evidence: input.evidence ?? {},
        created_by: input.userId,
      })
      .select(ROW_COLUMNS)
      .single()
    if (error) {
      // A concurrent add of the same word won the unique key: merge into it.
      if (error.code === '23505') {
        const raced = await findByText(supabase, key)
        if (raced) return await mergeInto(supabase, raced, { soundsLike, status, source: input.source, evidence: input.evidence })
      }
      return { ok: false, status: 500, message: error.message }
    }
    return { ok: true, term: toTerm(data as Record<string, unknown>), created: true }
  } catch (err) {
    return { ok: false, status: 500, message: err instanceof Error ? err.message : 'The word was not saved' }
  }
}

async function mergeInto(
  supabase: SupabaseClient,
  existing: VocabularyTerm,
  add: { soundsLike: string[]; status: VocabularyStatus; source: VocabularySource; evidence?: VocabularyEvidence },
): Promise<WriteResult> {
  // Turning a word off for oneself (status dismissed) never switches off one that is on.
  if (add.status === 'dismissed' && existing.status === 'active' && existing.source !== 'auto') {
    return { ok: true, term: existing, created: false, note: 'already_active' }
  }
  const merged = normalizeSoundsLike([...existing.soundsLike, ...add.soundsLike], existing.term)
  const patch: Record<string, unknown> = { sounds_like: merged }
  if (add.status !== existing.status) {
    patch.status = add.status
    patch.source = add.source
  } else if (existing.source === 'workspace' && (add.source === 'manual' || add.source === 'agent')) {
    // A person adding a harvested word makes it theirs: the harvest no longer removes it.
    patch.source = add.source
  }
  const unchanged = patch.status === undefined && patch.source === undefined && merged.length === existing.soundsLike.length
  if (unchanged) return { ok: true, term: existing, created: false, note: existing.status === 'active' ? 'already_active' : 'merged' }
  const { data, error } = await supabase
    .from('vocabulary_term')
    .update(patch)
    .eq('id', existing.id)
    .eq('workspace_id', existing.workspaceId)
    .select(ROW_COLUMNS)
    .single()
  if (error) return { ok: false, status: 500, message: error.message }
  return { ok: true, term: toTerm(data as Record<string, unknown>), created: false, note: 'merged' }
}

export interface UpdateTermInput {
  workspaceId: string
  userId: string
  id: string
  term?: unknown
  soundsLike?: unknown
  status?: unknown
  scope?: unknown
}

/** Edit a word: rewrite it, its "sounds like" forms, its status (on / off) or who owns it. */
export async function updateVocabularyTerm(supabase: SupabaseClient, input: UpdateTermInput): Promise<WriteResult> {
  try {
    const existing = await getVocabularyTerm(supabase, input)
    if (!existing) return { ok: false, status: 404, message: 'That word is not in this workspace’s vocabulary' }
    const patch: Record<string, unknown> = {}
    let term = existing.term
    if (input.term !== undefined) {
      const checked = normalizeTerm(input.term)
      if (!checked.ok) return { ok: false, status: 400, message: termProblem(checked.reason) }
      term = checked.term
      patch.term = term
    }
    if (input.soundsLike !== undefined || patch.term !== undefined) {
      patch.sounds_like = normalizeSoundsLike(input.soundsLike !== undefined ? input.soundsLike : existing.soundsLike, term)
    }
    if (input.status !== undefined) {
      if (!VOCABULARY_STATUSES.includes(input.status as VocabularyStatus)) return { ok: false, status: 400, message: 'status must be active or dismissed' }
      patch.status = input.status
    }
    if (input.scope !== undefined) {
      if (input.scope !== 'workspace' && input.scope !== 'personal') return { ok: false, status: 400, message: 'scope must be workspace or personal' }
      patch.user_id = input.scope === 'personal' ? input.userId : null
    }
    if (!Object.keys(patch).length) return { ok: true, term: existing, created: false }
    const { data, error } = await supabase
      .from('vocabulary_term')
      .update(patch)
      .eq('id', input.id)
      .eq('workspace_id', input.workspaceId)
      .or(ownerFilter(input.userId))
      .select(ROW_COLUMNS)
      .maybeSingle()
    if (error) {
      if (error.code === '23505') return { ok: false, status: 409, message: `“${term}” is already in that vocabulary` }
      return { ok: false, status: 500, message: error.message }
    }
    if (!data) return { ok: false, status: 404, message: 'That word is not in this workspace’s vocabulary' }
    return { ok: true, term: toTerm(data as Record<string, unknown>), created: false }
  } catch (err) {
    return { ok: false, status: 500, message: err instanceof Error ? err.message : 'The word was not saved' }
  }
}

export async function deleteVocabularyTerm(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; id: string },
): Promise<{ ok: true; deleted: boolean } | { ok: false; message: string }> {
  const { data, error } = await supabase
    .from('vocabulary_term')
    .delete()
    .eq('id', args.id)
    .eq('workspace_id', args.workspaceId)
    .or(ownerFilter(args.userId))
    .select('id')
  if (error) return { ok: false, message: error.message }
  return { ok: true, deleted: (data ?? []).length > 0 }
}

// ── automatic names ─────────────────────────────────────────────────────────

const cleanName = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null
  const s = raw.replace(/\s+/g, ' ').trim()
  if (!s || s.length > VOCABULARY_TERM_MAX_CHARS || !letters(s) || s.includes('@')) return null
  // Not a name anyone says: internal ids (__default__), placeholders, and contacts
  // named after an email address (stephanie.guerreiro.1, dl-d-usallfield, vrolland).
  if (s.includes('_') || /\p{L}\.\p{L}/u.test(s) || /^untitled\b/i.test(s)) return null
  if (/^[\x20-\x7e]+$/.test(s) && !/[A-Z]/.test(s)) return null
  return s
}

/**
 * Names Native Intelligence already knows, live without setup (Liam, 2026-10-24: trusted
 * sources go live automatically): teammates, projects, and the person's
 * workspace-visible or own contacts with their companies, most recently
 * active first. Never another member's private or team-only contact: the
 * fence is explicit because this may run on a service-role client.
 */
export async function automaticVocabulary(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; limit?: number },
): Promise<AutomaticTerm[]> {
  const limit = args.limit ?? AUTOMATIC_TERM_LIMIT
  const out: AutomaticTerm[] = []
  const seen = new Set<string>()
  const lexicon = await loadLexicon()
  const push = (raw: unknown, kind: AutomaticKind) => {
    const term = cleanName(raw)
    if (!term) return
    // Made only of everyday words ("Daily", "Get a dog"): transcription already writes
    // those, and the corrector would never apply them, so they are not listed.
    if (term.split(' ').every((w) => isOrdinary(w, lexicon))) return
    const key = letters(term)
    if (seen.has(key)) return
    seen.add(key)
    out.push({ term, kind })
  }

  const [members, projects] = await Promise.all([
    supabase.from('member').select('id, user_id, display_name').eq('workspace_id', args.workspaceId).limit(500),
    supabase.from('projects').select('name').eq('workspace_id', args.workspaceId).eq('is_archived', false).limit(500),
  ])
  const memberRows = (members.data ?? []) as Array<{ id: string; user_id: string | null; display_name: string | null }>
  for (const m of memberRows) push(m.display_name, 'teammate')
  for (const p of (projects.data ?? []) as Array<{ name: string | null }>) push(p.name, 'project')

  const viewerMemberId = memberRows.find((m) => m.user_id === args.userId)?.id ?? null
  const visibility = viewerMemberId ? `visibility.eq.workspace,created_by_member_id.eq.${viewerMemberId}` : 'visibility.eq.workspace'
  const contacts = await supabase
    .from('contact')
    .select('full_name, company:company_id(name)')
    .eq('workspace_id', args.workspaceId)
    .is('merged_into_contact_id', null)
    .or(visibility)
    .order('last_interaction_at', { ascending: false, nullsFirst: false })
    .limit(limit)
  for (const c of (contacts.data ?? []) as Array<{ full_name: string | null; company: { name?: string | null } | Array<{ name?: string | null }> | null }>) {
    if (out.length >= limit) break
    push(c.full_name, 'contact')
    const company = Array.isArray(c.company) ? c.company[0] : c.company
    push(company?.name, 'company')
  }
  return out.slice(0, limit)
}

// ── what transcription uses ─────────────────────────────────────────────────

export interface CompiledVocabulary {
  entries: VocabularyEntry[]
  /** Changes whenever the entries do (the client's cache key). */
  version: string
  counts: { stored: number; automatic: number }
}

function hash(s: string): string {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}

/**
 * Everything transcription should know for this person in this workspace: the
 * active words (theirs and the workspace's) with their "sounds like" forms,
 * plus the automatic names nobody turned off.
 */
export async function compileVocabulary(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string },
): Promise<CompiledVocabulary> {
  const [stored, automatic] = await Promise.all([
    listVocabulary(supabase, args),
    automaticVocabulary(supabase, args).catch(() => [] as AutomaticTerm[]),
  ])
  // A person's "turn off" of an automatic name (or of a harvested word) is a dismissed 'auto' row.
  const hidden = new Set(stored.filter((t) => t.status === 'dismissed' && t.source === 'auto').map((t) => letters(t.term)))
  // One spelling per word (Liam, 2026-10-25: "kokolink" won over the project KokoLink):
  // a word someone added (yours, then the workspace's) wins; otherwise a spelling with a
  // capital beats one without, then how the team writes it beats a name record (contacts'
  // company names are often auto-cased: the team writes "AKQA", the record says "Akqa"),
  // then the person's own writing. Every spelling's "sounds like" forms stay with the word.
  const rank = (t: VocabularyTerm | null): number => {
    if (!t) return 3
    if (t.source === 'manual' || t.source === 'agent') return t.scope === 'personal' ? 0 : 1
    return t.scope === 'workspace' ? 2 : 4
  }
  const outranks = (term: string, r: number, prev: { term: string; rank: number }) => {
    const added = (x: number) => (x <= 1 ? x : 2)
    if (added(r) !== added(prev.rank)) return added(r) < added(prev.rank)
    const cap = (t: string) => (/[A-Z]/.test(t) ? 0 : 1)
    if (cap(term) !== cap(prev.term)) return cap(term) < cap(prev.term)
    return r < prev.rank
  }
  const groups = new Map<string, { term: string; rank: number; soundsLike: string[]; automatic: boolean }>()
  const offer = (term: string, r: number, soundsLike: readonly string[], automatic: boolean) => {
    const key = letters(term)
    const prev = groups.get(key)
    if (!prev) {
      groups.set(key, { term, rank: r, soundsLike: [...soundsLike], automatic })
      return
    }
    prev.soundsLike.push(...soundsLike)
    if (outranks(term, r, prev)) Object.assign(prev, { term, rank: r, automatic })
  }
  for (const t of stored) {
    if (t.status !== 'active') continue
    if (t.source === 'workspace' && hidden.has(letters(t.term))) continue
    offer(t.term, rank(t), t.soundsLike, false)
  }
  for (const a of automatic) {
    if (hidden.has(letters(a.term))) continue
    offer(a.term, rank(null), [], true)
  }
  const chosen = [...groups.values()].sort((a, b) => a.rank - b.rank || (a.term < b.term ? -1 : a.term > b.term ? 1 : 0))
  const entries: VocabularyEntry[] = chosen.map((g) =>
    g.soundsLike.length ? { term: g.term, soundsLike: [...new Set(g.soundsLike)] } : g.automatic ? { term: g.term } : { term: g.term, soundsLike: [] },
  )
  const automaticCount = chosen.filter((g) => g.automatic).length
  const version = hash(JSON.stringify(entries))
  return { entries, version, counts: { stored: entries.length - automaticCount, automatic: automaticCount } }
}
