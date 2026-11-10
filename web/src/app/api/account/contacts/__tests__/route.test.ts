/**
 * Tests for GET + POST /api/account/contacts.
 *
 * GET: covers the search parameter that filters contacts by full_name or email.
 * POST: covers the HubSpot contact-push emit — a fire-and-forget
 * crm/hubspot-push-contact event that must fire ONLY for a manual creation that
 * carries an email (never for a no-email creation).
 *
 * Uses the same integration-test pattern as api/early-access/__tests__/route.test.ts
 * and api/account/actions/__tests__/route.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest } from '@/test/integration'

const hoisted = vi.hoisted(() => ({
  getUser: vi.fn(),
  getCurrentWorkspaceId: vi.fn(),
  contactSelect: vi.fn(),
  orSpy: vi.fn(),
  eqSpy: vi.fn(),
  orderSpy: vi.fn(),
  rangeSpy: vi.fn(),
  // POST path
  insertedRow: { id: 'contact-1', source: 'manual', email: 'ada@example.com', full_name: 'Ada' } as Record<string, unknown>,
  inngestSend: vi.fn(),
  trackServerEvent: vi.fn(),
}))

// Build a chainable Supabase query mock that records method calls.
// Uses the same self-returning proxy pattern as the actions test, with
// spy hooks for the methods we want to assert on.
function makeContactQuery() {
  const result = { data: [], error: null, count: 0 }
  const proxy: Record<string, unknown> = {
    then: (cb: (v: unknown) => unknown) => Promise.resolve(result).then(cb),
  }
  const handler = new Proxy(proxy, {
    get(target, prop: string) {
      // Pass through thenable so `await query` resolves correctly
      if (prop === 'then') return target.then
      // Track spy calls, then return the same proxy for chaining
      return (...args: unknown[]) => {
        if (prop === 'or') hoisted.orSpy(...args)
        if (prop === 'eq') hoisted.eqSpy(...args)
        if (prop === 'order') hoisted.orderSpy(...args)
        if (prop === 'range') hoisted.rangeSpy(...args)
        return handler
      }
    },
  })
  return handler
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: hoisted.getUser },
    from: (table: string) => {
      if (table === 'contact') {
        return {
          select: hoisted.contactSelect,
          // POST insert path: .insert(...).select(...).single()
          insert: () => ({
            select: () => ({
              single: () =>
                Promise.resolve({ data: hoisted.insertedRow, error: null }),
            }),
          }),
        }
      }
      // member lookup (POST ownership + 'mine' filter)
      return { select: () => ({ eq: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { id: 'member-1' }, error: null }) }) }) }) }
    },
  }),
}))

vi.mock('@/lib/workspace', () => ({
  getCurrentWorkspaceId: hoisted.getCurrentWorkspaceId,
}))

vi.mock('@/lib/posthog', () => ({
  trackServerEvent: hoisted.trackServerEvent,
}))

vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: hoisted.inngestSend },
}))

const { GET, POST } = await import('@/app/api/account/contacts/route')

function getReq(params: Record<string, string> = {}): NextRequest {
  const url = new URL('https://nativeintelligence.dev/api/account/contacts')
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  const req = buildRequest({ url: url.toString(), method: 'GET' })
  // Augment with nextUrl (Next.js-specific property used by the route handler)
  return Object.assign(req, { nextUrl: url }) as unknown as NextRequest
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
  hoisted.getCurrentWorkspaceId.mockResolvedValue('workspace-1')
  hoisted.inngestSend.mockResolvedValue({ ids: ['e'] })
  hoisted.insertedRow = {
    id: 'contact-1',
    source: 'manual',
    email: 'ada@example.com',
    full_name: 'Ada',
  }

  const query = makeContactQuery()
  hoisted.contactSelect.mockReturnValue(query)
})

function postReq(body: Record<string, unknown>): NextRequest {
  const url = new URL('https://nativeintelligence.dev/api/account/contacts')
  // buildRequest JSON.stringifies the body by default; pass the raw object.
  const req = buildRequest({ url: url.toString(), method: 'POST', body })
  return Object.assign(req, { nextUrl: url }) as unknown as NextRequest
}

describe('GET /api/account/contacts', () => {
  it('returns 401 when unauthenticated', async () => {
    hoisted.getUser.mockResolvedValueOnce({ data: { user: null } })
    const res = await GET(getReq())
    expect(res.status).toBe(401)
  })

  it('returns 400 when workspace is missing', async () => {
    hoisted.getCurrentWorkspaceId.mockResolvedValueOnce(null)
    const res = await GET(getReq())
    expect(res.status).toBe(400)
  })

  it('applies OR filter when search param is present', async () => {
    const res = await GET(getReq({ search: 'alice' }))
    expect(res.status).toBe(200)
    expect(hoisted.orSpy).toHaveBeenCalledWith(
      expect.stringContaining('full_name.ilike.%alice%'),
    )
    expect(hoisted.orSpy).toHaveBeenCalledWith(
      expect.stringContaining('email.ilike.%alice%'),
    )
  })

  it('strips PostgREST filter-syntax characters from search before the OR filter', async () => {
    // A typed comma/paren/quote would otherwise break the `.or()` expression (500).
    const res = await GET(getReq({ search: 'Chen, Maya ("m")' }))
    expect(res.status).toBe(200)
    expect(hoisted.orSpy).toHaveBeenCalledWith('full_name.ilike.%Chen Maya m%,email.ilike.%Chen Maya m%')
  })

  it('skips the OR filter when search is only filter-syntax characters', async () => {
    const res = await GET(getReq({ search: ',()' }))
    expect(res.status).toBe(200)
    expect(hoisted.orSpy).not.toHaveBeenCalled()
  })

  it('does not apply OR filter when search param is absent', async () => {
    const res = await GET(getReq())
    expect(res.status).toBe(200)
    expect(hoisted.orSpy).not.toHaveBeenCalled()
  })

  it('returns contacts array in response body', async () => {
    const res = await GET(getReq())
    expect(res.status).toBe(200)
    const body = await res.json() as { contacts: unknown[]; total: number }
    expect(Array.isArray(body.contacts)).toBe(true)
    expect(typeof body.total).toBe('number')
  })
})

describe('POST /api/account/contacts — HubSpot push emit', () => {
  it('emits crm/hubspot-push-contact for a manual creation with an email', async () => {
    hoisted.insertedRow = {
      id: 'contact-1',
      source: 'manual',
      email: 'ada@example.com',
      full_name: 'Ada',
    }
    const res = await POST(postReq({ full_name: 'Ada', email: 'ada@example.com' }))
    expect(res.status).toBe(200)
    expect(hoisted.inngestSend).toHaveBeenCalledOnce()
    expect(hoisted.inngestSend).toHaveBeenCalledWith({
      name: 'crm/hubspot-push-contact',
      data: { contactId: 'contact-1', workspaceId: 'workspace-1' },
    })
  })

  it('does NOT emit when the created contact has no email', async () => {
    hoisted.insertedRow = {
      id: 'contact-2',
      source: 'manual',
      email: null,
      full_name: 'No Email',
    }
    const res = await POST(postReq({ full_name: 'No Email' }))
    expect(res.status).toBe(200)
    expect(hoisted.inngestSend).not.toHaveBeenCalled()
  })

  it('does NOT fail the request when the emit send rejects (fire-and-forget)', async () => {
    hoisted.inngestSend.mockRejectedValueOnce(new Error('inngest down'))
    const res = await POST(postReq({ full_name: 'Ada', email: 'ada@example.com' }))
    // The .catch() swallows the failure — creation still succeeds.
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.contact.id).toBe('contact-1')
  })
})
