/**
 * The live agent on a call's capture, the app's side (src/lib/team-calls/
 * live-turns.ts). Off unless TEAM_CALL_LIVE_AGENT=on with the recorder on.
 * The feed's hook answers at once and does its work after the segments
 * route has answered; a turn is handed to Inngest only when 655's claim gave
 * it the lease, so two callers at once start one turn; a send that fails
 * gives the lease back. A turn runs the live agent's own route as the
 * capture's owner, as the paired note-taker (it writes the record, never
 * talks), with the words the lease holds; it never reads who is in the call.
 * One that fails is skipped (its words stay for the next); a usage wall or a
 * refusal stops the agent for the call; nothing throws. The SQL itself
 * (throttle, lease, bound, the call's end) is proven on PGlite by
 * scripts/check-call-live-notes-sql.mjs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { LIVEKIT_ENV } from './signing'

const h = vi.hoisted(() => ({
  afters: [] as Array<() => Promise<unknown>>,
  sent: [] as unknown[],
}))

vi.mock('server-only', () => ({}))
vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (task: () => Promise<unknown>) => {
    h.afters.push(task)
  },
}))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: async (e: unknown) => void h.sent.push(e) } }))

const { callLiveTurnsHook, offerLiveTurn, runLiveTurn, teamCallLiveAgentOn, CALL_LIVE_TURN_EVENT, LIVE_TURN_MAX_FAILURES_IN_ROW } = await import('../live-turns')

const CAPTURE = '11111111-1111-4111-8111-111111111111'
const LEASE = '22222222-2222-4222-8222-222222222222'
const OWNER = '33333333-3333-4333-8333-333333333333'
const WS = '44444444-4444-4444-8444-444444444444'

/** An environment as process.env holds one. */
const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv

const ON = { ...LIVEKIT_ENV, TEAM_CALL_RECORDER: 'on', CAPTURE_FEED_SECRET: 'capture-feed-secret-of-its-own-0123456789', TEAM_CALL_LIVE_AGENT: 'on' }

interface FakeDb {
  svc: SupabaseClient
  rpcs: Array<[string, Record<string, unknown>]>
  tables: string[]
  inserted: Array<Record<string, unknown>>
  deleted: string[]
}

/** A service client: rpc answers by name, and the captures row of the owner. */
function fakeDb(rpc: Record<string, (args: Record<string, unknown>) => unknown>, owner: string | null = OWNER): FakeDb {
  const db: FakeDb = { svc: null as unknown as SupabaseClient, rpcs: [], tables: [], inserted: [], deleted: [] }
  const from = (table: string) => {
    db.tables.push(table)
    const chain = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => ({ data: table === 'captures' ? { user_id: owner, workspace_id: WS } : null, error: null }),
      insert: (row: Record<string, unknown>) => {
        db.inserted.push(row)
        return { select: () => ({ single: async () => ({ data: { id: 'tok-1' }, error: null }) }) }
      },
      delete: () => ({ eq: async (_c: string, v: string) => (db.deleted.push(v), { error: null }) }),
    }
    return chain
  }
  db.svc = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      db.rpcs.push([name, args])
      const fn = rpc[name]
      if (!fn) return { data: null, error: { message: `no ${name}` } }
      try {
        return { data: fn(args), error: null }
      } catch (err) {
        return { data: null, error: { message: (err as Error).message } }
      }
    },
    from,
  } as unknown as SupabaseClient
  return db
}

const claimed = (turn = 1) => [{ outcome: 'claimed', lease: LEASE, turn_no: turn }]
const window = (over: Record<string, unknown> = {}) => [{ from_offset: 100, to_offset: 400, context: '[Dana Ortiz] Earlier words\n', words: '[Rosa Lind] New words\n', ...over }]

let saved: NodeJS.ProcessEnv
beforeEach(() => {
  saved = { ...process.env }
  h.afters = []
  h.sent = []
})
afterEach(() => {
  process.env = saved
})

describe('the switch', () => {
  it('is off unless TEAM_CALL_LIVE_AGENT=on with the call recorder on', () => {
    expect(teamCallLiveAgentOn(env({}))).toBe(false)
    expect(teamCallLiveAgentOn(env({ TEAM_CALL_LIVE_AGENT: 'on' }))).toBe(false)
    const { TEAM_CALL_LIVE_AGENT: _off, ...recorderOnly } = ON
    expect(teamCallLiveAgentOn(env(recorderOnly))).toBe(false)
    expect(teamCallLiveAgentOn(env({ ...ON, TEAM_CALL_LIVE_AGENT: 'yes' }))).toBe(false)
    expect(teamCallLiveAgentOn(env(ON))).toBe(true)
  })
})

describe('the feed hook', () => {
  it('does nothing at all while the switch is off', async () => {
    const db = fakeDb({})
    await callLiveTurnsHook(db.svc, { sessionId: 's', captureId: CAPTURE, accepted: 3, transcriptLength: 900 })
    expect(h.afters).toEqual([])
    expect(db.rpcs).toEqual([])
  })

  it('answers at once and offers the turn after the route has answered', async () => {
    Object.assign(process.env, ON)
    const db = fakeDb({ team_call_live_turn_claim: () => claimed() })
    const started = performance.now()
    await callLiveTurnsHook(db.svc, { sessionId: 's', captureId: CAPTURE, accepted: 3, transcriptLength: 900 })
    // Nothing touched the database in the route's own time: the claim waits for after().
    expect(db.rpcs).toEqual([])
    expect(performance.now() - started).toBeLessThan(50)
    expect(h.afters).toHaveLength(1)
    await h.afters[0]()
    expect(db.rpcs.map(([n]) => n)).toEqual(['team_call_live_turn_claim'])
    expect(h.sent).toEqual([{ name: CALL_LIVE_TURN_EVENT, id: `call-live-turn-${CAPTURE}-${LEASE}`, data: { captureId: CAPTURE, lease: LEASE } }])
  })
})

describe('offering a turn', () => {
  it('sends a turn only when the claim gave the lease', async () => {
    for (const outcome of ['busy', 'too_soon', 'too_few_words', 'waiting', 'notes_off', 'stopped', 'not_a_call']) {
      h.sent = []
      const db = fakeDb({ team_call_live_turn_claim: () => [{ outcome, lease: null, turn_no: 4 }] })
      expect(await offerLiveTurn(db.svc, CAPTURE)).toBe(outcome)
      expect(h.sent).toEqual([])
    }
  })

  it('passes the cadence and the bound to the claim', async () => {
    const db = fakeDb({ team_call_live_turn_claim: () => [{ outcome: 'too_soon', lease: null, turn_no: 1 }] })
    await offerLiveTurn(db.svc, CAPTURE)
    expect(db.rpcs[0][1]).toEqual({
      target_capture: CAPTURE,
      min_interval_seconds: 20,
      min_chars: 60,
      ready_chars: 600,
      quiet_seconds: 30,
      max_turns: 300,
      lease_seconds: 300,
    })
  })

  it('two callers at once start one turn: the second finds the lease held', async () => {
    // The lease as 655 holds it: the first claim takes it, every other claim while it is held is busy.
    let held: string | null = null
    const db = fakeDb({
      team_call_live_turn_claim: () => {
        if (held) return [{ outcome: 'busy', lease: null, turn_no: 1 }]
        held = LEASE
        return claimed()
      },
    })
    const outcomes = await Promise.all([offerLiveTurn(db.svc, CAPTURE), offerLiveTurn(db.svc, CAPTURE)])
    expect(outcomes.sort()).toEqual(['busy', 'claimed'])
    expect(h.sent).toHaveLength(1)
  })

  it('a send that fails gives the lease back as a failed turn, and never throws', async () => {
    const db = fakeDb({ team_call_live_turn_claim: () => claimed(), team_call_live_turn_release: () => 'failed' })
    const out = await offerLiveTurn(db.svc, CAPTURE, { send: async () => Promise.reject(new Error('inngest down')) })
    expect(out).toBe('claimed')
    expect(db.rpcs.find(([n]) => n === 'team_call_live_turn_release')?.[1]).toMatchObject({ turn_lease: LEASE, turn_outcome: 'failed', reason: 'not_sent' })
  })

  it('a claim that cannot be read is skipped', async () => {
    const db = fakeDb({})
    expect(await offerLiveTurn(db.svc, CAPTURE)).toBe('error')
    expect(h.sent).toEqual([])
  })
})

describe('a turn', () => {
  const release = (db: FakeDb) => db.rpcs.find(([n]) => n === 'team_call_live_turn_release')?.[1]

  it('runs the live agent as the capture’s owner with the lease’s words, then reads them', async () => {
    const db = fakeDb({ team_call_live_turn_window: () => window(), team_call_live_turn_release: () => 'ready' })
    const posts: unknown[] = []
    const out = await runLiveTurn(db.svc, { captureId: CAPTURE, lease: LEASE }, { postTurn: async (a) => (posts.push(a), 200) })
    expect(out).toBe('ok')
    expect(posts).toEqual([{ captureId: CAPTURE, ownerId: OWNER, workspaceId: WS, recentChunks: ['[Dana Ortiz] Earlier words\n', '[Rosa Lind] New words\n'] }])
    expect(release(db)).toMatchObject({ turn_outcome: 'ok', sent_to: 400, max_failures_in_row: LIVE_TURN_MAX_FAILURES_IN_ROW })
  })

  it('never reads who is in the call: the owner having left changes nothing', async () => {
    const db = fakeDb({ team_call_live_turn_window: () => window(), team_call_live_turn_release: () => 'ready' })
    await runLiveTurn(db.svc, { captureId: CAPTURE, lease: LEASE }, { postTurn: async () => 200 })
    expect(db.tables).toEqual(['captures'])
    expect(db.rpcs.map(([n]) => n)).toEqual(['team_call_live_turn_window', 'team_call_live_turn_release'])
  })

  it('a turn that fails is skipped: its words stay unread for the next, and nothing throws', async () => {
    for (const fail of [async () => 500, async () => 504, async () => Promise.reject(new Error('socket hang up'))]) {
      const db = fakeDb({ team_call_live_turn_window: () => window(), team_call_live_turn_release: () => 'failed' })
      const out = await runLiveTurn(db.svc, { captureId: CAPTURE, lease: LEASE }, { postTurn: fail as () => Promise<number> })
      expect(out).toBe('failed')
      const r = release(db)
      expect(r?.turn_outcome).toBe('failed')
      expect(r?.sent_to ?? null).toBeNull()
    }
  })

  it('the owner’s usage running out, or the route refusing them, stops the agent for the call', async () => {
    for (const [status, reason] of [[429, 'usage'], [402, 'usage'], [403, 'refused']] as const) {
      const db = fakeDb({ team_call_live_turn_window: () => window(), team_call_live_turn_release: () => 'stopped' })
      expect(await runLiveTurn(db.svc, { captureId: CAPTURE, lease: LEASE }, { postTurn: async () => status })).toBe('stopped')
      expect(release(db)).toMatchObject({ turn_outcome: 'stopped', reason })
    }
  })

  it('once the call is over the turn sends nothing (655 stopped the agent; its release is stale)', async () => {
    const db = fakeDb({ team_call_live_turn_window: () => [], team_call_live_turn_release: () => 'stale' })
    const posts: unknown[] = []
    expect(await runLiveTurn(db.svc, { captureId: CAPTURE, lease: LEASE }, { postTurn: async (a) => (posts.push(a), 200) })).toBe('stopped')
    expect(posts).toEqual([])
  })

  it('a window with no words reads ahead without a model call', async () => {
    const db = fakeDb({ team_call_live_turn_window: () => window({ words: '  ' }), team_call_live_turn_release: () => 'ready' })
    const posts: unknown[] = []
    expect(await runLiveTurn(db.svc, { captureId: CAPTURE, lease: LEASE }, { postTurn: async (a) => (posts.push(a), 200) })).toBe('empty')
    expect(posts).toEqual([])
  })

  it('posts the live agent’s own route as the owner, as the paired note-taker, and revokes the token after', async () => {
    const db = fakeDb({ team_call_live_turn_window: () => window(), team_call_live_turn_release: () => 'ready' })
    const calls: Array<{ url: string; init: RequestInit }> = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }) as typeof fetch
    try {
      expect(await runLiveTurn(db.svc, { captureId: CAPTURE, lease: LEASE })).toBe('ok')
    } finally {
      globalThis.fetch = realFetch
    }
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toMatch(/\/api\/ai\/live-agent$/)
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      capture_id: CAPTURE,
      recent_chunks: ['[Dana Ortiz] Earlier words\n', '[Rosa Lind] New words\n'],
      mode: 'live',
      live_role: 'notes',
    })
    expect((calls[0].init.headers as Record<string, string>).Authorization).toMatch(/^Bearer nid_/)
    // The owner's token, pinned to the capture's workspace, and gone once the turn is over.
    expect(db.inserted[0]).toMatchObject({ user_id: OWNER, active_workspace_id: WS })
    expect(db.deleted).toEqual(['tok-1'])
  })
})
