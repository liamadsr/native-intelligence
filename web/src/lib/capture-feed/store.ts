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
    | { outcome?: string; session_id?: string | null; capture_id?: string | null; started_at?: string | null; round?: number | null }
    | undefined
  const outcome = (row?.outcome as FeedStartOutcome) ?? 'unknown'
  const live = (outcome === 'started' || outcome === 'resumed') && row?.session_id && row.capture_id && row.started_at
  return {
    outcome,
    session: live ? { id: row!.session_id!, startedAt: new Date(row!.started_at!).toISOString(), round: row!.round ?? 0, captureId: row!.capture_id! } : null,
  }
}

export interface FeedBeat {
  id: string
  keep: boolean
  reason: string | null
}

/** The producer runs these sessions (588's capture_feed_heartbeat): which to keep, which to stop. */
export async function heartbeatFeeds(svc: SupabaseClient, producer: CaptureFeedProducer, sessionIds: readonly string[]): Promise<FeedBeat[]> {
  if (sessionIds.length === 0) return []
  const { data, error } = await svc.rpc('capture_feed_heartbeat', { p_producer_id: producer.id, p_sessions: [...sessionIds] })
  if (error) throw new Error(`capture feed: heartbeat failed: ${error.message}`)
  return ((data ?? []) as Array<{ session_id: string; keep: boolean; reason: string | null }>).map((r) => ({ id: r.session_id, keep: r.keep === true, reason: r.reason ?? null }))
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

/** The producer stopped (588's capture_feed_end). */
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

/** One stored segment, with its speaker's label (the transcript's line). */
export interface StoredSegment {
  sessionId: string
  speakerKey: string
  label: string
  saidAt: string
  startMs: number
  endMs: number
  text: string
}

/** Every segment of a capture, in the order said, with labels. */
export async function capturedSegments(svc: SupabaseClient, captureId: string): Promise<StoredSegment[]> {
  const [segs, speakers, people] = await Promise.all([
    svc.from('capture_feed_segment').select('session_id, speaker_key, said_at, start_ms, end_ms, text, key').eq('capture_id', captureId).order('said_at', { ascending: true }).order('key', { ascending: true }),
    svc.from('capture_feed_speaker').select('speaker_key, participant_id').eq('capture_id', captureId),
    svc.from('capture_participant').select('id, speaker_label').eq('capture_id', captureId).eq('source', 'call_roster'),
  ])
  if (segs.error) throw new Error(`capture feed: segments read failed: ${segs.error.message}`)
  if (speakers.error) throw new Error(`capture feed: speakers read failed: ${speakers.error.message}`)
  if (people.error) throw new Error(`capture feed: participants read failed: ${people.error.message}`)
  const labelOf = new Map(((people.data ?? []) as Array<{ id: string; speaker_label: string | null }>).map((p) => [p.id, p.speaker_label]))
  const labels = new Map<string, string>()
  for (const s of (speakers.data ?? []) as Array<{ speaker_key: string; participant_id: string }>) {
    const label = labelOf.get(s.participant_id)
    if (label) labels.set(s.speaker_key, label)
  }
  return ((segs.data ?? []) as Array<{ session_id: string; speaker_key: string; said_at: string; start_ms: number; end_ms: number; text: string }>).map((r) => ({
    sessionId: r.session_id,
    speakerKey: r.speaker_key,
    label: labels.get(r.speaker_key) ?? 'Teammate',
    saidAt: r.said_at,
    startMs: Number(r.start_ms),
    endMs: Number(r.end_ms),
    text: r.text,
  }))
}

/** The sessions of a source, oldest round first (a finish's gaps and its wait). */
export async function sourceSessions(
  svc: SupabaseClient,
  source: { kind: CaptureFeedSourceKind; ref: string },
): Promise<Array<{ id: string; round: number; status: 'live' | 'lost' | 'ended'; startedAt: string; endedAt: string | null; gaps: Array<{ from: string; to?: string }> }>> {
  const { data, error } = await svc
    .from('capture_feed_session')
    .select('id, round, status, started_at, ended_at, gaps')
    .eq('source_kind', source.kind)
    .eq('source_ref', source.ref)
    .order('round', { ascending: true })
  if (error) throw new Error(`capture feed: sessions read failed: ${error.message}`)
  return ((data ?? []) as Array<{ id: string; round: number; status: 'live' | 'lost' | 'ended'; started_at: string; ended_at: string | null; gaps: unknown }>).map((r) => ({
    id: r.id,
    round: r.round,
    status: r.status,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    gaps: Array.isArray(r.gaps) ? (r.gaps as Array<{ from: string; to?: string }>) : [],
  }))
}
