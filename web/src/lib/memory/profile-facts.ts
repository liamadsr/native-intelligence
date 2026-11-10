/**
 * Facts about you (docs/plans/always-on-agent.md §3, slice A2a; migration
 * 328): the profile tier. One person's facts, shared across every workspace
 * they work in and readable by nobody else.
 *
 * The capture rule (decision 2): how you work (style, preferences, habits,
 * how you like answers) is a profile fact and follows you; what you work on
 * (names, clients, deals, projects) stays in that workspace as a personal
 * area line (src/lib/packs/memory-write.ts).
 *
 * The one writer `remember` (scope 'profile'), the editor's routes and, later,
 * the capture pass (A2c) all go through, mirroring saveMemoryLine:
 *   - a told or typed fact is active at once, and so is a learned one (Liam,
 *     2026-10-17: learning on by default; it keeps its `learned` source so
 *     What Native Intelligence has learned marks it "Native Intelligence noticed this", with a one-tap
 *     remove). Only `proposeOnly` saves a proposal the person accepts;
 *   - the same fact twice is saved once (`already`), except that restating a
 *     proposal accepts it, so what the person says always ends up loading;
 *   - at most PROFILE_FACTS_MAX_ACTIVE active facts in about
 *     PROFILE_FACTS_MAX_CHARS characters, at most PROFILE_LEARNED_MAX of them
 *     learned, and at most PROFILE_PROPOSALS_MAX proposals waiting;
 *   - never a secret (memoryTextProblem) and never contact details
 *     (hasContactDetails): a fact is about how they work, not how to reach them.
 *
 * Callers on the service role (the `remember` tool, the internal memory route)
 * skip RLS and the guard, so every read and write here is fenced to the
 * person's own rows (`user_id`), never left to the database alone.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { hasContactDetails, memoryTextProblem, normalizeMemoryText, MEMORY_LINE_MAX_CHARS } from '@/lib/packs/memory-types'

/** The most ACTIVE facts one person has. */
export const PROFILE_FACTS_MAX_ACTIVE = 100
/** About how many characters of active facts one person has (what the chat carries). */
export const PROFILE_FACTS_MAX_CHARS = 4_000
/** The most proposals waiting for one person, so they can't pile up. */
export const PROFILE_PROPOSALS_MAX = 20
/**
 * The most live facts Native Intelligence learned (source `learned`) one person has. They go
 * live without being accepted (2026-10-17), so this keeps what Native Intelligence noticed
 * from filling the room meant for what the person said: the same allowance
 * its proposals had. Removing one makes room.
 */
export const PROFILE_LEARNED_MAX = PROFILE_PROPOSALS_MAX
/** The longest fact: migration 328's CHECK, the same as an area line. */
export const PROFILE_FACT_MAX_CHARS = MEMORY_LINE_MAX_CHARS
/** The importance a fact gets when none is given (1 least, 5 most). */
export const PROFILE_FACT_DEFAULT_IMPORTANCE = 3

export const PROFILE_FACT_STATUSES = ['active', 'proposed'] as const
export type ProfileFactStatus = (typeof PROFILE_FACT_STATUSES)[number]
export type ProfileFactSource = 'told' | 'learned' | 'edited'

/** One fact, as the editor, the chip and the routes see it. */
export interface ProfileFact {
  id: string
  text: string
  status: ProfileFactStatus
  source: ProfileFactSource
  importance: number
  source_workspace_id: string | null
  created_at: string
  updated_at: string
}

/** The columns a fact is read back with. */
export const PROFILE_FACT_COLUMNS = 'id, text, status, source, importance, source_workspace_id, created_at, updated_at'

/** A fact as the chat's memory record carries it (and the epoch snapshot stores it). */
export interface RecalledFact {
  id: string
  text: string
}

export type ProfileFactErrorCode = 'INPUT_INVALID' | 'PROFILE_FULL' | 'TOO_MANY_PROPOSALS' | 'NOT_FOUND' | 'DUPLICATE' | 'SAVE_FAILED'
export type ProfileFactResult =
  | { ok: true; fact: ProfileFact; already: boolean }
  | { ok: false; code: ProfileFactErrorCode; error: string }

/** Postgres' unique violation: migration 328's one-live-fact-per-text index. */
const UNIQUE_VIOLATION = '23505'
const isUniqueViolation = (error: { code?: string } | null | undefined) => error?.code === UNIQUE_VIOLATION
const DUPLICATE_ERROR = 'The person already has that fact.'

/** Live facts read to judge a save: every active fact and proposal, with room to spare. */
const READ_LIMIT = 500

const FULL_FIX = 'Ask the person to delete or merge some in What Native Intelligence has learned (Settings → Memory), About you, first.'

/**
 * Why a fact can't be saved, in words that name the fix, or null when it can.
 * memoryTextProblem's rules (empty, too long, a secret), plus no contact
 * details. Shared by the tool, the routes and the editor.
 */
export function profileFactProblem(text: string): string | null {
  const problem = memoryTextProblem(text)
  if (problem) return problem.replace('the preference itself', 'the fact itself')
  if (hasContactDetails(text)) {
    return 'That holds an email address, link or phone number. A fact about the person says how they work, never how to reach them or anyone else.'
  }
  return null
}

/** A clamped importance, 1..5. */
export function clampImportance(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : PROFILE_FACT_DEFAULT_IMPORTANCE
  return Math.min(5, Math.max(1, n))
}

const sameText = (a: string, b: string) => normalizeMemoryText(a).toLowerCase() === normalizeMemoryText(b).toLowerCase()

/** The person's live (not retired) facts, active and proposed. */
async function liveFacts(supabase: SupabaseClient, userId: string): Promise<{ facts: ProfileFact[]; error: string | null }> {
  const { data, error } = await supabase
    .from('profile_fact')
    .select(PROFILE_FACT_COLUMNS)
    .eq('user_id', userId)
    .is('retired_at', null)
    .limit(READ_LIMIT)
  return { facts: (data ?? []) as ProfileFact[], error: error ? error.message : null }
}

/** Would one more active fact of `text` (replacing `replacing`) break the caps? A message, or null. */
function capProblem(active: readonly ProfileFact[], text: string, replacing?: string): string | null {
  const others = active.filter((f) => f.id !== replacing)
  if (others.length >= PROFILE_FACTS_MAX_ACTIVE) {
    return `The person already has ${PROFILE_FACTS_MAX_ACTIVE} facts about them. ${FULL_FIX}`
  }
  const chars = others.reduce((n, f) => n + f.text.length, 0)
  if (chars + text.length > PROFILE_FACTS_MAX_CHARS) {
    return `The person's facts already hold about ${PROFILE_FACTS_MAX_CHARS} characters. ${FULL_FIX}`
  }
  return null
}

/**
 * Save one fact about the person. Told, typed or learned (the capture pass):
 * active at once, a learned one within PROFILE_LEARNED_MAX. Restating a
 * proposal (told or typed) accepts it. `proposeOnly` (a `remember` in a turn
 * that read outside text, or a replacement the person didn't verify): a
 * proposal whatever its source, and restating one never accepts it.
 *
 * Two saves of the same text racing: the second insert hits migration 328's
 * one-live-fact-per-text index and comes back as the first one (`already`).
 */
export async function saveProfileFact(
  supabase: SupabaseClient,
  args: {
    userId: string
    text: string
    source: ProfileFactSource
    importance?: number
    /** Where it was said: provenance only, never a read scope. */
    sourceWorkspaceId?: string | null
    /** Save as a proposal the person accepts, never active. */
    proposeOnly?: boolean
  },
): Promise<ProfileFactResult> {
  const text = normalizeMemoryText(args.text)
  const problem = profileFactProblem(text)
  if (problem) return { ok: false, code: 'INPUT_INVALID', error: problem }

  const { facts, error: readError } = await liveFacts(supabase, args.userId)
  if (readError) return { ok: false, code: 'SAVE_FAILED', error: readError }
  const active = facts.filter((f) => f.status === 'active')

  const same = facts.find((f) => sameText(f.text, text))
  if (same) {
    if (same.status !== 'proposed' || args.source === 'learned' || args.proposeOnly) return { ok: true, fact: same, already: true }
    // Saying what was proposed accepts it.
    const full = capProblem(active, same.text)
    if (full) return { ok: false, code: 'PROFILE_FULL', error: full }
    const { data, error } = await supabase
      .from('profile_fact')
      // Accepted on the person's own words: it is now theirs (told, or edited).
      .update({ status: 'active', source: args.source })
      .eq('id', same.id)
      .eq('user_id', args.userId)
      .eq('status', 'proposed')
      .select(PROFILE_FACT_COLUMNS)
    const fact = ((data ?? []) as ProfileFact[])[0]
    if (error || !fact) return { ok: false, code: 'SAVE_FAILED', error: error?.message ?? 'The fact was not saved.' }
    return { ok: true, fact, already: false }
  }

  const status: ProfileFactStatus = args.proposeOnly ? 'proposed' : 'active'
  if (status === 'active') {
    const full = capProblem(active, text)
    if (full) return { ok: false, code: 'PROFILE_FULL', error: full }
    if (args.source === 'learned' && active.filter((f) => f.source === 'learned').length >= PROFILE_LEARNED_MAX) {
      return { ok: false, code: 'PROFILE_FULL', error: `The person already has ${PROFILE_LEARNED_MAX} facts Native Intelligence noticed. ${FULL_FIX}` }
    }
  } else if (facts.filter((f) => f.status === 'proposed').length >= PROFILE_PROPOSALS_MAX) {
    return {
      ok: false,
      code: 'TOO_MANY_PROPOSALS',
      error: `${PROFILE_PROPOSALS_MAX} facts already wait for the person to accept or dismiss them.`,
    }
  }

  const { data: row, error } = await supabase
    .from('profile_fact')
    .insert({
      user_id: args.userId,
      text,
      status,
      source: args.source,
      importance: clampImportance(args.importance),
      source_workspace_id: args.sourceWorkspaceId ?? null,
    })
    .select(PROFILE_FACT_COLUMNS)
    .maybeSingle()
  if (isUniqueViolation(error)) return alreadyThere(supabase, args.userId, text)
  if (error || !row) return { ok: false, code: 'SAVE_FAILED', error: error?.message ?? 'The fact was not saved.' }
  return { ok: true, fact: row as ProfileFact, already: false }
}

/** The live fact with this text, after a unique violation said one exists (`already`). */
async function alreadyThere(supabase: SupabaseClient, userId: string, text: string): Promise<ProfileFactResult> {
  const { facts, error } = await liveFacts(supabase, userId)
  const same = facts.find((f) => sameText(f.text, text))
  if (error || !same) return { ok: false, code: 'SAVE_FAILED', error: error ?? 'The fact was not saved.' }
  return { ok: true, fact: same, already: true }
}

/** Edit a fact's text and/or importance. A changed fact is `edited`. */
export async function editProfileFact(
  supabase: SupabaseClient,
  args: { userId: string; id: string; text?: string; importance?: number },
): Promise<ProfileFactResult> {
  const { facts, error: readError } = await liveFacts(supabase, args.userId)
  if (readError) return { ok: false, code: 'SAVE_FAILED', error: readError }
  const current = facts.find((f) => f.id === args.id)
  if (!current) return { ok: false, code: 'NOT_FOUND', error: 'No such fact about you.' }

  const patch: Record<string, unknown> = {}
  if (args.text !== undefined) {
    const text = normalizeMemoryText(args.text)
    const problem = profileFactProblem(text)
    if (problem) return { ok: false, code: 'INPUT_INVALID', error: problem }
    if (facts.some((f) => f.id !== current.id && sameText(f.text, text))) return { ok: false, code: 'DUPLICATE', error: DUPLICATE_ERROR }
    if (current.status === 'active') {
      const full = capProblem(facts.filter((f) => f.status === 'active'), text, current.id)
      if (full) return { ok: false, code: 'PROFILE_FULL', error: full }
    }
    patch.text = text
    patch.source = 'edited'
  }
  if (args.importance !== undefined) patch.importance = clampImportance(args.importance)
  if (Object.keys(patch).length === 0) return { ok: false, code: 'INPUT_INVALID', error: 'Send text or importance to change.' }

  const { data, error } = await supabase
    .from('profile_fact')
    .update(patch)
    .eq('id', args.id)
    .eq('user_id', args.userId)
    .is('retired_at', null)
    .select(PROFILE_FACT_COLUMNS)
  const fact = ((data ?? []) as ProfileFact[])[0]
  if (isUniqueViolation(error)) return { ok: false, code: 'DUPLICATE', error: DUPLICATE_ERROR }
  if (error) return { ok: false, code: 'SAVE_FAILED', error: error.message }
  if (!fact) return { ok: false, code: 'NOT_FOUND', error: 'No such fact about you.' }
  return { ok: true, fact, already: false }
}

/** Accept a proposal: it becomes active, within the caps. */
export async function acceptProfileFact(supabase: SupabaseClient, args: { userId: string; id: string }): Promise<ProfileFactResult> {
  const { facts, error: readError } = await liveFacts(supabase, args.userId)
  if (readError) return { ok: false, code: 'SAVE_FAILED', error: readError }
  const current = facts.find((f) => f.id === args.id && f.status === 'proposed')
  if (!current) return { ok: false, code: 'NOT_FOUND', error: 'No such proposal: it may already be accepted or dismissed.' }
  const full = capProblem(facts.filter((f) => f.status === 'active'), current.text)
  if (full) return { ok: false, code: 'PROFILE_FULL', error: full }
  const { data, error } = await supabase
    .from('profile_fact')
    .update({ status: 'active' })
    .eq('id', args.id)
    .eq('user_id', args.userId)
    .eq('status', 'proposed')
    .select(PROFILE_FACT_COLUMNS)
  const fact = ((data ?? []) as ProfileFact[])[0]
  if (error) return { ok: false, code: 'SAVE_FAILED', error: error.message }
  if (!fact) return { ok: false, code: 'NOT_FOUND', error: 'No such proposal: it may already be accepted or dismissed.' }
  return { ok: true, fact, already: false }
}

/**
 * Delete a fact (the editor's delete, the chip's Undo), or with
 * `onlyProposed` dismiss a proposal. Ok when it is gone.
 */
export async function deleteProfileFact(
  supabase: SupabaseClient,
  args: { userId: string; id: string; onlyProposed?: boolean },
): Promise<{ ok: true } | { ok: false; code: 'NOT_FOUND' | 'SAVE_FAILED'; error: string }> {
  let read = supabase.from('profile_fact').select('id, status').eq('id', args.id).eq('user_id', args.userId)
  if (args.onlyProposed) read = read.eq('status', 'proposed')
  const { data: found, error: readError } = await read.maybeSingle()
  if (readError) return { ok: false, code: 'SAVE_FAILED', error: readError.message }
  if (!found) return { ok: false, code: 'NOT_FOUND', error: 'No such fact about you.' }
  let del = supabase.from('profile_fact').delete().eq('id', args.id).eq('user_id', args.userId)
  if (args.onlyProposed) del = del.eq('status', 'proposed')
  const { error } = await del
  if (error) return { ok: false, code: 'SAVE_FAILED', error: error.message }
  return { ok: true }
}

/**
 * Pick what the chat carries from active facts: the most important first, then
 * the newest, within PROFILE_FACTS_MAX_ACTIVE facts and about
 * PROFILE_FACTS_MAX_CHARS characters. A fact that doesn't fit is skipped (a
 * shorter one may still fit). Pure; the order out is the order shown.
 */
export function selectProfileFacts(
  facts: ReadonlyArray<Pick<ProfileFact, 'id' | 'text' | 'importance' | 'updated_at'>>,
): RecalledFact[] {
  const ranked = [...facts].sort(
    (a, b) =>
      clampImportance(b.importance) - clampImportance(a.importance) ||
      (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
  const out: RecalledFact[] = []
  let left = PROFILE_FACTS_MAX_CHARS
  for (const f of ranked) {
    if (out.length >= PROFILE_FACTS_MAX_ACTIVE) break
    if (f.text.length > left) continue
    out.push({ id: f.id, text: f.text })
    left -= f.text.length
  }
  return out
}

/**
 * The person's active facts as the chat carries them (selectProfileFacts).
 * Throws on a failed read: the memory route decides what a failure returns.
 */
export async function loadProfileFacts(supabase: SupabaseClient, userId: string): Promise<RecalledFact[]> {
  const { data, error } = await supabase
    .from('profile_fact')
    .select('id, text, importance, updated_at')
    .eq('user_id', userId)
    .eq('status', 'active')
    .is('retired_at', null)
    .order('importance', { ascending: false })
    .order('updated_at', { ascending: false })
    .limit(READ_LIMIT)
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as Array<{ id: unknown; text: unknown; importance: unknown; updated_at: unknown }>
  return selectProfileFacts(
    rows
      .filter((r) => typeof r.id === 'string' && typeof r.text === 'string')
      .map((r) => ({ id: r.id as string, text: r.text as string, importance: Number(r.importance), updated_at: String(r.updated_at ?? '') })),
  )
}

/**
 * Replace an ACTIVE fact with a new text (the capture pass's replacement of a
 * fact it was shown): the new fact is inserted, active, keeping the old one's
 * importance, and the old one is retired (`superseded_by` and `retired_at`), the way a
 * teammate's agent_memory entry is superseded. Restating another live fact
 * retires the old one onto that fact instead. Within the caps (the old fact's
 * room is freed first).
 */
export async function supersedeProfileFact(
  supabase: SupabaseClient,
  args: { userId: string; id: string; text: string; source: Exclude<ProfileFactSource, 'learned'>; sourceWorkspaceId?: string | null },
): Promise<ProfileFactResult> {
  const text = normalizeMemoryText(args.text)
  const problem = profileFactProblem(text)
  if (problem) return { ok: false, code: 'INPUT_INVALID', error: problem }
  const { facts, error: readError } = await liveFacts(supabase, args.userId)
  if (readError) return { ok: false, code: 'SAVE_FAILED', error: readError }
  const old = facts.find((f) => f.id === args.id && f.status === 'active')
  if (!old) return { ok: false, code: 'NOT_FOUND', error: 'No such active fact about you.' }
  if (sameText(old.text, text)) return { ok: true, fact: old, already: true }

  const retire = async (byId: string) => {
    const { error } = await supabase
      .from('profile_fact')
      .update({ superseded_by: byId, retired_at: new Date().toISOString() })
      .eq('id', old.id)
      .eq('user_id', args.userId)
      .is('retired_at', null)
    return error
  }

  /** Whether the old fact did retire onto `byId` (re-read: a write can commit and still report an error). */
  const retiredOnto = async (byId: string): Promise<boolean> => {
    const { data } = await supabase.from('profile_fact').select('superseded_by').eq('id', old.id).eq('user_id', args.userId).maybeSingle()
    return (data as { superseded_by?: unknown } | null)?.superseded_by === byId
  }

  const same = facts.find((f) => f.id !== old.id && sameText(f.text, text))
  if (same && same.status === 'active') {
    const error = await retire(same.id)
    if (error) return { ok: false, code: 'SAVE_FAILED', error: error.message }
    return { ok: true, fact: same, already: true }
  }
  if (same) {
    // The new text waits as a proposal: accepting it is the replacement (within
    // the caps, the old fact's room freed), then the old fact retires onto it.
    const full = capProblem(facts.filter((f) => f.status === 'active'), same.text, old.id)
    if (full) return { ok: false, code: 'PROFILE_FULL', error: full }
    const { data, error } = await supabase
      .from('profile_fact')
      // A replacement is only ever made on the person's verified words: the
      // accepted proposal is now theirs (told), no longer something learned.
      .update({ status: 'active', source: args.source })
      .eq('id', same.id)
      .eq('user_id', args.userId)
      .eq('status', 'proposed')
      .is('retired_at', null)
      .select(PROFILE_FACT_COLUMNS)
    const accepted = ((data ?? []) as ProfileFact[])[0]
    if (error || !accepted) return { ok: false, code: 'SAVE_FAILED', error: error?.message ?? 'The proposal could not be accepted.' }
    const retireError = await retire(accepted.id)
    if (retireError && !(await retiredOnto(accepted.id))) {
      // Never two live versions: put the proposal back as it was.
      const { error: revertError } = await supabase
        .from('profile_fact')
        .update({ status: 'proposed', source: same.source })
        .eq('id', accepted.id)
        .eq('user_id', args.userId)
      return {
        ok: false,
        code: 'SAVE_FAILED',
        error: revertError ? `${retireError.message}; and the proposal could not be put back: ${revertError.message}` : retireError.message,
      }
    }
    return { ok: true, fact: accepted, already: false }
  }

  const full = capProblem(facts.filter((f) => f.status === 'active'), text, old.id)
  if (full) return { ok: false, code: 'PROFILE_FULL', error: full }
  const { data: row, error } = await supabase
    .from('profile_fact')
    .insert({
      user_id: args.userId,
      text,
      status: 'active',
      source: args.source,
      importance: clampImportance(old.importance),
      source_workspace_id: args.sourceWorkspaceId ?? old.source_workspace_id ?? null,
    })
    .select(PROFILE_FACT_COLUMNS)
    .maybeSingle()
  if (isUniqueViolation(error)) {
    // Saved meanwhile by another writer: retire the old fact onto that one.
    const there = await alreadyThere(supabase, args.userId, text)
    if (!there.ok) return there
    const retireError = await retire(there.fact.id)
    if (retireError) return { ok: false, code: 'SAVE_FAILED', error: retireError.message }
    return there
  }
  if (error || !row) return { ok: false, code: 'SAVE_FAILED', error: error?.message ?? 'The fact was not saved.' }
  const fact = row as ProfileFact
  const retireError = await retire(fact.id)
  // The retire may have committed and still reported an error: look before
  // undoing anything.
  if (retireError && !(await retiredOnto(fact.id))) {
    // Never two live versions: the new row goes when the old one can't retire.
    const { error: undoError } = await supabase.from('profile_fact').delete().eq('id', fact.id).eq('user_id', args.userId)
    return {
      ok: false,
      code: 'SAVE_FAILED',
      error: undoError ? `${retireError.message}; and the new fact could not be removed: ${undoError.message}` : retireError.message,
    }
  }
  return { ok: true, fact, already: false }
}

/**
 * Soft-retire a live fact (the capture pass's verified removal): it stops
 * loading but stays on record (`retired_at`), unlike the person's own delete.
 */
export async function retireProfileFact(
  supabase: SupabaseClient,
  args: { userId: string; id: string },
): Promise<{ ok: true } | { ok: false; code: 'NOT_FOUND' | 'SAVE_FAILED'; error: string }> {
  const { data, error } = await supabase
    .from('profile_fact')
    .update({ retired_at: new Date().toISOString() })
    .eq('id', args.id)
    .eq('user_id', args.userId)
    .is('retired_at', null)
    .select('id')
  if (error) return { ok: false, code: 'SAVE_FAILED', error: error.message }
  if (!data || data.length === 0) return { ok: false, code: 'NOT_FOUND', error: 'No such live fact.' }
  return { ok: true }
}

/**
 * Rewrite a PROPOSAL's text (the capture pass refining what it suggested):
 * still a proposal, still its source, nothing the person did. A proposal the
 * person already accepted is left alone (NOT_FOUND).
 */
export async function reviseProposedFact(
  supabase: SupabaseClient,
  args: { userId: string; id: string; text: string },
): Promise<ProfileFactResult> {
  const text = normalizeMemoryText(args.text)
  const problem = profileFactProblem(text)
  if (problem) return { ok: false, code: 'INPUT_INVALID', error: problem }
  const { data, error } = await supabase
    .from('profile_fact')
    .update({ text })
    .eq('id', args.id)
    .eq('user_id', args.userId)
    .eq('status', 'proposed')
    .is('retired_at', null)
    .select(PROFILE_FACT_COLUMNS)
  if (isUniqueViolation(error)) return { ok: false, code: 'DUPLICATE', error: DUPLICATE_ERROR }
  if (error) return { ok: false, code: 'SAVE_FAILED', error: error.message }
  const fact = ((data ?? []) as ProfileFact[])[0]
  if (!fact) return { ok: false, code: 'NOT_FOUND', error: 'No such proposal.' }
  return { ok: true, fact, already: false }
}
