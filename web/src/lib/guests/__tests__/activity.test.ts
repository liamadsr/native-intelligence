/**
 * The owner's log of who talks to their agent (src/lib/guests/activity.ts):
 * one line per guest per hour, grown in place, never refusing the text.
 */
import { describe, expect, it, vi } from 'vitest'
import { fakeSupabase } from './fake-supabase'

const h = vi.hoisted(() => ({ append: vi.fn(async () => ({ written: true })) }))
vi.mock('@/lib/chat/home-message-writer', () => ({
  appendHomeMessage: h.append,
  resolveHomeConversation: vi.fn(async () => ({ conversationId: 'home-1', created: false })),
}))

import { guestActivityMessageId, nextGuestActivity, recordGuestActivity } from '../activity'

const GUEST = { id: 'g1', displayName: 'Sam', preset: 'household' as const, ownerUserId: 'owner-1', workspaceId: 'ws-1' }
const AT = Date.parse('2026-10-27T19:05:00.000Z')

describe('the log line', () => {
  it('one per guest per clock hour', () => {
    expect(guestActivityMessageId('g1', AT)).toBe(guestActivityMessageId('g1', Date.parse('2026-10-27T19:59:59.000Z')))
    expect(guestActivityMessageId('g1', AT)).not.toBe(guestActivityMessageId('g1', Date.parse('2026-10-27T20:00:00.000Z')))
  })

  it('starts a stretch, then grows it: count, last time, a line of the last text', () => {
    const first = nextGuestActivity(null, { guest: GUEST, conversationId: 'conv-g', messageId: 'sms-in:1', text: 'Hi!', at: AT })
    expect(first).toEqual({
      guest: { id: 'g1', name: 'Sam', preset: 'household', channel: 'sms', conversation_id: 'conv-g', message_id: 'sms-in:1' },
      summary: 'Texted: “Hi!”',
      count: 1,
      started_at: new Date(AT).toISOString(),
      last_at: new Date(AT).toISOString(),
    })
    const next = nextGuestActivity(first, { guest: GUEST, conversationId: 'conv-g', messageId: 'sms-in:2', text: 'x'.repeat(300), at: AT + 60_000 })
    expect(next).toMatchObject({ count: 2, guest: { message_id: 'sms-in:1' }, started_at: first.started_at, last_at: new Date(AT + 60_000).toISOString() })
    expect(next.summary.length).toBe(140 + 'Texted: “”'.length)
  })
})

describe('recordGuestActivity', () => {
  it("writes a new line in the owner's home thread", async () => {
    const f = fakeSupabase(() => ({ data: null }))
    await recordGuestActivity(f.supabase, { guest: GUEST, conversationId: 'conv-g', messageId: 'sms-in:1', text: 'Hi' }, AT)
    expect(h.append).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ userId: 'owner-1', messageId: guestActivityMessageId('g1', AT), metadata: { kind: 'guest_activity', guest_id: 'g1' } }))
  })

  it('grows the hour’s line in place', async () => {
    h.append.mockClear()
    const id = guestActivityMessageId('g1', AT)
    const prev = nextGuestActivity(null, { guest: GUEST, conversationId: 'conv-g', messageId: 'sms-in:1', text: 'Hi', at: AT })
    const f = fakeSupabase((q) => (q.op === 'select' ? { data: { id: 'row-1', ui_message: { id, role: 'assistant', parts: [{ type: 'data-guest-activity', id, data: prev }] } } } : {}))
    await recordGuestActivity(f.supabase, { guest: GUEST, conversationId: 'conv-g', messageId: 'sms-in:2', text: 'Again' }, AT + 1000)
    expect(h.append).not.toHaveBeenCalled()
    const update = f.queries.find((q) => q.op === 'update')!
    const parts = (update.values as { ui_message: { parts: Array<{ data: { count: number; summary: string } }> } }).ui_message.parts
    expect(parts[0].data).toMatchObject({ count: 2, summary: 'Texted: “Again”' })
  })

  it('never throws', async () => {
    const broken = { from: () => { throw new Error('down') } } as never
    await expect(recordGuestActivity(broken, { guest: GUEST, conversationId: 'c', messageId: 'm', text: 't' }, AT)).resolves.toBeUndefined()
  })
})

describe('postGuestRequest', () => {
  it("puts the request card in the owner's home thread once, with only the number's last four digits", async () => {
    h.append.mockClear()
    const { postGuestRequest } = await import('../activity')
    await postGuestRequest({} as never, { id: 'g9', displayName: 'Jason', phone: '+15551234567', ownerUserId: 'owner-1', workspaceId: 'ws-1', requestedAt: '2026-10-27T19:00:00.000Z' })
    expect(h.append).toHaveBeenCalledWith(expect.anything(), {
      userId: 'owner-1',
      workspaceId: 'ws-1',
      messageId: 'guest-request:g9',
      parts: [{ type: 'data-guest-request', id: 'guest-request:g9', data: { guest_id: 'g9', guest_name: 'Jason', phone_last4: '4567', status: 'pending', requested_at: '2026-10-27T19:00:00.000Z' } }],
      metadata: { kind: 'guest_request', guest_id: 'g9' },
    })
    expect(JSON.stringify(h.append.mock.calls)).not.toContain('5551234567')
  })

  it('asks the router to take the request to the owner (ids only, keyed on the guest); a card not written routes nothing', async () => {
    const { postGuestRequest } = await import('../activity')
    const route = vi.fn(async () => undefined)
    const guest = { id: 'g9', displayName: 'Jason', phone: '+15551234567', ownerUserId: 'owner-1', workspaceId: 'ws-1', requestedAt: null }
    h.append.mockResolvedValueOnce({ written: true, conversationId: 'home-1' } as never)
    await postGuestRequest({} as never, guest, AT, { route })
    expect(route).toHaveBeenCalledWith({ userId: 'owner-1', workspaceId: 'ws-1', conversationId: 'home-1' }, 'guest-request:g9')
    route.mockClear()
    h.append.mockResolvedValueOnce({ written: false, reason: 'error' } as never)
    await postGuestRequest({} as never, guest, AT, { route })
    expect(route).not.toHaveBeenCalled()
  })
})
