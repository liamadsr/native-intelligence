/**
 * What a canon edit came from (eve-alignment.md §6 decision 16, as Liam
 * settled it on 2026-10-20: "The agent should just go ahead and do it… Just
 * give me the option to undo it"). Nothing here holds an edit: every agent
 * edit to a canon document applies at once (canon-edit.ts), lands in the
 * history with its sources and one digest line, and can be reverted. This
 * module decides only how that edit is LABELLED, so the person can spot what
 * rests on untrusted outside text and undo it: "(from a web page)" on the
 * digest line and the history (canonOutsideLabel).
 *
 * What the run READ counts, never only what the model CITES: a cited capture
 * or document id proves nothing, because an injected run can cite any row it
 * can list. So an edit is labelled outside when:
 *   - a source it names is outside text (an email from someone the person
 *     doesn't know, a web page, a non-member's message, a file, a connected
 *     app's data); or
 *   - the turn belongs to a run that read untrusted outside text
 *     (agent_run.outside_reads, 374), whatever it cites; or
 *   - it is an unattended turn with no run to check (fail closed).
 * A person's own conversation is the source of an edit made in it. Sources
 * are kept for the history (who it came from), and an email's sender is
 * checked against the people the person knows only to say whether that one
 * source is outside text.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { knownSenders } from '@/lib/agent-events/known-senders'
import { emailDomain, outsideReadLabel, outsideSourceLabel } from '@/lib/safety/outside-label'

export const CANON_SOURCE_KINDS = ['capture', 'chat', 'document', 'claim', 'action', 'project', 'email', 'web', 'message', 'file', 'connected_app'] as const
export type CanonSourceKind = (typeof CANON_SOURCE_KINDS)[number]

/** One thing an edit came from, as the agent names it (kept for the history and its label). */
export interface CanonSource {
  kind: CanonSourceKind
  /** The row's id (capture, document, claim, action, project). */
  id?: string
  /** The sender's address (email). */
  from?: string
  /** The page (web). */
  url?: string
  /** A short note: which part, who said it. */
  note?: string
}

export type SourceTrust = 'trusted' | 'outside' | 'unverified'

/** The table each id-backed kind is checked in. */
const ID_TABLES: Partial<Record<CanonSourceKind, string>> = {
  capture: 'captures',
  document: 'document',
  claim: 'claim',
  action: 'actions',
  project: 'projects',
}

const ALWAYS_OUTSIDE: ReadonlySet<CanonSourceKind> = new Set(['web', 'message', 'file', 'connected_app'])

/** At most this many sources are kept on a revision. */
export const MAX_CANON_SOURCES = 10

/** Sources as the agent sent them, cleaned: known kinds, short strings, at most 10. Pure. */
export function normalizeCanonSources(value: unknown): CanonSource[] {
  if (!Array.isArray(value)) return []
  const out: CanonSource[] = []
  const clip = (v: unknown, n: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : undefined)
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    if (!(CANON_SOURCE_KINDS as readonly string[]).includes(r.kind as string)) continue
    const source: CanonSource = { kind: r.kind as CanonSourceKind }
    const id = clip(r.id, 64)
    const from = clip(r.from, 320)
    const url = clip(r.url, 500)
    const note = clip(r.note, 200)
    if (id) source.id = id
    if (from) source.from = from.toLowerCase()
    if (url) source.url = url
    if (note) source.note = note
    out.push(source)
    if (out.length >= MAX_CANON_SOURCES) break
  }
  return out
}

export interface TrustContext {
  /** A person is in the conversation (the main chat, a follow-up chat turn, their own MCP client). */
  attended: boolean
  /** The run read untrusted outside text (agent_run.outside_reads not empty). */
  runReadOutsideText: boolean
}

/** What outside text the turn's run read: whether any, and which tools when known. */
export interface TurnOutsideReads {
  read: boolean
  tools: string[]
}

/**
 * What outside text the turn read: the run's own record when the turn
 * belongs to a run (attended or not); otherwise yes for an unattended turn
 * (nothing to check, so fail closed) and no for a person's own conversation.
 */
export async function turnOutsideReads(
  supabase: SupabaseClient,
  ctx: { workspaceId: string; attended: boolean; runId: string | null | undefined },
): Promise<TurnOutsideReads> {
  if (ctx.runId) {
    const tools = await runOutsideReadTools(supabase, ctx.workspaceId, ctx.runId)
    return tools === null ? { read: true, tools: [] } : { read: tools.length > 0, tools }
  }
  return { read: !ctx.attended, tools: [] }
}

/** The tools that brought outside text into a run (agent_run.outside_reads), or null when the read failed. */
async function runOutsideReadTools(supabase: SupabaseClient, workspaceId: string, agentRunId: string): Promise<string[] | null> {
  try {
    const { data, error } = await supabase.from('agent_run').select('outside_reads').eq('id', agentRunId).eq('workspace_id', workspaceId).maybeSingle()
    if (error) return null
    const reads = (data as { outside_reads?: unknown } | null)?.outside_reads
    return Array.isArray(reads) ? reads.filter((t): t is string => typeof t === 'string') : []
  } catch {
    return null
  }
}

/** Whether a run read untrusted outside text (agent_run.outside_reads). Fails closed: a failed read says yes. */
export async function runReadOutsideText(supabase: SupabaseClient, workspaceId: string, agentRunId: string | null | undefined): Promise<boolean> {
  if (!agentRunId) return false
  const tools = await runOutsideReadTools(supabase, workspaceId, agentRunId)
  return tools === null || tools.length > 0
}

/**
 * The outside text an edit rests on, in a few words for its history and its
 * digest line ("a web page on acme.com", "an outside email from acme.com"), or
 * null when it rests on none: the first source named that is outside text,
 * else what the run read (outsideReadLabel). Only a kind and a domain, never
 * an address. Pure.
 */
export function canonOutsideLabel(
  sources: readonly CanonSource[],
  trust: readonly SourceTrust[],
  reads: { read: boolean; tools?: readonly string[] },
): string | null {
  const i = trust.findIndex((t) => t === 'outside')
  if (i >= 0 && sources[i]) {
    const s = sources[i]
    const domain = s.kind === 'email' ? (emailDomain(s.from) ?? undefined) : undefined
    return outsideSourceLabel({ kind: s.kind, ...(s.url ? { url: s.url } : {}), ...(domain ? { domain } : {}) })
  }
  return reads.read ? outsideReadLabel(reads.tools ?? []) : null
}

/**
 * Each source's trust (see the header): one read per id-backed kind named,
 * one known-senders lookup for the emails. Never throws: a failed check is
 * `unverified` for an id and `outside` for an email.
 */
export async function classifyCanonSources(
  supabase: SupabaseClient,
  sources: readonly CanonSource[],
  ctx: { workspaceId: string; userId: string } & TrustContext,
): Promise<SourceTrust[]> {
  const byKind = new Map<string, Set<string>>()
  for (const s of sources) {
    const table = ID_TABLES[s.kind]
    if (table && s.id) {
      if (!byKind.has(table)) byKind.set(table, new Set())
      byKind.get(table)!.add(s.id)
    }
  }
  const found = new Map<string, Set<string>>()
  await Promise.all(
    [...byKind].map(async ([table, ids]) => {
      try {
        const { data } = await supabase.from(table).select('id').eq('workspace_id', ctx.workspaceId).in('id', [...ids])
        found.set(table, new Set(((data ?? []) as Array<{ id?: unknown }>).map((r) => String(r.id))))
      } catch {
        found.set(table, new Set())
      }
    }),
  )
  const emails = sources.filter((s) => s.kind === 'email' && s.from).map((s) => s.from as string)
  let known = new Set<string>()
  if (emails.length && !ctx.runReadOutsideText) {
    try {
      known = await knownSenders(supabase, { workspaceId: ctx.workspaceId, userId: ctx.userId, addresses: emails })
    } catch {
      known = new Set()
    }
  }
  return sources.map((s): SourceTrust => {
    if (ALWAYS_OUTSIDE.has(s.kind)) return 'outside'
    if (s.kind === 'chat') return ctx.attended ? 'trusted' : 'unverified'
    if (s.kind === 'email') return !ctx.runReadOutsideText && s.from && known.has(s.from) ? 'trusted' : 'outside'
    const table = ID_TABLES[s.kind]
    return table && s.id && found.get(table)?.has(s.id) ? 'trusted' : 'unverified'
  })
}
