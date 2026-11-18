/**
 * Whether a call's words are being written (668): the sweeper says so of a
 * session whose recorder went quiet (its next heartbeat clears it), and a
 * database without 668 answers nothing rather than failing the feed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { markLostFeeds, stampFeedHealth } from '../store'

let rpcs: Array<[string, Record<string, unknown>]>
let answers: Record<string, { data: unknown; error: unknown }>
const svc = {
  rpc: async (name: string, args: Record<string, unknown>) => {
    rpcs.push([name, args])
    return answers[name] ?? { data: null, error: { message: `no answer for ${name}` } }
  },
} as unknown as SupabaseClient

beforeEach(() => {
  rpcs = []
  answers = {}
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => vi.restoreAllMocks())

describe('feed health', () => {
  it('a session the sweeper marks lost reads “lost” for the members, stamped as the sweeper (any producer)', async () => {
    answers.capture_feed_mark_lost = { data: [{ session_id: 's1', capture_id: 'c1', source_ref: 'call-1' }], error: null }
    answers.capture_feed_health_stamp = { data: [{ o_session: 's1', o_capture: 'c1', o_changed: true }], error: null }
    expect(await markLostFeeds(svc)).toEqual([{ sessionId: 's1', captureId: 'c1', sourceRef: 'call-1' }])
    expect(rpcs[1]).toEqual(['capture_feed_health_stamp', { p_producer_id: null, p_sessions: ['s1'], p_states: ['lost'] }])
  })

  it('a stamp that fails never fails the sweep; none asked when nothing is lost', async () => {
    answers.capture_feed_mark_lost = { data: [{ session_id: 's1', capture_id: 'c1', source_ref: 'call-1' }], error: null }
    answers.capture_feed_health_stamp = { data: null, error: { message: 'boom' } }
    expect(await markLostFeeds(svc)).toHaveLength(1)
    rpcs = []
    answers.capture_feed_mark_lost = { data: [], error: null }
    await markLostFeeds(svc)
    expect(rpcs.map(([n]) => n)).toEqual(['capture_feed_mark_lost'])
  })

  it('without 668 applied: nothing stamped, nothing thrown; any other failure throws', async () => {
    answers.capture_feed_health_stamp = { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }
    expect(await stampFeedHealth(svc, { kind: 'livekit_recorder', id: 'recorder' }, [{ id: 's1', state: 'down' }])).toEqual([])
    answers.capture_feed_health_stamp = { data: null, error: { code: '23514', message: 'check' } }
    await expect(stampFeedHealth(svc, { kind: 'livekit_recorder', id: 'recorder' }, [{ id: 's1', state: 'down' }])).rejects.toThrow(/health not stamped/)
    expect(await stampFeedHealth(svc, null, [])).toEqual([])
  })
})
