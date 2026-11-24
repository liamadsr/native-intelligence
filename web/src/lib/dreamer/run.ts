/**
 * The Dreamer's schedule and start (docs/plans/dreamer.md "Schedule and
 * gates", "The run").
 *
 * THE TRIGGER (dreamerRequestsFor, from the hourly member scan in
 * src/lib/inngest/agent-events.ts agentEventDigest, the look-ahead's way):
 * every candidate whose zone reads a Dreamer hour gets one
 * `dreamer/run.requested`, Inngest id `dreamer:<user>:<workspace>:<local
 * date>:<hour>`, carrying `{ userId, workspaceId, timeZone, localDate, hour }`,
 * delivered (its `ts`) at the hour's start plus a jitter of up to 30 minutes
 * that is the same for the same person every time (dreamerJitterMs), so the
 * hour's runs, each a Think-tier work run, are spread over its first half:
 * the consumer's "five at once" holds only its own cheap start step, never
 * the runs it starts:
 *   • heartbeats at 07:00, 11:00, 15:00 and 19:00 local;
 *   • the reflection run at 03:00 local, skipped when the person's zone is
 *     only the UTC fallback (03:00 UTC is nobody's night by default), as the
 *     look-ahead skips.
 *
 * THE RUN (runDreamerFor, inside src/lib/inngest/dreamer.ts, one per person
 * at a time). Its gates, in order, each skip a templated reason the consumer
 * logs (dreamerLogLine), all in code, before any model work:
 *   1. a home thread (chat_conversations.is_home): the run reports there;
 *   2. the agent isn't paused, which is autonomy not being off: the one
 *      switch readAgentPausedState reads (the same check planHomeTurn
 *      makes), failing CLOSED;
 *   3. the workspace isn't dormant (workspaceIsDormant), failing CLOSED as
 *      well (a failed read is `lookup_failed`);
 *   4. the person is within their usage limits (checkUsageLimits);
 *   5. the admission RPC's caps (start_chat_helper, kind 'dreamer',
 *      migration 720): one Dreamer working per person, six a UTC day; its
 *      fire key is this slot's (`…:session:dreamer:turn:<date>T<hh>:call:
 *      heartbeat|reflection`), so a retried event never starts a second run.
 * Then startServerHelper, kind 'dreamer', quiet (no push, agent log line or
 * inbox event), its task the Dreamer's role and this run's instructions
 * (src/lib/dreamer/prompt.ts) joined by DREAMER_PART_SEPARATOR, on Think
 * (start-helper.ts). The task names this run's start: the slot's own
 * instant in UTC, the same words on every retry (the RPC fingerprints the
 * task, so a retry is the same run, never a CALL_ID_CONFLICT).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AgentPausedState } from '@/lib/work/agent-paused'
import type { DigestCandidate } from '@/lib/agent-events/digest'
import type { ServerHelperStart, StartHelperDeps } from '@/lib/chat/start-helper'
import type { StartHelperInput } from '@/lib/ai/tools/chat-helpers'
import { DREAMER_PART_SEPARATOR, DREAMER_ROLE, dreamerRunInstructions, type DreamerRunContext } from './prompt'
import { DREAMER_HEARTBEAT_CALL, DREAMER_REFLECTION_CALL } from './notes'

/** The event that starts one person's Dreamer run for one slot. */
export const DREAMER_REQUESTED_EVENT = 'dreamer/run.requested'
/** The heartbeats' local hours. */
export const DREAMER_HEARTBEAT_HOURS = [7, 11, 15, 19] as const
/** The nightly reflection run's local hour. */
export const DREAMER_REFLECTION_HOUR = 3
/** Every local hour the scan looks for. */
export const DREAMER_HOURS: readonly number[] = [DREAMER_REFLECTION_HOUR, ...DREAMER_HEARTBEAT_HOURS]
/** The admission key's scope part (start_chat_helper's `session:<scope>`). */
export const DREAMER_SCOPE = 'dreamer'

/** True for a Dreamer hour. Pure. */
export function isDreamerHour(hour: unknown): hour is number {
  return typeof hour === 'number' && DREAMER_HOURS.includes(hour)
}

/** What `dreamer/run.requested` carries. */
export interface DreamerRequestData {
  userId: string
  workspaceId: string
  timeZone: string
  /** The person's local date the scan ran on (YYYY-MM-DD). */
  localDate: string
  /** The local hour: one of DREAMER_HOURS. */
  hour: number
}

export interface DreamerRequest {
  id: string
  name: typeof DREAMER_REQUESTED_EVENT
  /** When Inngest delivers it (ms): the scan's hour plus the person's jitter (dreamerJitterMs). */
  ts: number
  data: DreamerRequestData
}

/** The jitter's bound: every run of an hour starts within its first 30 minutes. */
export const DREAMER_JITTER_MAX_MS = 30 * 60_000
const HOUR_MS = 60 * 60_000

/**
 * How far into the hour one person's run starts, in ms, in [0, 30 minutes):
 * a hash of who it is (FNV-1a over the user and workspace ids), so the same
 * person always starts at the same point of the hour, and everyone at one hour
 * is spread over its first half instead of starting at once. Only when the
 * event is delivered moves: its id, its admission key and the run's start in
 * its task stay the slot's. Pure.
 */
export function dreamerJitterMs(userId: string, workspaceId: string): number {
  let hash = 0x811c9dc5
  for (const ch of `${userId}:${workspaceId}`) {
    hash ^= ch.charCodeAt(0)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return (hash % (DREAMER_JITTER_MAX_MS / 1000)) * 1000
}

/** Why the scan sent no request for a candidate at a Dreamer hour. */
export type DreamerScanSkip = 'no_zone'

/** The request the scan sends for one candidate, or why none: only at a Dreamer hour, and the reflection only in a zone of the person's own. Pure. */
export function dreamerRequestFor(
  c: Pick<DigestCandidate, 'userId' | 'workspaceId' | 'timeZone' | 'timeZoneSource' | 'date' | 'hour'>,
  /** When the scan ran (ms): the request is delivered at its hour's start plus the person's jitter. */
  scanMs: number,
): { ok: true; request: DreamerRequest } | { ok: false; reason: DreamerScanSkip } | null {
  if (!isDreamerHour(c.hour)) return null
  if (c.hour === DREAMER_REFLECTION_HOUR && (!c.timeZoneSource || c.timeZoneSource === 'utc')) return { ok: false, reason: 'no_zone' }
  return {
    ok: true,
    request: {
      id: `dreamer:${c.userId}:${c.workspaceId}:${c.date}:${c.hour}`,
      name: DREAMER_REQUESTED_EVENT,
      ts: Math.floor(scanMs / HOUR_MS) * HOUR_MS + dreamerJitterMs(c.userId, c.workspaceId),
      data: { userId: c.userId, workspaceId: c.workspaceId, timeZone: c.timeZone, localDate: c.date, hour: c.hour },
    },
  }
}

/** The scan's requests for its candidates, and its skips. Pure. */
export function dreamerRequestsFor(candidates: readonly DigestCandidate[], scanMs: number): { requests: DreamerRequest[]; skips: Partial<Record<DreamerScanSkip, number>> } {
  const requests: DreamerRequest[] = []
  const skips: Partial<Record<DreamerScanSkip, number>> = {}
  for (const c of candidates) {
    const r = dreamerRequestFor(c, scanMs)
    if (!r) continue
    if (r.ok) requests.push(r.request)
    else skips[r.reason] = (skips[r.reason] ?? 0) + 1
  }
  return { requests, skips }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LOCAL_DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/

/** The event's data, shape-checked (an event is data). Null when malformed. Pure. */
export function parseDreamerRequest(raw: unknown): DreamerRequestData | null {
  if (!raw || typeof raw !== 'object') return null
  const d = raw as Record<string, unknown>
  if (typeof d.userId !== 'string' || !UUID_RE.test(d.userId) || typeof d.workspaceId !== 'string' || !UUID_RE.test(d.workspaceId)) return null
  if (typeof d.timeZone !== 'string' || !d.timeZone || d.timeZone.length > 64) return null
  if (typeof d.localDate !== 'string' || !LOCAL_DATE_RE.test(d.localDate) || !isDreamerHour(d.hour)) return null
  return { userId: d.userId, workspaceId: d.workspaceId, timeZone: d.timeZone, localDate: d.localDate, hour: d.hour }
}

/** True for the nightly reflection run's slot. Pure. */
export function isReflectionSlot(data: Pick<DreamerRequestData, 'hour'>): boolean {
  return data.hour === DREAMER_REFLECTION_HOUR
}

/** Two digits. */
const pad = (n: number) => String(n).padStart(2, '0')

/** The admission key's subject part for a slot: `<local date>T<hh>` (no ':'). Pure. */
export function dreamerSubject(data: Pick<DreamerRequestData, 'localDate' | 'hour'>): string {
  return `${data.localDate}T${pad(data.hour)}`
}

/** The admission key's call part: the reflection run's, or a heartbeat's (the report reads it back: notes.ts isReflectionFireKey). Pure. */
export function dreamerCallId(data: Pick<DreamerRequestData, 'hour'>): string {
  return isReflectionSlot(data) ? DREAMER_REFLECTION_CALL : DREAMER_HEARTBEAT_CALL
}

/** The zone's offset from UTC at `ms`, in ms (local wall clock minus UTC), or 0 for a zone Intl refuses. Pure. */
function zoneOffsetMs(timeZone: string, ms: number): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(ms))
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
    return Number.isFinite(asUtc) ? asUtc - Math.floor(ms / 1000) * 1000 : 0
  } catch {
    return 0
  }
}

/**
 * The UTC instant of `<localDate> <hour>:00` in `timeZone`, ISO 8601: the
 * slot's start (the run's start, named in its task and its checkpoint).
 * A zone Intl refuses reads as UTC. Pure.
 */
export function dreamerSlotStartIso(data: Pick<DreamerRequestData, 'localDate' | 'hour' | 'timeZone'>): string {
  const [y, m, d] = data.localDate.split('-').map(Number)
  const wall = Date.UTC(y, m - 1, d, data.hour, 0, 0)
  // Twice: the offset at the guess, then at the instant it gives (a DST change between them).
  let at = wall - zoneOffsetMs(data.timeZone, wall)
  at = wall - zoneOffsetMs(data.timeZone, at)
  return new Date(at).toISOString()
}

/** What the run is told about itself (prompt.ts DreamerRunContext). Pure. */
export function dreamerRunContext(data: Pick<DreamerRequestData, 'localDate' | 'hour' | 'timeZone'>): DreamerRunContext {
  return {
    runStartIso: dreamerSlotStartIso(data),
    localTime: `${data.localDate} ${pad(data.hour)}:00 (${data.timeZone})`,
    reflection: isReflectionSlot(data),
  }
}

/** The run's task: the Dreamer's role, then this run's instructions (prompt.ts). Pure. */
export function dreamerTaskPrompt(run: DreamerRunContext): string {
  return `${DREAMER_ROLE}${DREAMER_PART_SEPARATOR}${dreamerRunInstructions(run)}`
}

/** The helper input beside the task (the ledger's and the tier's; the task itself is the prompt above). Pure. */
export function dreamerHelperInput(data: Pick<DreamerRequestData, 'hour'>): StartHelperInput {
  return {
    task: isReflectionSlot(data)
      ? "Nightly reflection: background research for the person's main assistant."
      : "Heartbeat: background research for the person's main assistant.",
    expects: [],
  }
}

/** Why a Dreamer run did not start. */
export type DreamerSkip = 'no_home_thread' | 'paused' | 'dormant' | 'usage_limited' | 'usage_check_failed' | 'refused' | 'lookup_failed'

export type DreamerRunResult =
  | { status: 'started' | 'reused' | 'queued'; runId: string | null }
  | { status: 'skipped'; reason: DreamerSkip; code?: string }

export interface DreamerRunDeps {
  /** The kill switch's three states (readAgentPausedState): anything but 'active' skips (fail closed). */
  pausedState: (supabase: SupabaseClient, workspaceId: string) => Promise<AgentPausedState>
  isDormant: (supabase: SupabaseClient, workspaceId: string) => Promise<boolean>
  /** checkUsageLimits: throws a 429 Response past the limits. */
  checkUsage: (userId: string, workspaceId: string) => Promise<unknown>
  startHelper: (supabase: SupabaseClient, start: ServerHelperStart, input: StartHelperInput, deps?: StartHelperDeps) => Promise<Record<string, unknown>>
  send?: StartHelperDeps['send']
}

/**
 * One person's Dreamer run for one slot (see the header): the gates, then the
 * start. Never throws: a failed read is `lookup_failed` (the next slot tries
 * again).
 */
export async function runDreamerFor(supabase: SupabaseClient, data: DreamerRequestData, deps: DreamerRunDeps): Promise<DreamerRunResult> {
  try {
    const { data: convs, error } = await supabase
      .from('chat_conversations')
      .select('id')
      .eq('user_id', data.userId)
      .eq('workspace_id', data.workspaceId)
      .eq('is_home', true)
      .limit(1)
    if (error) return { status: 'skipped', reason: 'lookup_failed' }
    const conversationId = (convs as Array<{ id?: unknown }> | null)?.[0]?.id
    if (typeof conversationId !== 'string') return { status: 'skipped', reason: 'no_home_thread' }

    // Fails CLOSED: this spends money, so a switch that can't be read is off.
    // The switch is autonomy itself (agent-paused.ts): paused and autonomy off are one gate.
    const state = await deps.pausedState(supabase, data.workspaceId).catch((): AgentPausedState => 'unknown')
    if (state !== 'active') return { status: 'skipped', reason: 'paused' }
    // Fails CLOSED too: a dormancy that can't be read starts nothing (the next slot tries again).
    const dormant = await deps.isDormant(supabase, data.workspaceId).then(
      (d) => d,
      () => null,
    )
    if (dormant === null) return { status: 'skipped', reason: 'lookup_failed' }
    if (dormant) return { status: 'skipped', reason: 'dormant' }

    try {
      await deps.checkUsage(data.userId, data.workspaceId)
    } catch (err) {
      if (err instanceof Response && err.status === 429) return { status: 'skipped', reason: 'usage_limited' }
      return { status: 'skipped', reason: 'usage_check_failed' }
    }

    const out = await deps.startHelper(
      supabase,
      {
        kind: 'dreamer',
        workspaceId: data.workspaceId,
        userId: data.userId,
        conversationId,
        scope: DREAMER_SCOPE,
        subject: dreamerSubject(data),
        callId: dreamerCallId(data),
        quiet: true,
        taskPrompt: dreamerTaskPrompt(dreamerRunContext(data)),
      },
      dreamerHelperInput(data),
      deps.send ? { send: deps.send } : {},
    )
    if (out.status === 'refused') return { status: 'skipped', reason: 'refused', ...(typeof out.code === 'string' ? { code: out.code } : {}) }
    const runId = typeof out.run_id === 'string' ? out.run_id : null
    if (out.reused === true) return { status: 'reused', runId }
    return { status: out.status === 'queued' ? 'queued' : 'started', runId }
  } catch (err) {
    console.warn('[dreamer] start skipped:', err instanceof Error ? err.message : String(err))
    return { status: 'skipped', reason: 'lookup_failed' }
  }
}

/** One `[dreamer]` line per run: ids and the outcome only. Pure. */
export function dreamerLogLine(data: Pick<DreamerRequestData, 'userId' | 'workspaceId' | 'localDate' | 'hour'> | null, result: DreamerRunResult | { status: 'skipped'; reason: 'bad_event' }): string {
  const who = data ? ` user=${data.userId} workspace=${data.workspaceId} slot=${data.localDate}T${pad(data.hour)}` : ''
  const outcome = result.status === 'skipped' ? `skip_${result.reason}${'code' in result && result.code ? `_${result.code}` : ''}` : result.status
  const run = 'runId' in result && result.runId ? ` run=${result.runId}` : ''
  return `[dreamer]${who} ${outcome}${run}`
}

/** One `[dreamer] scan` line per hourly scan. Pure. */
export function dreamerScanLogLine(r: { candidates: number; sent: number; skips: Partial<Record<DreamerScanSkip, number>> }): string {
  const skips = Object.entries(r.skips)
    .map(([k, n]) => `${k}=${n}`)
    .join(' ')
  return `[dreamer] scan candidates=${r.candidates} sent=${r.sent}${skips ? ` ${skips}` : ''}`
}
