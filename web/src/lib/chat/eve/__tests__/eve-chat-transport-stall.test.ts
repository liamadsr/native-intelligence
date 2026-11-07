/**
 * A send whose session accepts it and never starts a turn (A4 live check: the
 * home thread bound to a run on a retired dev deployment answered 202, then
 * nothing). Pinned:
 *   - no event within the stall window → the session's health is read; dead
 *     (idle, ended, or unreadable) → the turn fails with EVE_SESSION_STALLED,
 *     the handle is dropped, and nothing is re-sent by itself;
 *   - the next send never re-attaches the dead session (though the row still
 *     names it): it makes a fresh one, primed with the thread, registered over
 *     the dead one;
 *   - a live but slow session (a turn running when the health is read) is
 *     waited for and kept;
 *   - a session that shows anything (reasoning) before the window is never
 *     read at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai'
import type { HandleMessageStreamEvent } from 'eve/client'
import {
  EveChatTransport,
  EveSessionBusyError,
  EveSessionStalledError,
  SESSION_HEALTH_TAIL_EVENTS,
  healthOfEvents,
  sessionHealth,
  type SessionBusyState,
} from '../eve-chat-transport'

const ev = (type: string, data: Record<string, unknown> = {}) => ({ type, data: { sequence: 0, stepIndex: 0, turnId: 'turn_0', ...data } }) as unknown as HandleMessageStreamEvent
const evText = (delta: string) => ev('message.appended', { messageDelta: delta })
const evDone = () => ev('turn.completed')

type Script = { events: Array<{ at: number; event: HandleMessageStreamEvent }> } | 'silent'

function response(sessionId: string, script: Script) {
  return {
    sessionId,
    [Symbol.asyncIterator]() {
      if (script === 'silent') return { next: () => new Promise<IteratorResult<HandleMessageStreamEvent>>(() => {}) }
      const queue = [...script.events]
      let last = 0
      return {
        async next(): Promise<IteratorResult<HandleMessageStreamEvent>> {
          const item = queue.shift()
          if (!item) return { done: true, value: undefined }
          await new Promise((r) => setTimeout(r, Math.max(0, item.at - last)))
          last = item.at
          return { done: false, value: item.event }
        },
      }
    },
  }
}

function sendOpts(): Parameters<ChatTransport<UIMessage>['sendMessages']>[0] {
  return {
    chatId: 'chat-1',
    messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
    trigger: 'submit-message',
    messageId: undefined,
    body: { conversationId: 'home-1' },
  } as unknown as Parameters<ChatTransport<UIMessage>['sendMessages']>[0]
}

async function drain(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const chunks: UIMessageChunk[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  return chunks
}

function setup(opts: {
  scripts: Record<string, Script>
  snapshot: (id: string) => Promise<{ events: Array<{ type: string }> }>
  rowSession: string | null
  compaction?: { waitMs: number; pollMs: number }
}) {
  const busy: Array<SessionBusyState | null> = []
  const attached: string[] = []
  const created: Array<{ message: unknown }> = []
  const registered: Array<{ sessionId: string; previousSessionId: string | null }> = []
  const snapshots: string[] = []
  const tailStarts: Array<number | undefined> = []
  let made = 0
  const makeSession = (id: string) => ({
    send: vi.fn(async () => response(id, opts.scripts[id] ?? { events: [{ at: 0, event: evText('hi') }, { at: 0, event: evDone() }] })),
    respond: vi.fn(),
    cancel: vi.fn(async () => ({})),
    // A health read: the tail of the durable stream, which then stays open (a live stream follows).
    stream: vi.fn((streamOpts: { startIndex?: number }) => {
      snapshots.push(id)
      tailStarts.push(streamOpts.startIndex)
      return (async function* () {
        const snap = await opts.snapshot(id)
        for (const e of snap.events) yield e
        await new Promise<never>(() => {})
      })()
    }),
    state: { sessionId: id },
  })
  const client = {
    sessions: {
      create: vi.fn(async (input: { message: unknown }) => {
        const id = `wrun_NEW${++made}`
        created.push({ message: input.message })
        return { response: response(id, { events: [{ at: 0, event: evText('fresh') }, { at: 0, event: evDone() }] }), session: makeSession(id) }
      }),
      attach: vi.fn((id: string) => {
        attached.push(id)
        return makeSession(id)
      }),
    },
  }
  const transport = new EveChatTransport({
    getAccessToken: () => 'tok',
    mintRunToken: async () => ({ token: 'run', conversationId: 'home-1', historyPrimer: 'PRIMER', ...(opts.rowSession ? { eveSessionId: opts.rowSession } : {}) }),
    registerEveSession: async (a) => void registered.push({ sessionId: a.sessionId, previousSessionId: a.previousSessionId }),
    persistTurn: async () => {},
    createClient: () => client as never,
    timeouts: {
      turnStartStallMs: 30,
      sessionHealthReadMs: 50,
      sessionHealthTailIdleMs: 10,
      ...(opts.compaction ? { compactionWaitMs: opts.compaction.waitMs, compactionPollMs: opts.compaction.pollMs } : {}),
    },
    onSessionBusy: (_chatId, state) => void busy.push(state),
  })
  return { transport, attached, created, registered, snapshots, busy, tailStarts }
}

let warn: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => warn.mockRestore())

describe('a send whose session never starts a turn (A4 live check)', () => {
  it('times out, reads the session as dead, fails with EVE_SESSION_STALLED, and drops the handle; the next send starts fresh', async () => {
    const s = setup({
      rowSession: 'wrun_DEAD',
      scripts: { wrun_DEAD: 'silent' },
      // Idle: its last turn ended, and the message just accepted never started one.
      snapshot: async () => ({ events: [{ type: 'turn.started' }, { type: 'turn.completed' }] }),
    })
    const err = await drain(await s.transport.sendMessages(sendOpts())).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(EveSessionStalledError)
    expect((err as { code: string }).code).toBe('EVE_SESSION_STALLED')
    expect(s.snapshots).toEqual(['wrun_DEAD'])
    // Only the tail is read, never the whole history.
    expect(s.tailStarts).toEqual([-SESSION_HEALTH_TAIL_EVENTS])
    expect(s.transport.eveSessionIdOf('chat-1')).toBeNull()
    // Nothing re-sent by itself.
    expect(s.created).toHaveLength(0)

    // The Retry: the row still names the dead session, which is never re-attached
    // (it is read once more, still idle, so a fresh session goes ahead).
    const chunks = await drain(await s.transport.sendMessages(sendOpts()))
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
    expect(new Set(s.attached)).toEqual(new Set(['wrun_DEAD']))
    expect(s.snapshots).toEqual(['wrun_DEAD', 'wrun_DEAD'])
    expect(s.created).toHaveLength(1)
    expect(JSON.stringify(s.created[0].message)).toContain('PRIMER')
    expect(s.registered).toEqual([{ sessionId: 'wrun_NEW1', previousSessionId: 'wrun_DEAD' }])
  })

  it('an ended session, or one whose health can’t be read, is dead too', async () => {
    for (const snapshot of [async () => ({ events: [{ type: 'session.failed' }] }), async () => Promise.reject(new Error('404')), () => new Promise<never>(() => {})]) {
      const s = setup({ rowSession: 'wrun_DEAD', scripts: { wrun_DEAD: 'silent' }, snapshot: snapshot as never })
      const err = await drain(await s.transport.sendMessages(sendOpts())).then(
        () => null,
        (e: unknown) => e,
      )
      expect(err).toBeInstanceOf(EveSessionStalledError)
    }
  })

  it('a live but slow session (a turn running when its health is read) is waited for and kept', async () => {
    const s = setup({
      rowSession: 'wrun_SLOW',
      scripts: { wrun_SLOW: { events: [{ at: 120, event: evText('slow but here') }, { at: 120, event: evDone() }] } },
      snapshot: async () => ({ events: [{ type: 'turn.completed' }, { type: 'turn.started' }] }),
    })
    const chunks = await drain(await s.transport.sendMessages(sendOpts()))
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
    expect(s.snapshots).toEqual(['wrun_SLOW'])
    expect(s.transport.eveSessionIdOf('chat-1')).toBe('wrun_SLOW')
  })

  it('a session that shows reasoning before the window is never read, however long the answer takes', async () => {
    const s = setup({
      rowSession: 'wrun_THINK',
      scripts: {
        wrun_THINK: {
          events: [
            { at: 5, event: ev('turn.started') },
            { at: 10, event: ev('reasoning.appended', { reasoningDelta: 'thinking…' }) },
            { at: 90, event: evText('done thinking') },
            { at: 90, event: evDone() },
          ],
        },
      },
      snapshot: async () => {
        throw new Error('must not be read')
      },
    })
    const chunks = await drain(await s.transport.sendMessages(sendOpts()))
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
    expect(s.snapshots).toEqual([])
    expect(s.transport.eveSessionIdOf('chat-1')).toBe('wrun_THINK')
  })
})

describe('sessionHealth (a bounded tail read)', () => {
  const stream = (events: Array<{ type: string }>, opts: { thenStream?: boolean } = {}) => ({
    stream: vi.fn(() =>
      (async function* () {
        for (const e of events) yield e
        if (opts.thenStream) for (;;) {
          await new Promise((r) => setTimeout(r, 5))
          yield { type: 'message.appended' }
        }
        await new Promise<never>(() => {})
      })(),
    ),
  })

  it('reads only the tail and stops at its first pause', async () => {
    const s = stream([{ type: 'turn.started' }, { type: 'turn.completed' }, { type: 'session.waiting' }, { type: 'compaction.requested' }])
    expect(await sessionHealth(s as never, 2_000, 20)).toBe('compacting')
    expect(s.stream).toHaveBeenCalledWith(expect.objectContaining({ startIndex: -SESSION_HEALTH_TAIL_EVENTS, streamReconnectPolicy: { reconnect: false } }))
  })

  it('a turn streaming the whole time is judged on what came by the cap: alive', async () => {
    expect(await sessionHealth(stream([{ type: 'message.appended' }], { thenStream: true }) as never, 80, 20)).toBe('alive')
  })

  it('nothing at all (a failed or hung open) is dead', async () => {
    expect(await sessionHealth(stream([]) as never, 40, 20)).toBe('dead')
    expect(await sessionHealth({ stream: () => { throw new Error('404') } } as never, 40, 20)).toBe('dead')
  })
})

describe('healthOfEvents', () => {
  it('a window that begins mid-turn (past its turn.started) still reads the running turn as alive', () => {
    expect(healthOfEvents([{ type: 'message.appended' }, { type: 'step.completed' }])).toBe('alive')
    expect(healthOfEvents([{ type: 'message.appended' }, { type: 'turn.completed' }, { type: 'session.waiting' }])).toBe('dead')
  })

  it('reads a running turn as alive; idle, ended or empty as dead', () => {
    expect(healthOfEvents([{ type: 'turn.started' }])).toBe('alive')
    expect(healthOfEvents([{ type: 'turn.started' }, { type: 'turn.cancelled' }])).toBe('dead')
    expect(healthOfEvents([{ type: 'turn.started' }, { type: 'session.completed' }])).toBe('dead')
    expect(healthOfEvents([])).toBe('dead')
  })

  it('reads an unclosed compact-only pass (no turn.started) as compacting; a closed one as idle', () => {
    const done = [{ type: 'turn.started' }, { type: 'turn.completed' }, { type: 'session.waiting' }]
    expect(healthOfEvents([...done, { type: 'compaction.requested' }])).toBe('compacting')
    expect(healthOfEvents([...done, { type: 'compaction.requested' }, { type: 'compaction.completed' }])).toBe('dead')
    // A failed pass parks with no compaction.completed.
    expect(healthOfEvents([...done, { type: 'compaction.requested' }, { type: 'session.waiting' }])).toBe('dead')
    // Ended wins; a compaction inside a running turn is just the turn.
    expect(healthOfEvents([...done, { type: 'compaction.requested' }, { type: 'session.failed' }])).toBe('dead')
    expect(healthOfEvents([{ type: 'turn.started' }, { type: 'compaction.requested' }])).toBe('alive')
    // The queued message's turn starting after the compaction.
    expect(healthOfEvents([...done, { type: 'compaction.requested' }, { type: 'compaction.completed' }, { type: 'session.waiting' }, { type: 'turn.started' }])).toBe('alive')
  })
})

describe('a send that arrives while an idle compaction runs (always-on reliability)', () => {
  const settled = [{ type: 'turn.started' }, { type: 'turn.completed' }, { type: 'session.waiting' }]
  const compacting = { events: [...settled, { type: 'compaction.requested' }] }
  const compacted = { events: [...settled, { type: 'compaction.requested' }, { type: 'compaction.completed' }, { type: 'session.waiting' }] }

  it('stays alive behind the compaction: no stall, no Retry, the panel hears “compacting” then null, and the reply streams on the same session', async () => {
    const s = setup({
      rowSession: 'wrun_HOME',
      // The queued message's turn starts once the compaction ends (well past the 30 ms stall window).
      scripts: { wrun_HOME: { events: [{ at: 140, event: ev('turn.started') }, { at: 140, event: evText('after the tidy') }, { at: 140, event: evDone() }] } },
      snapshot: async () => compacting,
      compaction: { waitMs: 5_000, pollMs: 40 },
    })
    const chunks = await drain(await s.transport.sendMessages(sendOpts()))
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
    expect(s.busy).toEqual(['compacting', null])
    expect(s.snapshots.length).toBeGreaterThanOrEqual(2)
    expect(s.transport.eveSessionIdOf('chat-1')).toBe('wrun_HOME')
    expect(s.created).toHaveLength(0)
    expect(s.registered).toEqual([])
  })

  it('a read between the compaction’s park and the queued turn’s start (idle for a moment) is given one more window', async () => {
    let reads = 0
    const s = setup({
      rowSession: 'wrun_HOME',
      scripts: { wrun_HOME: { events: [{ at: 100, event: evText('here') }, { at: 100, event: evDone() }] } },
      snapshot: async () => (++reads === 1 ? compacting : compacted),
      compaction: { waitMs: 5_000, pollMs: 40 },
    })
    const chunks = await drain(await s.transport.sendMessages(sendOpts()))
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
    expect(s.transport.eveSessionIdOf('chat-1')).toBe('wrun_HOME')
  })

  it('a compaction that never closes is waited for only so long, then reads as dead', async () => {
    const s = setup({
      rowSession: 'wrun_STUCK',
      scripts: { wrun_STUCK: 'silent' },
      snapshot: async () => compacting,
      compaction: { waitMs: 120, pollMs: 30 },
    })
    const err = await drain(await s.transport.sendMessages(sendOpts())).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(EveSessionStalledError)
    expect((err as EveSessionStalledError).reason).toBe('wait_timed_out')
    expect(s.busy).toEqual(['compacting', null])
    expect(s.transport.eveSessionIdOf('chat-1')).toBeNull()
  })

  it('the wait timed out, then Retry: a compaction a retired run left open never refuses the Retry (a fresh session goes ahead)', async () => {
    const s = setup({
      rowSession: 'wrun_STUCK',
      scripts: { wrun_STUCK: 'silent' },
      snapshot: async () => compacting,
      compaction: { waitMs: 120, pollMs: 30 },
    })
    const err = await drain(await s.transport.sendMessages(sendOpts())).then(
      () => null,
      (e: unknown) => e,
    )
    expect((err as EveSessionStalledError).reason).toBe('wait_timed_out')
    const reads = s.snapshots.length
    const chunks = await drain(await s.transport.sendMessages(sendOpts()))
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
    // Not even read again: the stall was the wait running out.
    expect(s.snapshots.length).toBe(reads)
    expect(s.created).toHaveLength(1)
    expect(s.registered).toEqual([{ sessionId: 'wrun_NEW1', previousSessionId: 'wrun_STUCK' }])
  })

  it('a Retry is refused at most once per session: the second goes ahead', async () => {
    let phase: 'idle' | 'compacting' = 'idle'
    const s = setup({
      rowSession: 'wrun_HOME',
      scripts: { wrun_HOME: 'silent' },
      snapshot: async () => (phase === 'idle' ? { events: settled } : compacting),
      compaction: { waitMs: 5_000, pollMs: 40 },
    })
    const settle = async () =>
      drain(await s.transport.sendMessages(sendOpts())).then(
        () => null,
        (e: unknown) => e,
      )
    expect(await settle()).toBeInstanceOf(EveSessionStalledError)
    phase = 'compacting'
    expect(await settle()).toBeInstanceOf(EveSessionBusyError)
    // The re-attached session stalls again (idle) …
    phase = 'idle'
    expect(await settle()).toBeInstanceOf(EveSessionStalledError)
    // … and reads compacting at the next Retry: already refused once, so a fresh session goes ahead.
    phase = 'compacting'
    expect(await settle()).toBeNull()
    expect(s.created).toHaveLength(1)
    expect(s.registered).toEqual([{ sessionId: 'wrun_NEW1', previousSessionId: 'wrun_HOME' }])
  })

  it('a Retry over a session that reads as running a turn is not refused (a dead run’s leftover turn.started reads alive for good)', async () => {
    let phase: 'idle' | 'alive' = 'idle'
    const s = setup({
      rowSession: 'wrun_HOME',
      scripts: { wrun_HOME: 'silent' },
      snapshot: async () => (phase === 'idle' ? { events: settled } : { events: [...settled, { type: 'turn.started' }] }),
    })
    const first = await drain(await s.transport.sendMessages(sendOpts())).then(
      () => null,
      (e: unknown) => e,
    )
    expect(first).toBeInstanceOf(EveSessionStalledError)
    phase = 'alive'
    const chunks = await drain(await s.transport.sendMessages(sendOpts()))
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
    expect(s.created).toHaveLength(1)
  })

  it('a Retry never registers a new session over one that is compacting again: nothing sent, it is re-attached, and the next send goes to it', async () => {
    let phase: 'idle' | 'compacting' = 'idle'
    const scripts: Record<string, Script> = { wrun_HOME: 'silent' }
    const s = setup({
      rowSession: 'wrun_HOME',
      scripts,
      snapshot: async () => (phase === 'idle' ? { events: settled } : compacting),
      compaction: { waitMs: 5_000, pollMs: 40 },
    })
    // The first send reads the session idle (dead): stalled, dropped.
    const first = await drain(await s.transport.sendMessages(sendOpts())).then(
      () => null,
      (e: unknown) => e,
    )
    expect(first).toBeInstanceOf(EveSessionStalledError)

    // By the Retry it shows a compaction running: the Retry is refused.
    phase = 'compacting'
    const retry = await drain(await s.transport.sendMessages(sendOpts())).then(
      () => null,
      (e: unknown) => e,
    )
    expect(retry).toBeInstanceOf(EveSessionBusyError)
    expect((retry as { code: string }).code).toBe('EVE_SESSION_BUSY')
    expect((first as EveSessionStalledError).reason).toBe('idle')
    expect(s.created).toHaveLength(0)
    expect(s.registered).toEqual([])
    expect(s.transport.eveSessionIdOf('chat-1')).toBe('wrun_HOME')

    // The person's next send goes to that same session (queued behind its work).
    scripts.wrun_HOME = { events: [{ at: 0, event: evText('back') }, { at: 0, event: evDone() }] }
    const chunks = await drain(await s.transport.sendMessages(sendOpts()))
    expect(chunks.some((c) => c.type === 'text-delta')).toBe(true)
    expect(s.created).toHaveLength(0)
    expect(s.registered).toEqual([])
  })
})
