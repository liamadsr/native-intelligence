import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { CALL_TURN_LEASE_WAITS, CALL_TURN_SPEAK_BUDGET_MS, callTurnSkipNotice, runCallTurn, type CallTurnDeps } from '../call-turn-server'
import { callMessageId, CALL_CHANNEL, CHANNEL_MESSAGE_KIND } from '@/lib/chat/channel-turn'
import type { HomeTurnPlan, HomeTurnReadResult, HomeTurnReadState, HomeTurnRow } from '@/lib/chat/home-turn-server'

const supabase = {} as SupabaseClient
const CALLER = { userId: 'u1', workspaceId: 'w1', via: 'verified_phone' as const }
const ARGS = { caller: CALLER, sessionId: 'live_1', delegationId: 'del_1', words: "What's on tomorrow?" }
const ROW: HomeTurnRow = { id: 'row1', status: 'claimed', eve_session_id: 's1', eve_turn_id: null, stream_position: 0, created_at: '2026-10-31T00:00:00Z' }
const PLAN = { ok: true, sessionId: 's1' } as unknown as HomeTurnPlan
const STATE = {} as HomeTurnReadState
const done = (end: 'completed' | 'failed' | 'cancelled' | 'session_ended' = 'completed'): HomeTurnReadResult => ({ done: true, end, state: STATE })

/** Every step succeeding by default: the reply is read back as `reply`. */
function deps(over: Partial<CallTurnDeps> & { reply?: string } = {}): CallTurnDeps & { persisted: unknown[] } {
  const persisted: unknown[] = []
  return {
    persisted,
    ensureHome: (async () => ({ id: 'home1' })) as unknown as CallTurnDeps['ensureHome'],
    persist: (async (_s: unknown, opts: unknown) => {
      persisted.push(opts)
      return { written: true }
    }) as unknown as CallTurnDeps['persist'],
    plan: (async () => PLAN) as unknown as CallTurnDeps['plan'],
    claim: (async () => ({ kind: 'claimed', row: ROW })) as unknown as CallTurnDeps['claim'],
    send: (async () => ({ kind: 'read', result: done() })) as unknown as CallTurnDeps['send'],
    finish: (async () => ({ outcome: 'written', written: true })) as unknown as CallTurnDeps['finish'],
    recordSkip: (async () => {}) as unknown as CallTurnDeps['recordSkip'],
    readReply: async () => over.reply ?? 'You have two meetings.',
    sleep: async () => {},
    ...over,
  }
}

describe('runCallTurn', () => {
  it("writes the person's words as a call message and returns the turn's reply", async () => {
    const d = deps()
    const plan = vi.fn(d.plan!)
    const result = await runCallTurn(supabase, ARGS, { ...d, plan })
    expect(result).toEqual({ kind: 'reply', text: 'You have two meetings.', outcome: 'written', rowId: 'row1' })
    expect(d.persisted).toEqual([
      expect.objectContaining({
        conversationId: 'home1',
        userId: 'u1',
        workspaceId: 'w1',
        role: 'user',
        parts: [{ type: 'text', text: "What's on tomorrow?" }],
        messageId: callMessageId('live_1', 'del_1'),
        metadata: { kind: CHANNEL_MESSAGE_KIND, channel: CALL_CHANNEL, live_session_id: 'live_1' },
      }),
    ])
    expect(plan.mock.calls[0][1]).toEqual({ conversationId: 'home1', userId: 'u1', workspaceId: 'w1', workItemIds: [], reason: 'call', callSessionId: 'live_1' })
  })

  it('reads first on a short budget; a turn still running is told to the caller and finished in the background', async () => {
    const budgets: Array<number | undefined> = []
    const send = (async (_s: unknown, _d: unknown, _p: unknown, _r: unknown, io: { budgetMs?: number }) => {
      budgets.push(io?.budgetMs)
      return { kind: 'read', result: { done: false, state: STATE } }
    }) as unknown as CallTurnDeps['send']
    const continueRead = vi.fn(async () => ({ kind: 'read' as const, result: done() }))
    const finish = vi.fn(async () => ({ outcome: 'written', written: true }))
    const background: Promise<void>[] = []
    const result = await runCallTurn(supabase, ARGS, deps({ send, continueRead: continueRead as unknown as CallTurnDeps['continueRead'], finish: finish as unknown as CallTurnDeps['finish'], background: (w) => background.push(w) }))
    expect(budgets).toEqual([CALL_TURN_SPEAK_BUDGET_MS])
    expect(result).toEqual({ kind: 'notice', text: callTurnSkipNotice('unfinished'), outcome: 'slow', rowId: 'row1' })
    expect(background).toHaveLength(1)
    await background[0]
    expect(continueRead).toHaveBeenCalledTimes(1)
    expect(finish).toHaveBeenCalledTimes(1)
  })

  it('tries a step that throws once more, then fails its row so it never holds the lease', async () => {
    let sends = 0
    const flaky = (async () => {
      if (++sends === 1) throw new Error('blip')
      return { kind: 'read', result: done() }
    }) as unknown as CallTurnDeps['send']
    expect((await runCallTurn(supabase, ARGS, deps({ send: flaky }))).kind).toBe('reply')
    expect(sends).toBe(2)

    const markFailed = vi.fn(async () => {})
    const broken = (async () => {
      throw new TypeError('down')
    }) as unknown as CallTurnDeps['send']
    expect(await runCallTurn(supabase, ARGS, deps({ send: broken, markFailed }))).toEqual({ kind: 'notice', text: callTurnSkipNotice('failed'), outcome: 'error:TypeError', rowId: 'row1' })
    expect(markFailed).toHaveBeenCalledWith(supabase, 'row1')

    const slow = (async () => ({ kind: 'read', result: { done: false, state: STATE } })) as unknown as CallTurnDeps['send']
    const brokenRead = (async () => {
      throw new Error('gone')
    }) as unknown as CallTurnDeps['continueRead']
    const later: Promise<void>[] = []
    const failedLater = vi.fn(async () => {})
    await runCallTurn(supabase, ARGS, deps({ send: slow, continueRead: brokenRead, markFailed: failedLater, background: (w) => later.push(w) }))
    await later[0]
    expect(failedLater).toHaveBeenCalledWith(supabase, 'row1')
  })

  it('waits briefly for another turn’s lease, then tells the person it is busy', async () => {
    const sleep = vi.fn(async () => {})
    let claims = 0
    const claim = (async () => (++claims <= 2 ? { kind: 'busy', holder: 'other' } : { kind: 'claimed', row: ROW })) as unknown as CallTurnDeps['claim']
    expect((await runCallTurn(supabase, ARGS, deps({ claim, sleep }))).kind).toBe('reply')
    expect(sleep).toHaveBeenCalledTimes(2)

    const always = (async () => ({ kind: 'busy', holder: 'other' })) as unknown as CallTurnDeps['claim']
    expect(await runCallTurn(supabase, ARGS, deps({ claim: always }))).toEqual({ kind: 'notice', text: callTurnSkipNotice('busy'), outcome: 'busy' })
    expect(CALL_TURN_LEASE_WAITS).toBeGreaterThan(0)
  })

  it('a skipped plan records its row and says why; nothing new is quiet', async () => {
    const recordSkip = vi.fn(async () => {})
    const pending = (async () => ({ ok: false, reason: 'question_pending', record: { dedupeKey: 'k', reports: [], workItemIds: [], sessionId: 's1', channelMessages: [] } })) as unknown as CallTurnDeps['plan']
    expect(await runCallTurn(supabase, ARGS, deps({ plan: pending, recordSkip: recordSkip as unknown as CallTurnDeps['recordSkip'] }))).toEqual({ kind: 'notice', text: callTurnSkipNotice('question_pending'), outcome: 'question_pending' })
    expect(recordSkip).toHaveBeenCalledTimes(1)
    const nothing = (async () => ({ ok: false, reason: 'nothing_new' })) as unknown as CallTurnDeps['plan']
    expect(await runCallTurn(supabase, ARGS, deps({ plan: nothing }))).toEqual({ kind: 'quiet', outcome: 'nothing_new' })
  })

  it('a held call with no words says it waits for their OK; a failed turn apologises; [quiet] is quiet', async () => {
    const held = (async () => ({ outcome: 'quiet', written: true, heldApproval: true })) as unknown as CallTurnDeps['finish']
    expect(await runCallTurn(supabase, ARGS, deps({ reply: '', finish: held }))).toMatchObject({ kind: 'notice', text: callTurnSkipNotice('held') })
    const failed = (async () => ({ kind: 'read', result: done('failed') })) as unknown as CallTurnDeps['send']
    expect(await runCallTurn(supabase, ARGS, deps({ reply: '', send: failed }))).toMatchObject({ kind: 'notice', text: callTurnSkipNotice('failed'), outcome: 'written:failed' })
    expect(await runCallTurn(supabase, ARGS, deps({ reply: '[quiet]' }))).toEqual({ kind: 'quiet', outcome: 'written', rowId: 'row1' })
  })

  it('never throws: a failed write or step is a notice', async () => {
    const persist = (async () => {
      throw new Error('db down')
    }) as unknown as CallTurnDeps['persist']
    expect(await runCallTurn(supabase, ARGS, deps({ persist }))).toEqual({ kind: 'notice', text: callTurnSkipNotice('failed'), outcome: 'write_failed' })
    const send = (async () => {
      throw new TypeError('boom')
    }) as unknown as CallTurnDeps['send']
    expect(await runCallTurn(supabase, ARGS, deps({ send, markFailed: async () => {} }))).toEqual({ kind: 'notice', text: callTurnSkipNotice('failed'), outcome: 'error:TypeError', rowId: 'row1' })
    const sendFailed = (async () => ({ kind: 'failed', error: 'send_failed' })) as unknown as CallTurnDeps['send']
    expect(await runCallTurn(supabase, ARGS, deps({ send: sendFailed }))).toEqual({ kind: 'notice', text: callTurnSkipNotice('failed'), outcome: 'send_failed', rowId: 'row1' })
  })
})

describe('callTurnSkipNotice', () => {
  it('says nothing for a duplicate or nothing new, and speaks to the person otherwise', () => {
    expect(callTurnSkipNotice('duplicate')).toBeNull()
    expect(callTurnSkipNotice('nothing_new')).toBeNull()
    for (const reason of ['question_pending', 'autonomy_off', 'usage_limited', 'not_member', 'busy', 'unfinished', 'held', 'failed'] as const) {
      expect(callTurnSkipNotice(reason)).toMatch(/\b(I|I'm|I've|me|you|your|You've|You)\b/)
    }
  })
})
