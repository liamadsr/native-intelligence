/**
 * Idle-time compaction (src/lib/chat/idle-compaction.ts). Pinned:
 *   - checkIdleCompaction: each database skip (no row, no session, a removed
 *     member, no billed turn, a small turn, a manual compaction since, usage
 *     limits, a failed read) and the pass, with the token claims each
 *     conversation kind gets;
 *   - idleCompactionStillQuiet: a newer billed row (or a failed read) is not quiet;
 *   - inspectSessionTail: open turns, the last step's input, a compaction
 *     since, the newest event's time;
 *   - compactIdleSession: each eve-side skip (no chat secret, a running turn,
 *     recent activity, no events, a small context, a compaction since,
 *     someone back right before `compact()`), a slow stream open, the happy path
 *     (compact() called once, as the server principal: the chat secret plus a
 *     valid run token for the conversation, no user credential), and every
 *     failure ending as an outcome, never a throw;
 *   - compactChatSession on command (mode 'manual'): the quiet time and the
 *     minimum size are not checked, a running turn, nothing new since the last
 *     compaction or no step still stop it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeFakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import type { MessageStreamEvent } from 'eve/client'

const checkUsageLimits = vi.fn(async (_userId: string): Promise<unknown> => undefined)
vi.mock('@/lib/ai/auth', () => ({ checkUsageLimits: (u: string) => checkUsageLimits(u) }))

import {
  IDLE_COMPACTION_DEBOUNCE_PERIOD,
  IDLE_COMPACTION_MIN_INPUT_TOKENS,
  IDLE_COMPACTION_QUIET_MS,
  IDLE_COMPACTION_RECHECK_OUTCOMES,
  WAKING_HELPER_MAX_AGE_MS,
  WAKING_HOME_TURN_FRESH_MS,
  WAKING_REPORT_WINDOW_MS,
  backgroundWorkWaking,
  checkIdleCompaction,
  contextSizeOf,
  compactChatSession,
  compactIdleSession,
  idleCompactionLogLine,
  idleCompactionStillQuiet,
  inspectSessionTail,
  IDLE_COMPACTION_PENDING_MAX_MS,
  parseActivityData,
} from '../idle-compaction'
import { CHAT_RUN_SECRET_HEADER, CHAT_RUN_TOKEN_HEADER, verifyChatRunToken } from '../chat-run-token'
import { CHAT_IDLE_COMPACT_TOKENS } from '../context-usage'
import { ClientError } from 'eve/client'

const SECRET = 'test-chat-internal-secret-abcdefghij'
const NOW = Date.parse('2026-10-14T12:00:00.000Z')
const BIND = { conversationId: 'conv-1', userId: 'user-1', workspaceId: 'ws-1' }
const DATA = { ...BIND, source: 'turn' as const }

beforeEach(() => {
  process.env.CHAT_INTERNAL_SECRET = SECRET
  checkUsageLimits.mockReset()
  checkUsageLimits.mockResolvedValue(undefined)
})
afterEach(() => {
  delete process.env.CHAT_INTERNAL_SECRET
  delete process.env.RUN_SKILL_INTERNAL_SECRET
})

describe('constants', () => {
  it('debounces on the same 3-minute quiet time', () => {
    expect(IDLE_COMPACTION_QUIET_MS).toBe(180_000)
    expect(IDLE_COMPACTION_DEBOUNCE_PERIOD).toBe('3m')
    expect(IDLE_COMPACTION_MIN_INPUT_TOKENS).toBe(150_000)
  })

  it("the side panel's Context card draws its idle line at the same size (context-usage.ts, a client-safe twin)", () => {
    expect(CHAT_IDLE_COMPACT_TOKENS).toBe(IDLE_COMPACTION_MIN_INPUT_TOKENS)
  })
})

describe('parseActivityData', () => {
  it('keeps the ids and the source, drops anything else; refuses a malformed event', () => {
    expect(parseActivityData({ ...BIND, source: 'mint', cred: 'x', jwt: 'y' })).toEqual({ ...BIND, source: 'mint' })
    expect(parseActivityData({ ...BIND, source: 'typing' })).toEqual({ ...BIND, source: 'typing' })
    expect(parseActivityData({ ...BIND })).toEqual({ ...BIND, source: 'turn' })
    expect(parseActivityData({ conversationId: 'c' })).toBeNull()
    expect(parseActivityData(null)).toBeNull()
  })
})

// ── Step 1: the database checks ─────────────────────────────────────────────

function seedDb(opts: {
  conv?: Record<string, unknown> | null
  usage?: Array<Record<string, unknown>>
  /** False: the person was removed from the workspace. */
  member?: boolean
} = {}) {
  const db = makeFakeSupabase()
  if (opts.member !== false) db.seed('member', [{ id: 'm-1', user_id: 'user-1', workspace_id: 'ws-1' }])
  if (opts.conv !== null) {
    db.seed('chat_conversations', [
      {
        id: 'conv-1',
        user_id: 'user-1',
        workspace_id: 'ws-1',
        eve_session_id: 'sess-1',
        ai_team_member_id: null,
        focus_area: null,
        capture_id: null,
        ...opts.conv,
      },
    ])
  }
  db.seed(
    'ai_usage_logs',
    opts.usage ?? [
      { user_id: 'user-1', feature: 'ai_chat', input_tokens: 40_000, metadata: { eve_session_id: 'sess-1' }, created_at: '2026-10-14T11:00:00Z' },
      { user_id: 'user-1', feature: 'ai_chat', input_tokens: 420_000, metadata: { eve_session_id: 'sess-1' }, created_at: '2026-10-14T11:49:00Z' },
      // Another session's bigger turn never counts.
      { user_id: 'user-1', feature: 'ai_chat', input_tokens: 900_000, metadata: { eve_session_id: 'sess-other' }, created_at: '2026-10-14T11:55:00Z' },
    ],
  )
  return db
}

describe('checkIdleCompaction', () => {
  it('passes a big, settled main-chat conversation with plain claims', async () => {
    const check = await checkIdleCompaction(seedDb() as never, DATA)
    expect(check).toEqual({ ok: true, sessionId: 'sess-1', claims: BIND, billedInputTokens: 420_000, latestUsageAt: '2026-10-14T11:49:00Z' })
    expect(checkUsageLimits).toHaveBeenCalledWith('user-1')
  })

  it.each([
    ['a bot thread', { ai_team_member_id: 'tm-1' }, { teammateId: 'tm-1' }],
    ['a focused conversation', { focus_area: 'calendar' }, { focusArea: 'calendar' }],
    ['an unknown focus', { focus_area: 'nope' }, {}],
  ])('mints %s with its own claims', async (_label, conv, extra) => {
    const check = await checkIdleCompaction(seedDb({ conv }) as never, DATA)
    expect(check).toMatchObject({ ok: true, claims: { ...BIND, ...extra } })
    if (check.ok) expect(Object.keys(check.claims).sort()).toEqual(Object.keys({ ...BIND, ...extra }).sort())
  })

  it('skips a conversation that is gone, or someone else’s', async () => {
    expect(await checkIdleCompaction(seedDb({ conv: null }) as never, DATA)).toEqual({ ok: false, reason: 'no_conversation' })
    expect(await checkIdleCompaction(seedDb() as never, { ...DATA, userId: 'user-2' })).toEqual({ ok: false, reason: 'no_conversation' })
  })

  it('skips a conversation with no registered eve session', async () => {
    expect(await checkIdleCompaction(seedDb({ conv: { eve_session_id: null } }) as never, DATA)).toEqual({ ok: false, reason: 'no_session' })
  })

  it('skips a person removed from the workspace since (never compacted, never billed)', async () => {
    expect(await checkIdleCompaction(seedDb({ member: false }) as never, DATA)).toEqual({ ok: false, reason: 'not_member', sessionId: 'sess-1' })
    // Another workspace's membership doesn't count.
    const db = seedDb({ member: false })
    db.seed('member', [{ id: 'm-2', user_id: 'user-1', workspace_id: 'ws-2' }])
    expect(await checkIdleCompaction(db as never, DATA)).toMatchObject({ ok: false, reason: 'not_member' })
    expect(checkUsageLimits).not.toHaveBeenCalled()
  })

  it('skips a session with no billed turn yet', async () => {
    expect(await checkIdleCompaction(seedDb({ usage: [] }) as never, DATA)).toEqual({ ok: false, reason: 'no_usage', sessionId: 'sess-1' })
  })

  it('skips when the latest turn’s input is under the minimum (the sum bounds the context from above)', async () => {
    const usage = [{ user_id: 'user-1', feature: 'ai_chat', input_tokens: 149_999, metadata: { eve_session_id: 'sess-1' }, created_at: '2026-10-14T11:49:00Z' }]
    expect(await checkIdleCompaction(seedDb({ usage }) as never, DATA)).toEqual({
      ok: false,
      reason: 'small_context',
      sessionId: 'sess-1',
      billedInputTokens: 149_999,
    })
    expect(checkUsageLimits).not.toHaveBeenCalled()
  })

  it('judges by the latest turn row\'s last-step input when it carries one (the sum over steps is not a context size)', async () => {
    // The 2026-10-15 audit's shape: a 6-step turn summed to ~780K while each call read ~130K.
    const summedBig = [{ user_id: 'user-1', feature: 'ai_chat', input_tokens: 782_415, metadata: { eve_session_id: 'sess-1', context_last_step_input_tokens: 131_000 }, created_at: '2026-10-14T11:49:00Z' }]
    expect(await checkIdleCompaction(seedDb({ usage: summedBig }) as never, DATA)).toEqual({
      ok: false,
      reason: 'small_context',
      sessionId: 'sess-1',
      billedInputTokens: 131_000,
    })
    const lastBig = [{ user_id: 'user-1', feature: 'ai_chat', input_tokens: 543_239, metadata: { eve_session_id: 'sess-1', context_last_step_input_tokens: 185_000 }, created_at: '2026-10-14T11:49:00Z' }]
    expect(await checkIdleCompaction(seedDb({ usage: lastBig }) as never, DATA)).toMatchObject({ ok: true, billedInputTokens: 185_000 })
  })

  it('contextSizeOf: the last step\'s input when recorded and positive, else the summed input', () => {
    expect(contextSizeOf({ input_tokens: 500_000, metadata: { context_last_step_input_tokens: 160_000 } })).toBe(160_000)
    expect(contextSizeOf({ input_tokens: 500_000, metadata: { context_last_step_input_tokens: 0 } })).toBe(500_000)
    expect(contextSizeOf({ input_tokens: 500_000, metadata: { context_last_step_input_tokens: '9' } })).toBe(500_000)
    expect(contextSizeOf({ input_tokens: 70_000, metadata: null })).toBe(70_000)
    expect(contextSizeOf({ input_tokens: null, metadata: null })).toBe(0)
  })

  it('skips when a manual compaction was billed after the latest turn', async () => {
    const usage = [
      { user_id: 'user-1', feature: 'ai_chat', input_tokens: 420_000, metadata: { eve_session_id: 'sess-1' }, created_at: '2026-10-14T11:40:00Z' },
      { user_id: 'user-1', feature: 'ai_chat', input_tokens: 400_000, metadata: { eve_session_id: 'sess-1', compaction: true }, created_at: '2026-10-14T11:50:00Z' },
    ]
    expect(await checkIdleCompaction(seedDb({ usage }) as never, DATA)).toEqual({ ok: false, reason: 'already_compacted', sessionId: 'sess-1' })
  })

  it('skips a person over their usage limits, and fails closed when billing is down', async () => {
    checkUsageLimits.mockRejectedValueOnce(new Response('{}', { status: 429 }))
    expect(await checkIdleCompaction(seedDb() as never, DATA)).toMatchObject({ ok: false, reason: 'usage_limited' })
    checkUsageLimits.mockRejectedValueOnce(new Response('{}', { status: 503 }))
    expect(await checkIdleCompaction(seedDb() as never, DATA)).toMatchObject({ ok: false, reason: 'usage_check_failed' })
  })

  it('a failed read is a skip, never a throw', async () => {
    const broken = { from: () => { throw new Error('db down') } }
    expect(await checkIdleCompaction(broken as never, DATA)).toEqual({ ok: false, reason: 'lookup_failed' })
  })

  it('never compacts (or bills) a capture’s conversation, however big', async () => {
    expect(await checkIdleCompaction(seedDb({ conv: { capture_id: 'cap-1' } }) as never, DATA)).toEqual({ ok: false, reason: 'capture_conversation' })
    expect(checkUsageLimits).not.toHaveBeenCalled()
  })

  it('skips a big conversation that background work is about to wake (the function re-arms the timer)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    try {
      const db = seedDb()
      db.seed('home_turn', [{ conversation_id: 'conv-1', user_id: 'user-1', status: 'sent', report_message_ids: [], updated_at: iso(NOW - 60_000) }])
      expect(await checkIdleCompaction(db as never, DATA)).toEqual({ ok: false, reason: 'background_waking', sessionId: 'sess-1', billedInputTokens: 420_000 })
    } finally {
      vi.useRealTimers()
    }
  })
})

const iso = (ms: number) => new Date(ms).toISOString()

describe('backgroundWorkWaking (plan §2: skip when background work is about to wake the agent)', () => {
  const report = (id: string, at: number) => ({
    conversation_id: 'conv-1',
    user_id: 'user-1',
    workspace_id: 'ws-1',
    role: 'assistant',
    created_at: iso(at),
    ui_message: { id, metadata: { kind: 'teammate_report' } },
  })
  const helper = (status: string, at: number) => ({ id: `run-${status}`, workspace_id: 'ws-1', origin: 'chat', chat_conversation_id: 'conv-1', status, created_at: iso(at) })

  it('nothing in flight: null', async () => {
    expect(await backgroundWorkWaking(makeFakeSupabase() as never, BIND, NOW)).toBeNull()
  })

  it('a home turn claimed or sending, touched recently, is waking; a stale or settled one is not', async () => {
    for (const status of ['claimed', 'sent']) {
      const db = makeFakeSupabase()
      db.seed('home_turn', [{ conversation_id: 'conv-1', user_id: 'user-1', status, report_message_ids: [], updated_at: iso(NOW - 60_000) }])
      expect(await backgroundWorkWaking(db as never, BIND, NOW)).toBe('home_turn_running')
    }
    const db = makeFakeSupabase()
    db.seed('home_turn', [
      { conversation_id: 'conv-1', user_id: 'user-1', status: 'sent', report_message_ids: [], updated_at: iso(NOW - WAKING_HOME_TURN_FRESH_MS - 1000) },
      { conversation_id: 'conv-1', user_id: 'user-1', status: 'done', report_message_ids: [], updated_at: iso(NOW - 1000) },
    ])
    expect(await backgroundWorkWaking(db as never, BIND, NOW)).toBeNull()
  })

  it('a helper’s recent report no home turn carried yet is a pending home turn; once carried, or old, it is not', async () => {
    const pending = makeFakeSupabase()
    pending.seed('chat_messages', [report('rep-1', NOW - 30_000)])
    expect(await backgroundWorkWaking(pending as never, BIND, NOW)).toBe('home_turn_pending')

    const carried = makeFakeSupabase()
    carried.seed('chat_messages', [report('rep-1', NOW - 30_000)])
    carried.seed('home_turn', [{ conversation_id: 'conv-1', user_id: 'user-1', status: 'done', report_message_ids: ['rep-1'], updated_at: iso(NOW - 10_000) }])
    expect(await backgroundWorkWaking(carried as never, BIND, NOW)).toBeNull()

    const old = makeFakeSupabase()
    old.seed('chat_messages', [report('rep-1', NOW - WAKING_REPORT_WINDOW_MS - 1000)])
    expect(await backgroundWorkWaking(old as never, BIND, NOW)).toBeNull()
  })

  it('a background helper queued or running is waking; one waiting on the person, finished, or implausibly old is not', async () => {
    for (const status of ['queued', 'running']) {
      const db = makeFakeSupabase()
      db.seed('agent_run', [helper(status, NOW - 60_000)])
      expect(await backgroundWorkWaking(db as never, BIND, NOW)).toBe('helper_running')
    }
    const db = makeFakeSupabase()
    db.seed('agent_run', [
      helper('needs_input', NOW - 60_000),
      helper('done', NOW - 60_000),
      { ...helper('running', NOW - WAKING_HELPER_MAX_AGE_MS - 1000), id: 'run-old' },
      { ...helper('running', NOW - 60_000), id: 'run-other', chat_conversation_id: 'conv-2' },
    ])
    expect(await backgroundWorkWaking(db as never, BIND, NOW)).toBeNull()
  })

  it('a failed read is “error” (when unsure, don’t compact)', async () => {
    const broken = { from: () => { throw new Error('db down') } }
    expect(await backgroundWorkWaking(broken as never, BIND, NOW)).toBe('error')
  })
})

describe('idleCompactionStillQuiet', () => {
  const args = { userId: 'user-1', sessionId: 'sess-1', latestUsageAt: '2026-10-14T11:49:00Z' }
  it('quiet while the latest billed row is the one step 1 saw', async () => {
    expect(await idleCompactionStillQuiet(seedDb() as never, args)).toBe(true)
  })
  it('a turn billed since is someone back', async () => {
    const db = seedDb()
    db.seed('ai_usage_logs', [{ user_id: 'user-1', feature: 'ai_chat', input_tokens: 430_000, metadata: { eve_session_id: 'sess-1' }, created_at: '2026-10-14T12:01:00Z' }])
    expect(await idleCompactionStillQuiet(db as never, args)).toBe(false)
  })
  it('a failed read is not quiet (when unsure, don’t compact)', async () => {
    const broken = { from: () => { throw new Error('db down') } }
    expect(await idleCompactionStillQuiet(broken as never, args)).toBe(false)
  })
})

// ── The tail view ───────────────────────────────────────────────────────────

const at = (msAgo: number) => new Date(NOW - msAgo).toISOString()
function ev(type: string, msAgo: number, data: Record<string, unknown> = {}): MessageStreamEvent {
  return { type, data, meta: { at: at(msAgo), id: `evt_${type}_${msAgo}` } } as unknown as MessageStreamEvent
}
const step = (input: number, msAgo: number) => ev('step.completed', msAgo, { usage: { inputTokens: input } })
const QUIET = IDLE_COMPACTION_QUIET_MS + 60_000

/** A settled turn ending QUIET ago with its last step at `input`. */
const settledTurn = (input: number) => [
  ev('turn.started', QUIET + 5000),
  step(input - 20_000, QUIET + 4000),
  step(input, QUIET + 2000),
  ev('turn.completed', QUIET + 1000),
  ev('session.waiting', QUIET),
]

describe('inspectSessionTail', () => {
  it('reads a settled turn: closed, the last step’s input, the newest time', () => {
    expect(inspectSessionTail(settledTurn(300_000))).toEqual({
      openTurn: false,
      lastStepInputTokens: 300_000,
      compactedSinceLastStep: false,
      compactionPending: false,
      compactionRequestedAt: null,
      lastEventAt: NOW - QUIET,
    })
  })

  it('a compaction requested with no end after it is pending, from when it was asked; its end, the park or a turn end closes it', () => {
    const asked = [...settledTurn(300_000), ev('compaction.requested', 2000)]
    expect(inspectSessionTail(asked)).toMatchObject({ compactionPending: true, compactionRequestedAt: NOW - 2000 })
    expect(inspectSessionTail([...asked, ev('compaction.completed', 1000)])).toMatchObject({ compactionPending: false, compactionRequestedAt: null })
    // A failed compact-only pass ends at the park, with no compaction.completed.
    expect(inspectSessionTail([...asked, ev('session.waiting', 1000)]).compactionPending).toBe(false)
    expect(inspectSessionTail([...asked, ev('turn.completed', 1000)]).compactionPending).toBe(false)
  })

  it('a turn started with no boundary after it is open; so is a window with neither', () => {
    expect(inspectSessionTail([...settledTurn(300_000), ev('turn.started', 1000)]).openTurn).toBe(true)
    expect(inspectSessionTail([...settledTurn(300_000), ev('message.received', 1000)]).openTurn).toBe(true)
    expect(inspectSessionTail([step(1, 10), step(2, 5)]).openTurn).toBe(true)
  })

  it('a compaction after the last step counts; a step after it resets', () => {
    const compacted = [...settledTurn(300_000), ev('compaction.requested', QUIET - 10), ev('compaction.completed', QUIET - 20), ev('session.waiting', QUIET - 30)]
    expect(inspectSessionTail(compacted).compactedSinceLastStep).toBe(true)
    const thenTurn = [...compacted, ev('turn.started', QUIET - 40), step(60_000, QUIET - 50), ev('turn.completed', QUIET - 60)]
    expect(inspectSessionTail(thenTurn)).toMatchObject({ compactedSinceLastStep: false, lastStepInputTokens: 60_000 })
  })
})

// ── Step 2: eve ─────────────────────────────────────────────────────────────

/**
 * A fake eve session: `stream()` yields the tail, then waits; `compact()`
 * releases `after` (the compaction's events) onto the same stream.
 */
function fakeEve(opts: {
  tail: MessageStreamEvent[]
  after?: MessageStreamEvent[]
  compact?: () => Promise<unknown>
  streamError?: Error
  /** Keep streaming tail events past the read limit. */
  endless?: boolean
  /** The stream's open takes this long before the first event (a cold agent). */
  openDelayMs?: number
  /** Ends the stream right after the tail. */
  endAfterTail?: boolean
  /** An event that lands after the tail once this settles (before compact()). */
  interject?: Promise<MessageStreamEvent>
}) {
  const made: Array<{ secret: string; token: string }> = []
  const streamOpts: unknown[] = []
  let release: (() => void) | null = null
  const released = new Promise<void>((r) => {
    release = r
  })
  const compact = vi.fn(async () => {
    const res = opts.compact ? await opts.compact() : { status: 'accepted', sessionId: 'sess-1' }
    release?.()
    return res
  })
  const session = {
    compact,
    stream(o: { signal?: AbortSignal }) {
      streamOpts.push(o)
      return (async function* () {
        if (opts.streamError) throw opts.streamError
        if (opts.openDelayMs) await new Promise((r) => setTimeout(r, opts.openDelayMs))
        for (const e of opts.tail) yield e
        if (opts.endAfterTail) return
        if (opts.endless) {
          for (;;) {
            await new Promise((r) => setTimeout(r, 1))
            yield ev('message.appended', 0)
          }
        }
        const late = await Promise.race([
          released.then(() => null),
          ...(opts.interject ? [opts.interject] : []),
          new Promise<null>((_, reject) => o.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
        ])
        if (late) {
          yield late
          await released
        }
        for (const e of opts.after ?? []) yield e
        await new Promise((_, reject) => o.signal?.addEventListener('abort', () => reject(new Error('aborted'))))
      })()
    },
  }
  const makeClient = (args: { secret: string; token: string }) => {
    made.push(args)
    return { sessions: { attach: (id: string) => (id === 'sess-1' ? session : null) } } as never
  }
  return { makeClient, compact, made, streamOpts }
}

const TIMING = { firstEventMs: 150, tailIdleMs: 20, tailMaxMs: 200, recheckMs: 20, watchMs: 300 }
const run = (eve: ReturnType<typeof fakeEve>, claims: Record<string, unknown> = BIND, stillQuiet?: () => Promise<boolean>) =>
  compactIdleSession(
    { claims: claims as never, sessionId: 'sess-1' },
    { makeClient: eve.makeClient, now: () => NOW, timing: TIMING, ...(stillQuiet ? { stillQuiet } : {}) },
  )

const COMPACTION = [
  ev('compaction.requested', 0, { turnId: 'turn_9', usageInputTokens: 300_000 }),
  ev('compaction.completed', 0, { turnId: 'turn_9' }),
  ev('session.waiting', 0),
]

describe('compactIdleSession', () => {
  it('compacts a big idle session once, as the server principal, with a valid run token for the conversation', async () => {
    const eve = fakeEve({ tail: settledTurn(300_000), after: COMPACTION })
    expect(await run(eve)).toEqual({ outcome: 'compacted', inputTokens: 300_000 })
    expect(eve.compact).toHaveBeenCalledTimes(1)
    expect(eve.made).toHaveLength(1)
    const { secret, token } = eve.made[0]
    expect(secret).toBe(SECRET)
    const claims = verifyChatRunToken(token)
    expect(claims).toMatchObject(BIND)
    expect(claims?.cred).toBeUndefined()
    expect(claims?.surface).toBeUndefined()
    // The server's own token: quick helpers (helpers-gate.ts) refuse it.
    expect(claims?.server).toBe('idle_compaction')
    // The tail read starts from the end of the stream and never reconnects.
    expect(eve.streamOpts[0]).toMatchObject({ startIndex: -200, streamReconnectPolicy: { reconnect: false } })
  })

  it('a bot thread’s token names its bot', async () => {
    const eve = fakeEve({ tail: settledTurn(300_000), after: COMPACTION })
    await run(eve, { ...BIND, teammateId: 'tm-1' })
    expect(verifyChatRunToken(eve.made[0].token)).toMatchObject({ teammateId: 'tm-1' })
  })

  it('uses the RUN_SKILL fallback like every chat-family caller; with no secret at all, stops before any eve call', async () => {
    delete process.env.CHAT_INTERNAL_SECRET
    process.env.RUN_SKILL_INTERNAL_SECRET = 'root-secret-0123456789abcdef'
    const eve = fakeEve({ tail: settledTurn(300_000), after: COMPACTION })
    expect(await run(eve)).toMatchObject({ outcome: 'compacted' })
    expect(eve.made[0].secret).toBe('root-secret-0123456789abcdef')

    delete process.env.RUN_SKILL_INTERNAL_SECRET
    const none = fakeEve({ tail: settledTurn(300_000), after: COMPACTION })
    expect(await run(none)).toEqual({ outcome: 'server_auth_failed' })
    expect(none.made).toHaveLength(0)
  })

  it('a slow stream open (a cold agent) is waited out: the idle gap starts at the first event', async () => {
    // Slower than the idle gap (20 ms), inside the first event's wait (150 ms).
    const eve = fakeEve({ tail: settledTurn(300_000), after: COMPACTION, openDelayMs: 80 })
    expect(await run(eve)).toEqual({ outcome: 'compacted', inputTokens: 300_000 })
    expect(eve.compact).toHaveBeenCalledTimes(1)
  })

  it('no event at all is `no_events`, never a running turn (and never compacts)', async () => {
    // The open outlasts the first event's wait.
    const slow = fakeEve({ tail: settledTurn(300_000), openDelayMs: 400 })
    expect(await run(slow)).toEqual({ outcome: 'no_events' })
    expect(slow.compact).not.toHaveBeenCalled()
    // An empty window that just waits, and one that ends.
    const empty = fakeEve({ tail: [] })
    expect(await run(empty)).toEqual({ outcome: 'no_events' })
    const ended = fakeEve({ tail: [], endAfterTail: true })
    expect(await run(ended)).toEqual({ outcome: 'no_events' })
    expect(IDLE_COMPACTION_RECHECK_OUTCOMES.has('no_events')).toBe(true)
  })

  it('someone back right before compact() (a turn billed since): recent_activity, no compaction', async () => {
    const eve = fakeEve({ tail: settledTurn(300_000), after: COMPACTION })
    const stillQuiet = vi.fn(async () => false)
    expect(await run(eve, BIND, stillQuiet)).toEqual({ outcome: 'recent_activity', inputTokens: 300_000 })
    expect(stillQuiet).toHaveBeenCalledTimes(1)
    expect(eve.compact).not.toHaveBeenCalled()
  })

  it('a stream event landing right before compact() (a send arriving): recent_activity, no compaction', async () => {
    let land: (e: MessageStreamEvent) => void = () => {}
    const interject = new Promise<MessageStreamEvent>((r) => {
      land = r
    })
    const eve = fakeEve({ tail: settledTurn(300_000), after: COMPACTION, interject })
    const stillQuiet = async () => {
      land(ev('message.received', 0))
      return true
    }
    expect(await run(eve, BIND, stillQuiet)).toEqual({ outcome: 'recent_activity', inputTokens: 300_000 })
    expect(eve.compact).not.toHaveBeenCalled()
  })

  it('still quiet at the re-check: compacts', async () => {
    const eve = fakeEve({ tail: settledTurn(300_000), after: COMPACTION })
    expect(await run(eve, BIND, async () => true)).toEqual({ outcome: 'compacted', inputTokens: 300_000 })
  })

  it('skips a session with a turn running', async () => {
    const eve = fakeEve({ tail: [...settledTurn(300_000), ev('turn.started', 2000), step(310_000, 1000)] })
    expect(await run(eve)).toMatchObject({ outcome: 'turn_running' })
    expect(eve.compact).not.toHaveBeenCalled()
  })

  it('skips a tail still streaming after the read limit (a turn producing events)', async () => {
    const eve = fakeEve({ tail: settledTurn(300_000), endless: true })
    expect(await run(eve)).toEqual({ outcome: 'turn_running' })
    expect(eve.compact).not.toHaveBeenCalled()
  })

  it('skips when eve saw activity inside the quiet time (re-read, not the event)', async () => {
    const recent = settledTurn(300_000).map((e, i, all) => (i === all.length - 1 ? ev('session.waiting', 60_000) : e))
    const eve = fakeEve({ tail: recent })
    expect(await run(eve)).toMatchObject({ outcome: 'recent_activity' })
    expect(eve.compact).not.toHaveBeenCalled()
  })

  it('skips when the last model call’s input is under the minimum', async () => {
    const eve = fakeEve({ tail: settledTurn(IDLE_COMPACTION_MIN_INPUT_TOKENS - 1) })
    expect(await run(eve)).toEqual({ outcome: 'small_context', inputTokens: IDLE_COMPACTION_MIN_INPUT_TOKENS - 1 })
    expect(eve.compact).not.toHaveBeenCalled()
  })

  it('skips when the session already compacted since its last step', async () => {
    const tail = [...settledTurn(300_000), ev('compaction.completed', QUIET - 10), ev('session.waiting', QUIET - 20)]
    const eve = fakeEve({ tail })
    expect(await run(eve)).toMatchObject({ outcome: 'already_compacted' })
    expect(eve.compact).not.toHaveBeenCalled()
  })

  it('skips when no step is in the window', async () => {
    const eve = fakeEve({ tail: [ev('turn.completed', QUIET + 10), ev('session.waiting', QUIET)] })
    expect(await run(eve)).toEqual({ outcome: 'no_recent_step' })
  })

  it('a failed summary keeps the history: kept_history, no throw', async () => {
    const eve = fakeEve({ tail: settledTurn(300_000), after: [ev('compaction.requested', 0), ev('session.waiting', 0)] })
    expect(await run(eve)).toEqual({ outcome: 'kept_history', inputTokens: 300_000 })
  })

  it('a turn that starts first queues the compaction behind it', async () => {
    const eve = fakeEve({ tail: settledTurn(300_000), after: [ev('turn.started', 0)] })
    expect(await run(eve)).toEqual({ outcome: 'queued_behind_turn', inputTokens: 300_000 })
  })

  it('no outcome within the watch time is `requested`', async () => {
    const eve = fakeEve({ tail: settledTurn(300_000), after: [ev('compaction.requested', 0)] })
    expect(await run(eve)).toEqual({ outcome: 'requested', inputTokens: 300_000 })
  })

  it('an inactive session, a refused secret or token and an eve error are outcomes, never throws', async () => {
    expect(await run(fakeEve({ tail: settledTurn(300_000), compact: async () => ({ status: 'no_active_session' }) }))).toMatchObject({
      outcome: 'session_inactive',
    })
    expect(await run(fakeEve({ tail: [], streamError: new ClientError(401, '{"code":"server_secret_invalid"}') }))).toEqual({
      outcome: 'server_auth_failed',
    })
    expect(await run(fakeEve({ tail: [], streamError: new ClientError(403, '{"code":"session_forbidden"}') }))).toEqual({ outcome: 'forbidden' })
    expect(await run(fakeEve({ tail: settledTurn(300_000), compact: async () => { throw new ClientError(403, '{}') } }))).toMatchObject({
      outcome: 'forbidden',
    })
    expect(await run(fakeEve({ tail: settledTurn(300_000), compact: async () => { throw new Error('boom') } }))).toMatchObject({
      outcome: 'error',
    })
  })
})

describe('compactChatSession on command (mode manual: the side panel’s Compact now, manual-compaction.ts)', () => {
  const runMode = (eve: ReturnType<typeof fakeEve>, mode: 'idle' | 'manual') =>
    compactChatSession({ claims: BIND as never, sessionId: 'sess-1', mode }, { makeClient: eve.makeClient, now: () => NOW, timing: TIMING })

  /** A small turn that settled seconds ago: inside the quiet time, under the minimum. */
  const justNow = (input: number) => [
    ev('turn.started', 9000),
    step(input - 1000, 8000),
    step(input, 6000),
    ev('turn.completed', 5000),
    ev('session.waiting', 4000),
  ]

  it('compacts a small context that just went quiet: the person asked, as the same server principal', async () => {
    const eve = fakeEve({ tail: justNow(40_000), after: COMPACTION })
    expect(await runMode(eve, 'manual')).toEqual({ outcome: 'compacted', inputTokens: 40_000 })
    expect(eve.compact).toHaveBeenCalledTimes(1)
    expect(verifyChatRunToken(eve.made[0].token)).toMatchObject({ ...BIND, server: 'idle_compaction' })
  })

  it('the idle timer skips the same tails: recent activity, and a small context once quiet', async () => {
    const recent = fakeEve({ tail: justNow(40_000), after: COMPACTION })
    expect(await runMode(recent, 'idle')).toEqual({ outcome: 'recent_activity', inputTokens: 40_000 })
    const small = fakeEve({ tail: settledTurn(40_000), after: COMPACTION })
    expect(await runMode(small, 'idle')).toEqual({ outcome: 'small_context', inputTokens: 40_000 })
    // compactIdleSession is the idle mode.
    const viaIdle = fakeEve({ tail: justNow(40_000), after: COMPACTION })
    expect(await run(viaIdle)).toEqual({ outcome: 'recent_activity', inputTokens: 40_000 })
    for (const eve of [recent, small, viaIdle]) expect(eve.compact).not.toHaveBeenCalled()
    // The quiet, small one compacts on command.
    const asked = fakeEve({ tail: settledTurn(40_000), after: COMPACTION })
    expect(await runMode(asked, 'manual')).toEqual({ outcome: 'compacted', inputTokens: 40_000 })
  })

  it('still stops for a running turn, a tail still streaming, nothing new since the last compaction, or no step', async () => {
    const running = fakeEve({ tail: [...justNow(40_000), ev('turn.started', 1000)] })
    expect(await runMode(running, 'manual')).toEqual({ outcome: 'turn_running', inputTokens: 40_000 })
    const streaming = fakeEve({ tail: justNow(40_000), endless: true })
    expect(await runMode(streaming, 'manual')).toEqual({ outcome: 'turn_running' })
    const compacted = fakeEve({ tail: [...justNow(40_000), ev('compaction.completed', 3000), ev('session.waiting', 2000)] })
    expect(await runMode(compacted, 'manual')).toEqual({ outcome: 'already_compacted', inputTokens: 40_000 })
    const noStep = fakeEve({ tail: [ev('turn.completed', 2000), ev('session.waiting', 1000)] })
    expect(await runMode(noStep, 'manual')).toEqual({ outcome: 'no_recent_step' })
    for (const eve of [running, streaming, compacted, noStep]) expect(eve.compact).not.toHaveBeenCalled()
  })

  it('never a second compaction on top of one running (idle’s, another tab’s), in either mode; a leftover past IDLE_COMPACTION_PENDING_MAX_MS no longer stops one', async () => {
    const running = (msAgo: number) => [
      ev('turn.started', msAgo + 40_000),
      step(200_000, msAgo + 30_000),
      ev('turn.completed', msAgo + 20_000),
      ev('session.waiting', msAgo + 10_000),
      ev('compaction.requested', msAgo),
    ]
    const manual = fakeEve({ tail: running(20_000), after: COMPACTION })
    expect(await runMode(manual, 'manual')).toEqual({ outcome: 'compacting', inputTokens: 200_000 })
    const idle = fakeEve({ tail: running(QUIET + 20_000), after: COMPACTION })
    expect(await runMode(idle, 'idle')).toEqual({ outcome: 'compacting', inputTokens: 200_000 })
    for (const eve of [manual, idle]) expect(eve.compact).not.toHaveBeenCalled()
    const leftover = fakeEve({ tail: running(IDLE_COMPACTION_PENDING_MAX_MS + 60_000), after: COMPACTION })
    expect(await runMode(leftover, 'manual')).toEqual({ outcome: 'compacted', inputTokens: 200_000 })
    expect(leftover.compact).toHaveBeenCalledTimes(1)
  })

  it('a send landing right before compact() still stops it on command', async () => {
    let land: (e: MessageStreamEvent) => void = () => {}
    const interject = new Promise<MessageStreamEvent>((r) => {
      land = r
    })
    const eve = fakeEve({ tail: justNow(40_000), after: COMPACTION, interject })
    const result = compactChatSession(
      { claims: BIND as never, sessionId: 'sess-1', mode: 'manual' },
      {
        makeClient: eve.makeClient,
        now: () => NOW,
        timing: TIMING,
        stillQuiet: async () => {
          land(ev('message.received', 0))
          return true
        },
      },
    )
    expect(await result).toEqual({ outcome: 'recent_activity', inputTokens: 40_000 })
    expect(eve.compact).not.toHaveBeenCalled()
  })
})

describe('makeIdleCompactionClient', () => {
  it('sends the chat secret and the run token, never an Authorization header, and refuses redirects', async () => {
    const { makeIdleCompactionClient } = await import('../idle-compaction')
    const seen: Request[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Request(input, init))
      return new Response(JSON.stringify({ ok: true, status: 'accepted', sessionId: 'sess-1' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch
    try {
      await makeIdleCompactionClient({ secret: SECRET, token: 'tok' }).sessions.attach('sess-1').compact()
    } finally {
      globalThis.fetch = realFetch
    }
    expect(seen).toHaveLength(1)
    const r = seen[0]
    expect([r.method, new URL(r.url).pathname]).toEqual(['POST', '/eve/chat-agent/v1/session/sess-1/compact'])
    expect(r.headers.get(CHAT_RUN_SECRET_HEADER)).toBe(SECRET)
    expect(r.headers.get(CHAT_RUN_TOKEN_HEADER)).toBe('tok')
    expect(r.headers.get('authorization')).toBeNull()
    expect(r.redirect).toBe('error')
  })
})

describe('idleCompactionLogLine', () => {
  it('is one line of counts and ids', () => {
    expect(idleCompactionLogLine({ conversationId: 'conv-1', sessionId: 'sess-1', inputTokens: 300_000, outcome: 'compacted' })).toBe(
      '[idle-compaction] conversation=conv-1 session=sess-1 input=300000 outcome=compacted',
    )
    expect(idleCompactionLogLine({ conversationId: 'conv-1', outcome: 'no_session' })).toBe(
      '[idle-compaction] conversation=conv-1 session=- input=- outcome=no_session',
    )
    expect(idleCompactionLogLine({ conversationId: 'conv-1', outcome: 'no_events', recheck: true })).toBe(
      '[idle-compaction] conversation=conv-1 session=- input=- outcome=no_events recheck=1',
    )
  })
})
