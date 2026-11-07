/**
 * chat/session.activity → (debounced) → idle compaction, via the
 * createFunction-capture pattern. Pinned: the config (one function, debounced
 * 10 minutes per conversation on its own event, never retried); a skip from
 * the database step returns without touching eve; the compact step gets the
 * checked claims and session only (the event is ids only: nothing to carry);
 * every outcome is one `[idle-compaction]` line and a return, never a throw;
 * a running turn, recent activity or no events sleeps 5 minutes and looks
 * once more (both steps), then stops; the compact step re-checks presence
 * against the billed row step 1 saw.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'
import { createStepMock } from '@/test/inngest-step-mock'

type Handler = (ctx: { event: { data: Record<string, unknown>; ts?: number }; step: ReturnType<typeof createStepMock> }) => Promise<unknown>

const hoisted = vi.hoisted(() => ({
  handler: null as unknown as Handler,
  config: null as unknown as Record<string, unknown>,
}))

vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    createFunction: (config: Record<string, unknown>, fn: Handler) => {
      hoisted.handler = fn
      hoisted.config = config
      return { id: config.id }
    },
    send: vi.fn(),
  },
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ db: true }) }))

const idleCompactionStillQuiet = vi.fn(async (..._a: unknown[]) => true)

const checkIdleCompaction = vi.fn()
const compactIdleSession = vi.fn()
vi.mock('@/lib/chat/idle-compaction', async () => {
  const actual = await vi.importActual<typeof import('@/lib/chat/idle-compaction')>('@/lib/chat/idle-compaction')
  return {
    ...actual,
    checkIdleCompaction: (...a: unknown[]) => checkIdleCompaction(...a),
    compactIdleSession: (...a: unknown[]) => compactIdleSession(...a),
    idleCompactionStillQuiet: (...a: unknown[]) => idleCompactionStillQuiet(...a),
  }
})

import '../chat-idle-compaction'

const DATA = { conversationId: 'conv-1', workspaceId: 'ws-1', userId: 'user-1', source: 'turn' }
const CLAIMS = { conversationId: 'conv-1', workspaceId: 'ws-1', userId: 'user-1' }
const PASS = { ok: true, sessionId: 'sess-1', claims: CLAIMS, billedInputTokens: 900_000, latestUsageAt: '2026-10-14T11:49:00Z' }

describe('chatIdleCompaction', () => {
  let info: MockInstance<typeof console.info>
  const lines = () => info.mock.calls.map(([l]) => l)

  beforeEach(() => {
    checkIdleCompaction.mockReset()
    compactIdleSession.mockReset()
    idleCompactionStillQuiet.mockClear()
    info = vi.spyOn(console, 'info').mockImplementation(() => {})
  })
  afterEach(() => info.mockRestore())

  it('debounces 3 minutes per conversation on its own event, and never retries a billed request', () => {
    expect(hoisted.config).toMatchObject({
      id: 'chat-idle-compaction',
      retries: 0,
      debounce: { key: 'event.data.conversationId', period: '3m' },
      triggers: [{ event: 'chat/session.activity' }],
    })
  })

  it('a database skip returns without asking eve, with one log line', async () => {
    checkIdleCompaction.mockResolvedValue({ ok: false, reason: 'small_context', sessionId: 'sess-1', billedInputTokens: 40_000 })
    const step = createStepMock()
    expect(await hoisted.handler({ event: { data: DATA }, step })).toEqual({ status: 'skipped', reason: 'small_context' })
    expect(checkIdleCompaction).toHaveBeenCalledWith({ db: true }, { ...DATA })
    expect(compactIdleSession).not.toHaveBeenCalled()
    expect(lines()).toEqual(['[idle-compaction] conversation=conv-1 session=sess-1 input=40000 outcome=small_context'])
  })

  it('background work about to wake the agent: no compaction, and the quiet timer is re-armed through the same debounce', async () => {
    checkIdleCompaction.mockResolvedValue({ ok: false, reason: 'background_waking', sessionId: 'sess-1', billedInputTokens: 420_000 })
    const step = createStepMock()
    expect(await hoisted.handler({ event: { data: DATA }, step })).toEqual({ status: 'skipped', reason: 'background_waking' })
    expect(compactIdleSession).not.toHaveBeenCalled()
    expect(step.sendEvent).toHaveBeenCalledTimes(1)
    expect(step.sendEvent).toHaveBeenCalledWith('rearm', { name: 'chat/session.activity', data: { ...DATA, source: 'turn' } })
  })

  it('any other database skip re-arms nothing', async () => {
    checkIdleCompaction.mockResolvedValue({ ok: false, reason: 'capture_conversation' })
    const step = createStepMock()
    expect(await hoisted.handler({ event: { data: DATA }, step })).toEqual({ status: 'skipped', reason: 'capture_conversation' })
    expect(step.sendEvent).not.toHaveBeenCalled()
  })

  it('compacts with the checked claims (no credential anywhere) and logs the outcome', async () => {
    checkIdleCompaction.mockResolvedValue(PASS)
    compactIdleSession.mockResolvedValue({ outcome: 'compacted', inputTokens: 310_000 })
    const step = createStepMock()
    expect(await hoisted.handler({ event: { data: DATA }, step })).toEqual({ status: 'compacted', conversationId: 'conv-1' })
    expect(compactIdleSession).toHaveBeenCalledWith({ claims: CLAIMS, sessionId: 'sess-1' }, { stillQuiet: expect.any(Function) })
    expect(step.run.mock.calls.map(([id]) => id)).toEqual(['check', 'compact'])
    expect(step.sleep).not.toHaveBeenCalled()
    expect(lines()).toEqual(['[idle-compaction] conversation=conv-1 session=sess-1 input=310000 outcome=compacted'])
  })

  it('the presence re-check compares against the billed row step 1 saw', async () => {
    checkIdleCompaction.mockResolvedValue(PASS)
    compactIdleSession.mockImplementation(async (_input: unknown, deps: { stillQuiet: () => Promise<boolean> }) => {
      expect(await deps.stillQuiet()).toBe(true)
      return { outcome: 'compacted' }
    })
    await hoisted.handler({ event: { data: DATA }, step: createStepMock() })
    expect(idleCompactionStillQuiet).toHaveBeenCalledWith({ db: true }, { userId: 'user-1', sessionId: 'sess-1', latestUsageAt: '2026-10-14T11:49:00Z' })
  })

  it.each(['turn_running', 'recent_activity', 'no_events'] as const)(
    '%s sleeps 5 minutes and looks once more (both steps), then stops',
    async (outcome) => {
      checkIdleCompaction.mockResolvedValue(PASS)
      compactIdleSession.mockResolvedValueOnce({ outcome }).mockResolvedValueOnce({ outcome: 'compacted', inputTokens: 300_000 })
      const step = createStepMock()
      expect(await hoisted.handler({ event: { data: DATA }, step })).toEqual({ status: 'compacted', conversationId: 'conv-1', rechecked: true })
      expect(step.sleep).toHaveBeenCalledTimes(1)
      expect(step.sleep).toHaveBeenCalledWith('recheck-wait', '5m')
      expect(step.run.mock.calls.map(([id]) => id)).toEqual(['check', 'compact', 'check-again', 'compact-again'])
      expect(checkIdleCompaction).toHaveBeenCalledTimes(2)
      expect(lines()).toEqual([
        `[idle-compaction] conversation=conv-1 session=sess-1 input=900000 outcome=${outcome}`,
        '[idle-compaction] conversation=conv-1 session=sess-1 input=300000 outcome=compacted recheck=1',
      ])
    },
  )

  it('the re-check is bounded: the same outcome again stops (one sleep, never a loop)', async () => {
    checkIdleCompaction.mockResolvedValue(PASS)
    compactIdleSession.mockResolvedValue({ outcome: 'turn_running' })
    const step = createStepMock()
    expect(await hoisted.handler({ event: { data: DATA }, step })).toEqual({ status: 'turn_running', conversationId: 'conv-1', rechecked: true })
    expect(step.sleep).toHaveBeenCalledTimes(1)
    expect(compactIdleSession).toHaveBeenCalledTimes(2)
  })

  it('the re-check runs step 1 again: a skip there (compacted meanwhile, or removed) stops it', async () => {
    checkIdleCompaction.mockResolvedValueOnce(PASS).mockResolvedValueOnce({ ok: false, reason: 'already_compacted', sessionId: 'sess-1' })
    compactIdleSession.mockResolvedValue({ outcome: 'no_events' })
    const step = createStepMock()
    expect(await hoisted.handler({ event: { data: DATA }, step })).toEqual({
      status: 'skipped',
      reason: 'already_compacted',
      conversationId: 'conv-1',
      rechecked: true,
    })
    expect(compactIdleSession).toHaveBeenCalledTimes(1)
    expect(lines()[1]).toBe('[idle-compaction] conversation=conv-1 session=sess-1 input=- outcome=already_compacted recheck=1')
  })

  it('an event that still carries a credential field never passes it on', async () => {
    checkIdleCompaction.mockResolvedValue(PASS)
    compactIdleSession.mockResolvedValue({ outcome: 'compacted' })
    await hoisted.handler({ event: { data: { ...DATA, cred: 'legacy-sealed', jwt: 'eyJ.x.y' } }, step: createStepMock() })
    expect(checkIdleCompaction).toHaveBeenCalledWith({ db: true }, DATA)
    expect(JSON.stringify(compactIdleSession.mock.calls)).not.toMatch(/legacy-sealed|eyJ/)
  })

  it.each(['kept_history', 'queued_behind_turn', 'requested', 'forbidden', 'server_auth_failed', 'error', 'small_context', 'session_inactive'] as const)(
    'outcome %s is logged and returned, never thrown (and never re-checked)',
    async (outcome) => {
      checkIdleCompaction.mockResolvedValue(PASS)
      compactIdleSession.mockResolvedValue({ outcome })
      const step = createStepMock()
      await expect(hoisted.handler({ event: { data: DATA }, step })).resolves.toEqual({ status: outcome, conversationId: 'conv-1' })
      expect(step.sleep).not.toHaveBeenCalled()
      expect(lines()).toEqual([`[idle-compaction] conversation=conv-1 session=sess-1 input=900000 outcome=${outcome}`])
    },
  )

  it('a malformed event is a skip', async () => {
    const step = createStepMock()
    expect(await hoisted.handler({ event: { data: { conversationId: 'conv-1' } }, step })).toEqual({ status: 'skipped', reason: 'bad_event' })
    expect(checkIdleCompaction).not.toHaveBeenCalled()
  })
})
