/**
 * A text from a number nobody linked, as a guest's: an active guest's text
 * goes to their own agent (with a daily cap), the right invite code from the
 * right phone makes them active, a JOIN with an open request code asks the
 * owner, and anything else is not a guest's (null). Every reply goes through
 * the inbound handler's capped auto-reply.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  GUEST_DAILY_TEXT_CAP,
  GUEST_JOIN_DAILY_CAP,
  GUEST_REQUEST_REFUSED_REPLY,
  codeCandidates,
  guestConflictReply,
  guestLimitedReply,
  guestRequestExistsReply,
  guestRequestedReply,
  guestWelcomeReply,
  handleGuestText,
  parseJoin,
  type GuestTextDeps,
} from '../texting'
import { hashInviteCode, type AgentGuest } from '../store'

const PHONE = '+15551234567'
const KEY = 'test-key'
const NOW = Date.parse('2026-10-24T18:00:00.000Z')

function guest(over: Partial<AgentGuest> = {}): AgentGuest {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    ownerUserId: 'owner-1',
    workspaceId: 'ws-1',
    displayName: 'Sam',
    phone: PHONE,
    channels: ['sms'],
    phoneBoundAt: null,
    slackTeamId: null,
    slackUserId: null,
    peerUserId: null,
    peerBoundAt: null,
    calendarEmails: [],
    businessNumberId: null,
    contactId: null,
    preset: 'household',
    tools: ['get_free_busy', 'message_owner', 'ask_owner_agent'],
    askTools: [],
    askBefore: ['payments', 'deletes'],
    notes: null,
    state: 'active',
    inviteExpiresAt: null,
    requestedAt: null,
    activatedAt: null,
    removedAt: null,
    optedOut: false,
    lastInboundAt: null,
    createdAt: '2026-10-20T00:00:00.000Z',
    ...over,
  }
}

function fakeDeps(over: Partial<GuestTextDeps> & { active?: AgentGuest | null; invites?: Array<{ guest: AgentGuest; inviteHash: string }>; inboundToday?: number; joinsToday?: number; noticed?: boolean } = {}) {
  const marks: Array<[string, string, string | null]> = []
  const replies: Array<{ kind: string; text: string; guestId: string | null }> = []
  const delivered: Array<{ guest: AgentGuest; text: string; sid: string }> = []
  const deps: GuestTextDeps = {
    findActiveGuest: vi.fn(async () => over.active ?? null),
    findOpenInvites: vi.fn(async () => over.invites ?? []),
    activate: vi.fn(async (g: AgentGuest) => ({ ok: true as const, guest: { ...g, state: 'active' as const } })),
    findRequestCode: vi.fn(async () => null),
    createRequest: vi.fn(async (input) => ({ ok: true as const, guest: guest({ state: 'requested', displayName: input.name ?? input.phone }) })),
    ownerName: vi.fn(async () => 'Liam'),
    markInbound: vi.fn(async (sid, kind, guestId) => {
      marks.push([sid, kind, guestId])
    }),
    countGuestInboundSince: vi.fn(async () => over.inboundToday ?? 0),
    countJoinsSince: vi.fn(async () => over.joinsToday ?? 0),
    noticedSince: vi.fn(async () => over.noticed ?? false),
    autoReply: vi.fn(async (_phone, kind, text, guestId) => {
      replies.push({ kind, text, guestId })
      return text
    }),
    deliver: vi.fn(async (args) => {
      delivered.push(args)
    }),
    inviteKey: KEY,
    ...over,
  }
  return { deps, marks, replies, delivered }
}

const input = (text: string, over: Partial<{ sid: string | null; numMedia: number; phone: string }> = {}) => ({ phone: PHONE, text, sid: 'SM1', numMedia: 0, ...over })

describe('an active guest', () => {
  it('their text goes to their own agent, marked as theirs', async () => {
    const f = fakeDeps({ active: guest() })
    expect(await handleGuestText(input('when is Liam free friday?'), f.deps, NOW)).toEqual({ outcome: 'guest_queued', reply: null })
    expect(f.marks).toEqual([['SM1', 'guest_text', guest().id]])
    expect(f.delivered).toEqual([{ guest: guest(), text: 'when is Liam free friday?', sid: 'SM1' }])
    // Never read as an invite or a JOIN once they're active.
    expect(f.deps.findOpenInvites).not.toHaveBeenCalled()
  })

  it('past the daily cap: one notice a day, then silence, and nothing reaches the agent', async () => {
    const capped = fakeDeps({ active: guest(), inboundToday: GUEST_DAILY_TEXT_CAP })
    expect(await handleGuestText(input('again'), capped.deps, NOW)).toEqual({ outcome: 'guest_limited', reply: guestLimitedReply('Liam') })
    expect(capped.marks).toEqual([['SM1', 'limited', guest().id]])
    expect(capped.delivered).toHaveLength(0)
    const quiet = fakeDeps({ active: guest(), inboundToday: GUEST_DAILY_TEXT_CAP, noticed: true })
    expect(await handleGuestText(input('again'), quiet.deps, NOW)).toEqual({ outcome: 'guest_limited_ignored', reply: null })
    expect(quiet.replies).toHaveLength(0)
  })

  it('a picture alone gets a short note; nothing is delivered', async () => {
    const f = fakeDeps({ active: guest() })
    expect((await handleGuestText(input('', { numMedia: 1 }), f.deps, NOW))?.outcome).toBe('guest_no_text')
    expect(f.delivered).toHaveLength(0)
  })
})

describe('the invite code', () => {
  const invited = guest({ state: 'invited' })
  const hash = hashInviteCode('K7Q4MX', { guestId: invited.id, phone: PHONE }, KEY)

  it('the right code from the invited phone activates them and welcomes them, with the compliance lines', async () => {
    const f = fakeDeps({ invites: [{ guest: invited, inviteHash: hash }] })
    const out = await handleGuestText(input("Hi, it's Sam · K7Q4MX"), f.deps, NOW)
    expect(out).toEqual({ outcome: 'guest_welcomed', reply: guestWelcomeReply('Liam') })
    expect(out?.reply).toMatch(/STOP to opt out/)
    expect(out?.reply).toMatch(/HELP/)
    expect(f.deps.activate).toHaveBeenCalledWith(invited, NOW)
    expect(f.marks).toEqual([['SM1', 'guest_invite', invited.id]])
    expect(f.replies[0]).toMatchObject({ kind: 'guest_welcome', guestId: invited.id })
    expect(f.delivered).toHaveLength(0)
  })

  it('is case-insensitive', async () => {
    const f = fakeDeps({ invites: [{ guest: invited, inviteHash: hash }] })
    expect((await handleGuestText(input('k7q4mx'), f.deps, NOW))?.outcome).toBe('guest_welcomed')
  })

  it("a wrong code, or the right code from another phone, isn't a guest's text", async () => {
    const wrong = fakeDeps({ invites: [{ guest: invited, inviteHash: hash }] })
    expect(await handleGuestText(input('ABCDEF'), wrong.deps, NOW)).toBeNull()
    expect(wrong.deps.activate).not.toHaveBeenCalled()
    // The hash binds the phone: another number's invite row never matches this code.
    const otherPhone = fakeDeps({ invites: [{ guest: { ...invited, phone: '+15559876543' }, inviteHash: hashInviteCode('K7Q4MX', { guestId: invited.id, phone: '+15559876543' }, KEY) }] })
    expect(await handleGuestText(input('K7Q4MX'), otherPhone.deps, NOW)).toBeNull()
  })

  it('a number already active for another owner is refused', async () => {
    const f = fakeDeps({ invites: [{ guest: invited, inviteHash: hash }], activate: vi.fn(async () => ({ ok: false as const, reason: 'conflict' as const })) })
    expect(await handleGuestText(input('K7Q4MX'), f.deps, NOW)).toEqual({ outcome: 'guest_conflict', reply: guestConflictReply() })
  })

  it('without the invite key, no invite activates', async () => {
    const f = fakeDeps({ invites: [{ guest: invited, inviteHash: hash }], inviteKey: null })
    expect(await handleGuestText(input('K7Q4MX'), f.deps, NOW)).toBeNull()
    expect(f.deps.findOpenInvites).not.toHaveBeenCalled()
  })
})

describe('JOIN', () => {
  const owner = { ownerUserId: 'owner-1', workspaceId: 'ws-1' }

  it('with an open request code: a request for the owner, and a reply saying so', async () => {
    const f = fakeDeps({ findRequestCode: vi.fn(async () => owner) })
    expect(await handleGuestText(input('JOIN k7q4mx Jason Lee'), f.deps, NOW)).toEqual({ outcome: 'guest_requested', reply: guestRequestedReply('Liam') })
    expect(f.deps.findRequestCode).toHaveBeenCalledWith('K7Q4MX')
    expect(f.deps.createRequest).toHaveBeenCalledWith({ ...owner, phone: PHONE, name: 'Jason Lee' }, NOW)
    expect(f.marks[0]).toEqual(['SM1', 'guest_join', guest().id])
  })

  it('asking twice says they already asked; a refused request says so plainly', async () => {
    const again = fakeDeps({ findRequestCode: vi.fn(async () => owner), createRequest: vi.fn(async () => ({ ok: false as const, reason: 'exists' as const, guest: guest({ state: 'requested' }) })) })
    expect(await handleGuestText(input('JOIN K7Q4MX'), again.deps, NOW)).toEqual({ outcome: 'guest_request_exists', reply: guestRequestExistsReply('Liam') })
    const refused = fakeDeps({ findRequestCode: vi.fn(async () => owner), createRequest: vi.fn(async () => ({ ok: false as const, reason: 'too_many' as const })) })
    expect(await handleGuestText(input('JOIN K7Q4MX'), refused.deps, NOW)).toEqual({ outcome: 'guest_request_refused', reply: GUEST_REQUEST_REFUSED_REPLY })
  })

  it('a closed or unknown code is not a guest text (the unknown-number reply takes it)', async () => {
    const f = fakeDeps()
    expect(await handleGuestText(input('JOIN K7Q4MX'), f.deps, NOW)).toBeNull()
    expect(f.deps.createRequest).not.toHaveBeenCalled()
  })

  it(`at most ${GUEST_JOIN_DAILY_CAP} a day per number, then silence`, async () => {
    const f = fakeDeps({ findRequestCode: vi.fn(async () => owner), joinsToday: GUEST_JOIN_DAILY_CAP })
    expect(await handleGuestText(input('JOIN K7Q4MX'), f.deps, NOW)).toEqual({ outcome: 'guest_join_capped', reply: null })
    expect(f.deps.createRequest).not.toHaveBeenCalled()
  })
})

describe('parsing', () => {
  it('finds six-character codes of the alphabet only', () => {
    expect(codeCandidates("Hi, it's Sam · K7Q4MX")).toEqual(['K7Q4MX'])
    expect(codeCandidates('hello there')).toEqual([])
    // 0, O, 1 and I are not in the alphabet.
    expect(codeCandidates('K0Q1MI')).toEqual([])
  })

  it('reads JOIN with or without a name', () => {
    expect(parseJoin('JOIN K7Q4MX')).toEqual({ code: 'K7Q4MX', name: null })
    expect(parseJoin('  join k7q4mx - Jason  ')).toEqual({ code: 'K7Q4MX', name: 'Jason' })
    expect(parseJoin('please join K7Q4MX')).toBeNull()
  })
})

it('anything else from an unknown number is not a guest text', async () => {
  const f = fakeDeps()
  expect(await handleGuestText(input('who is this?'), f.deps, NOW)).toBeNull()
})
