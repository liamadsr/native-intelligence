/**
 * POST /api/account/evals/suites/[id]/cases/from-capture — the route's own job:
 * auth and the feature gate, the suite fence on the caller's client, a strict
 * body, and mapping the lib's fence (`not_found`) to a 404 that says nothing
 * about whether the capture exists.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildRequest } from '@/test/integration'

const hoisted = vi.hoisted(() => ({
  requireWorkspace: vi.fn(),
  requireWorkspaceFeature: vi.fn(),
  getServiceClient: vi.fn(),
  getSuite: vi.fn(),
  createEvalCaseFromCapture: vi.fn(),
}))

vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: hoisted.requireWorkspace,
  requireWorkspaceFeature: hoisted.requireWorkspaceFeature,
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: hoisted.getServiceClient }))
vi.mock('@/lib/evals/queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/evals/queries')>()),
  getSuite: hoisted.getSuite,
}))
vi.mock('@/lib/evals/case-from-capture', () => ({
  createEvalCaseFromCapture: hoisted.createEvalCaseFromCapture,
}))

const route = await import('@/app/api/account/evals/suites/[id]/cases/from-capture/route')

const WS = 'ws-1'
const USER = { id: 'user-1' }
const CAPTURE = '11111111-1111-4111-8111-111111111111'
const supabase = { tag: 'user-client' }
const service = { tag: 'service-client' }
const params = (id: string) => ({ params: Promise.resolve({ id }) })

function post(body: unknown) {
  const url = 'https://nativeintelligence.dev/api/account/evals/suites/suite-1/cases/from-capture'
  const req = buildRequest({ url, method: 'POST', body })
  Object.defineProperty(req, 'nextUrl', { value: new URL(url) })
  return req as never
}

beforeEach(() => {
  for (const fn of Object.values(hoisted)) fn.mockReset()
  hoisted.requireWorkspace.mockResolvedValue({ supabase, user: USER, workspaceId: WS })
  hoisted.requireWorkspaceFeature.mockResolvedValue(null)
  hoisted.getServiceClient.mockReturnValue(service)
  hoisted.getSuite.mockResolvedValue({ id: 'suite-1', workspace_id: WS })
  hoisted.createEvalCaseFromCapture.mockResolvedValue({ ok: true, caseRow: { id: 'case-1' } })
})

describe('POST /suites/[id]/cases/from-capture', () => {
  it('seeds the case as the caller, in the workspace the suite read resolved', async () => {
    const res = await route.POST(post({ capture_id: CAPTURE, name: 'Acme replay' }), params('suite-1'))
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ case: { id: 'case-1' } })
    expect(hoisted.getSuite).toHaveBeenCalledWith(supabase, WS, 'suite-1')
    expect(hoisted.createEvalCaseFromCapture).toHaveBeenCalledWith(service, {
      workspaceId: WS,
      userId: USER.id,
      suiteId: 'suite-1',
      captureId: CAPTURE,
      name: 'Acme replay',
    })
  })

  it('is a 404 for a capture the caller cannot see, the same as a missing one', async () => {
    hoisted.createEvalCaseFromCapture.mockResolvedValue({ ok: false, reason: 'not_found' })
    const res = await route.POST(post({ capture_id: CAPTURE }), params('suite-1'))
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('Capture not found')
  })

  it('is a 400 for a capture with no transcript', async () => {
    hoisted.createEvalCaseFromCapture.mockResolvedValue({ ok: false, reason: 'empty_transcript' })
    expect((await route.POST(post({ capture_id: CAPTURE }), params('suite-1'))).status).toBe(400)
  })

  it("is a 404 for a suite outside the caller's workspace, before any service write", async () => {
    hoisted.getSuite.mockResolvedValue(null)
    const res = await route.POST(post({ capture_id: CAPTURE }), params('suite-x'))
    expect(res.status).toBe(404)
    expect(hoisted.createEvalCaseFromCapture).not.toHaveBeenCalled()
  })

  it('refuses a body that is not exactly { capture_id, name? }', async () => {
    for (const body of [{}, { capture_id: 'not-a-uuid' }, { capture_id: CAPTURE, expected: {} }]) {
      expect((await route.POST(post(body), params('suite-1'))).status).toBe(400)
    }
    expect(hoisted.createEvalCaseFromCapture).not.toHaveBeenCalled()
  })

  it('propagates auth and the feature gate untouched', async () => {
    hoisted.requireWorkspace.mockResolvedValueOnce(new Response('nope', { status: 401 }))
    expect((await route.POST(post({ capture_id: CAPTURE }), params('suite-1'))).status).toBe(401)
    hoisted.requireWorkspaceFeature.mockResolvedValueOnce(new Response('gated', { status: 403 }))
    expect((await route.POST(post({ capture_id: CAPTURE }), params('suite-1'))).status).toBe(403)
    expect(hoisted.createEvalCaseFromCapture).not.toHaveBeenCalled()
  })

  it('maps a throw to a 500 with no upstream text', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    hoisted.createEvalCaseFromCapture.mockRejectedValue(new Error('pg: secret detail'))
    const res = await route.POST(post({ capture_id: CAPTURE }), params('suite-1'))
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('secret detail')
    errors.mockRestore()
  })
})
