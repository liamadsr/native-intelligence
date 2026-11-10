/**
 * Saving a line of what Native Intelligence has learned (migration 317). The one writer the
 * `remember` tool and the editor's add both go through, so the scope rules
 * read the same everywhere:
 *
 *   - a personal line is the caller's, active at once;
 *   - a workspace line is active when an owner or admin adds it, else it is
 *     proposed and waits for one of them;
 *   - the same line twice in one note is saved once: the existing line comes
 *     back (`already`), except that restating a PROPOSED line someone may
 *     activate (their own, or the workspace's as an owner or admin) accepts
 *     it, so what the person says always ends up loading;
 *   - a note holds at most MEMORY_NOTE_MAX_LINES active lines, and at most
 *     MEMORY_PROPOSALS_PER_AUTHOR proposals from any one author (Native Intelligence counts
 *     as one), so proposals can't crowd out what is real.
 *
 * What Native Intelligence learns on its own goes through learnMemoryLine below.
 *
 * The tool runs on the service role, which skips RLS and the guard, so these
 * rules are applied here, never left to the database alone. The editor's
 * route calls this with the person's own session, where the database holds
 * them again.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { PACKS, type AreaKey } from './registry'
import {
  MEMORY_LEARNED_PER_NOTE,
  MEMORY_NOTE_MAX_LINES,
  MEMORY_PROPOSALS_PER_AUTHOR,
  canManageWorkspaceMemory,
  hasContactDetails,
  memoryTextProblem,
  normalizeMemoryText,
  type MemoryLine,
  type MemoryScope,
  type MemorySource,
} from './memory-types'

/** The columns a line is read back with. */
export const MEMORY_LINE_COLUMNS = 'id, area, scope, status, source, text, created_by, created_at, updated_at'

export type SaveMemoryResult =
  | { ok: true; line: MemoryLine; already: boolean }
  | { ok: false; code: 'NOT_MEMBER' | 'INPUT_INVALID' | 'NOTE_FULL' | 'TOO_MANY_PROPOSALS' | 'SAVE_FAILED'; error: string }

/** Lines read to judge a note: its active lines and every author's proposals, with room to spare. */
const NOTE_READ_LIMIT = 1_000

/** The caller's role in the workspace, or null when they aren't a member. */
export async function memberRole(supabase: SupabaseClient, workspaceId: string, userId: string): Promise<string | null> {
  const { data } = await supabase
    .from('member')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle<{ role: string | null }>()
  return data?.role ?? null
}

/** A note's lines: this workspace and area, and for a personal note only this user's. */
function noteQuery(supabase: SupabaseClient, args: { workspaceId: string; userId: string; area: AreaKey; scope: MemoryScope }) {
  const q = supabase
    .from('area_memory')
    .select(MEMORY_LINE_COLUMNS)
    .eq('workspace_id', args.workspaceId)
    .eq('area', args.area)
    .eq('scope', args.scope)
  return args.scope === 'personal' ? q.eq('user_id', args.userId) : q
}

export type LearnMemoryResult =
  | { ok: true; line: MemoryLine | null; already: boolean }
  | { ok: false; code: 'NOT_MEMBER' | 'INPUT_INVALID' | 'NOTE_FULL' | 'TOO_MANY_LEARNED' | 'TOO_MANY_PROPOSALS' | 'SAVE_FAILED'; error: string }

/**
 * Add a line on the server's behalf (the capture pass, A2c):
 *   - a personal `learned` line (inferred: Native Intelligence noticed it) is ACTIVE at
 *     once, keeps its `learned` source so the editor marks it "Native Intelligence noticed
 *     this", and has no author. Learning is on by default (Liam, 2026-10-17):
 *     the person removes what is wrong with one tap instead of accepting
 *     what is right. At most MEMORY_LEARNED_PER_NOTE such lines in a note,
 *     within MEMORY_NOTE_MAX_LINES active lines;
 *   - a workspace line (every member reads it) is a PROPOSAL for an owner or
 *     admin (open question 10), even when the person it came from is one: a
 *     `learned` one has no author and shares one MEMORY_PROPOSALS_PER_AUTHOR
 *     allowance per note; a `told` one is theirs and counts against theirs;
 *   - a personal `told` line (said outright, evidence not verified) waits as
 *     the person's own proposal, as before;
 *   - the same line already in the note (any status) is not added again;
 *   - never a secret, and never contact details.
 * Service role only: the guard lets only the server write `learned`.
 */
export async function learnMemoryLine(
  supabase: SupabaseClient,
  args: {
    workspaceId: string
    userId: string
    area: AreaKey
    scope: MemoryScope
    text: string
    source: 'told' | 'learned'
  },
): Promise<LearnMemoryResult> {
  const text = normalizeMemoryText(args.text)
  const problem = memoryTextProblem(text) ?? (hasContactDetails(text) ? 'That holds an email address, link or phone number: a remembered line says how someone works, never how to reach anyone.' : null)
  if (problem) return { ok: false, code: 'INPUT_INVALID', error: problem }

  const role = await memberRole(supabase, args.workspaceId, args.userId)
  if (!role) return { ok: false, code: 'NOT_MEMBER', error: 'Not a member of this workspace.' }

  const { data: existing, error: readError } = await noteQuery(supabase, args).limit(NOTE_READ_LIMIT)
  if (readError) return { ok: false, code: 'SAVE_FAILED', error: readError.message }
  const lines = (existing ?? []) as MemoryLine[]
  const same = lines.find((l) => normalizeMemoryText(l.text).toLowerCase() === text.toLowerCase())
  if (same) return { ok: true, line: same, already: true }

  const author = args.source === 'learned' ? null : args.userId
  const live = args.scope === 'personal' && args.source === 'learned'
  if (live) {
    if (lines.filter((l) => l.status === 'active').length >= MEMORY_NOTE_MAX_LINES) {
      return { ok: false, code: 'NOTE_FULL', error: `This note already has ${MEMORY_NOTE_MAX_LINES} lines.` }
    }
    if (lines.filter((l) => l.source === 'learned' && l.created_by === null).length >= MEMORY_LEARNED_PER_NOTE) {
      return { ok: false, code: 'TOO_MANY_LEARNED', error: `${MEMORY_LEARNED_PER_NOTE} lines Native Intelligence noticed are already in this note.` }
    }
  } else if (lines.filter((l) => l.status === 'proposed' && l.created_by === author).length >= MEMORY_PROPOSALS_PER_AUTHOR) {
    return { ok: false, code: 'TOO_MANY_PROPOSALS', error: `${MEMORY_PROPOSALS_PER_AUTHOR} proposals already wait in this note.` }
  }

  const { data: row, error } = await supabase
    .from('area_memory')
    .insert({
      workspace_id: args.workspaceId,
      area: args.area,
      scope: args.scope,
      user_id: args.scope === 'personal' ? args.userId : null,
      text,
      status: live ? 'active' : 'proposed',
      source: args.source,
      created_by: author,
      updated_by: author,
    })
    .select(MEMORY_LINE_COLUMNS)
    .maybeSingle()
  if (error || !row) return { ok: false, code: 'SAVE_FAILED', error: error?.message ?? 'The line was not saved.' }
  return { ok: true, line: row as MemoryLine, already: false }
}

export async function saveMemoryLine(
  supabase: SupabaseClient,
  args: {
    workspaceId: string
    userId: string
    area: AreaKey
    scope: MemoryScope
    text: string
    source: Exclude<MemorySource, 'learned'>
  },
): Promise<SaveMemoryResult> {
  const text = normalizeMemoryText(args.text)
  const problem = memoryTextProblem(text)
  if (problem) return { ok: false, code: 'INPUT_INVALID', error: problem }

  const role = await memberRole(supabase, args.workspaceId, args.userId)
  if (!role) return { ok: false, code: 'NOT_MEMBER', error: 'You are not a member of this workspace.' }

  const { data: existing, error: readError } = await noteQuery(supabase, args).limit(NOTE_READ_LIMIT)
  if (readError) return { ok: false, code: 'SAVE_FAILED', error: readError.message }
  const lines = (existing ?? []) as MemoryLine[]
  const mayActivate = args.scope === 'personal' || canManageWorkspaceMemory(role)
  const where = args.scope === 'personal' ? 'your' : "the workspace's"
  const noteFull = (): SaveMemoryResult => ({
    ok: false,
    code: 'NOTE_FULL',
    error: `${where} ${PACKS[args.area].name} note already has ${MEMORY_NOTE_MAX_LINES} lines. Ask the person to delete or merge some in What Native Intelligence has learned (Settings → Memory) first.`,
  })
  const activeCount = lines.filter((l) => l.status === 'active').length

  const same = lines.find((l) => normalizeMemoryText(l.text).toLowerCase() === text.toLowerCase())
  if (same) {
    if (same.status !== 'proposed' || !mayActivate) return { ok: true, line: same, already: true }
    // Saying what was proposed accepts it.
    if (activeCount >= MEMORY_NOTE_MAX_LINES) return noteFull()
    const { data: accepted, error: acceptError } = await supabase
      .from('area_memory')
      .update({ status: 'active', source: args.source, updated_by: args.userId })
      .eq('id', same.id)
      .eq('status', 'proposed')
      .select(MEMORY_LINE_COLUMNS)
    const line = ((accepted ?? []) as MemoryLine[])[0]
    if (acceptError || !line) return { ok: false, code: 'SAVE_FAILED', error: acceptError?.message ?? 'The line was not saved.' }
    return { ok: true, line, already: false }
  }

  const status = mayActivate ? 'active' : 'proposed'
  if (status === 'active' && activeCount >= MEMORY_NOTE_MAX_LINES) return noteFull()
  if (status === 'proposed' && lines.filter((l) => l.status === 'proposed' && l.created_by === args.userId).length >= MEMORY_PROPOSALS_PER_AUTHOR) {
    return {
      ok: false,
      code: 'TOO_MANY_PROPOSALS',
      error: `You already have ${MEMORY_PROPOSALS_PER_AUTHOR} proposals waiting in the workspace's ${PACKS[args.area].name} note. Ask an owner or admin to accept or dismiss some in What Native Intelligence has learned (Settings → Memory) first.`,
    }
  }

  const { data: row, error } = await supabase
    .from('area_memory')
    .insert({
      workspace_id: args.workspaceId,
      area: args.area,
      scope: args.scope,
      user_id: args.scope === 'personal' ? args.userId : null,
      text,
      status,
      source: args.source,
      created_by: args.userId,
      updated_by: args.userId,
    })
    .select(MEMORY_LINE_COLUMNS)
    .maybeSingle()
  if (error || !row) return { ok: false, code: 'SAVE_FAILED', error: error?.message ?? 'The line was not saved.' }
  return { ok: true, line: row as MemoryLine, already: false }
}
