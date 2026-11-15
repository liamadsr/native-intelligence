/**
 * Tests for GET + POST /api/account/contacts.
 *
 * GET: covers the search parameter that filters contacts by full_name or email.
 * POST: covers the HubSpot contact-push emit — a fire-and-forget
 * crm/hubspot-push-contact event that must fire ONLY for a manual creation that
 * carries an email (never for a no-email creation) — and the contact_created
 * loops' event, sent for every contact a person creates here, never failing it.
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
  notifyContactCreated: vi.fn(),
  memberRow: { id: 'member-1' } as { id: string } | null,
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
      return { select: () => ({ eq: () => ({ eq: () => ({ single: () => Promise.resolve({ data: hoisted.memberRow, error: null }) }) }) }) }
    },
  }),
}))

vi.mock('@/lib/workspace', () => ({
  getCurrentWorkspaceId: hoisted.getCurrentWorkspaceId,
}))

// The route's auth goes through the shared helpers (web/CLAUDE.md): here they
// read the same mocked session and current workspace, and answer the same
// errors the real ones do (401 signed out, 400 no workspace).
vi.mock('@/lib/api-auth', async () => {
  const { createClient } = await import('@/lib/supabase/server')
  const { noWorkspace, unauthorized } = await import('@/lib/api-errors')
  const requireUser = async () => {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    return user ? { supabase, user } : unauthorized()
  }
  const requireWorkspace = async () => {
    const auth = await requireUser()
    if (auth instanceof Response) return auth
    const workspaceId = await hoisted.getCurrentWorkspaceId()
    return workspaceId ? { ...auth, workspaceId } : noWorkspace()
  }
  const requireWorkspaceMember = async () => {
    const auth = await requireWorkspace()
    if (auth instanceof Response) return auth
    return { ...auth, member: { id: 'member-1' } }
  }
  return { requireUser, requireWorkspace, requireWorkspaceMember }
})

vi.mock('@/lib/posthog', () => ({
  trackServerEvent: hoisted.trackServerEvent,
}))

vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: hoisted.inngestSend },
}))

vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ service: true }) }))

vi.mock('@/lib/flows/emit-contact-created', () => ({
  notifyContactCreated: hoisted.notifyContactCreated,
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
  hoisted.notifyContactCreated.mockResolvedValue(true)
  hoisted.memberRow = { id: 'member-1' }
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

  it('an explicit workspace_id is read only for a member of it: 403 otherwise, and the current workspace is not consulted', async () => {
    const res = await GET(getReq({ workspace_id: 'workspace-2' }))
    expect(res.status).toBe(200)
    expect(hoisted.eqSpy).toHaveBeenCalledWith('workspace_id', 'workspace-2')
    expect(hoisted.getCurrentWorkspaceId).not.toHaveBeenCalled()
    hoisted.memberRow = null
    const refused = await GET(getReq({ workspace_id: 'workspace-3' }))
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({ error: 'Not a member of this workspace' })
    hoisted.getUser.mockResolvedValueOnce({ data: { user: null } })
    expect((await GET(getReq({ workspace_id: 'workspace-2' }))).status).toBe(401)
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

describe('POST /api/account/contacts — the contact_created loops', () => {
  it("sends a person's new contact to its loops (about five minutes later, the emitter's), on the service client", async () => {
    const res = await POST(postReq({ full_name: 'Ada', email: 'ada@example.com' }))
    expect(res.status).toBe(200)
    expect(hoisted.notifyContactCreated).toHaveBeenCalledOnce()
    expect(hoisted.notifyContactCreated).toHaveBeenCalledWith({ service: true }, { workspaceId: 'workspace-1', contactId: 'contact-1', source: 'person' })
  })

  it('sends it for a contact with no email too', async () => {
    hoisted.insertedRow = { id: 'contact-2', source: 'manual', email: null, full_name: 'No Email' }
    await POST(postReq({ full_name: 'No Email' }))
    expect(hoisted.notifyContactCreated).toHaveBeenCalledWith({ service: true }, { workspaceId: 'workspace-1', contactId: 'contact-2', source: 'person' })
  })

  it('never fails the creation when the loop event cannot be sent', async () => {
    hoisted.notifyContactCreated.mockRejectedValueOnce(new Error('inngest down'))
    const res = await POST(postReq({ full_name: 'Ada', email: 'ada@example.com' }))
    expect(res.status).toBe(200)
    expect((await res.json()).contact.id).toBe('contact-1')
  })

  it('answers 401 signed out and 400 with no workspace, creating nothing', async () => {
    hoisted.getUser.mockResolvedValueOnce({ data: { user: null } })
    expect((await POST(postReq({ full_name: 'Ada' }))).status).toBe(401)
    hoisted.getCurrentWorkspaceId.mockResolvedValueOnce(null)
    expect((await POST(postReq({ full_name: 'Ada' }))).status).toBe(400)
    expect(hoisted.notifyContactCreated).not.toHaveBeenCalled()
    expect(hoisted.inngestSend).not.toHaveBeenCalled()
  })

  it('a refused creation sends nothing', async () => {
    const res = await POST(postReq({}))
    expect(res.status).toBe(400)
    expect(hoisted.notifyContactCreated).not.toHaveBeenCalled()
  })
})
