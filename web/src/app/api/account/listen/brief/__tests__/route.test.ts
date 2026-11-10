import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * POST /api/account/listen/brief — what listen mode says about the item just
 * opened, as sentences, with no model call.
 *
 *  - Auth's Response is returned as is; a bad body is a 400; an item with
 *    nothing to say (missing, not the user's to see) is a 404.
 *  - The brief is built as the user (their RLS client, member and sign-in
 *    address), in their time zone (unknown → UTC), with any `input`.
 *  - It never touches the AI: no utility agent, no usage limit, no billing.
 */

const hoisted = vi.hoisted(() => ({
  requireWorkspaceMember: vi.fn(),
  buildBrief: vi.fn(),
}))

vi.mock('@/lib/api-auth', () => ({ requireWorkspaceMember: hoisted.requireWorkspaceMember }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ service: true }) }))
vi.mock('@/lib/listen-briefs/build', () => ({ buildBrief: hoisted.buildBrief }))

const { POST } = await import('@/app/api/account/listen/brief/route')

function request(body: unknown) {
  return new Request('https://nativeintelligence.dev/api/account/listen/brief', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  hoisted.requireWorkspaceMember.mockReset()
  hoisted.requireWorkspaceMember.mockResolvedValue({
    supabase: { rls: true },
    user: { id: 'user-1', email: 'liam@dial8.ai' },
    workspaceId: 'ws-1',
    member: { id: 'member-1' },
  })
  hoisted.buildBrief.mockReset()
  hoisted.buildBrief.mockResolvedValue(['Pricing sync, on Tuesday, with Jessa Lin.', 'We agreed to hold the price.'])
})

describe('POST /api/account/listen/brief', () => {
  it('returns auth’s Response as is', async () => {
    hoisted.requireWorkspaceMember.mockResolvedValue(new Response(null, { status: 401 }))
    expect((await POST(request({ kind: 'capture', id: 'c1' }))).status).toBe(401)
  })

  it('a bad body is a 400; nothing to say is a 404', async () => {
    expect((await POST(request({ kind: 'spaceship', id: 'c1' }))).status).toBe(400)
    expect((await POST(request({ kind: 'capture' }))).status).toBe(400)
    hoisted.buildBrief.mockResolvedValue(null)
    expect((await POST(request({ kind: 'capture', id: 'c1' }))).status).toBe(404)
  })

  it('builds the brief as the user, in their time zone, and returns its sentences', async () => {
    const res = await POST(request({ kind: 'capture', id: 'c1', timeZone: 'America/Los_Angeles', input: { x: 1 } }))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({
      sentences: ['Pricing sync, on Tuesday, with Jessa Lin.', 'We agreed to hold the price.'],
    })

    const [kind, id, ctx, input] = hoisted.buildBrief.mock.calls[0]
    expect([kind, id, input]).toEqual(['capture', 'c1', { x: 1 }])
    expect(ctx).toMatchObject({
      supabase: { rls: true },
      service: { service: true },
      workspaceId: 'ws-1',
      userId: 'user-1',
      memberId: 'member-1',
      userEmail: 'liam@dial8.ai',
      clock: { timeZone: 'America/Los_Angeles' },
    })
  })

  it('an unknown time zone reads as UTC', async () => {
    await POST(request({ kind: 'contact', id: 'c1', timeZone: 'Mars/Olympus' }))
    expect(hoisted.buildBrief.mock.calls[0][2].clock.timeZone).toBe('UTC')
  })
})
