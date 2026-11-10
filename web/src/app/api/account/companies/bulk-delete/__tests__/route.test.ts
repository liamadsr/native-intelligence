/**
 * Tests for POST /api/account/companies/bulk-delete — the cascade delete
 * endpoint (companies + their contacts).
 *
 * Locked in: auth passthrough, the owner/admin role gate (the cascade runs on
 * the service client, so plain members must be refused here), body validation
 * (400s), dry_run passthrough to the helper, and the { companies, contacts }
 * result shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'

const hoisted = vi.hoisted(() => ({
  requireWorkspaceMember: vi.fn(),
  deleteCompaniesWithContacts: vi.fn(),
  serviceClient: { __service: true },
}))

vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceMember: hoisted.requireWorkspaceMember,
}))

vi.mock('@/lib/admin', () => ({
  getServiceClient: () => hoisted.serviceClient,
}))

vi.mock('@/lib/crm/delete-companies', () => ({
  deleteCompaniesWithContacts: hoisted.deleteCompaniesWithContacts,
}))

const { POST } = await import('@/app/api/account/companies/bulk-delete/route')

function postReq(body?: unknown): NextRequest {
  return buildRequest({
    url: 'https://nativeintelligence.dev/api/account/companies/bulk-delete',
    method: 'POST',
    body,
  }) as unknown as NextRequest
}

beforeEach(() => {
  hoisted.requireWorkspaceMember.mockReset()
  hoisted.deleteCompaniesWithContacts.mockReset()
  hoisted.requireWorkspaceMember.mockResolvedValue({
    supabase: {},
    user: { id: 'user-1' },
    workspaceId: 'ws-1',
    member: { id: 'member-1', role: 'owner' },
  })
  hoisted.deleteCompaniesWithContacts.mockResolvedValue({ companies: 1, contacts: 3 })
})

describe('POST /api/account/companies/bulk-delete', () => {
  it('passes through the auth failure Response', async () => {
    const denied = new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
    hoisted.requireWorkspaceMember.mockResolvedValue(denied)

    const res = await POST(postReq({ ids: ['co-1'] }))
    expect(res.status).toBe(401)
    expect(hoisted.deleteCompaniesWithContacts).not.toHaveBeenCalled()
  })

  it('refuses plain members with 403 — even for dry runs', async () => {
    hoisted.requireWorkspaceMember.mockResolvedValue({
      supabase: {},
      user: { id: 'user-2' },
      workspaceId: 'ws-1',
      member: { id: 'member-2', role: 'member' },
    })

    const res = await POST(postReq({ ids: ['co-1'], dry_run: true }))
    expect(res.status).toBe(403)
    // No helper call means no dry-run count leak of contacts they cannot see.
    expect(hoisted.deleteCompaniesWithContacts).not.toHaveBeenCalled()
  })

  it('requests the member role from the auth helper', async () => {
    // The helper's select defaults to just 'id' — without naming 'role' here
    // member.role is undefined and the gate would 403 owners too. The mock
    // hides that at runtime, so pin the call shape instead.
    await POST(postReq({ ids: ['co-1'], dry_run: true }))
    expect(hoisted.requireWorkspaceMember).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.stringContaining('role') }),
    )
  })

  it('allows admins', async () => {
    hoisted.requireWorkspaceMember.mockResolvedValue({
      supabase: {},
      user: { id: 'user-3' },
      workspaceId: 'ws-1',
      member: { id: 'member-3', role: 'admin' },
    })

    const res = await POST(postReq({ ids: ['co-1'] }))
    expect(res.status).toBe(200)
  })

  it('treats a truthy non-boolean dry_run as a dry run, never a delete', async () => {
    const res = await POST(postReq({ ids: ['co-1'], dry_run: 'true' }))
    expect(res.status).toBe(200)
    expect(hoisted.deleteCompaniesWithContacts).toHaveBeenCalledWith(
      hoisted.serviceClient,
      'ws-1',
      ['co-1'],
      { dryRun: true },
    )
  })

  it.each([
    ['missing ids', {}],
    ['empty ids', { ids: [] }],
    ['non-array ids', { ids: 'co-1' }],
    ['non-string entries', { ids: ['co-1', 42] }],
  ])('rejects %s with 400', async (_label, body) => {
    const res = await POST(postReq(body))
    expect(res.status).toBe(400)
    expect(hoisted.deleteCompaniesWithContacts).not.toHaveBeenCalled()
  })

  it('rejects more than 100 ids with 400', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `co-${i}`)
    const res = await POST(postReq({ ids }))
    expect(res.status).toBe(400)
    expect(hoisted.deleteCompaniesWithContacts).not.toHaveBeenCalled()
  })

  it('rejects invalid JSON with 400', async () => {
    const req = buildRequest({
      url: 'https://nativeintelligence.dev/api/account/companies/bulk-delete',
      method: 'POST',
      body: 'not json',
      raw: true,
    }) as unknown as NextRequest
    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it('passes dry_run through to the helper', async () => {
    hoisted.deleteCompaniesWithContacts.mockResolvedValue({ companies: 2, contacts: 5 })

    const res = await POST(postReq({ ids: ['co-1', 'co-2'], dry_run: true }))
    expect(res.status).toBe(200)
    expect(await readJson(res)).toEqual({ companies: 2, contacts: 5 })
    expect(hoisted.deleteCompaniesWithContacts).toHaveBeenCalledWith(
      hoisted.serviceClient,
      'ws-1',
      ['co-1', 'co-2'],
      { dryRun: true },
    )
  })

  it('performs the delete and returns counts when dry_run is absent', async () => {
    const res = await POST(postReq({ ids: ['co-1'] }))
    expect(res.status).toBe(200)
    expect(await readJson(res)).toEqual({ companies: 1, contacts: 3 })
    expect(hoisted.deleteCompaniesWithContacts).toHaveBeenCalledWith(
      hoisted.serviceClient,
      'ws-1',
      ['co-1'],
      { dryRun: false },
    )
  })

  it('returns 500 when the cascade throws', async () => {
    hoisted.deleteCompaniesWithContacts.mockRejectedValue(new Error('boom'))
    const res = await POST(postReq({ ids: ['co-1'] }))
    expect(res.status).toBe(500)
    const body = await readJson(res) as { error: string }
    expect(body.error).toBeTruthy()
  })
})
