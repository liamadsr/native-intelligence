/**
 * The capture feed's reads and writes (migrations 587-588), as the service
 * role: one function per request of the contract (./contract.ts), and what
 * the sweeper and a call's finish need. Every write is one of 588's
 * functions, which lock the session (and the capture) and decide; this file
 * passes arguments and reads answers. Privacy: logs carry ids and counts,
 * never words or names.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { rosterEventRow, segmentRow, type CaptureFeedProducer, type CaptureFeedRosterEvent, type CaptureFeedSegment, type CaptureFeedSourceKind } from './contract'

export type FeedStartOutcome = 'started' | 'resumed' | 'busy' | 'not_wanted' | 'unknown'

export interface FeedSession {
  id: string
  startedAt: string
  round: number
  captureId: string
  /** The meeting guests who may be heard in this round (let in, and said go to its notes); every member may. */
  guests: string[]
}

export interface FeedStart {
  outcome: FeedStartOutcome
  session: FeedSession | null
}

/** A producer begins (or takes up again) a source's feed (588's capture_feed_start). Throws on a failed write. */
export async function startFeed(
  svc: SupabaseClient,
  input: { source: { kind: CaptureFeedSourceKind; ref: string }; producer: CaptureFeedProducer; title: string },
): Promise<FeedStart> {
  const { data, error } = await svc.rpc('capture_feed_start', {
    p_source_kind: input.source.kind,
    p_source_ref: input.source.ref,
    p_producer_kind: input.producer.kind,
    p_producer_id: input.producer.id,
    p_capture_title: input.title,
  })
  if (error) throw new Error(`capture feed: start failed: ${error.message}`)
  const row = (Array.isArray(data) ? data[0] : data) as
    | { outcome?: string; session_id?: string | null; capture_id?: string | null; started_at?: string | null; round?: number | null; guests?: string[] | null }
    | undefined
  const outcome = (row?.outcome as FeedStartOutcome) ?? 'unknown'
  const live = (outcome === 'started' || outcome === 'resumed') && row?.session_id && row.capture_id && row.started_at
  return {
    outcome,
    session: live
      ? { id: row!.session_id!, startedAt: new Date(row!.started_at!).toISOString(), round: row!.round ?? 0, captureId: row!.capture_id!, guests: row!.guests ?? [] }
      : null,
  }
}

export interface FeedBeat {
  id: string
  keep: boolean
  reason: string | null
  /** Kept: the meeting guests who may be heard now (a guest who says go mid-round joins this list). */
  guests: string[]
}

/** The producer runs these sessions (588's capture_feed_heartbeat): which to keep, which to stop, and whom it may hear. */
export async function heartbeatFeeds(svc: SupabaseClient, producer: CaptureFeedProducer, sessionIds: readonly string[]): Promise<FeedBeat[]> {
  if (sessionIds.length === 0) return []
  const { data, error } = await svc.rpc('capture_feed_heartbeat', { p_producer_id: producer.id, p_sessions: [...sessionIds] })
  if (error) throw new Error(`capture feed: heartbeat failed: ${error.message}`)
  return ((data ?? []) as Array<{ session_id: string; keep: boolean; reason: string | null; guests: string[] | null }>).map((r) => ({
    id: r.session_id,
    keep: r.keep === true,
    reason: r.reason ?? null,
    guests: r.keep === true ? (r.guests ?? []) : [],
  }))
}

export type RosterOutcome = 'applied' | 'stale' | 'unknown_speaker' | 'refused' | 'invalid' | 'locked' | 'taken' | 'unknown'

/** Who joined and left (588's capture_feed_roster), each event's outcome by its key. */
export async function applyRoster(
  svc: SupabaseClient,
  sessionId: string,
  producer: CaptureFeedProducer,
  events: readonly CaptureFeedRosterEvent[],
): Promise<Array<{ key: string; outcome: RosterOutcome }>> {
  const { data, error } = await svc.rpc('capture_feed_roster', { p_session: sessionId, p_producer_id: producer.id, p_events: events.map(rosterEventRow) })
  if (error) throw new Error(`capture feed: roster failed: ${error.message}`)
  return ((data ?? []) as Array<{ key: string; outcome: string }>).map((r) => ({ key: r.key, outcome: r.outcome as RosterOutcome }))
}

export interface AppendResult {
  outcome: 'applied' | 'locked' | 'taken' | 'unknown'
  accepted: number
  duplicate: number
  dropped: number
  transcriptLength: number | null
  captureId: string | null
}

/**
 * Final segments into the session's capture (588's capture_feed_append): each
 * key once, appended in the order they were said. Throws on a failed write,
 * including an append the transcript did not take: the producer sends the
 * same batch again, and what was stored already is a duplicate.
 */
export async function appendSegments(
  svc: SupabaseClient,
  sessionId: string,
  producer: CaptureFeedProducer,
  segments: readonly CaptureFeedSegment[],
): Promise<AppendResult> {
  const { data, error } = await svc.rpc('capture_feed_append', { p_session: sessionId, p_producer_id: producer.id, p_segments: segments.map(segmentRow) })
  if (error) throw new Error(`capture feed: append failed: ${error.message}`)
  const row = (Array.isArray(data) ? data[0] : data) as
    | { outcome?: string; accepted?: number; duplicate?: number; dropped?: number; transcript_length?: number | null; capture_id?: string | null }
    | undefined
  return {
    outcome: (row?.outcome as AppendResult['outcome']) ?? 'unknown',
    accepted: row?.accepted ?? 0,
    duplicate: row?.duplicate ?? 0,
    dropped: row?.dropped ?? segments.length,
    transcriptLength: row?.transcript_length ?? null,
    captureId: row?.capture_id ?? null,
  }
}

/** The producer delivered everything it heard and left the session (588's capture_feed_end). */
export async function endFeed(svc: SupabaseClient, sessionId: string, producer: CaptureFeedProducer, reason: string | undefined): Promise<boolean> {
  const { data, error } = await svc.rpc('capture_feed_end', { p_session: sessionId, p_producer_id: producer.id, p_reason: reason ?? null })
  if (error) throw new Error(`capture feed: end failed: ${error.message}`)
  return data === true
}

/** No heartbeat for this long and a session is lost (the sweeper). */
export const FEED_LOST_AFTER_SECONDS = 90

/** The sweeper: sessions whose producer went quiet are 'lost', and their captures say so (588's capture_feed_mark_lost). */
export async function markLostFeeds(svc: SupabaseClient, staleSeconds = FEED_LOST_AFTER_SECONDS): Promise<Array<{ sessionId: string; captureId: string; sourceRef: string }>> {
  const { data, error } = await svc.rpc('capture_feed_mark_lost', { stale_seconds: staleSeconds })
  if (error) throw new Error(`capture feed: lost read failed: ${error.message}`)
  return ((data ?? []) as Array<{ session_id: string; capture_id: string; source_ref: string }>).map((r) => ({ sessionId: r.session_id, captureId: r.capture_id, sourceRef: r.source_ref }))
}

/**
 * The sweeper: every producer still in a room whose call wants no feed of it (notes off, the call
 * over, the capture closed, or it went quiet) goes on the eject outbox again (588's
 * capture_feed_fence_producers). Returns how many were queued.
 */
export async function fenceProducers(svc: SupabaseClient): Promise<number> {
  const { data, error } = await svc.rpc('capture_feed_fence_producers')
  if (error) throw new Error(`capture feed: producers not fenced: ${error.message}`)
  return typeof data === 'number' ? data : 0
}

/** The sessions of a source, oldest round first (a finish's gaps and its wait). */
export async function sourceSessions(
  svc: SupabaseClient,
  source: { kind: CaptureFeedSourceKind; ref: string },
): Promise<
  Array<{ id: string; round: number; status: 'live' | 'lost' | 'ended'; startedAt: string; endedAt: string | null; deliveredAt: string | null; heartbeatAt: string; gaps: Array<{ from: string; to?: string }> }>
> {
  // One row per round of notes: a call has a handful (each round needs a person to turn notes on),
  // far under PostgREST's row cap.
  const { data, error } = await svc
    .from('capture_feed_session')
    .select('id, round, status, started_at, ended_at, delivered_at, heartbeat_at, gaps')
    .eq('source_kind', source.kind)
    .eq('source_ref', source.ref)
    .order('round', { ascending: true })
  if (error) throw new Error(`capture feed: sessions read failed: ${error.message}`)
  return ((data ?? []) as Array<{ id: string; round: number; status: 'live' | 'lost' | 'ended'; started_at: string; ended_at: string | null; delivered_at: string | null; heartbeat_at: string; gaps: unknown }>).map((r) => ({
    id: r.id,
    round: r.round,
    status: r.status,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    deliveredAt: r.delivered_at,
    heartbeatAt: r.heartbeat_at,
    gaps: Array.isArray(r.gaps) ? (r.gaps as Array<{ from: string; to?: string }>) : [],
  }))
}
