/**
 * The ring state machine one tab runs (src/lib/team-calls/ring-state.ts):
 * a ring rings until its row says it was settled (accepted or declined on
 * another tab or device, missed, cancelled) or its time is up here; a late
 * or repeated row never brings a settled one back; a full read drops what
 * settled while away; and a person already in a call hears no ring (a quiet
 * notice), with nothing at all for the call they are in.
 */
import { describe, expect, it } from 'vitest'
import { EMPTY_RINGS, nextExpiry, ringReducer, ringSurface, type RingState } from '../ring-state'
import type { TeamCallRing } from '../types'

const T0 = Date.parse('2026-11-11T10:00:00Z')
function ring(id: string, over: Partial<TeamCallRing> = {}): TeamCallRing {
  return {
    id,
    call_id: 'call-1',
    workspace_id: 'w',
    channel_id: 'c',
    member_id: 'me',
    caller_member_id: 'ana',
    caller_name: 'Ana Ruiz',
    channel_kind: 'dm',
    channel_name: null,
    state: 'ringing',
    created_at: new Date(T0).toISOString(),
    expires_at: new Date(T0 + 40_000).toISOString(),
    ...over,
  }
}
const run = (state: RingState, ...actions: Parameters<typeof ringReducer>[1][]) => actions.reduce(ringReducer, state)

describe('ringReducer and ringSurface', () => {
  it('a new ring rings', () => {
    const s = run(EMPTY_RINGS, { type: 'row', ring: ring('r1') })
    expect(ringSurface(s, { now: T0 + 1000, inCall: null }).ringing.map((r) => r.id)).toEqual(['r1'])
  })

  it('accepted on another device: it stops here at once', () => {
    const s = run(EMPTY_RINGS, { type: 'row', ring: ring('r1') }, { type: 'row', ring: ring('r1', { state: 'accepted' }) })
    expect(ringSurface(s, { now: T0 + 1000, inCall: null })).toEqual({ ringing: [], quiet: [] })
  })

  it('declined on another tab: it stops here, and the INSERT arriving late does not bring it back', () => {
    const s = run(EMPTY_RINGS, { type: 'row', ring: ring('r1', { state: 'declined' }) }, { type: 'row', ring: ring('r1') })
    expect(ringSurface(s, { now: T0 + 1000, inCall: null }).ringing).toEqual([])
  })

  it('answered here: settled at once (before the server’s word), and its later rows change nothing', () => {
    let s = run(EMPTY_RINGS, { type: 'row', ring: ring('r1') }, { type: 'settle', ringId: 'r1' })
    expect(ringSurface(s, { now: T0, inCall: null }).ringing).toEqual([])
    s = run(s, { type: 'row', ring: ring('r1') })
    expect(ringSurface(s, { now: T0, inCall: null }).ringing).toEqual([])
  })

  it('unanswered: past its time it stops here (the server writes it missed), and the missed row changes nothing', () => {
    let s = run(EMPTY_RINGS, { type: 'row', ring: ring('r1') })
    expect(ringSurface(s, { now: T0 + 39_000, inCall: null }).ringing).toHaveLength(1)
    // Even before the tick runs, a ring past its time is not drawn.
    expect(ringSurface(s, { now: T0 + 40_000, inCall: null }).ringing).toHaveLength(0)
    s = run(s, { type: 'tick', now: T0 + 40_050 })
    expect(s.open).toEqual({})
    s = run(s, { type: 'row', ring: ring('r1', { state: 'missed' }) })
    expect(s.open).toEqual({})
  })

  it('the next timer is the soonest ring’s', () => {
    const s = run(EMPTY_RINGS, { type: 'row', ring: ring('r1') }, { type: 'row', ring: ring('r2', { expires_at: new Date(T0 + 10_000).toISOString() }) })
    expect(nextExpiry(s)).toBe(T0 + 10_000)
    expect(nextExpiry(EMPTY_RINGS)).toBeNull()
  })

  it('in a call on this page: another call’s ring is a quiet notice, never a ringtone', () => {
    const s = run(EMPTY_RINGS, { type: 'row', ring: ring('r1', { call_id: 'call-2' }) })
    expect(ringSurface(s, { now: T0, inCall: 'call-1' })).toEqual({ ringing: [], quiet: [expect.objectContaining({ id: 'r1' })] })
  })

  it('a ring for the call they are in is nothing at all', () => {
    const s = run(EMPTY_RINGS, { type: 'row', ring: ring('r1', { call_id: 'call-1' }) })
    expect(ringSurface(s, { now: T0, inCall: 'call-1' })).toEqual({ ringing: [], quiet: [] })
  })

  it('in a call elsewhere (the server said busy): quiet', () => {
    const s = run(EMPTY_RINGS, { type: 'row', ring: ring('r1', { state: 'busy' }) })
    expect(ringSurface(s, { now: T0, inCall: null })).toEqual({ ringing: [], quiet: [expect.objectContaining({ id: 'r1' })] })
  })

  it('a full read replaces what is open: one settled while away is gone, and stays gone', () => {
    let s = run(EMPTY_RINGS, { type: 'row', ring: ring('r1') }, { type: 'row', ring: ring('r2') })
    s = run(s, { type: 'sync', rings: [ring('r2'), ring('r3', { state: 'declined' })] })
    expect(Object.keys(s.open)).toEqual(['r2'])
    s = run(s, { type: 'row', ring: ring('r1') })
    expect(Object.keys(s.open)).toEqual(['r2'])
  })

  it('several rings: oldest first', () => {
    const s = run(
      EMPTY_RINGS,
      { type: 'row', ring: ring('late', { created_at: new Date(T0 + 5000).toISOString() }) },
      { type: 'row', ring: ring('early') },
    )
    expect(ringSurface(s, { now: T0 + 6000, inCall: null }).ringing.map((r) => r.id)).toEqual(['early', 'late'])
  })

  it('remembers a bounded number of settled rings', () => {
    let s = EMPTY_RINGS
    for (let i = 0; i < 300; i++) s = ringReducer(s, { type: 'settle', ringId: `r${i}` })
    expect(Object.keys(s.settled).length).toBeLessThanOrEqual(200)
    expect(s.settled.r299).toBe(true)
  })
})
