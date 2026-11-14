/**
 * The call's finish and the live agent's last turn (src/lib/inngest/
 * team-call-notes.ts, src/lib/team-calls/live-turns.ts): a turn still
 * running when the call ended is waited for before the end-of-meeting pass,
 * so its writes never land beside or on top of the pass's: also when the
 * recorder's last words, after the call ended, stopped the agent while the
 * turn ran (the stop keeps its lease); a lease never given back is waited
 * out whole; a failed read counts as busy. With the live agent off it looks
 * once, and waits out a lease it sees. The route's "not yet" is asked again
 * after a wait; on the last attempt it escapes its step, so a retry of the
 * finish asks again (the steps are memoised as Inngest keeps them), and a
 * finished batch never runs twice.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const CALL = '77777777-7777-4777-8777-777777777777'
const CAPTURE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

const h = vi.hoisted(() => ({ on: true, busy: [] as boolean[], calls: [] as string[], lease: null as null | (() => boolean), notYet: 0, postFails: 0 }))

vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({}) }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { createFunction: () => ({}) } }))
vi.mock('../capture-finalizer', () => {
  class CallNotesLiveError extends Error {}
  return {
    CallNotesLiveError,
    runOwnerBatch: async () => {
      // The route's "not yet" (409 CALL_NOTES_LIVE), as many times as asked.
      if (h.notYet > 0) {
        h.notYet--
        h.calls.push('batch:not-yet')
        throw new CallNotesLiveError('a live turn still holds the lease')
      }
      h.calls.push('batch')
      return 'completed'
    },
    postExtraction: async () => {
      if (h.postFails > 0) {
        h.postFails--
        throw new Error('post-extraction failed')
      }
      h.calls.push('post')
    },
  }
})
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

const { runTeamCallNotesFinish, LIVE_TURN_SETTLE_ROUNDS, FED_POLL, CALL_BATCH_ATTEMPTS } = await import('../team-call-notes')
const { LIVE_TURN_LEASE_SECONDS, LIVE_TURN_BUSY_MARGIN_SECONDS } = await import('@/lib/team-calls/live-turns')

/**
 * Steps as Inngest runs them: a finished step's result is kept by its id and
 * replayed on a retry of the function, never re-run; a step that threw is not
 * kept, so the retry runs it again. A finished sleep is not slept again.
 */
function step(memo = new Map<string, unknown>()) {
  return {
    run: async <T,>(id: string, fn: () => Promise<T>): Promise<T> => {
      if (memo.has(id)) return memo.get(id) as T
      const out = await fn()
      memo.set(id, out)
      return out
    },
    sleep: async (id: string) => {
      if (memo.has(`sleep:${id}`)) return
      h.calls.push(`sleep:${id.replace(/-\d+$/, '')}`)
      memo.set(`sleep:${id}`, null)
    },
  }
}

/** The finish as Inngest runs it: a run that throws is retried (its `retries: 2`) with the same kept steps; a NonRetriableError is not. */
async function finishWithRetries(data: Record<string, unknown>, retries = 2) {
  const memo = new Map<string, unknown>()
  let error: unknown = null
  for (let run = 0; run <= retries; run++) {
    try {
      return { out: await runTeamCallNotesFinish({ event: { data }, step: step(memo) }), runs: run + 1, error: null }
    } catch (err) {
      error = err
      if ((err as Error).name === 'NonRetriableError') break
    }
  }
  return { out: null, runs: retries + 1, error }
}

beforeEach(() => {
  h.on = true
  h.busy = []
  h.calls = []
  h.lease = null
  h.notYet = 0
  h.postFails = 0
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
    expect(LIVE_TURN_SETTLE_ROUNDS * 5).toBeGreaterThan(LIVE_TURN_LEASE_SECONDS + LIVE_TURN_BUSY_MARGIN_SECONDS)
    // The margin the wait counts is 655's own (busy()'s SQL).
    const sql = readFileSync(join(process.cwd(), 'supabase/migrations/655_call_live_agent.sql'), 'utf8')
    expect(sql).toContain(`a.lease_until > now() - interval '${LIVE_TURN_BUSY_MARGIN_SECONDS} seconds'`)
    expect(h.calls.slice(-2)).toEqual(['batch', 'post'])
  })

  it('every read failing: the pass runs after the bound, and the log says the lease could not be read', async () => {
    h.lease = () => {
      throw new Error('read failed')
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await runTeamCallNotesFinish({ event: { data: { callId: CALL } }, step: step() })
      expect(looks()).toBe(LIVE_TURN_SETTLE_ROUNDS)
      expect(h.calls.slice(-2)).toEqual(['batch', 'post'])
      const said = warn.mock.calls.map((c) => String(c[0])).join('\n')
      expect(said).toContain('lease could not be read')
      expect(said).not.toContain('never finished')
    } finally {
      warn.mockRestore()
    }
  })

  it('a lease held the whole wait: the log says the pass ran after waiting it out', async () => {
    endedCallWithRunningTurn({ releasedAfterLooks: null })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await runTeamCallNotesFinish({ event: { data: { callId: CALL } }, step: step() })
      expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain("after waiting out a live turn's lease (0 of")
    } finally {
      warn.mockRestore()
    }
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

  it('with the live agent off and no lease held: one look, nothing waits', async () => {
    h.on = false
    await runTeamCallNotesFinish({ event: { data: { callId: CALL } }, step: step() })
    expect(h.calls).toEqual(['busy?', 'batch', 'post'])
  })

  it('with the live agent off and no row to read (655 not applied): one look, nothing waits', async () => {
    h.on = false
    h.lease = () => {
      throw new Error('function does not exist')
    }
    await runTeamCallNotesFinish({ event: { data: { callId: CALL } }, step: step() })
    expect(h.calls).toEqual(['busy?', 'batch', 'post'])
  })

  it('the switch turned off while the call was live, a turn cut by the roll-out still holding its lease: waited out, then the pass runs (never dropped)', async () => {
    h.on = false
    endedCallWithRunningTurn({ releasedAfterLooks: 3 })
    await runTeamCallNotesFinish({ event: { data: { callId: CALL } }, step: step() })
    expect(looks()).toBe(4)
    expect(h.calls.slice(-2)).toEqual(['batch', 'post'])
  })

  it('the route answers "not yet" (409 CALL_NOTES_LIVE): the finish waits again and asks again, and the pass runs', async () => {
    h.on = false
    h.notYet = 1
    await runTeamCallNotesFinish({ event: { data: { callId: CALL } }, step: step() })
    expect(h.calls).toEqual(['busy?', 'batch:not-yet', 'busy?', 'batch', 'post'])
  })

  it('"not yet" on the last attempt escapes its step: the retry of the finish asks the route again, and the pass runs once', async () => {
    h.notYet = CALL_BATCH_ATTEMPTS // the last attempt's first ask is "not yet" too; its retry is answered
    const { out, runs } = await finishWithRetries({ callId: CALL })
    expect(out).toMatchObject({ status: 'ready' })
    expect(runs).toBe(2)
    // Asked CALL_BATCH_ATTEMPTS times in the first run, and once more by the retry (the earlier
    // attempts' "not yet" are kept steps: replayed, never asked again).
    expect(h.calls.filter((c) => c === 'batch:not-yet')).toHaveLength(CALL_BATCH_ATTEMPTS)
    expect(h.calls.filter((c) => c === 'batch')).toHaveLength(1)
    expect(h.calls.filter((c) => c === 'post')).toHaveLength(1)
  })

  it('"not yet" every time: the route is asked CALL_BATCH_ATTEMPTS + 2 times, then the finish fails (its onFailure locks the notes as they are)', async () => {
    h.notYet = 100
    const { out, runs, error } = await finishWithRetries({ callId: CALL })
    expect(out).toBeNull()
    expect(runs).toBe(3)
    expect((error as Error).name).not.toBe('NonRetriableError')
    expect(h.calls.filter((c) => c === 'batch:not-yet')).toHaveLength(CALL_BATCH_ATTEMPTS + 2)
    expect(h.calls).not.toContain('post')
  })

  it('a finished batch never runs twice: a retry after a later step failed replays it', async () => {
    h.postFails = 1
    const { out, runs } = await finishWithRetries({ callId: CALL })
    expect(out).toMatchObject({ status: 'ready' })
    expect(runs).toBe(2)
    expect(h.calls.filter((c) => c === 'batch')).toHaveLength(1)
    expect(h.calls.filter((c) => c === 'post')).toHaveLength(1)
  })
})
