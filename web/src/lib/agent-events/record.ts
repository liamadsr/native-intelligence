/**
 * The one writer of the agent's inbox (migration 336; A6). Every producer
 * (the work recorder, the mail seam, the capture consumer, the meeting-soon
 * cron, the mention tap) hands its events here.
 *
 * Rules, the agent log's (src/lib/log/agent-log.ts):
 *   • ONE (workspace, user) per row: nothing fans a row out to anyone else.
 *   • TEMPLATED FACTS ONLY: every string fact is cleaned and clipped
 *     (clipLogText: control and format characters collapse, angle brackets
 *     become ‹ ›, a title is cut at 80 characters), and the whole object is
 *     capped at the table's 4000 bytes. Never a body.
 *   • IDEMPOTENT: an ignore-duplicates upsert on (workspace, user, dedupe
 *     key), so a retried producer or a replayed Inngest event writes nothing
 *     twice.
 *   • NEVER THROWS INTO A CALLER: a lost event is a gap in the inbox, never a
 *     failed run. Errors are logged and the count of rows that landed is
 *     returned.
 *
 * After writing, it sends `agent/event.created` once per person, which wakes
 * the router (debounced 60 s per person, so a burst is one routing pass).
 * Sent for a duplicate too: a retry whose first send was lost still wakes it.
 *
 * Service-role only: the table has no client write policy.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { getServiceClient } from '@/lib/admin'
import { clipLogText } from '@/lib/log/agent-log'
import { isRepoFullName } from '@/lib/environments/types'
import {
  AGENT_EVENT_CREATED,
  AGENT_EVENT_DEDUPE_KEY_MAX,
  AGENT_EVENT_FACTS_MAX_BYTES,
  AGENT_EVENT_TITLE_MAX,
  KIND_SOURCE,
  PR_CHANGE_STATES,
  isAgentEventKind,
  personKey,
  type AgentEventCreatedData,
  type AgentEventFacts,
  type AgentEventKind,
} from './types'

export interface AgentEventInput {
  workspaceId: string
  userId: string
  kind: AgentEventKind
  /** 0 (low) to 3 (urgent); defaults to 1. */
  priority?: number
  /** When it happens (ISO): a meeting's start, else when it happened. Defaults to now. */
  occursAt?: string | null
  expiresAt?: string | null
  refType?: string | null
  refId?: string | null
  facts?: AgentEventFacts
  dedupeKey: string
}

export interface RecordAgentEventsDeps {
  /** The router wake-up (inngest.send); tests pass a spy. */
  send?: (payload: { name: string; data: AgentEventCreatedData }) => Promise<unknown>
}

function warn(op: string, err: unknown) {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : JSON.stringify(err)
  console.warn(`[agent-event] ${op} skipped:`, message)
}

/** Longer free-text facts (a reason) get a little more room than a title. */
const TEXT_FACT_MAX: Partial<Record<keyof AgentEventFacts, number>> = {
  reason: 120,
  from: 120,
  contactId: 64,
  workKind: 60,
  area: 40,
  notificationType: 60,
  targetType: 40,
  targetId: 64,
  door: 20,
  prepKey: 64,
  action: 64,
  catalogId: 40,
}
/** Flags kept only as booleans. */
const FLAG_FACTS: ReadonlySet<string> = new Set(['notified', 'prepReady', 'prepSkipped', 'known', 'flagged', 'toldHome', 'shouldKnow', 'needsInput', 'firstRun'])
/** Counts kept only as whole numbers in 0..1000. */
const COUNT_FACTS: ReadonlySet<string> = new Set(['openAsks', 'pendingProposals', 'attendeeCount'])
const MEETING_REFS: ReadonlySet<unknown> = new Set(['capture', 'local_calendar_event', 'calendar_event'])
const MEETING_CHANGES: ReadonlySet<unknown> = new Set(['cancelled', 'removed', 'moved'])
const EMAIL_KINDS_SET: ReadonlySet<unknown> = new Set(['conversation', 'meeting', 'receipt_or_bill', 'delivery', 'account_or_security', 'newsletter_or_promo', 'other_notice'])
const PR_STATES_SET: ReadonlySet<unknown> = new Set(PR_CHANGE_STATES)

/**
 * The facts as they may be stored: string values cleaned and clipped, flags
 * kept only as booleans, unknown keys and empty values dropped, and the whole
 * object within the table's cap (an oversized one keeps only its title).
 */
export function cleanFacts(facts: AgentEventFacts | null | undefined): AgentEventFacts {
  const out: Record<string, unknown> = {}
  if (!facts || typeof facts !== 'object') return {}
  for (const [key, value] of Object.entries(facts)) {
    if (value === undefined || value === null) continue
    if (FLAG_FACTS.has(key)) {
      if (typeof value === 'boolean') out[key] = value
      continue
    }
    if (COUNT_FACTS.has(key)) {
      if (typeof value === 'number' && Number.isInteger(value) && value >= 0) out[key] = Math.min(value, 1000)
      continue
    }
    if (key === 'meetingRef') {
      if (MEETING_REFS.has(value)) out[key] = value
      continue
    }
    if (key === 'change') {
      if (MEETING_CHANGES.has(value)) out[key] = value
      continue
    }
    if (key === 'emailKind') {
      if (EMAIL_KINDS_SET.has(value)) out[key] = value
      continue
    }
    // A pull request's change: the repo only in GitHub's own characters, the
    // number a whole one, the state one of four words (no outside text).
    if (key === 'repo') {
      if (isRepoFullName(value)) out[key] = value
      continue
    }
    if (key === 'prNumber') {
      if (typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 1_000_000_000) out[key] = value
      continue
    }
    if (key === 'prState') {
      if (PR_STATES_SET.has(value)) out[key] = value
      continue
    }
    if (key === 'movedTo') {
      const ms = typeof value === 'string' ? Date.parse(value) : NaN
      if (Number.isFinite(ms)) out[key] = new Date(ms).toISOString()
      continue
    }
    if (key === 'title' || key in TEXT_FACT_MAX) {
      const max = key === 'title' ? AGENT_EVENT_TITLE_MAX : TEXT_FACT_MAX[key as keyof AgentEventFacts]!
      const clipped = clipLogText(typeof value === 'string' ? value : null, max)
      if (clipped) out[key] = clipped
    }
  }
  if (new TextEncoder().encode(JSON.stringify(out)).length > AGENT_EVENT_FACTS_MAX_BYTES) {
    return typeof out.title === 'string' ? { title: out.title } : {}
  }
  return out as AgentEventFacts
}

function isoOrNull(value: string | null | undefined): string | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

/** The row for an input, or null when it can't be one (no owner, bad kind or key). */
export function agentEventRow(input: AgentEventInput): Record<string, unknown> | null {
  if (!input.workspaceId || !input.userId) return null
  if (!isAgentEventKind(input.kind)) return null
  const dedupeKey = typeof input.dedupeKey === 'string' ? input.dedupeKey.trim() : ''
  if (!dedupeKey || dedupeKey.length > AGENT_EVENT_DEDUPE_KEY_MAX) return null
  const priority = Number.isInteger(input.priority) ? Math.max(0, Math.min(3, input.priority as number)) : 1
  return {
    workspace_id: input.workspaceId,
    user_id: input.userId,
    source: KIND_SOURCE[input.kind],
    kind: input.kind,
    priority,
    occurs_at: isoOrNull(input.occursAt) ?? new Date().toISOString(),
    expires_at: isoOrNull(input.expiresAt),
    ref_type: input.refType ? input.refType.slice(0, 40) : null,
    ref_id: input.refId ? input.refId.slice(0, 300) : null,
    facts: cleanFacts(input.facts),
    dedupe_key: dedupeKey,
  }
}

async function defaultSend(payload: { name: string; data: AgentEventCreatedData }): Promise<unknown> {
  const { inngest } = await import('@/lib/inngest/client')
  return inngest.send(payload)
}

/**
 * Write these events (each once per dedupe key) and wake the router for each
 * person they belong to. Returns how many rows newly landed. Never throws.
 */
export async function recordAgentEvents(
  inputs: readonly AgentEventInput[],
  supabase?: SupabaseClient,
  deps: RecordAgentEventsDeps = {},
): Promise<number> {
  let landed = 0
  const persons = new Map<string, AgentEventCreatedData>()
  try {
    if (!inputs.length) return 0
    const client = supabase ?? getServiceClient()
    for (const input of inputs) {
      const row = agentEventRow(input)
      if (!row) {
        warn('record', `bad event (${String(input?.kind)})`)
        continue
      }
      try {
        const { data, error } = await client
          .from('agent_event')
          .upsert(row, { onConflict: 'workspace_id,user_id,dedupe_key', ignoreDuplicates: true })
          .select('id')
        if (error) {
          warn('record', error)
          continue
        }
        if (Array.isArray(data) && data.length > 0) landed++
        persons.set(personKey(input.workspaceId, input.userId), {
          workspaceId: input.workspaceId,
          userId: input.userId,
          personKey: personKey(input.workspaceId, input.userId),
        })
      } catch (err) {
        warn('record', err)
      }
    }
    const send = deps.send ?? defaultSend
    for (const data of persons.values()) {
      try {
        await send({ name: AGENT_EVENT_CREATED, data })
      } catch (err) {
        warn('router wake-up', err)
      }
    }
  } catch (err) {
    warn('record', err)
  }
  return landed
}

/** A `new` row older than this was missed by the router (its wake-up was lost): the sweep wakes it again. */
export const UNROUTED_SWEEP_AFTER_MS = 5 * 60_000
/** At most this many rows read per sweep. */
const UNROUTED_SWEEP_ROWS = 1000

/**
 * The people with rows the router never routed (state `new`, older than
 * UNROUTED_SWEEP_AFTER_MS): a producer whose `agent/event.created` send was
 * lost, or a pass that died. The 5-minute meeting-soon cron wakes the router
 * for each (src/lib/inngest/agent-events.ts). Throws on a failed read (the
 * cron step retries).
 */
export async function findUnroutedPeople(supabase: SupabaseClient, nowMs = Date.now()): Promise<AgentEventCreatedData[]> {
  const { data, error } = await supabase
    .from('agent_event')
    .select('workspace_id, user_id')
    .eq('state', 'new')
    .lt('created_at', new Date(nowMs - UNROUTED_SWEEP_AFTER_MS).toISOString())
    .order('created_at', { ascending: true })
    .limit(UNROUTED_SWEEP_ROWS)
  if (error) throw new Error(`agent_event sweep read failed: ${error.message}`)
  const people = new Map<string, AgentEventCreatedData>()
  for (const r of (data as Array<{ workspace_id?: unknown; user_id?: unknown }> | null) ?? []) {
    if (typeof r.workspace_id !== 'string' || typeof r.user_id !== 'string') continue
    const key = personKey(r.workspace_id, r.user_id)
    people.set(key, { workspaceId: r.workspace_id, userId: r.user_id, personKey: key })
  }
  return [...people.values()]
}
