/**
 * Compaction on command (src/lib/chat/manual-compaction.ts): the side panel's
 * Compact now and the composer's `/compact`. Pinned:
 *   - the conversation must be the caller's in this workspace (not_found),
 *     not a capture's, and have an eve session, before anything is billed or
 *     eve is touched; a failed read is lookup_failed, a throw is error;
 *   - the usage limits are checked (a compaction is billed): a 429 is
 *     usage_limited, anything else usage_check_failed, and eve is not touched;
 *   - then compactChatSession in manual mode, as the server principal with
 *     the conversation's own claims (a bot's thread names its bot, a focused
 *     conversation its area): a small context that just went quiet compacts;
 *     a running turn still stops it;
 *   - the route's time budget covers every wait.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { MessageStreamEvent } from 'eve/client'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

const checkUsageLimits = vi.fn(async (_userId: string): Promise<unknown> => undefined)
vi.mock('@/lib/ai/auth', () => ({ checkUsageLimits: (u: string) => checkUsageLimits(u) }))

import {
  MANUAL_COMPACTION_MAX_DURATION_S,
  MANUAL_COMPACTION_WATCH_MS,
  compactConversationNow,
  manualCompactionLogLine,
} from '../manual-compaction'
import {
  IDLE_COMPACTION_FIRST_EVENT_MS,
  IDLE_COMPACTION_RECHECK_MS,
  IDLE_COMPACTION_TAIL_IDLE_MS,
  IDLE_COMPACTION_TAIL_MAX_MS,
} from '../idle-compaction'
import { verifyChatRunToken } from '../chat-run-token'

const SECRET = 'test-chat-internal-secret-abcdefghij'
const NOW = Date.parse('2026-10-22T12:00:00.000Z')
const USER = 'user-1'
const WS = 'ws-1'
const ARGS = { conversationId: 'conv-main', userId: USER, workspaceId: WS }

let db: FakeSupabase

beforeEach(() => {
  process.env.CHAT_INTERNAL_SECRET = SECRET
  checkUsageLimits.mockReset()
  checkUsageLimits.mockResolvedValue(undefined)
  db = makeFakeSupabase()
  const conv = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    user_id: USER,
    workspace_id: WS,
    eve_session_id: 'sess-1',
    capture_id: null,
    ai_team_member_id: null,
    focus_area: null,
    ...over,
  })
  db.seed('chat_conversations', [
    conv('conv-main'),
    conv('conv-bot', { ai_team_member_id: 'tm-1' }),
    conv('conv-focus', { focus_area: 'calendar' }),
    conv('conv-capture', { capture_id: 'cap-1' }),
    conv('conv-new', { eve_session_id: null }),
    conv('conv-theirs', { user_id: 'user-2' }),
    conv('conv-elsewhere', { workspace_id: 'ws-2' }),
  ])
})
afterEach(() => {
  delete process.env.CHAT_INTERNAL_SECRET
})

// ── A fake eve session: the tail, then the compaction's events once compact() is called ──

function ev(type: string, msAgo: number, data: Record<string, unknown> = {}): MessageStreamEvent {
  return { type, data, meta: { at: new Date(NOW - msAgo).toISOString(), id: `evt_${type}_${msAgo}` } } as unknown as MessageStreamEvent
}
const step = (input: number, msAgo: number) => ev('step.completed', msAgo, { usage: { inputTokens: input } })
/** A small turn that settled seconds ago: the idle timer would wait, and skip it as small. */
const JUST_NOW = [ev('turn.started', 9000), step(39_000, 8000), step(40_000, 6000), ev('turn.completed', 5000), ev('session.waiting', 4000)]
const COMPACTION = [ev('compaction.requested', 0), ev('compaction.completed', 0), ev('session.waiting', 0)]

function fakeEve(tail: MessageStreamEvent[], after: MessageStreamEvent[] = COMPACTION) {
  const made: Array<{ secret: string; token: string }> = []
  let release: () => void = () => {}
  const released = new Promise<void>((r) => {
    release = r
  })
  const aborted = (signal?: AbortSignal) =>
    new Promise<never>((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted'))))
  const compact = vi.fn(async () => {
    release()
    return { status: 'accepted', sessionId: 'sess-1' }
  })
  const session = {
    compact,
    stream(o: { signal?: AbortSignal }) {
      return (async function* () {
        for (const e of tail) yield e
        await Promise.race([released, aborted(o.signal)])
        for (const e of after) yield e
        await aborted(o.signal)
      })()
    },
  }
  const attach = vi.fn((_id: string) => session)
  const makeClient = vi.fn((args: { secret: string; token: string }) => {
    made.push(args)
    return { sessions: { attach } } as never
  })
  return { makeClient, compact, attach, made }
}

/** Short waits for the tail read; the watch is the module's own (MANUAL_COMPACTION_WATCH_MS). */
const TIMING = { firstEventMs: 150, tailIdleMs: 20, tailMaxMs: 200, recheckMs: 20 }
const now = () => NOW

describe('compactConversationNow: the conversation and the limits', () => {
  it.each([
    ['someone else’s', 'conv-theirs'],
    ['in another workspace', 'conv-elsewhere'],
    ['gone', 'conv-missing'],
  ])('a conversation %s is not_found: nothing checked, eve untouched', async (_label, conversationId) => {
    const eve = fakeEve(JUST_NOW)
    expect(await compactConversationNow(db as never, { ...ARGS, conversationId }, { makeClient: eve.makeClient, now, timing: TIMING })).toEqual({
      outcome: 'not_found',
    })
    expect(checkUsageLimits).not.toHaveBeenCalled()
    expect(eve.makeClient).not.toHaveBeenCalled()
  })

  it('a capture’s conversation is never compacted; one with no eve session has nothing to compact', async () => {
    const eve = fakeEve(JUST_NOW)
    const deps = { makeClient: eve.makeClient, now, timing: TIMING }
    expect(await compactConversationNow(db as never, { ...ARGS, conversationId: 'conv-capture' }, deps)).toEqual({ outcome: 'capture_conversation' })
    expect(await compactConversationNow(db as never, { ...ARGS, conversationId: 'conv-new' }, deps)).toEqual({ outcome: 'no_session' })
    expect(checkUsageLimits).not.toHaveBeenCalled()
    expect(eve.makeClient).not.toHaveBeenCalled()
  })

  it('a failed read is lookup_failed; a throw is error (never thrown on)', async () => {
    const chain: Record<string, unknown> = {}
    for (const k of ['select', 'eq']) chain[k] = () => chain
    chain.maybeSingle = async () => ({ data: null, error: { message: 'db down' } })
    expect(await compactConversationNow({ from: () => chain } as never, ARGS)).toEqual({ outcome: 'lookup_failed' })
    const broken = {
      from: () => {
        throw new Error('db down')
      },
    }
    expect(await compactConversationNow(broken as never, ARGS)).toEqual({ outcome: 'error' })
  })

  it('past the usage limits (429) is usage_limited; a failed check is usage_check_failed; eve untouched either way', async () => {
    const eve = fakeEve(JUST_NOW)
    const limited = vi.fn(async () => {
      throw new Response(null, { status: 429 })
    })
    expect(await compactConversationNow(db as never, ARGS, { makeClient: eve.makeClient, checkLimits: limited })).toEqual({ outcome: 'usage_limited' })
    expect(limited).toHaveBeenCalledWith(USER)
    for (const err of [new Error('billing down'), new Response(null, { status: 500 })]) {
      const failing = async () => {
        throw err
      }
      expect(await compactConversationNow(db as never, ARGS, { makeClient: eve.makeClient, checkLimits: failing })).toEqual({
        outcome: 'usage_check_failed',
      })
    }
    expect(eve.makeClient).not.toHaveBeenCalled()
  })

  it('checks the person’s own usage limits by default', async () => {
    checkUsageLimits.mockRejectedValue(new Response(null, { status: 429 }))
    expect(await compactConversationNow(db as never, ARGS)).toEqual({ outcome: 'usage_limited' })
    expect(checkUsageLimits).toHaveBeenCalledWith(USER)
  })
})

describe('compactConversationNow: compacting', () => {
  it('compacts a small context that just went quiet (manual mode), as the server principal for the conversation', async () => {
    const eve = fakeEve(JUST_NOW)
    expect(await compactConversationNow(db as never, ARGS, { makeClient: eve.makeClient, now, timing: TIMING })).toEqual({
      outcome: 'compacted',
      inputTokens: 40_000,
    })
    expect(checkUsageLimits).toHaveBeenCalledWith(USER)
    expect(eve.attach).toHaveBeenCalledWith('sess-1')
    expect(eve.compact).toHaveBeenCalledTimes(1)
    expect(eve.made[0].secret).toBe(SECRET)
    const claims = verifyChatRunToken(eve.made[0].token)
    expect(claims).toMatchObject({ conversationId: 'conv-main', workspaceId: WS, userId: USER, server: 'idle_compaction' })
    expect(claims?.teammateId).toBeUndefined()
    expect(claims?.focusArea).toBeUndefined()
    expect(claims?.cred).toBeUndefined()
  })

  it.each([
    ['a bot’s thread names its bot', 'conv-bot', { teammateId: 'tm-1' }],
    ['a focused conversation names its area', 'conv-focus', { focusArea: 'calendar' }],
  ])('%s', async (_label, conversationId, extra) => {
    const eve = fakeEve(JUST_NOW)
    expect(await compactConversationNow(db as never, { ...ARGS, conversationId }, { makeClient: eve.makeClient, now, timing: TIMING })).toMatchObject({
      outcome: 'compacted',
    })
    expect(verifyChatRunToken(eve.made[0].token)).toMatchObject({ conversationId, ...extra })
  })

  it('a turn running still stops it', async () => {
    const eve = fakeEve([...JUST_NOW, ev('turn.started', 1000)])
    expect(await compactConversationNow(db as never, ARGS, { makeClient: eve.makeClient, now, timing: TIMING })).toEqual({
      outcome: 'turn_running',
      inputTokens: 40_000,
    })
    expect(eve.compact).not.toHaveBeenCalled()
  })
})

describe('the time budget', () => {
  it('waits up to 75 s for the outcome, and the route’s budget covers every wait with room to answer', () => {
    expect(MANUAL_COMPACTION_WATCH_MS).toBe(75_000)
    const waits = IDLE_COMPACTION_FIRST_EVENT_MS + IDLE_COMPACTION_TAIL_MAX_MS + IDLE_COMPACTION_TAIL_IDLE_MS + IDLE_COMPACTION_RECHECK_MS + MANUAL_COMPACTION_WATCH_MS
    expect(MANUAL_COMPACTION_MAX_DURATION_S * 1000).toBeGreaterThan(waits + 10_000)
  })
})

describe('manualCompactionLogLine', () => {
  it('is one line of counts and ids', () => {
    expect(manualCompactionLogLine({ conversationId: 'conv-main', inputTokens: 40_000, outcome: 'compacted' })).toBe(
      '[manual-compaction] conversation=conv-main input=40000 outcome=compacted',
    )
    expect(manualCompactionLogLine({ conversationId: 'conv-main', outcome: 'not_found' })).toBe(
      '[manual-compaction] conversation=conv-main input=- outcome=not_found',
    )
  })
})
