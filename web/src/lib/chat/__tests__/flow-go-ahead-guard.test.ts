/**
 * The same-turn go-ahead guard (A1b review M1): once a loop tool came back
 * awaiting_go_ahead or needs_go_ahead in a turn, no loop-tool call in that
 * turn may pass confirmed_with_user: true. The route wiring is pinned in
 * src/app/api/internal/chat/tool/__tests__/route.test.ts.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  GO_AHEAD_SAME_TURN_ERROR,
  MAIL_GO_AHEAD_SAME_TURN_ERROR,
  GO_AHEAD_GUARD_MAX_ENTRIES,
  goAheadGuardSize,
  goAheadTurnKey,
  recordGoAheadOutcome,
  resetGoAheadGuard,
  sameTurnGoAheadRefusal,
} from '../flow-go-ahead-guard'

const key = goAheadTurnKey({ userId: 'u', sessionId: 's', turnId: 't' })
const yes = { flow_id: 'f', enabled: true, confirmed_with_user: true }

beforeEach(() => resetGoAheadGuard())

describe('flow go-ahead guard', () => {
  it('keys on user, session and turn; none without a usable session and turn id', () => {
    expect(key).not.toBeNull()
    expect(goAheadTurnKey({ userId: 'u', sessionId: 's', turnId: 't2' })).not.toBe(key)
    expect(goAheadTurnKey({ userId: 'u2', sessionId: 's', turnId: 't' })).not.toBe(key)
    for (const bad of [undefined, '', 7, 'x'.repeat(201)]) {
      expect(goAheadTurnKey({ userId: 'u', sessionId: bad, turnId: 't' })).toBeNull()
      expect(goAheadTurnKey({ userId: 'u', sessionId: 's', turnId: bad })).toBeNull()
    }
  })

  it('a bulk inbox change (GEN-1166) waiting for the yes stops a same-turn confirmed one, and only for mail', () => {
    const mailYes = { thread_ids: ['a'], archive: true, confirmed_with_user: true }
    expect(sameTurnGoAheadRefusal(key, 'update_email_thread', mailYes)).toBeNull()
    recordGoAheadOutcome(key, 'update_email_thread', { success: false, code: 'NEEDS_CONFIRMATION', awaiting_go_ahead: true })
    expect(sameTurnGoAheadRefusal(key, 'update_email_thread', mailYes)).toEqual({
      success: false, code: 'GO_AHEAD_SAME_TURN', field: 'confirmed_with_user', error: MAIL_GO_AHEAD_SAME_TURN_ERROR,
    })
    // Unconfirmed calls run; the loops are tracked apart.
    expect(sameTurnGoAheadRefusal(key, 'update_email_thread', { thread_ids: ['a'], archive: true })).toBeNull()
    expect(sameTurnGoAheadRefusal(key, 'update_flow', yes)).toBeNull()
    recordGoAheadOutcome(key, 'create_flow', { awaiting_go_ahead: true })
    expect(sameTurnGoAheadRefusal(key, 'update_flow', yes)).toMatchObject({ error: GO_AHEAD_SAME_TURN_ERROR })
    // The person's reply is a new turn.
    const next = goAheadTurnKey({ userId: 'u', sessionId: 's', turnId: 't2' })
    expect(sameTurnGoAheadRefusal(next, 'update_email_thread', mailYes)).toBeNull()
  })

  it("adds up a turn's inbox changes: ten-at-a-time calls past ten are asked about, and arm the turn", () => {
    const batch = (from: number) => Array.from({ length: 6 }, (_, i) => `t${from + i}`)
    const output = (ids: string[]) => ({ success: true, changed: ids.length, threads: ids.map((thread_id) => ({ thread_id, status: 'changed' })) })
    expect(sameTurnGoAheadRefusal(key, 'update_email_thread', { thread_ids: batch(0), archive: true })).toBeNull()
    recordGoAheadOutcome(key, 'update_email_thread', output(batch(0)))
    // The same threads again don't add up.
    expect(sameTurnGoAheadRefusal(key, 'update_email_thread', { thread_ids: batch(0), read: true })).toBeNull()
    expect(sameTurnGoAheadRefusal(key, 'update_email_thread', { thread_ids: batch(6), archive: true })).toMatchObject({
      success: false, code: 'NEEDS_CONFIRMATION', awaiting_go_ahead: true, thread_count: 12,
    })
    // Asked: this turn can't claim the yes now.
    expect(sameTurnGoAheadRefusal(key, 'update_email_thread', { thread_ids: batch(6), archive: true, confirmed_with_user: true })).toMatchObject({ code: 'GO_AHEAD_SAME_TURN' })
    // The person's reply is a new turn, with its own count.
    const next = goAheadTurnKey({ userId: 'u', sessionId: 's', turnId: 't2' })
    expect(sameTurnGoAheadRefusal(next, 'update_email_thread', { thread_ids: batch(6), archive: true })).toBeNull()
  })

  it('refuses a confirmed loop-tool call only after an awaiting or needs outcome in the same turn', () => {
    expect(sameTurnGoAheadRefusal(key, 'update_flow', yes)).toBeNull()
    recordGoAheadOutcome(key, 'create_flow', { flow: { id: 'f' }, enabled: false })
    expect(sameTurnGoAheadRefusal(key, 'update_flow', yes)).toBeNull()
    recordGoAheadOutcome(key, 'create_flow', { awaiting_go_ahead: true })
    expect(sameTurnGoAheadRefusal(key, 'update_flow', yes)).toMatchObject({ code: 'GO_AHEAD_SAME_TURN', field: 'confirmed_with_user' })
    expect(sameTurnGoAheadRefusal(key, 'create_flow', { name: 'x', enabled: true, confirmed_with_user: true })).not.toBeNull()

    // A refusal for a forgotten flag isn't a fresh summary: the corrected retry runs.
    resetGoAheadGuard()
    recordGoAheadOutcome(key, 'update_flow', { success: false, needs_go_ahead: true })
    expect(sameTurnGoAheadRefusal(key, 'update_flow', yes)).toBeNull()
  })

  it("create_flow's yes is `enabled: true`: refused in a turn that asked, while a loop built off, or one the person asked for, runs", () => {
    // A loop the person asked for is saved on and arms nothing: a second asked-for loop runs.
    recordGoAheadOutcome(key, 'create_flow', { flow: { id: 'f1' }, enabled: true })
    expect(sameTurnGoAheadRefusal(key, 'create_flow', { name: 'b', enabled: true })).toBeNull()
    // The agent proposed one on its own: from then on this turn can't claim the yes.
    recordGoAheadOutcome(key, 'create_flow', { flow: { id: 'f2' }, enabled: false, awaiting_go_ahead: true })
    expect(sameTurnGoAheadRefusal(key, 'create_flow', { name: 'twin', enabled: true })).toMatchObject({ code: 'GO_AHEAD_SAME_TURN', field: 'enabled' })
    expect(sameTurnGoAheadRefusal(key, 'create_flow', { name: 'off twin' })).toBeNull()
  })

  it('never stops a call without confirmed_with_user, another tool, or another turn', () => {
    recordGoAheadOutcome(key, 'create_flow', { awaiting_go_ahead: true })
    expect(sameTurnGoAheadRefusal(key, 'update_flow', { flow_id: 'f', enabled: false })).toBeNull()
    expect(sameTurnGoAheadRefusal(key, 'update_flow', { ...yes, confirmed_with_user: 'true' })).toBeNull()
    expect(sameTurnGoAheadRefusal(key, 'run_prospect_discovery', yes)).toBeNull()
    expect(sameTurnGoAheadRefusal(goAheadTurnKey({ userId: 'u', sessionId: 's', turnId: 't2' }), 'update_flow', yes)).toBeNull()
    expect(sameTurnGoAheadRefusal(null, 'update_flow', yes)).toBeNull()
  })

  it('other tools’ outputs never mark a turn', () => {
    recordGoAheadOutcome(key, 'run_prospect_discovery', { needs_go_ahead: true })
    expect(goAheadGuardSize()).toBe(0)
  })

  it('forgets a turn after the TTL, and stays bounded', () => {
    recordGoAheadOutcome(key, 'create_flow', { awaiting_go_ahead: true }, 0)
    expect(sameTurnGoAheadRefusal(key, 'update_flow', yes, 60 * 60 * 1000 + 1)).toBeNull()
    for (let i = 0; i < GO_AHEAD_GUARD_MAX_ENTRIES + 10; i++) {
      recordGoAheadOutcome(goAheadTurnKey({ userId: 'u', sessionId: 's', turnId: `t${i}` }), 'create_flow', { awaiting_go_ahead: true })
    }
    expect(goAheadGuardSize()).toBe(GO_AHEAD_GUARD_MAX_ENTRIES)
  })
})
