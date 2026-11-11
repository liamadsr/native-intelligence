/**
 * A linked guest's free/busy for the host's own agent
 * (src/lib/guests/linked-free-busy.ts): only with the grant that already
 * lets the host's agent ask theirs get_free_busy (an active link, their half
 * for the host active, their agent a channel, free/busy on Always allow).
 * Needs approval, Blocked, a half not active, an ended link, a lookup that
 * fails, or a guest's or a linked agent's own turn (the grant fence): no
 * grant. Only busy or free crosses.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { halfSharesFreeBusy, linkedFreeBusyGrant, linkedSpansBusy } from '../linked-free-busy'
import type { AgentGuest } from '../store'

const HOST = 'user-ava'
const PEER = 'user-dana'
const db = {} as SupabaseClient

function half(over: Partial<AgentGuest> = {}): AgentGuest {
  return {
    id: 'half-dana',
    ownerUserId: PEER,
    workspaceId: 'ws-initech',
    displayName: 'Ava Lin',
    phone: null,
    channels: ['dial8'],
    phoneBoundAt: null,
    slackTeamId: null,
    slackUserId: null,
    peerUserId: HOST,
    peerBoundAt: '2026-11-01T00:00:00.000Z',
    calendarEmails: [],
    businessNumberId: null,
    contactId: null,
    preset: 'colleague',
    tools: ['get_free_busy', 'message_owner'],
    askTools: [],
    askBefore: [],
    notes: null,
    state: 'active',
    inviteExpiresAt: null,
    requestedAt: null,
    activatedAt: '2026-11-01T00:00:00.000Z',
    removedAt: null,
    optedOut: false,
    lastInboundAt: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    ...over,
  } as AgentGuest
}

const deps = (h: AgentGuest | null, linked = true) => ({
  resolveEmail: vi.fn(async (email: string) => (email === 'dana@initech.example' ? PEER : null)),
  activeLink: vi.fn(async () => linked),
  half: vi.fn(async () => h),
})

describe('halfSharesFreeBusy', () => {
  it('only free/busy on Always allow, over an active, bound half with their agent as a channel', () => {
    expect(halfSharesFreeBusy(half())).toBe(true)
    expect(halfSharesFreeBusy(half({ askTools: ['get_free_busy'] }))).toBe(false)
    expect(halfSharesFreeBusy(half({ tools: ['message_owner'] }))).toBe(false)
    expect(halfSharesFreeBusy(half({ state: 'invited' }))).toBe(false)
    expect(halfSharesFreeBusy(half({ channels: ['sms'] }))).toBe(false)
    expect(halfSharesFreeBusy(half({ peerBoundAt: null }))).toBe(false)
    expect(halfSharesFreeBusy(half({ preset: 'customer' }))).toBe(false)
  })
})

describe('linkedFreeBusyGrant', () => {
  it('the grant: whose free/busy, in which of their workspaces', async () => {
    const d = deps(half())
    expect(await linkedFreeBusyGrant(db, { hostUserId: HOST, email: 'dana@initech.example' }, d)).toEqual({ peerUserId: PEER, workspaceId: 'ws-initech' })
    // Their half for the host: owned by them, naming the host.
    expect(d.half).toHaveBeenCalledWith(PEER, HOST)
  })

  it('no grant: not a user, no active link, a half that asks first or names someone else, a failed lookup', async () => {
    expect(await linkedFreeBusyGrant(db, { hostUserId: HOST, email: 'sam@globex.example' }, deps(half()))).toBeNull()
    expect(await linkedFreeBusyGrant(db, { hostUserId: HOST, email: 'dana@initech.example' }, deps(half(), false))).toBeNull()
    expect(await linkedFreeBusyGrant(db, { hostUserId: HOST, email: 'dana@initech.example' }, deps(half({ askTools: ['get_free_busy'] })))).toBeNull()
    expect(await linkedFreeBusyGrant(db, { hostUserId: HOST, email: 'dana@initech.example' }, deps(half({ peerUserId: 'user-other' })))).toBeNull()
    expect(await linkedFreeBusyGrant(db, { hostUserId: HOST, email: 'dana@initech.example' }, { ...deps(half()), activeLink: vi.fn(async () => { throw new Error('down') }) })).toBeNull()
    expect(await linkedFreeBusyGrant(db, { hostUserId: HOST, email: null }, deps(half()))).toBeNull()
  })

  it('the grant fence: a guest\'s or a linked agent\'s own turn reads no grant, and looks nothing up', async () => {
    const d = deps(half())
    expect(await linkedFreeBusyGrant(db, { hostUserId: HOST, email: 'dana@initech.example', omitGrants: true }, d)).toBeNull()
    expect(d.resolveEmail).not.toHaveBeenCalled()
  })
})

describe('linkedSpansBusy', () => {
  it('busy or free for each span, strictly from their own calendars in their own zone; unreadable is unknown', async () => {
    const grant = { peerUserId: PEER, workspaceId: 'ws-initech' }
    const spans = [{ start: 1, end: 2 }]
    const linkedCheckFree = vi.fn(async () => ({ known: true as const, busy: [true] }))
    expect(await linkedSpansBusy(db, grant, spans, { linkedCheckFree, linkedTimeZone: async () => 'America/Chicago' })).toEqual({ known: true, busy: [true] })
    expect(linkedCheckFree).toHaveBeenCalledWith({ userId: PEER, workspaceId: 'ws-initech', timeZone: 'America/Chicago', spans })
    expect(await linkedSpansBusy(db, grant, spans, { linkedCheckFree: vi.fn(async () => ({ known: false as const, reason: 'x' })), linkedTimeZone: async () => 'UTC' })).toEqual({ known: false })
    expect(await linkedSpansBusy(db, grant, spans, { linkedCheckFree, linkedTimeZone: async () => { throw new Error('down') } })).toEqual({ known: false })
  })
})
