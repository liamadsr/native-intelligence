/**
 * disconnect (F2): never immediate. It raises the person's confirm card,
 * naming the loops that need the connection; the replay of their Accept
 * disconnects through the one disconnect path and switches those loops off.
 * A card for a connection that changed since does nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  ref: null as null | Record<string, unknown>,
  losing: [] as Array<{ id: string; name: string; on: boolean }>,
  approvals: [] as Array<Record<string, unknown>>,
  removed: [] as string[],
  switched: [] as unknown[],
}))
vi.mock('@/lib/connections/disconnect', () => ({
  findConnection: vi.fn(async () => state.ref),
  loopsLosing: vi.fn(async () => state.losing),
  // The shared disconnect switches the loops off itself (Settings' path too).
  disconnectOAuthAccount: vi.fn(async (_s: unknown, _u: string, id: string) => {
    state.removed.push(id)
    const on = state.losing.filter((l) => l.on)
    state.switched.push(...on)
    return { removed: true, loopsSwitchedOff: on }
  }),
  disconnectApp: vi.fn(async (_s: unknown, _u: string, id: string) => {
    state.removed.push(id)
    return { removed: true, loopsSwitchedOff: [] }
  }),
}))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => ({}) }))
vi.mock('@/lib/safety/approvals', () => ({
  createToolApproval: vi.fn(async (_s: unknown, approval: Record<string, unknown>) => {
    state.approvals.push(approval)
    return { ok: true, approvalId: 'appr-1', cardId: 'card-1' }
  }),
}))

import { createConnectionTools } from '../connections'
import { connectionStateHash } from '@/lib/connections/connection-cards'

const OPTS = { toolCallId: 't', messages: [] } as never
const ID = '11111111-1111-4111-8111-111111111111'
type Result = Record<string, unknown> & { success: boolean }

const run = (input: Record<string, unknown>, approvedCall?: unknown) =>
  createConnectionTools('u1', {} as never, 'ws-1', { conversationId: 'conv-1', approvedCall: approvedCall as never }).disconnect.execute!(input as never, OPTS) as unknown as Promise<Result>

beforeEach(() => {
  state.ref = { kind: 'integration', id: ID, name: 'google:calendar', provider: 'google', capability: 'calendar', account: 'me@x.com' }
  state.losing = [
    { id: 'f1', name: 'Prep my meetings', on: true },
    { id: 'f2', name: 'Weekly review', on: false },
  ]
  state.approvals = []
  state.removed = []
  state.switched = []
})

describe('disconnect', () => {
  it('raises the confirm card naming the loops, and disconnects nothing', async () => {
    const r = await run({ connection_id: ID })
    expect(r).toMatchObject({ success: false, code: 'APPROVAL_REQUIRED', approval_id: 'appr-1' })
    expect(state.removed).toEqual([])
    const held = state.approvals[0]
    expect(held).toMatchObject({ door: 'chat', toolName: 'disconnect', sideEffect: 'delete', conversationId: 'conv-1', userId: 'u1' })
    expect((held.card as { title: string }).title).toBe('Disconnect Calendar (me@x.com)?')
    expect((held.card as { why: string }).why).toContain('"Prep my meetings", "Weekly review" (already off)')
    // The card's input is only the real argument; the words are in title and why.
    expect(held.input).toEqual({ connection_id: ID })
    expect((held.context as { connection: { kind: string } }).connection.kind).toBe('disconnect')
    expect(String(r.message)).toMatch(/do not call disconnect again/)
  })

  it('the accepted card disconnects and switches the loops that were on off, and says so', async () => {
    await run({ connection_id: ID })
    const context = (state.approvals[0].context as { connection: unknown }).connection
    const r = await run({ connection_id: ID }, { approvalId: 'appr-1', tool: 'disconnect', connection: context })
    expect(r.success).toBe(true)
    expect(state.removed).toEqual([ID])
    expect(state.switched).toEqual([{ id: 'f1', name: 'Prep my meetings', on: true }])
    expect(String(r.message)).toContain('Disconnected Calendar (me@x.com). Switched off the loop that needed it')
  })

  it('a card whose loops changed since does nothing (they are in its hash)', async () => {
    await run({ connection_id: ID })
    const context = (state.approvals[0].context as { connection: unknown }).connection
    state.losing = [...state.losing, { id: 'f3', name: 'New loop', on: true }]
    const r = await run({ connection_id: ID }, { approvalId: 'appr-1', tool: 'disconnect', connection: context })
    expect(r).toMatchObject({ success: false, code: 'CONNECTION_CHANGED' })
    expect(state.removed).toEqual([])
  })

  it('stores the chat door\'s context (its persona) on the card, so Accept applies that ceiling', async () => {
    await createConnectionTools('u1', {} as never, 'ws-1', { approvalContext: { agentId: 'agent-7' } }).disconnect.execute!({ connection_id: ID } as never, OPTS)
    expect(state.approvals[0].context).toMatchObject({ agentId: 'agent-7', connection: { kind: 'disconnect' } })
  })

  it('a card for a connection that changed since does nothing', async () => {
    const stale = { kind: 'disconnect', connection_id: ID, state_hash: connectionStateHash({ other: true }) }
    const r = await run({ connection_id: ID }, { approvalId: 'appr-1', tool: 'disconnect', connection: stale })
    expect(r).toMatchObject({ success: false, code: 'CONNECTION_CHANGED' })
    expect(state.removed).toEqual([])
  })

  it("another tool's or another connection's approval is not this card", async () => {
    await run({ connection_id: ID })
    const context = (state.approvals[0].context as { connection: unknown }).connection
    const r = await run({ connection_id: ID }, { approvalId: 'appr-1', tool: 'set_tool_access', connection: context })
    expect(r.code).toBe('APPROVAL_REQUIRED')
    expect(state.removed).toEqual([])
  })

  it('an unknown id says so', async () => {
    state.ref = null
    expect((await run({ connection_id: ID })).success).toBe(false)
    expect(state.approvals).toEqual([])
  })
})
