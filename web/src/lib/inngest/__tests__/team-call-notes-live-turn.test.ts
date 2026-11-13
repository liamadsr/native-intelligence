/**
 * The call's finish and the live agent's last turn (src/lib/inngest/
 * team-call-notes.ts, src/lib/team-calls/live-turns.ts): a turn still
 * running when the call ended is waited for before the end-of-meeting pass,
 * so its writes never land beside or on top of the pass's: also when the
 * recorder's last words, after the call ended, stopped the agent while the
 * turn ran (the stop keeps its lease); a lease never given back is waited
 * out whole; a failed read counts as busy. With the live agent off, its
 * table is never read and nothing waits.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const CALL = '77777777-7777-4777-8777-777777777777'
const CAPTURE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

const h = vi.hoisted(() => ({ on: true, busy: [] as boolean[], calls: [] as string[], lease: null as null | (() => boolean) }))

vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({}) }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { createFunction: () => ({}) } }))
vi.mock('../capture-finalizer', () => ({
  runOwnerBatch: async () => (h.calls.push('batch'), 'completed'),
  postExtraction: async () => void h.calls.push('post'),
}))
vi.mock('@/lib/team-calls/egress', () => ({ teamCallEgressConfig: () => null, liveKitEgress: () => ({}) }))
vi.mock('@/lib/team-calls/fed-notes', () => ({
  FED_TAIL_CAP_MS: 120_000,
  markPassDone: async () => true,
  fedNotesStatus: async () => ({ fed: true, callStatus: 'ended', notesState: 'capturing', endedAt: null, undelivered: 0 }),
  writeFedNotes: async () => ({ outcome: 'ready', captureId: CAPTURE, ownerUserId: 'u-dana', workspaceId: 'ws', spoke: true }),
  finishClosedCapture: async () => ({ outcome: 'ready', captureId: CAPTURE, ownerUserId: 'u-dana', workspaceId: 'ws', spoke: true }),
  lockFedNotesAsTheyAre: async () => null,
}))
vi.mock('@/lib/team-calls/live-turns', async (orig) => ({
  ...(await orig<typeof import('@/lib/team-calls/live-turns')>()),
  teamCallLiveAgentOn: () => h.on,
  liveTurnBusy: async () => {
    h.calls.push('busy?')
    if (h.lease) return h.lease()
    return h.busy.length ? h.busy.shift()! : false
  },
}))

const { runTeamCallNotesFinish, LIVE_TURN_SETTLE_ROUNDS, FED_POLL } = await import('../team-call-notes')
const { LIVE_TURN_LEASE_SECONDS } = await import('@/lib/team-calls/live-turns')

function step() {
  return {
    run: async <T,>(_id: string, fn: () => Promise<T>) => fn(),
    sleep: async (id: string) => void h.calls.push(`sleep:${id.replace(/-\d+$/, '')}`),
  }
}

beforeEach(() => {
  h.on = true
  h.busy = []
  h.calls = []
  h.lease = null
})

/**
 * 655's contract for a call that ended with a turn running (proven on PGlite by
 * scripts/check-call-live-notes-sql.mjs): the recorder's last words after the end
 * stop the agent, the stop keeps the running turn's lease, busy() stays true
 * until the turn releases it or it runs out.
 */
function endedCallWithRunningTurn(opts: { releasedAfterLooks: number | null }) {
  const agent = { stopped: false, leaseHeld: true, looks: 0 }
  h.lease = () => {
    agent.looks++
    // The recorder's last append lands while the finish waits: its claim stops the agent.
    if (agent.looks === 1) agent.stopped = true
    if (opts.releasedAfterLooks !== null && agent.looks > opts.releasedAfterLooks) agent.leaseHeld = false
    return agent.leaseHeld
  }
  return agent
}

const looks = () => h.calls.filter((c) => c === 'busy?').length

describe('the finish and a live turn still running', () => {
  it('waits for it before the end-of-meeting pass', async () => {
    h.busy = [true, true, false]
    await runTeamCallNotesFinish({ event: { data: { callId: CALL } }, step: step() })
    expect(h.calls).toEqual(['busy?', 'sleep:live-turn-wait', 'busy?', 'sleep:live-turn-wait', 'busy?', 'batch', 'post'])
  })

  it('a capture closed by hand mid-call waits the same way', async () => {
    h.busy = [true, false]
    await runTeamCallNotesFinish({ event: { data: { callId: CALL, captureId: CAPTURE } }, step: step() })
    expect(h.calls).toEqual(['busy?', 'sleep:live-turn-wait', 'busy?', 'batch', 'post'])
  })

  it('a running lease on an ended call, the agent stopped by the last words: the pass waits until the turn gives the lease back', async () => {
    const agent = endedCallWithRunningTurn({ releasedAfterLooks: 4 })
    await runTeamCallNotesFinish({ event: { data: { callId: CALL } }, step: step() })
    expect(agent.stopped).toBe(true)
    expect(looks()).toBe(5)
    expect(h.calls.slice(-3)).toEqual(['busy?', 'batch', 'post'])
    expect(h.calls.indexOf('batch')).toBeGreaterThan(h.calls.lastIndexOf('sleep:live-turn-wait'))
  })

  it('a lease never given back (the turn’s answer never came): the pass waits past the whole lease, then runs', async () => {
    endedCallWithRunningTurn({ releasedAfterLooks: null })
    await runTeamCallNotesFinish({ event: { data: { callId: CALL } }, step: step() })
    expect(looks()).toBe(LIVE_TURN_SETTLE_ROUNDS)
    // Each look is FED_POLL apart: together longer than a lease, past which the turn's tools write nothing.
    expect(FED_POLL).toBe('5s')
    expect(LIVE_TURN_SETTLE_ROUNDS * 5).toBeGreaterThan(LIVE_TURN_LEASE_SECONDS)
    expect(h.calls.slice(-2)).toEqual(['batch', 'post'])
  })

  it('a busy read that fails counts as busy: the pass does not start beside a turn it could not see', async () => {
    let n = 0
    h.lease = () => {
      n++
      if (n <= 2) throw new Error('read failed')
      return false
    }
    await runTeamCallNotesFinish({ event: { data: { callId: CALL } }, step: step() })
    expect(h.calls).toEqual(['busy?', 'sleep:live-turn-wait', 'busy?', 'sleep:live-turn-wait', 'busy?', 'batch', 'post'])
  })

  it('with the live agent off, nothing is read and nothing waits', async () => {
    h.on = false
    await runTeamCallNotesFinish({ event: { data: { callId: CALL } }, step: step() })
    expect(h.calls).toEqual(['batch', 'post'])
  })
})
