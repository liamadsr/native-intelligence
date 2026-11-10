/**
 * The settle-time summariser for a teammate's memory (plan row 15, Part 4.2
 * writer 1). A completed work run done as a teammate is read back, summarised
 * on the utility agent into at most MEMORY_MAX_PER_RUN durable entries, and
 * written to agent_memory. The Inngest function that runs it is
 * src/lib/inngest/agent-memory-functions.ts; recall is agent-memory.ts.
 *
 * What the model sees (Part 4.3): the task, the run's own summary, its
 * deliverables' labels (never their contents), what kinds of things it
 * touched, and what the teammate already remembers. Its prompt refuses draft
 * or message contents, what was sent, the run's own outcome and secrets.
 * Every capture the run read or came from is recorded on the entries, so
 * recall can hide an entry from a user who cannot see one of them.
 *
 * Apply with undo (Liam, 2026-10-20; decision 16): every run's entries are
 * written ACTIVE, recorded with the run that taught them (agent_run_id), its
 * origin and the trust class of who asked for it (source.origin,
 * source.trust), and an owner or admin can remove any one
 * (settleMemoryEntry, agent-memory.ts). A run that read untrusted outside
 * text (agent_run.outside_reads, migration 374; src/lib/safety/outside-text.ts:
 * the web, a connected app, an attachment or ingest, mail from a sender the
 * person doesn't know) records those tools on its entries
 * (source.outside_reads), so What Native Intelligence has learned labels them ("learned
 * from a web page") for the person to spot and remove. Nothing waits to be
 * accepted.
 */
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import type { WorkProvenance } from './types'
import {
  MEMORY_KINDS,
  MEMORY_MAX_PER_RUN,
  MEMORY_RECALL_LIMIT,
  MEMORY_TEXT_MAX_CHARS,
  retireMemoryOverflow,
  type AgentMemorySource,
  type MemoryKind,
} from './agent-memory'
import { isCallerClass, runStarterClass, type CallerClass } from '@/lib/safety/caller'
import { outsideToolsInLog } from '@/lib/safety/outside-text'

/** The model's answer. Lenient on count and length: the writer clamps both. */
export const MemorySummarySchema = z.object({
  entries: z.array(
    z.object({
      kind: z.enum(MEMORY_KINDS),
      text: z.string(),
      /** The key of an entry it restates or corrects (m1, m2, …), or null. */
      replaces: z.string().nullable(),
    }),
  ),
})
export type MemorySummary = z.infer<typeof MemorySummarySchema>

/** Characters of the task the model sees. */
const TASK_MAX_CHARS = 3_000
/** Touched entities recorded on each entry. */
const ENTITIES_MAX = 12

export interface ExistingMemory {
  id: string
  kind: MemoryKind
  text: string
  salience: number
}

export interface SummaryInput {
  agentRunId: string
  workspaceId: string
  teammateId: string
  /** The run's user (agent_run.triggered_by): usage is theirs. */
  userId: string | null
  teammate: { name: string; role: string | null }
  task: string
  summary: string
  deliverables: Array<{ type: string; label: string }>
  touches: Array<{ type: string; id: string; verb: string }>
  workItemId: string | null
  captureIds: string[]
  existing: ExistingMemory[]
  /**
   * Who asked for the run (caller.ts runStarterClass, from agent_run.origin),
   * recorded on its entries. Absent (an input loaded before this existed):
   * unattended.
   */
  sourceClass?: CallerClass
  /** agent_run.origin, recorded on its entries. */
  origin?: string | null
  /**
   * The tools that brought untrusted outside text into the run
   * (outside-text.ts), recorded on its entries for their label.
   */
  outsideReads?: string[]
}

export type SummaryLoad = { skip: string } | { input: SummaryInput }

/**
 * Read a settled run back for its summary. Skips a run that is not a
 * completed work run done as this teammate, and one already summarised.
 */
export async function loadSummaryInput(
  supabase: SupabaseClient,
  ref: { agentRunId: string; workspaceId: string; teammateId: string },
): Promise<SummaryLoad> {
  const { data: run } = await supabase
    .from('agent_run')
    .select('id, kind, status, origin, outside_reads, log_tail, ai_team_member_id, triggered_by, task_prompt, result_summary, deliverables, resources')
    .eq('id', ref.agentRunId)
    .eq('workspace_id', ref.workspaceId)
    .maybeSingle()
  if (!run) return { skip: 'run not found' }
  if (run.kind !== 'workspace' || run.status !== 'completed') return { skip: 'not a completed work run' }
  if (run.ai_team_member_id !== ref.teammateId) return { skip: 'teammate changed' }

  const { data: done } = await supabase.from('agent_memory').select('id').eq('agent_run_id', ref.agentRunId).limit(1)
  if (done && done.length > 0) return { skip: 'already summarised' }

  const { data: mate } = await supabase
    .from('ai_team_member')
    .select('name, role')
    .eq('id', ref.teammateId)
    .eq('workspace_id', ref.workspaceId)
    .maybeSingle()
  if (!mate?.name) return { skip: 'teammate not found' }

  // What outside text the run read: its record (migration 374), and, should a
  // note have been lost, any outside-text tool its log tail names.
  const outsideReads = [
    ...new Set([
      ...(Array.isArray(run.outside_reads) ? (run.outside_reads as unknown[]).filter((t): t is string => typeof t === 'string') : []),
      ...outsideToolsInLog(run.log_tail),
    ]),
  ]

  const [{ data: touchRows }, { data: job }, { data: existingRows }] = await Promise.all([
    supabase
      .from('work_touch')
      .select('entity_type, entity_id, verb')
      .eq('agent_run_id', ref.agentRunId)
      .eq('workspace_id', ref.workspaceId)
      .limit(200),
    supabase
      .from('tracked_job')
      .select('id, source')
      .eq('agent_run_id', ref.agentRunId)
      .eq('workspace_id', ref.workspaceId)
      .maybeSingle(),
    supabase
      .from('agent_memory')
      .select('id, kind, text, salience')
      .eq('workspace_id', ref.workspaceId)
      .eq('ai_team_member_id', ref.teammateId)
      .eq('status', 'active')
      .order('salience', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(MEMORY_RECALL_LIMIT),
  ])

  const touches: SummaryInput['touches'] = []
  const seen = new Set<string>()
  for (const t of (touchRows ?? []) as Array<{ entity_type: string; entity_id: string; verb: string }>) {
    const key = `${t.entity_type}:${t.entity_id}:${t.verb}`
    if (seen.has(key)) continue
    seen.add(key)
    touches.push({ type: t.entity_type, id: t.entity_id, verb: t.verb })
  }

  const provenance = (job?.source as { provenance?: WorkProvenance } | null)?.provenance
  const resources = Array.isArray(run.resources) ? (run.resources as Array<{ type?: unknown; id?: unknown }>) : []
  const captureIds = [
    ...new Set(
      [
        ...touches.filter((t) => t.type === 'capture').map((t) => t.id),
        ...resources.filter((r) => r.type === 'capture' && typeof r.id === 'string').map((r) => r.id as string),
        ...(typeof provenance?.captureId === 'string' && provenance.captureId ? [provenance.captureId] : []),
      ].filter(Boolean),
    ),
  ]

  const deliverables = (Array.isArray(run.deliverables) ? (run.deliverables as Array<{ type?: unknown; label?: unknown }>) : [])
    .filter((d) => typeof d.type === 'string' && typeof d.label === 'string')
    .map((d) => ({ type: d.type as string, label: d.label as string }))

  return {
    input: {
      agentRunId: ref.agentRunId,
      workspaceId: ref.workspaceId,
      teammateId: ref.teammateId,
      userId: (run.triggered_by as string | null) ?? null,
      teammate: { name: mate.name as string, role: (mate.role as string | null) ?? null },
      task: ((run.task_prompt as string | null) ?? '').slice(0, TASK_MAX_CHARS),
      summary: (run.result_summary as string | null) ?? '',
      deliverables,
      touches,
      workItemId: (job?.id as string | null) ?? null,
      captureIds,
      existing: ((existingRows ?? []) as ExistingMemory[]).filter((m) => (MEMORY_KINDS as readonly string[]).includes(m.kind)),
      sourceClass: runStarterClass((run.origin as string | null | undefined) ?? null),
      origin: (run.origin as string | null | undefined) ?? null,
      outsideReads,
    },
  }
}

/** What the teammate touched, counted by verb and entity type ("wrote 1 document"). */
function touchLines(touches: SummaryInput['touches']): string[] {
  const counts = new Map<string, number>()
  for (const t of touches) counts.set(`${t.verb} ${t.type}`, (counts.get(`${t.verb} ${t.type}`) ?? 0) + 1)
  return [...counts].map(([k, n]) => {
    const [verb, type] = k.split(' ')
    return `- ${verb} ${n} ${type}${n === 1 ? '' : 's'}`
  })
}

/** The utility task's message: the finished work as data, then what is already remembered. */
export function buildSummaryMessage(input: SummaryInput): string {
  const role = input.teammate.role ? ` (${input.teammate.role})` : ''
  const lines = [
    `Teammate: ${input.teammate.name}${role}`,
    '',
    '## The task it was given',
    input.task.trim() || '(none)',
    '',
    '## What it reported when it finished',
    input.summary.trim() || '(nothing)',
    '',
    '## What it handed back (labels only)',
    ...(input.deliverables.length > 0 ? input.deliverables.map((d) => `- ${d.type}: ${d.label}`) : ['(nothing)']),
    '',
    '## What it touched',
    ...(input.touches.length > 0 ? touchLines(input.touches) : ['(nothing recorded)']),
    '',
    '## What it already remembers',
    ...(input.existing.length > 0 ? input.existing.map((m, i) => `m${i + 1} [${m.kind}] ${m.text}`) : ['(nothing yet)']),
  ]
  return lines.join('\n')
}

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

export interface MemoryWriteResult {
  inserted: number
  superseded: number
  retired: number
  alreadyWritten?: boolean
}

/**
 * Write the model's entries. At most MEMORY_MAX_PER_RUN, each clamped to one
 * line of MEMORY_TEXT_MAX_CHARS; one that repeats a remembered entry (or
 * another in the same answer) is dropped. An entry that `replaces` a
 * remembered one supersedes it and carries its salience + 1. Past
 * MEMORY_ACTIVE_CAP active entries the least reinforced, oldest are retired.
 * A run whose entries are already written is not written again. A run that
 * read outside text records which tools on every entry (source.outside_reads).
 */
export async function applyMemorySummary(
  supabase: SupabaseClient,
  input: SummaryInput,
  summary: MemorySummary,
): Promise<MemoryWriteResult> {
  const { data: done } = await supabase.from('agent_memory').select('id').eq('agent_run_id', input.agentRunId).limit(1)
  if (done && done.length > 0) return { inserted: 0, superseded: 0, retired: 0, alreadyWritten: true }

  const trust: CallerClass = isCallerClass(input.sourceClass) ? input.sourceClass : 'agent_unattended'
  const outsideReads = Array.isArray(input.outsideReads) ? [...new Set(input.outsideReads.filter((t) => typeof t === 'string' && t))].slice(0, 20) : []
  const remembered = new Set(input.existing.map((m) => normalize(m.text)))
  const replacedIds = new Set<string>()
  const rows: Array<{ replaces: ExistingMemory | null; row: Record<string, unknown> }> = []
  const source: AgentMemorySource = {
    work_item_id: input.workItemId,
    entities: input.touches
      .filter((t, i, all) => all.findIndex((o) => o.type === t.type && o.id === t.id) === i)
      .slice(0, ENTITIES_MAX)
      .map((t) => ({ type: t.type, id: t.id })),
    capture_ids: input.captureIds,
    trust,
    origin: input.origin ?? null,
    ...(outsideReads.length ? { outside_reads: outsideReads } : {}),
  }

  for (const entry of summary.entries) {
    if (rows.length >= MEMORY_MAX_PER_RUN) break
    const text = entry.text.replace(/\s+/g, ' ').trim().slice(0, MEMORY_TEXT_MAX_CHARS)
    if (!text || remembered.has(normalize(text))) continue
    remembered.add(normalize(text))
    const key = /^m(\d+)$/.exec((entry.replaces ?? '').trim())
    let replaces: ExistingMemory | null = key ? (input.existing[Number(key[1]) - 1] ?? null) : null
    if (replaces && replacedIds.has(replaces.id)) replaces = null
    if (replaces) replacedIds.add(replaces.id)
    rows.push({
      replaces,
      row: {
        id: randomUUID(),
        workspace_id: input.workspaceId,
        ai_team_member_id: input.teammateId,
        agent_run_id: input.agentRunId,
        kind: entry.kind,
        text,
        source,
        salience: replaces ? replaces.salience + 1 : 1,
        status: 'active',
      },
    })
  }
  if (rows.length === 0) return { inserted: 0, superseded: 0, retired: 0 }

  const { error } = await supabase.from('agent_memory').insert(rows.map((r) => r.row))
  if (error) throw new Error(`agent_memory insert failed: ${error.message}`)

  let superseded = 0
  for (const { replaces: old, row } of rows) {
    if (!old) continue
    const { data: moved } = await supabase
      .from('agent_memory')
      .update({ status: 'superseded', superseded_by: row.id })
      .eq('id', old.id)
      .eq('status', 'active')
      .select('id')
    superseded += (moved ?? []).length
  }

  const retired = await retireMemoryOverflow(supabase, { workspaceId: input.workspaceId, teammateId: input.teammateId })
  return { inserted: rows.length, superseded, retired }
}
