/**
 * The capture feed's contract (src/lib/capture-feed/contract.ts), its secret
 * (auth.ts) and its transcript at the end (transcript.ts): what a request
 * may carry, what it becomes for 588's functions, who may send one (only
 * the holder of a secret of the feed's own, compared in constant time; off
 * when unset or shared with another internal secret), and the line the
 * notes open with when the recorder was gone a while.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HeartbeatSchema, RosterSchema, SegmentsSchema, StartSchema, rosterEventRow, segmentRow } from '../contract'
import { captureFeedSecret, checkCaptureFeedAuth } from '../auth'
import { feedOwnsTranscript, gapLines } from '../transcript'

vi.mock('server-only', () => ({}))

const CALL = '77777777-7777-4777-8777-777777777777'
const MEMBER = '33333333-3333-4333-8333-333333333333'
const GUEST = '44444444-4444-4444-8444-444444444444'
const producer = { kind: 'livekit_recorder', id: 'recorder' }

describe('the contract', () => {
  it('a start names a source of a known kind and a producer', () => {
    expect(StartSchema.safeParse({ source: { kind: 'team_call', ref: CALL }, producer }).success).toBe(true)
    expect(StartSchema.safeParse({ source: { kind: 'meeting_bot', ref: CALL }, producer }).success).toBe(false)
    expect(StartSchema.safeParse({ source: { kind: 'team_call', ref: 'tc-x' }, producer }).success).toBe(false)
    expect(StartSchema.safeParse({ source: { kind: 'team_call', ref: CALL }, producer: { kind: 'Recorder!', id: 'r' } }).success).toBe(false)
  })

  it('segments: words, a key, times that run forward in the feed’s clock; at most 200 a request', () => {
    const ok = { key: 'p.TR_1.1', speaker: MEMBER, text: 'Hello.', startMs: 1200, endMs: 1800 }
    expect(SegmentsSchema.safeParse({ producer, segments: [ok] }).success).toBe(true)
    expect(SegmentsSchema.safeParse({ producer, segments: [{ ...ok, endMs: 1000 }] }).success).toBe(false)
    expect(SegmentsSchema.safeParse({ producer, segments: [{ ...ok, text: '' }] }).success).toBe(false)
    expect(SegmentsSchema.safeParse({ producer, segments: [{ ...ok, startMs: -1 }] }).success).toBe(false)
    expect(SegmentsSchema.safeParse({ producer, segments: [] }).success).toBe(false)
    expect(SegmentsSchema.safeParse({ producer, segments: Array.from({ length: 201 }, () => ok) }).success).toBe(false)
    expect(segmentRow(ok)).toEqual({ key: 'p.TR_1.1', speaker: MEMBER, text: 'Hello.', start_ms: 1200, end_ms: 1800 })
  })

  it('roster: one identity of three kinds, or none after a speaker’s first event', () => {
    const base = { key: 'r1', speaker: MEMBER, kind: 'joined' as const, atMs: 0 }
    expect(RosterSchema.safeParse({ producer, events: [{ ...base, identity: { memberId: MEMBER } }] }).success).toBe(true)
    expect(RosterSchema.safeParse({ producer, events: [{ ...base, identity: { guestId: GUEST } }] }).success).toBe(true)
    expect(RosterSchema.safeParse({ producer, events: [{ ...base, identity: { name: 'Dana Ortiz', email: 'dana@example.com' } }] }).success).toBe(true)
    expect(RosterSchema.safeParse({ producer, events: [base] }).success).toBe(true)
    expect(RosterSchema.safeParse({ producer, events: [{ ...base, identity: { memberId: MEMBER, guestId: GUEST } }] }).success).toBe(false)
    expect(RosterSchema.safeParse({ producer, events: [{ ...base, kind: 'muted' }] }).success).toBe(false)
    expect(rosterEventRow({ ...base, identity: { memberId: MEMBER.toUpperCase() } })).toEqual({ key: 'r1', speaker: MEMBER, kind: 'joined', at_ms: 0, identity: { member_id: MEMBER } })
    expect(rosterEventRow({ ...base, identity: { guestId: GUEST } }).identity).toEqual({ guest_id: GUEST })
    expect(rosterEventRow({ ...base, kind: 'left' })).toEqual({ key: 'r1', speaker: MEMBER, kind: 'left', at_ms: 0 })
  })

  it('a heartbeat lists session ids', () => {
    expect(HeartbeatSchema.safeParse({ producer, sessions: [CALL] }).success).toBe(true)
    expect(HeartbeatSchema.safeParse({ producer, sessions: ['nope'] }).success).toBe(false)
  })
})

describe('the secret', () => {
  afterEach(() => vi.unstubAllEnvs())
  const req = (auth?: string) => new Request('http://localhost/x', { method: 'POST', headers: auth ? { authorization: auth } : {} })
  const OWN = 'capture-feed-secret-of-its-own-0123456789'

  it('off while unset, and never the skill-runner’s key in its place', () => {
    vi.stubEnv('RUN_SKILL_INTERNAL_SECRET', 'root-secret-value-0123456789abcdef')
    vi.stubEnv('CAPTURE_FEED_SECRET', '')
    expect(captureFeedSecret()).toBeNull()
    expect(checkCaptureFeedAuth(req('Bearer root-secret-value-0123456789abcdef'))).toBe('off')
  })

  it('off when it equals another internal secret', () => {
    vi.stubEnv('CHAT_INTERNAL_SECRET', OWN)
    vi.stubEnv('CAPTURE_FEED_SECRET', OWN)
    expect(checkCaptureFeedAuth(req(`Bearer ${OWN}`))).toBe('off')
  })

  it('only the bearer of exactly that secret', () => {
    vi.stubEnv('CAPTURE_FEED_SECRET', OWN)
    expect(checkCaptureFeedAuth(req(`Bearer ${OWN}`))).toBe('ok')
    expect(checkCaptureFeedAuth(req())).toBe('refused')
    expect(checkCaptureFeedAuth(req(OWN))).toBe('refused')
    expect(checkCaptureFeedAuth(req(`Bearer ${OWN}x`))).toBe('refused')
    expect(checkCaptureFeedAuth(req(`Bearer ${OWN.slice(0, -1)}`))).toBe('refused')
  })
})

describe('the notes’ opening line', () => {
  it('what the notes missed while the recorder was gone, never past the call’s end', () => {
    const start = '2026-11-11T10:00:00.000Z'
    const end = '2026-11-11T11:00:00.000Z'
    expect(gapLines([{ from: '2026-11-11T10:12:00.000Z', to: '2026-11-11T10:15:10.000Z' }], start, end)).toEqual([
      'Notes missed about 3 min from 12 min into the call (the recorder stopped hearing it).',
    ])
    expect(gapLines([{ from: '2026-11-11T10:50:00.000Z', to: '2026-11-11T11:03:00.000Z' }], start, end)).toEqual([
      'Notes missed the rest of the call from 50 min into the call (the recorder stopped hearing it).',
    ])
    expect(gapLines([{ from: '2026-11-11T10:00:10.000Z' }], start, end)[0]).toContain('the rest of the call from the start of the call')
  })
})

describe('whose transcript a call capture is', () => {
  it('the recorder’s while it fills it (live or lost, open); anyone’s once the notes are done, or for any other capture', () => {
    expect(feedOwnsTranscript({ ended_at: null, is_transcript_locked: false, metadata: { notes_recorder: 'live' } })).toBe(true)
    expect(feedOwnsTranscript({ ended_at: null, is_transcript_locked: false, metadata: { notes_recorder: 'lost' } })).toBe(true)
    expect(feedOwnsTranscript({ ended_at: '2026-11-11T10:30:00Z', is_transcript_locked: true, metadata: { notes_recorder: 'done' } })).toBe(false)
    expect(feedOwnsTranscript({ ended_at: null, is_transcript_locked: true, metadata: { notes_recorder: 'live' } })).toBe(false)
    expect(feedOwnsTranscript({ ended_at: null, is_transcript_locked: false, metadata: { source: 'desktop' } })).toBe(false)
    expect(feedOwnsTranscript({ ended_at: null, metadata: null })).toBe(false)
    expect(feedOwnsTranscript(null)).toBe(false)
  })
})
