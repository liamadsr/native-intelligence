/**
 * /api/account/agent-guests (guest access, PR5): the People tab's routes.
 * Each calls the guest store for the signed-in user only, answers the
 * GuestView (never the owner id or the full number), and turns each store
 * refusal into the tab's error. The store is stubbed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => ({
  listGuests: vi.fn(),
  requestCode: vi.fn(),
  createGuest: vi.fn(),
  getGuest: vi.fn(),
  updateGuest: vi.fn(),
  approveRequest: vi.fn(),
  removeGuest: vi.fn(),
  renewInvite: vi.fn(),
  setRequestsOpen: vi.fn(),
}))

vi.mock('@/lib/api-auth', () => {
  const auth = { supabase: {}, user: { id: 'owner-1' }, workspaceId: 'ws-1', member: { id: 'm-1' } }
  return { requireUser: async () => auth, requireWorkspaceMember: async () => auth }
})
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => ({ service: true }) }))
vi.mock('@/lib/twilio/config', () => ({ twilioPhoneNumber: () => '+14155550100', twilioConfig: () => ({}) }))
vi.mock('@/lib/guests/store', async () => {
  const actual = await vi.importActual<typeof import('@/lib/guests/store')>('@/lib/guests/store')
  return { ...actual, ...store }
})

const { GUEST_CALENDAR_EMAILS_RAW_MAX } = await import('@/lib/guests/people')
const list = await import('../route')
const one = await import('../[id]/route')
const approve = await import('../[id]/approve/route')
const ignore = await import('../[id]/ignore/route')
const invite = await import('../[id]/invite/route')
const code = await import('../request-code/route')

function guest(over: Record<string, unknown> = {}) {
  return {
    id: 'g-1',
    ownerUserId: 'owner-1',
    workspaceId: 'ws-1',
    displayName: 'Sam Rivera',
    phone: '+14155558830',
    channels: ['sms'],
    phoneBoundAt: '2026-10-24T20:00:00Z',
    slackTeamId: null,
    slackUserId: null,
    preset: 'household',
    tools: ['get_free_busy', 'create_calendar_event', 'message_owner', 'ask_owner_agent'],
    askTools: ['create_calendar_event'],
    askBefore: ['payments'],
    notes: null,
    state: 'active',
    inviteExpiresAt: null,
    requestedAt: null,
    activatedAt: '2026-10-24T20:00:00Z',
    removedAt: null,
    optedOut: false,
    lastInboundAt: '2026-10-24T21:00:00Z',
    createdAt: '2026-10-24T19:00:00Z',
    ...over,
  }
}

const req = (body: unknown) => new Request('http://x', { method: 'POST', body: JSON.stringify(body) })
const params = (id = 'g-1') => ({ params: Promise.resolve({ id }) })

beforeEach(() => {
  for (const fn of Object.values(store)) fn.mockReset()
})

describe('GET /api/account/agent-guests', () => {
  it('lists the owner’s people as GuestViews, with their request code and the Native Intelligence number', async () => {
    store.listGuests.mockResolvedValue([guest()])
    store.requestCode.mockResolvedValue({ code: 'K7Q4MX', open: false })
    const res = await list.GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(store.listGuests).toHaveBeenCalledWith({ service: true }, 'owner-1')
    expect(store.requestCode).toHaveBeenCalledWith({ service: true }, 'owner-1', 'ws-1')
    expect(body.requests).toEqual({ code: 'K7Q4MX', open: false })
    expect(body.dial8Number).toBe('+14155550100')
    expect(body.guests[0]).toMatchObject({ id: 'g-1', displayName: 'Sam Rivera', masked: '··8830', askTools: ['create_calendar_event'] })
    expect(body.guests[0]).not.toHaveProperty('ownerUserId')
    expect(body.guests[0]).not.toHaveProperty('phone')
  })

  it('a failed read is a 500', async () => {
    store.listGuests.mockRejectedValue(new Error('boom'))
    store.requestCode.mockResolvedValue(null)
    expect((await list.GET()).status).toBe(500)
  })
})

describe('POST /api/account/agent-guests', () => {
  it('adds a person with their picks and answers the invite once', async () => {
    store.createGuest.mockResolvedValue({ ok: true, guest: guest({ state: 'invited', inviteExpiresAt: '2026-10-31T00:00:00Z' }), inviteCode: 'AB12CD' })
    const res = await list.POST(req({ displayName: 'Sam Rivera', phone: '+14155558830', preset: 'household', tools: ['get_free_busy', 7], askTools: [], askBefore: ['payments'] }))
    expect(res.status).toBe(201)
    expect(store.createGuest).toHaveBeenCalledWith(
      { service: true },
      expect.objectContaining({ ownerUserId: 'owner-1', workspaceId: 'ws-1', preset: 'household', tools: ['get_free_busy'], askTools: [], askBefore: ['payments'] }),
    )
    const body = await res.json()
    expect(body.invite).toEqual({ code: 'AB12CD', text: "Hi, it's Sam · AB12CD", dial8Number: '+14155550100', expiresAt: '2026-10-31T00:00:00Z' })
  })

  it('needs a preset', async () => {
    const res = await list.POST(req({ displayName: 'Sam', phone: '+14155558830', preset: 'admin' }))
    expect(res.status).toBe(400)
    expect(store.createGuest).not.toHaveBeenCalled()
  })

  it.each([
    ['bad_phone', 400],
    ['own_number', 400],
    ['someones_number', 409],
    ['already_listed', 409],
    ['too_many', 409],
    ['not_configured', 503],
    ['failed', 500],
  ])('a %s refusal is a %i', async (reason, status) => {
    store.createGuest.mockResolvedValue({ ok: false, reason })
    expect((await list.POST(req({ displayName: 'Sam', phone: '+14155558830', preset: 'colleague' }))).status).toBe(status)
  })
})

describe('/api/account/agent-guests/[id]', () => {
  it('GET reads one person, removed ones too', async () => {
    store.getGuest.mockResolvedValue(guest({ state: 'removed' }))
    const res = await one.GET(new Request('http://x'), params())
    expect(store.getGuest).toHaveBeenCalledWith({ service: true }, 'owner-1', 'g-1')
    expect((await res.json()).guest.state).toBe('removed')
  })

  it('GET of someone else’s is a 404', async () => {
    store.getGuest.mockResolvedValue(null)
    expect((await one.GET(new Request('http://x'), params())).status).toBe(404)
  })

  it('PATCH with a preset resets to its picks', async () => {
    store.updateGuest.mockResolvedValue({ ok: true, guest: guest({ preset: 'colleague' }) })
    const res = await one.PATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify({ preset: 'colleague' }) }), params())
    expect(res.status).toBe(200)
    const patch = store.updateGuest.mock.calls[0][3]
    expect(patch).toHaveProperty('tools')
    expect(patch).toHaveProperty('askTools')
    expect(patch).toHaveProperty('askBefore')
  })

  it('PATCH with a preset and tools of the owner’s own but no asks starts each extra tool on its default', async () => {
    store.updateGuest.mockResolvedValue({ ok: true, guest: guest() })
    await one.PATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify({ preset: 'household', tools: ['get_free_busy', 'update_calendar_event', 'publish_draft'] }) }), params())
    const patch = store.updateGuest.mock.calls[0][3]
    expect(patch.askTools).toEqual(expect.arrayContaining(['update_calendar_event', 'publish_draft']))
  })

  it('PATCH sets tools and askTools as picked', async () => {
    store.updateGuest.mockResolvedValue({ ok: true, guest: guest() })
    await one.PATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify({ tools: ['get_free_busy'], askTools: [] }) }), params())
    expect(store.updateGuest).toHaveBeenCalledWith({ service: true }, 'owner-1', 'g-1', { tools: ['get_free_busy'], askTools: [] })
  })

  it('PATCH with nothing to change is a 400', async () => {
    const res = await one.PATCH(new Request('http://x', { method: 'PATCH', body: '{}' }), params())
    expect(res.status).toBe(400)
  })

  it('PATCH sets their calendar emails, every entry as sent (the store cleans and checks them), and answers them in the view', async () => {
    store.updateGuest.mockResolvedValue({ ok: true, guest: guest({ calendarEmails: ['jess@gmail.com'] }) })
    const res = await one.PATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify({ calendarEmails: [' Jess@Gmail.com', 7] }) }), params())
    expect(res.status).toBe(200)
    expect(store.updateGuest).toHaveBeenCalledWith({ service: true }, 'owner-1', 'g-1', { calendarEmails: [' Jess@Gmail.com', 7] })
    expect((await res.json()).guest.calendarEmails).toEqual(['jess@gmail.com'])
  })

  it('PATCH calendar emails must be a list, and a bad address is the store’s 400 with what to type', async () => {
    const notList = await one.PATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify({ calendarEmails: 'jess@gmail.com' }) }), params())
    expect(notList.status).toBe(400)
    expect(store.updateGuest).not.toHaveBeenCalled()
    store.updateGuest.mockResolvedValue({ ok: false, reason: 'bad_calendar_emails' })
    const bad = await one.PATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify({ calendarEmails: ['jess'] }) }), params())
    expect(bad.status).toBe(400)
    expect((await bad.json()).error).toMatch(/up to 5 email addresses/)
  })

  it('PATCH refuses an oversized calendar-emails list before the store sees it', async () => {
    const res = await one.PATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify({ calendarEmails: Array(GUEST_CALENDAR_EMAILS_RAW_MAX + 1).fill('jess@gmail.com') }) }), params())
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/up to 5 email addresses/)
    expect(store.updateGuest).not.toHaveBeenCalled()
  })

  it('a view always carries calendar emails, an empty list for a guest with none', async () => {
    store.getGuest.mockResolvedValue(guest())
    const res = await one.GET(new Request('http://x'), params())
    expect((await res.json()).guest.calendarEmails).toEqual([])
  })

  it('DELETE removes them', async () => {
    store.removeGuest.mockResolvedValue({ ok: true, guest: guest({ state: 'removed' }) })
    const res = await one.DELETE(new Request('http://x', { method: 'DELETE' }), params())
    expect(await res.json()).toEqual({ ok: true })
  })
})

describe('approve and ignore', () => {
  it('approve allows a request with the preset', async () => {
    store.approveRequest.mockResolvedValue({ ok: true, guest: guest() })
    const res = await approve.POST(req({ preset: 'colleague' }), params())
    expect(res.status).toBe(200)
    expect(store.approveRequest).toHaveBeenCalledWith({ service: true }, 'owner-1', 'g-1', 'colleague')
  })

  it('approve of a settled request is a 409', async () => {
    store.approveRequest.mockResolvedValue({ ok: false, reason: 'wrong_state' })
    const res = await approve.POST(req({ preset: 'household' }), params())
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('GUEST_WRONG_STATE')
  })

  it('ignore removes a request', async () => {
    store.getGuest.mockResolvedValue(guest({ state: 'requested' }))
    store.removeGuest.mockResolvedValue({ ok: true, guest: guest({ state: 'removed' }) })
    expect((await ignore.POST(req({}), params())).status).toBe(200)
    expect(store.removeGuest).toHaveBeenCalled()
  })

  it('ignore is idempotent', async () => {
    store.getGuest.mockResolvedValue(guest({ state: 'removed' }))
    expect((await ignore.POST(req({}), params())).status).toBe(200)
    expect(store.removeGuest).not.toHaveBeenCalled()
  })

  it('ignore never removes an active guest', async () => {
    store.getGuest.mockResolvedValue(guest({ state: 'active' }))
    expect((await ignore.POST(req({}), params())).status).toBe(409)
    expect(store.removeGuest).not.toHaveBeenCalled()
  })
})

describe('invite and request code', () => {
  it('a new invite link answers the new code', async () => {
    store.renewInvite.mockResolvedValue({ ok: true, guest: guest({ state: 'invited' }), inviteCode: 'ZZ99XX' })
    const body = await (await invite.POST(req({}), params())).json()
    expect(body.invite.code).toBe('ZZ99XX')
  })

  it('Let people ask turns the code on', async () => {
    store.setRequestsOpen.mockResolvedValue({ code: 'K7Q4MX', open: true })
    const res = await code.PATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify({ open: true }) }))
    expect(await res.json()).toEqual({ code: 'K7Q4MX', open: true })
    expect(store.setRequestsOpen).toHaveBeenCalledWith({ service: true }, 'owner-1', 'ws-1', true)
  })

  it('needs open as a boolean', async () => {
    expect((await code.PATCH(new Request('http://x', { method: 'PATCH', body: JSON.stringify({ open: 'yes' }) }))).status).toBe(400)
  })
})
