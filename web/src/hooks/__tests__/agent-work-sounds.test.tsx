// @vitest-environment jsdom
/**
 * The run sounds, from the shell's one `tracked_job` channel (bots-v4.md Phase
 * 4a): the shared source's hook (useAgentWork, mounted once by
 * AgentWorkProvider) plays them, as the header's ledger hook (useWorkLedger)
 * did before it was deleted. Written while both hooks lived, and run against
 * both (the commit that moved the sounds), so the move kept every sound; the
 * old hook went with the Agents button.
 *
 * tracked_job has RLS, so a realtime UPDATE's old record is `{ id }` alone
 * (even with REPLICA IDENTITY FULL): the hook supplies the previous status
 * from what it saw last for the id (a load, an INSERT, an earlier UPDATE), and
 * the real trigger (src/lib/sounds/triggers.ts) picks the edge: one
 * `agent-complete` per running-to-done change. Every pushed row is noted for
 * whose it is (teammate-work.ts noteWorkRow), so the notice or card about it
 * that arrives next plays its teammate's own sound. INSERTs and loads play
 * nothing. Across windows the sound is one: each window asks the alert gates
 * with the same key (`work:<id>:done`), and the gates let one through.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Handler = (payload: unknown) => void

const hoisted = vi.hoisted(() => ({
  /** Each live channel's handlers, by event (one entry per channel made: two windows' share no object). */
  channels: new Set<Record<string, Handler>>(),
  play: vi.fn(async (_request: unknown): Promise<string> => 'played'),
  realPlay: null as null | ((request: unknown) => Promise<string>),
  /** What the (mocked) engine actually played. */
  engine: [] as string[],
  body: {} as Record<string, unknown>,
  /** While true, a channel made now stays down until the test brings it up (`subscribers`). */
  hold: false,
  subscribers: [] as Array<(status: string) => void>,
}))

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    channel: (name: string) => {
      const handlers: Record<string, Handler> = {}
      hoisted.channels.add(handlers)
      const ch: Record<string, unknown> = { topic: name, handlers }
      ch.on = (_type: string, spec: { event: string }, cb: Handler) => {
        handlers[spec.event] = cb
        return ch
      }
      // Up a tick later, as the real socket's reply is, unless held.
      ch.subscribe = (cb?: (status: string) => void) => {
        if (hoisted.hold) hoisted.subscribers.push(cb ?? (() => {}))
        else void Promise.resolve().then(() => cb?.('SUBSCRIBED'))
        return ch
      }
      return ch
    },
    removeChannel: (ch: { handlers: Record<string, Handler> }) => {
      hoisted.channels.delete(ch.handlers)
    },
  }),
}))
// The gates' entry point, spied (and, for the windows case, the real one).
vi.mock('@/lib/sounds/alerts', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/sounds/alerts')>()
  hoisted.realPlay = real.playAlertSound as (request: unknown) => Promise<string>
  return { ...real, playAlertSound: hoisted.play }
})
vi.mock('@/lib/sounds/engine', () => ({
  canPlaySoundsNow: () => true,
  playSound: (name: string) => {
    hoisted.engine.push(name)
    return { name, started: Promise.resolve(true), ended: Promise.resolve(), stop: () => {} }
  },
}))

import { MAX_TRACKED_STATUSES, SUBSCRIBE_WAIT_MS, useAgentWork } from '../use-agent-work'
import { announceAttentionItem, announceNotification } from '@/lib/sounds/triggers'
import { __resetTeammateWorkForTests } from '@/lib/sounds/teammate-work'
import { __resetAlertsForTests } from '@/lib/sounds/alerts'
import { __setLockManagerForTests } from '@/lib/sounds/cross-window'

/** A hook under test, mounted with or without its list of open rows loaded. */
type Subject = [name: string, Probe: (props: { withList: boolean }) => null]

/**
 * The hooks the suite runs against. It ran against the header's useWorkLedger
 * too until that hook was deleted (bots-v4.md Phase 4a): a hook that takes the
 * sounds over joins here.
 */
const SUBJECTS: Subject[] = [
  [
    "useAgentWork (the shared source's hook)",
    function SharedSource() {
      // The shell's always-on read: light, which loads the open rows (`withList` or not).
      useAgentWork()
      return null
    },
  ],
]

const RUN = { id: 'w1', workspace_id: 'ws1', member_id: 'm1', kind: 'coding_run', origin: 'user', source: {} }
const DONE = { sound: 'agent-complete', key: 'work:w1:done' }

const roots: Root[] = []

async function flush() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  })
}

async function mount(Probe: Subject[1], withList = false) {
  const root = createRoot(document.createElement('div'))
  roots.push(root)
  await act(async () => root.render(h(Probe, { withList })))
  await flush()
}

/** A table write, as realtime delivers it: to every channel up (each window's). */
function deliver(event: 'INSERT' | 'UPDATE', payload: Record<string, unknown>) {
  act(() => {
    for (const handlers of hoisted.channels.values()) handlers[event]?.(payload)
  })
}

/** What prod sends for an UPDATE: the full new row, and an old record of the key alone. */
const update = (row: Record<string, unknown>) => deliver('UPDATE', { new: row, old: { id: row.id } })
const insert = (row: Record<string, unknown>) => deliver('INSERT', { new: row })

/** Answers both hooks' reads: the open rows, the workspaces and members they cover, and the header's counts. */
function answer(items: unknown[] = []) {
  hoisted.body = { items, roster: [], workspace_ids: ['ws1'], member_ids: ['m1'], live: 1, needs_you: 0 }
}

beforeEach(() => {
  hoisted.channels.clear()
  hoisted.hold = false
  hoisted.subscribers.length = 0
  hoisted.engine.length = 0
  hoisted.play.mockImplementation(async () => 'played')
  __resetTeammateWorkForTests()
  answer()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => hoisted.body }) as unknown as Response),
  )
})

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe.each(SUBJECTS)('%s: the run sounds', (_name, Probe) => {
  describe('a run finishing', () => {
    beforeEach(() => mount(Probe))

    it('the first UPDATE of a row never seen plays nothing', () => {
      update({ ...RUN, status: 'done' })
      expect(hoisted.play).not.toHaveBeenCalled()
    })

    it('a run seen INSERTed chimes once when it finishes; the INSERT is silent', () => {
      insert({ ...RUN, status: 'queued' })
      expect(hoisted.play).not.toHaveBeenCalled()
      update({ ...RUN, status: 'done' })
      expect(hoisted.play).toHaveBeenCalledTimes(1)
      expect(hoisted.play).toHaveBeenCalledWith(DONE)
    })

    it('a run already going at mount is learned from its first (silent) running UPDATE', () => {
      update({ ...RUN, status: 'running' })
      expect(hoisted.play).not.toHaveBeenCalled()
      update({ ...RUN, status: 'done' })
      expect(hoisted.play).toHaveBeenCalledTimes(1)
      expect(hoisted.play).toHaveBeenCalledWith(DONE)
    })

    it('one agent-complete per running-to-done change: a later write to a finished run stays silent', () => {
      update({ ...RUN, status: 'running' })
      update({ ...RUN, status: 'done' })
      update({ ...RUN, status: 'done' })
      expect(hoisted.play).toHaveBeenCalledTimes(1)
      // Run again and finish again: a second change, a second ask.
      update({ ...RUN, status: 'running' })
      update({ ...RUN, status: 'done' })
      expect(hoisted.play).toHaveBeenCalledTimes(2)
    })

    it('a review closing (needs_review → done) is your own act, and silent', () => {
      update({ ...RUN, status: 'needs_review' })
      update({ ...RUN, status: 'done' })
      expect(hoisted.play).not.toHaveBeenCalled()
    })

    it('still reads a real old status when one is sent', () => {
      deliver('UPDATE', { new: { ...RUN, status: 'done' }, old: { id: 'w1', status: 'running' } })
      expect(hoisted.play).toHaveBeenCalledWith(DONE)
    })
  })

  it('a run in the loaded list chimes on its first UPDATE to done', async () => {
    answer([{ ...RUN, status: 'running', title: 'Fix the build', created_at: '2026-10-07T10:00:00.000Z' }])
    await mount(Probe, true)
    update({ ...RUN, status: 'done' })
    expect(hoisted.play).toHaveBeenCalledTimes(1)
    expect(hoisted.play).toHaveBeenCalledWith(DONE)
  })

  describe("a teammate's own sounds, picked by whose the row is (bots-v2 Phase 6)", () => {
    beforeEach(() => mount(Probe))

    const TEAMMATE_RUN = { ...RUN, kind: 'work_run', ai_team_member_id: 'tm-1' }
    const workNeedsYou = (status: string, body: string | null = null) => ({
      id: `n-${status}`,
      type: 'work_needs_you',
      body,
      target_type: 'work_item',
      target_id: 'w1',
      is_read: false,
      metadata: { kind: 'work_run', status },
    })

    it('parking on a question: the row move is silent, its notice plays the question sound once', () => {
      update({ ...TEAMMATE_RUN, status: 'running' })
      update({ ...TEAMMATE_RUN, status: 'needs_input', needs: { kind: 'input', questions: ['Which repo?'] } })
      expect(hoisted.play).not.toHaveBeenCalled()
      announceNotification(workNeedsYou('needs_input', 'Which repo?'))
      expect(hoisted.play).toHaveBeenCalledTimes(1)
      expect(hoisted.play).toHaveBeenCalledWith(expect.objectContaining({ sound: 'agent-alert-questions' }))
    })

    it('finishing work to review: the row move is silent, its notice plays the review sound once', () => {
      update({ ...TEAMMATE_RUN, status: 'running' })
      update({ ...TEAMMATE_RUN, status: 'needs_review' })
      expect(hoisted.play).not.toHaveBeenCalled()
      announceNotification(workNeedsYou('needs_review'))
      expect(hoisted.play).toHaveBeenCalledTimes(1)
      expect(hoisted.play).toHaveBeenCalledWith({ sound: 'agent-alert-hopful', key: 'work:w1:needs_review' })
    })

    it('each row is told apart: a notice plays for the owner of the row it names', () => {
      update({ ...TEAMMATE_RUN, id: 'w2', ai_team_member_id: null, status: 'needs_review' })
      update({ ...TEAMMATE_RUN, status: 'needs_review' })
      announceNotification({ ...workNeedsYou('needs_review'), target_id: 'w2' })
      // w2 has no teammate: today's sound for finished work to review.
      expect(hoisted.play).toHaveBeenLastCalledWith({ sound: 'agent-complete', key: 'work:w2:needs_review' })
      announceNotification(workNeedsYou('needs_review'))
      expect(hoisted.play).toHaveBeenLastCalledWith({ sound: 'agent-alert-hopful', key: 'work:w1:needs_review' })
    })

    // bots-v4.md Phase 3: the email drafting pass finishes `done` with its
    // drafts (no review, so no notice). Its row is inserted with no origin, so
    // it carries the column's default, 'user' (migration 280), like a run a
    // person started; it's silent because `email_drafts` isn't one of the
    // kinds whose finishing chimes (triggers.ts USER_RUN_KINDS), as any
    // finished loop pass.
    it('an email drafting pass finishing done with its drafts is silent', () => {
      const pass = { ...TEAMMATE_RUN, kind: 'email_drafts', origin: 'user', source: {} }
      update({ ...pass, status: 'running' })
      update({ ...pass, status: 'done', deliverables: [{ type: 'email_draft', id: 'd1', label: 'Re: pricing' }] })
      expect(hoisted.play).not.toHaveBeenCalled()
    })

    it("a teammate's loop fire, seen INSERTed: the cards it surfaces play the card sound", () => {
      insert({
        id: 'loop-1',
        workspace_id: 'ws1',
        member_id: 'm1',
        kind: 'flow_run',
        status: 'running',
        run_key: 'fire-1:flow-1',
        ai_team_member_id: 'tm-triage',
        source: {},
      })
      announceAttentionItem({ id: 'c1', status: 'pending', run_key: 'fire-1' })
      expect(hoisted.play).toHaveBeenCalledWith({ sound: 'agent-alert-arivel', key: 'attention-run:fire-1' })
    })
  })
})

describe('what a load teaches the memory', () => {
  function Feed() {
    useAgentWork()
    return null
  }

  /** An answer of `n` rows, newest first, as the routes answer: its newest is the run, still going. */
  function bigAnswer(n: number) {
    const at = Date.UTC(2026, 9, 7, 12)
    return Array.from({ length: n }, (_, i) => ({
      ...RUN,
      id: i === 0 ? 'w1' : `old-${i}`,
      status: i === 0 ? 'running' : 'done',
      title: `Item ${i}`,
      created_at: new Date(at - i * 60_000).toISOString(),
    }))
  }

  it.each([400, 520, 600, MAX_TRACKED_STATUSES + 100])(
    'a %i-row answer is learned oldest first: its newest run still chimes when it finishes',
    async (n) => {
      answer(bigAnswer(n))
      await mount(Feed)
      update({ ...RUN, status: 'done' })
      expect(hoisted.play).toHaveBeenCalledTimes(1)
      expect(hoisted.play).toHaveBeenCalledWith(DONE)
    },
  )

  describe('a finish nobody heard never chimes late', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('a run an early load saw going, that settled before the channel came up, is forgotten by the reload', async () => {
      // Realtime is slow: the load goes early, without the channel, and sees two runs going.
      hoisted.hold = true
      answer([
        { ...RUN, status: 'running', created_at: '2026-10-07T10:01:00.000Z' },
        { ...RUN, id: 'w2', status: 'running', created_at: '2026-10-07T10:00:00.000Z' },
      ])
      await mount(Feed)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SUBSCRIBE_WAIT_MS + 10)
      })
      await flush()
      // w1 finishes while nothing listens; w2 is still going. The channel comes up, and reloads.
      answer([{ ...RUN, id: 'w2', status: 'running', created_at: '2026-10-07T10:00:00.000Z' }])
      await act(async () => {
        for (const up of hoisted.subscribers.splice(0)) up('SUBSCRIBED')
      })
      await flush()
      // Minutes later, w1's next write (its open stamp): no late chime.
      update({ ...RUN, status: 'done', opened_at: '2026-10-07T10:09:00.000Z' })
      expect(hoisted.play).not.toHaveBeenCalled()
      // The run the reload still holds chimes as ever.
      update({ ...RUN, id: 'w2', status: 'done' })
      expect(hoisted.play).toHaveBeenCalledTimes(1)
      expect(hoisted.play).toHaveBeenCalledWith({ sound: 'agent-complete', key: 'work:w2:done' })
    })
  })
})

/** A LockManager with what the gates use: exclusive locks, ifAvailable, held while the callback's promise is, and query. */
class FakeLocks {
  held = new Set<string>()
  async request(name: string, options: { ifAvailable?: boolean }, callback: (lock: unknown) => unknown) {
    if (this.held.has(name)) {
      if (options.ifAvailable) return callback(null)
      throw new Error(`test lock manager: ${name} is contended`)
    }
    this.held.add(name)
    try {
      return await callback({ name })
    } finally {
      this.held.delete(name)
    }
  }
  async query() {
    return { held: [...this.held].map((name) => ({ name })) }
  }
}

describe.each(SUBJECTS)('%s: once across windows (the alert gates)', (_name, Probe) => {
  beforeEach(() => {
    window.localStorage.clear()
    __resetAlertsForTests()
    __setLockManagerForTests(new FakeLocks())
    hoisted.play.mockImplementation((request) => hoisted.realPlay!(request))
  })
  afterEach(() => {
    __setLockManagerForTests(undefined)
    window.localStorage.clear()
  })

  it('two windows hear the same run finish: both ask with one key, one sound plays', async () => {
    // Two windows, each with its own channel and its own memory of the run.
    await mount(Probe)
    await mount(Probe)
    expect(hoisted.channels.size).toBe(2)
    update({ ...RUN, status: 'running' })
    update({ ...RUN, status: 'done' })
    await flush()
    expect(hoisted.play).toHaveBeenCalledTimes(2)
    for (const [request] of hoisted.play.mock.calls) expect(request).toEqual(DONE)
    const outcomes = await Promise.all(hoisted.play.mock.results.map((r) => r.value as Promise<string>))
    expect(outcomes.sort()).toEqual(['duplicate', 'played'])
    expect(hoisted.engine).toEqual(['agent-complete'])
  })
})
