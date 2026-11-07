/**
 * "Take over this flow" (F1): POST runs chat's request_flow_takeover as the
 * caller, strict to the active workspace; GET reports the caller's waiting
 * request.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'

const h = vi.hoisted(() => ({
  args: [] as unknown[][],
  output: {} as Record<string, unknown>,
  pending: false,
}))

vi.mock('@/lib/api-auth', () => ({ requireWorkspaceMember: async () => ({ supabase: {}, user: { id: 'user-2' }, workspaceId: 'ws-1' }) }))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => ({}) }))
vi.mock('@/lib/flows/flow-approvals', () => ({ takeoverPending: async () => h.pending }))
vi.mock('@/lib/ai/tools/flows', () => ({
  createFlowTools: (...args: unknown[]) => {
    h.args.push(args)
    return { request_flow_takeover: { execute: async () => h.output } }
  },
}))

const { GET, POST } = await import('../route')
const params = { params: Promise.resolve({ id: 'flow-1' }) }
const req = () => new Request('http://localhost/api/account/flows/flow-1/takeover', { method: 'POST' }) as unknown as NextRequest

beforeEach(() => {
  h.args.length = 0
  h.pending = false
})

describe('POST /api/account/flows/[id]/takeover', () => {
  it("raises the owner's card as the caller, fenced to the active workspace", async () => {
    h.output = { success: false, code: 'APPROVAL_REQUIRED', requested: true, message: 'Liam has a card' }
    const res = await POST(req(), params)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ requested: true, message: 'Liam has a card' })
    expect(h.args[0].slice(0, 4)).toEqual(['user-2', {}, 'ws-1', true])
  })

  it('a refusal comes back as an error the editor toasts', async () => {
    h.output = { success: false, code: 'NOT_ALLOWED', error: 'Nobody can approve this' }
    const res = await POST(req(), params)
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('Nobody can approve this')
  })
})

describe('GET /api/account/flows/[id]/takeover', () => {
  it("reports the caller's waiting request", async () => {
    h.pending = true
    expect(await (await GET(req(), params)).json()).toEqual({ pending: true })
  })
})
