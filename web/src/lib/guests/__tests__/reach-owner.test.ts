/**
 * The tools every guest's agent holds (src/lib/guests/reach-owner.ts): a note
 * to the owner lands in their home thread as a guest message, and the router
 * is asked to take it to them (src/lib/reach/route.ts); a question for the
 * owner's agent is an ask and a guest_ask home turn, never while the agent is
 * off and never past the caps; a retried call lands once; what is remembered
 * is the guest's, deduped and capped.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeSupabase, filterOf, type FakeQuery } from './fake-supabase'

const h = vi.hoisted(() => ({ paused: 'active' as string }))
vi.mock('@/lib/work/agent-paused', () => ({ readAgentPausedState: vi.fn(async () => h.paused) }))
vi.mock('@/lib/chat/home-message-writer', () => ({
  appendHomeMessage: vi.fn(),
  resolveHomeConversation: vi.fn(async () => ({ conversationId: 'home-1', created: false })),
}))

import {
  GUEST_ASKS_PENDING,
  GUEST_MEMORY_CAP,
  GUEST_MESSAGES_PER_DAY,
  GUEST_REACH_INPUT_JSON_SCHEMAS,
  askOwnerAgent,
  messageOwnerInputSchema,
  callKeyOf,
  callUuid,
  messageOwner,
  rememberAboutGuest,
} from '../reach-owner'

const GUEST = { id: 'g1', displayName: 'Sam', preset: 'household' as const }
const SCOPE = { ownerUserId: 'owner-1', workspaceId: 'ws-1', conversationId: 'conv-g', callKey: 's:t:c' }

beforeEach(() => {
  h.paused = 'active'
})

describe('callUuid', () => {
  it('is stable for one call and shaped as a uuid; without a call key it is fresh', () => {
    const a = callUuid('x', 's:t:c')
    expect(a).toBe(callUuid('x', 's:t:c'))
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(callUuid('y', 's:t:c')).not.toBe(a)
    expect(callUuid('x', null)).not.toBe(callUuid('x', null))
    expect(callKeyOf({ callId: 'c', turnId: 't', sessionId: 's' })).toBe('s:t:c')
    expect(callKeyOf({ callId: 'c', turnId: 't' })).toBeNull()
  })
})

describe('message_owner', () => {
  const quiet = (sent = 0) => fakeSupabase((q) => (q.table === 'chat_messages' ? { count: sent } : undefined))

  it("lands in the owner's home thread as the guest's message, keyed on the call, and asks the router to take it to them", async () => {
    const append = vi.fn(async () => ({ written: true, conversationId: 'home-1' }))
    const route = vi.fn(async () => undefined)
    const out = await messageOwner(quiet().supabase, SCOPE, GUEST, { text: 'Can you pick up milk?' }, { append, route, now: 0 })
    expect(out).toMatchObject({ success: true, delivered: 'in_app' })
    const noteId = callUuid('guest-message:g1', 's:t:c')
    const [, args] = append.mock.calls[0] as unknown as [unknown, { userId: string; messageId: string; parts: Array<{ type: string; data: Record<string, unknown> }>; metadata: Record<string, unknown> }]
    expect(args.userId).toBe('owner-1')
    expect(args.messageId).toBe(`guest-message:${noteId}`)
    expect(args.parts[0]).toMatchObject({ type: 'data-guest-message', data: { guest: { id: 'g1', name: 'Sam', preset: 'household', channel: 'sms', conversation_id: 'conv-g' }, text: 'Can you pick up milk?', urgent: false } })
    expect(args.metadata).toMatchObject({ kind: 'guest_message', guest_id: 'g1', note_id: noteId })
    // Ids only, keyed on the note: the system picks where it goes, never the guest's agent.
    expect(route).toHaveBeenCalledWith({ userId: 'owner-1', workspaceId: 'ws-1', conversationId: 'home-1' }, `guest-message:${noteId}`)
    expect(String(out.message)).toMatch(/away/)
  })

  it('a note with a `by` is urgent: stored as its urgent_by (the card and the router read it), routed like any other', async () => {
    const append = vi.fn(async () => ({ written: true, conversationId: 'home-1' }))
    const route = vi.fn(async () => undefined)
    const out = await messageOwner(quiet().supabase, SCOPE, GUEST, { text: 'Locked out', by: '2026-11-01T09:00:00-04:00' }, { append, route })
    expect(out).toMatchObject({ success: true, delivered: 'in_app' })
    expect(String(out.message)).toMatch(/urgent/)
    expect(out).not.toHaveProperty('pinged')
    expect(route).toHaveBeenCalledOnce()
    const [, args] = append.mock.calls[0] as unknown as [unknown, { parts: Array<{ data: Record<string, unknown> }>; metadata: Record<string, unknown> }]
    expect(args.parts[0].data).toMatchObject({ urgent: true, urgent_by: '2026-11-01T09:00:00-04:00' })
    expect(args.metadata).toMatchObject({ urgent_by: '2026-11-01T09:00:00-04:00' })
  })

  it('the schema takes `by` (an ISO time with its offset) in place of urgent: true', () => {
    expect(messageOwnerInputSchema.safeParse({ text: 'hi', by: '2026-11-01T09:00:00-04:00' }).success).toBe(true)
    expect(messageOwnerInputSchema.safeParse({ text: 'hi', by: '2026-11-01T13:00:00Z' }).success).toBe(true)
    expect(messageOwnerInputSchema.safeParse({ text: 'hi' }).success).toBe(true)
    expect(messageOwnerInputSchema.safeParse({ text: 'hi', by: '2026-11-01T09:00:00' }).success).toBe(false)
    expect(messageOwnerInputSchema.safeParse({ text: 'hi', by: 'tomorrow' }).success).toBe(false)
    const json = GUEST_REACH_INPUT_JSON_SCHEMAS.message_owner
    expect(Object.keys(json.properties).sort()).toEqual(['by', 'text'])
    expect(json.properties.by.description).toMatch(/UTC offset/)
    expect(json.required).toEqual(['text'])
  })

  it('never past the daily cap, and a note that could not be written says so (and routes nothing)', async () => {
    const append = vi.fn(async () => ({ written: true }))
    const route = vi.fn(async () => undefined)
    expect(await messageOwner(quiet(GUEST_MESSAGES_PER_DAY).supabase, SCOPE, GUEST, { text: 'hi' }, { append, route })).toMatchObject({ success: false, code: 'DAILY_LIMIT' })
    expect(append).not.toHaveBeenCalled()
    expect(await messageOwner(quiet().supabase, SCOPE, GUEST, { text: 'hi' }, { append: async () => ({ written: false, reason: 'error' }), route })).toMatchObject({ success: false, code: 'NOT_DELIVERED' })
    expect(route).not.toHaveBeenCalled()
  })
})

describe('ask_owner_agent', () => {
  function store(recent: Array<{ id: string; status: string }> = []) {
    return fakeSupabase((q: FakeQuery) => (q.table === 'agent_guest_ask' && q.op === 'select' ? { data: recent } : undefined))
  }

  it("files the ask for the guest's thread and requests a guest_ask turn in the owner's home thread", async () => {
    const f = store()
    const send = vi.fn(async () => undefined)
    const out = await askOwnerAgent(f.supabase, SCOPE, GUEST, { question: 'Is Liam free Friday night?' }, { send })
    const askId = callUuid('guest-ask:g1', 's:t:c')
    expect(out).toMatchObject({ success: true, ask_id: askId, status: 'asked' })
    const insert = f.queries.find((q) => q.table === 'agent_guest_ask' && q.op === 'insert')
    expect(insert?.values).toMatchObject({ id: askId, guest_id: 'g1', owner_user_id: 'owner-1', workspace_id: 'ws-1', guest_conversation_id: 'conv-g', status: 'pending' })
    expect(send).toHaveBeenCalledWith({
      name: 'home/turn.requested',
      id: `guest-ask-${askId}`,
      data: { conversationId: 'home-1', userId: 'owner-1', workspaceId: 'ws-1', workItemIds: [], reason: 'guest_ask' },
    })
  })

  it('a retried call finds its ask and asks nothing again', async () => {
    const askId = callUuid('guest-ask:g1', 's:t:c')
    const f = store([{ id: askId, status: 'pending' }])
    const send = vi.fn()
    expect(await askOwnerAgent(f.supabase, SCOPE, GUEST, { question: 'x' }, { send })).toMatchObject({ success: true, ask_id: askId })
    expect(f.queries.some((q) => q.op === 'insert')).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('never while the agent is off, with too many waiting, or past the day’s asks', async () => {
    h.paused = 'paused'
    expect(await askOwnerAgent(store().supabase, SCOPE, GUEST, { question: 'x' })).toMatchObject({ success: false, code: 'OWNER_AGENT_OFF' })
    h.paused = 'active'
    const waiting = Array.from({ length: GUEST_ASKS_PENDING }, (_, i) => ({ id: `a${i}`, status: 'pending' }))
    expect(await askOwnerAgent(store(waiting).supabase, SCOPE, GUEST, { question: 'x' })).toMatchObject({ success: false, code: 'TOO_MANY_PENDING' })
    const answered = Array.from({ length: 10 }, (_, i) => ({ id: `a${i}`, status: 'answered' }))
    expect(await askOwnerAgent(store(answered).supabase, SCOPE, GUEST, { question: 'x' })).toMatchObject({ success: false, code: 'DAILY_LIMIT' })
  })
})

describe('remember_about_guest', () => {
  it('keeps it as the guest’s, once, and never past the cap', async () => {
    const f = fakeSupabase((q) => (q.table === 'agent_guest_memory' && q.op === 'select' ? { data: [{ text: 'Prefers texts after 6pm' }] } : undefined))
    expect(await rememberAboutGuest(f.supabase, SCOPE, GUEST, { kind: 'preference', text: 'Vegetarian' })).toMatchObject({ success: true, remembered: true, message: expect.stringContaining('sets nothing up') })
    const insert = f.queries.find((q) => q.op === 'insert')
    expect(insert?.values).toEqual({ guest_id: 'g1', owner_user_id: 'owner-1', kind: 'preference', text: 'Vegetarian' })
    expect(filterOf(f.queries[0], 'guest_id')).toBe('g1')
    expect(await rememberAboutGuest(f.supabase, SCOPE, GUEST, { kind: 'preference', text: 'prefers texts after 6PM' })).toMatchObject({ remembered: false })
    const full = fakeSupabase(() => ({ data: Array.from({ length: GUEST_MEMORY_CAP }, (_, i) => ({ text: `t${i}` })) }))
    expect(await rememberAboutGuest(full.supabase, SCOPE, GUEST, { kind: 'fact', text: 'new' })).toMatchObject({ success: false, code: 'MEMORY_FULL' })
  })
})
