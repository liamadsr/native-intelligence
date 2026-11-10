/**
 * A teammate's memory across work runs (plan Part 5 row 15, Part 4), without
 * eve's memory slot: Native Intelligence recalls a teammate's entries into the brief at the
 * start of its run, and asks for a summary when a run settles. The summariser
 * is agent-memory-summary.ts, run by the Inngest function in
 * src/lib/inngest/agent-memory-functions.ts; the table is agent_memory
 * (migration 289, service role only).
 *
 * Recall is fail-soft, like the brief's other optional fields: a failed read
 * leaves `memory` out and the run proceeds as before.
 *
 * Apply with undo (Liam, 2026-10-20: "They should all just be accepted. If
 * there's something that I think is incorrect, I have the option to just
 * remove it."): every entry is active at once, with no queue to accept from.
 * One a run learned after reading untrusted outside text (migration 374:
 * agent_run.outside_reads) records those tools (source.outside_reads), so
 * What Native Intelligence has learned labels it ("learned from a web page") for an owner
 * or admin to spot and remove. They remove (and restore) any entry:
 * settleMemoryEntry, behind /api/account/agent-memory. A teammate's memory is
 * read by every member's runs of it, so it is workspace-scope, like area
 * notes' workspace lines. What a person is shown is fenced by capture
 * visibility exactly as recall is (visibleCaptureIdsFor).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { applyCaptureVisibility } from '@/lib/ai/tools/_shared'
import { inngest } from '@/lib/inngest/client'
import type { CallerClass } from '@/lib/safety/caller'

export const MEMORY_KINDS = ['fact', 'preference', 'lesson'] as const
export type MemoryKind = (typeof MEMORY_KINDS)[number]

/** Entries one recall reads, most reinforced then newest first. */
export const MEMORY_RECALL_LIMIT = 30
/** The recalled entries' text, in all, stays under this. */
export const MEMORY_RECALL_MAX_CHARS = 4_000
/** One entry's text (the table's check constraint). */
export const MEMORY_TEXT_MAX_CHARS = 500
/** Entries one run may add. */
export const MEMORY_MAX_PER_RUN = 3
/** Active entries kept per teammate; the least reinforced, oldest are retired past it. */
export const MEMORY_ACTIVE_CAP = 100

export const AGENT_MEMORY_SUMMARIZE_EVENT = 'agent-memory/summarize'

/** One recalled entry, as the brief carries it. */
export interface BriefMemory {
  kind: MemoryKind
  text: string
}

/** agent_memory.source */
export interface AgentMemorySource {
  work_item_id?: string | null
  entities?: Array<{ type: string; id: string }>
  /** Every capture the teaching run read or came from. */
  capture_ids?: string[]
  /** The trust class of who asked for the teaching run (caller.ts runStarterClass). */
  trust?: CallerClass
  /** The teaching run's agent_run.origin. */
  origin?: string | null
  /** The tools that brought untrusted outside text into the teaching run (outside-text.ts), when it read any: the entry's label. */
  outside_reads?: string[]
}

interface MemoryRow {
  id: string
  kind: string
  text: string
  source: AgentMemorySource | null
}

/**
 * The teammate's active entries for the brief, for a run whose user is
 * `userId`. An entry learned from a capture that user cannot see is left out
 * (a private capture's fact never reaches someone it is hidden from; a
 * capture that is gone counts as unseen). Stamps last_recalled_at on what it
 * returns. Undefined when there is nothing to recall or a read fails.
 */
export async function loadTeammateMemory(
  supabase: SupabaseClient,
  args: { workspaceId: string; teammateId: string; userId: string | null },
): Promise<BriefMemory[] | undefined> {
  try {
    const { data, error } = await supabase
      .from('agent_memory')
      .select('id, kind, text, source')
      .eq('workspace_id', args.workspaceId)
      .eq('ai_team_member_id', args.teammateId)
      .eq('status', 'active')
      .order('salience', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(MEMORY_RECALL_LIMIT)
    if (error || !data || data.length === 0) return undefined
    const rows = data as MemoryRow[]

    // A failed read shows nothing learned from a capture (fails closed).
    const visible = await visibleCaptureIdsFor(supabase, {
      workspaceId: args.workspaceId,
      userId: args.userId,
      captureIds: rows.flatMap((r) => captureIdsOf(r.source)),
    })

    const out: Array<BriefMemory & { id: string }> = []
    let chars = 0
    for (const row of rows) {
      if (!(MEMORY_KINDS as readonly string[]).includes(row.kind)) continue
      if (!captureIdsOf(row.source).every((id) => visible.has(id))) continue
      if (chars + row.text.length > MEMORY_RECALL_MAX_CHARS) break
      chars += row.text.length
      out.push({ id: row.id, kind: row.kind as MemoryKind, text: row.text })
    }
    if (out.length === 0) return undefined

    await supabase
      .from('agent_memory')
      .update({ last_recalled_at: new Date().toISOString() })
      .in('id', out.map((m) => m.id))
    return out.map(({ kind, text }) => ({ kind, text }))
  } catch {
    return undefined
  }
}

function captureIdsOf(source: AgentMemorySource | null): string[] {
  const ids = source?.capture_ids
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && id.length > 0) : []
}

type MemorySend = (payload: { id: string; name: string; data: Record<string, unknown> }) => Promise<unknown>

/**
 * A completed work run done as a teammate asks for its summary. Best-effort
 * and never throws: a lost request only means this run teaches nothing. The
 * event id makes a replayed settle ask once.
 */
export async function requestMemorySummary(
  ref: { agentRunId: string; workspaceId: string; teammateId: string | null },
  deps: { send?: MemorySend } = {},
): Promise<void> {
  if (!ref.teammateId) return
  try {
    const send: MemorySend = deps.send ?? ((p) => inngest.send(p as never))
    await send({
      id: `agent-memory:${ref.agentRunId}`,
      name: AGENT_MEMORY_SUMMARIZE_EVENT,
      data: { agent_run_id: ref.agentRunId, workspace_id: ref.workspaceId, ai_team_member_id: ref.teammateId },
    })
  } catch (err) {
    console.error('[agent-memory] summary request failed:', err instanceof Error ? err.message : err)
  }
}

/**
 * Of `captureIds`, the ones `userId` may see (the captures read every product
 * surface uses: workspace-visible, or their own private one; eval captures
 * never). A capture that is gone counts as unseen, and a failed read sees
 * nothing (fails closed). Recall, the teammate-memory list and every settle
 * use it, so nothing learned from a capture reaches someone it is hidden from.
 */
export async function visibleCaptureIdsFor(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string | null; captureIds: readonly string[] },
): Promise<Set<string>> {
  const ids = [...new Set(args.captureIds)]
  if (ids.length === 0) return new Set()
  const { data, error } = await applyCaptureVisibility(
    supabase.from('captures').select('id').eq('workspace_id', args.workspaceId).in('id', ids),
    args.userId,
  )
  if (error) return new Set()
  return new Set(((data ?? []) as Array<{ id: string }>).map((c) => c.id))
}

/** True when every capture an entry was learned from is in `visible`. */
function learnedFromVisible(source: AgentMemorySource | null, visible: ReadonlySet<string>): boolean {
  return captureIdsOf(source).every((id) => visible.has(id))
}

/**
 * Past MEMORY_ACTIVE_CAP active entries, retire the least reinforced, oldest.
 * `keep` (an entry just restored) is never one of them: it holds one of the
 * cap's places. Returns how many were retired.
 */
export async function retireMemoryOverflow(
  supabase: SupabaseClient,
  ref: { workspaceId: string; teammateId: string; keep?: string },
): Promise<number> {
  let query = supabase
    .from('agent_memory')
    .select('id')
    .eq('workspace_id', ref.workspaceId)
    .eq('ai_team_member_id', ref.teammateId)
    .eq('status', 'active')
  if (ref.keep) query = query.neq('id', ref.keep)
  const from = ref.keep ? MEMORY_ACTIVE_CAP - 1 : MEMORY_ACTIVE_CAP
  const { data: overflow } = await query
    .order('salience', { ascending: false })
    .order('created_at', { ascending: false })
    .range(from, from + 199)
  const overflowIds = ((overflow ?? []) as Array<{ id: string }>).map((r) => r.id).filter((id) => id !== ref.keep)
  if (overflowIds.length === 0) return 0
  const { data: gone } = await supabase.from('agent_memory').update({ status: 'retired' }).in('id', overflowIds).select('id')
  return (gone ?? []).length
}

/** One entry of a teammate's memory, as an owner or admin sees it. */
export interface TeammateMemoryEntry {
  id: string
  teammateId: string
  kind: MemoryKind
  text: string
  /** The trust class of who asked for the run that learned it. */
  trust: CallerClass | null
  /** The run's origin. */
  origin: string | null
  /** The tools that brought outside text into its run (empty: none): what its label says. */
  outsideReads: string[]
  agentRunId: string | null
  createdAt: string
}

interface EntryRow {
  id: string
  ai_team_member_id: string
  kind: string
  text: string
  source: AgentMemorySource | null
  agent_run_id: string | null
  created_at: string
}

const ENTRY_COLUMNS = 'id, ai_team_member_id, kind, text, source, agent_run_id, created_at'

/** The tools on an entry's source that brought outside text into its run. Pure. */
export function outsideReadsOf(source: AgentMemorySource | null): string[] {
  const reads = source?.outside_reads
  return Array.isArray(reads) ? reads.filter((t): t is string => typeof t === 'string' && t.length > 0) : []
}

/**
 * A workspace's teammate memory for `viewerUserId`: the active entries,
 * newest first, at most `limit` (default 100). An entry learned from a
 * capture the viewer can't see is left out, as recall leaves it out.
 * Service-role client; the caller checks the viewer may manage the
 * workspace's memory. Throws on a failed read.
 */
export async function listTeammateMemory(
  supabase: SupabaseClient,
  args: { workspaceId: string; viewerUserId: string; limit?: number },
): Promise<{ entries: TeammateMemoryEntry[] }> {
  const limit = Math.min(args.limit ?? 100, 200)
  const { data, error } = await supabase
    .from('agent_memory')
    .select(ENTRY_COLUMNS)
    .eq('workspace_id', args.workspaceId)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error('agent_memory read failed')
  const rows = ((data ?? []) as EntryRow[]).filter((r) => (MEMORY_KINDS as readonly string[]).includes(r.kind))
  const visible = await visibleCaptureIdsFor(supabase, {
    workspaceId: args.workspaceId,
    userId: args.viewerUserId,
    captureIds: rows.flatMap((r) => captureIdsOf(r.source)),
  })
  return {
    entries: rows
      .filter((r) => learnedFromVisible(r.source, visible))
      .map((r) => ({
        id: r.id,
        teammateId: r.ai_team_member_id,
        kind: r.kind as MemoryKind,
        text: r.text,
        trust: r.source?.trust ?? null,
        origin: r.source?.origin ?? null,
        outsideReads: outsideReadsOf(r.source),
        agentRunId: r.agent_run_id,
        createdAt: r.created_at,
      })),
  }
}

export const MEMORY_ENTRY_ACTIONS = ['remove', 'restore'] as const
export type MemoryEntryAction = (typeof MEMORY_ENTRY_ACTIONS)[number]

export type SettleEntryResult =
  | { ok: true; status: 'active' | 'retired'; retired: number }
  | { ok: false; code: 'NOT_FOUND' | 'ALREADY_SETTLED'; error: string }

/** What each action moves an entry from and to. */
const MOVES: Record<MemoryEntryAction, { from: string; to: 'active' | 'retired' }> = {
  remove: { from: 'active', to: 'retired' },
  restore: { from: 'retired', to: 'active' },
}

const normalizeText = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim()

/**
 * An owner or admin removes one entry of a teammate's memory, or restores it
 * (the route checks who may):
 *   remove  an active entry → retired, never recalled again;
 *   restore a removed entry → active again (the Undo), unless an active entry
 *           already says the same. It is never the one retired past the cap.
 * Compare-and-swap on the status. An entry learned from a capture
 * `viewerUserId` can't see is not found for them. Service-role client,
 * fenced to the workspace.
 */
export async function settleMemoryEntry(
  supabase: SupabaseClient,
  args: { workspaceId: string; viewerUserId: string; id: string; action: MemoryEntryAction },
): Promise<SettleEntryResult> {
  const move = Object.hasOwn(MOVES, args.action) ? MOVES[args.action] : undefined
  if (!move) return { ok: false, code: 'NOT_FOUND', error: 'No such entry.' }
  const { data: row } = await supabase
    .from('agent_memory')
    .select('id, ai_team_member_id, status, text, source')
    .eq('id', args.id)
    .eq('workspace_id', args.workspaceId)
    .maybeSingle<{ id: string; ai_team_member_id: string; status: string; text: string; source: AgentMemorySource | null }>()
  if (!row) return { ok: false, code: 'NOT_FOUND', error: 'No such entry.' }
  const visible = await visibleCaptureIdsFor(supabase, { workspaceId: args.workspaceId, userId: args.viewerUserId, captureIds: captureIdsOf(row.source) })
  if (!learnedFromVisible(row.source, visible)) return { ok: false, code: 'NOT_FOUND', error: 'No such entry.' }
  if (row.status !== move.from) return { ok: false, code: 'ALREADY_SETTLED', error: `This entry is ${row.status}.` }

  // Restoring: never twice the same thing.
  if (move.to === 'active') {
    const { data: same } = await supabase
      .from('agent_memory')
      .select('id, text')
      .eq('workspace_id', args.workspaceId)
      .eq('ai_team_member_id', row.ai_team_member_id)
      .eq('status', 'active')
      .limit(MEMORY_ACTIVE_CAP + 50)
    const mine = normalizeText(row.text)
    if (((same ?? []) as Array<{ id: string; text: string }>).some((r) => r.id !== row.id && normalizeText(r.text) === mine)) {
      return { ok: false, code: 'ALREADY_SETTLED', error: 'An active entry already says this.' }
    }
  }

  const { data: moved } = await supabase
    .from('agent_memory')
    .update({ status: move.to })
    .eq('id', row.id)
    .eq('workspace_id', args.workspaceId)
    .eq('status', move.from)
    .select('id')
  if (!(moved ?? []).length) return { ok: false, code: 'ALREADY_SETTLED', error: 'This entry was already changed.' }
  if (move.to === 'retired') return { ok: true, status: 'retired', retired: 0 }
  const retired = await retireMemoryOverflow(supabase, { workspaceId: args.workspaceId, teammateId: row.ai_team_member_id, keep: row.id })
  return { ok: true, status: 'active', retired }
}
