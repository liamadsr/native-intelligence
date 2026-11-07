/**
 * GET /api/internal/live-agent/spec — the two gates, the 404 path, and the
 * `?schemas=1` switch. The rebuild itself is pinned against the real cloud
 * route in src/lib/live-agent/__tests__/live-agent-spec-parity.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  LIVE_AGENT_SECRET_HEADER,
  LIVE_AGENT_TOKEN_HEADER,
  mintLiveAgentRunToken,
} from '@/lib/live-agent/live-agent-run-token'

const h = vi.hoisted(() => ({
  rebuild: vi.fn(),
}))

vi.mock('@/lib/live-agent/live-agent-spec', () => ({
  rebuildLiveAgentSpec: (...args: unknown[]) => h.rebuild(...args),
}))

const { GET } = await import('../route')

const SECRET = 'live-internal-secret'
const CLAIMS = {
  captureId: 'cap-1',
  workspaceId: 'ws-1',
  userId: 'user-1',
  currentMemberId: null,
  turnType: 'copilot' as const,
  model: 'deepseek-v4-flash',
  isEvalCapture: false,
  allowAutoArchive: false,
}

function req(opts: { secret?: string | null; token?: string | null; query?: string } = {}) {
  const headers: Record<string, string> = {}
  const secret = opts.secret === undefined ? SECRET : opts.secret
  if (secret !== null) headers[LIVE_AGENT_SECRET_HEADER] = secret
  const token = opts.token === undefined ? mintLiveAgentRunToken(CLAIMS) : opts.token
  if (token !== null) headers[LIVE_AGENT_TOKEN_HEADER] = token
  return new Request(`https://app.test/api/internal/live-agent/spec${opts.query ?? ''}`, { headers })
}

beforeEach(() => {
  process.env.LIVE_AGENT_INTERNAL_SECRET = SECRET
  h.rebuild.mockReset()
  h.rebuild.mockResolvedValue({ systemPrompt: 'P', model: 'm/x', ceiling: [], ceilingTools: [], coreToolNames: [] })
})

describe('GET /api/internal/live-agent/spec', () => {
  it('401 without the internal secret, and never rebuilds', async () => {
    expect((await GET(req({ secret: null }))).status).toBe(401)
    expect((await GET(req({ secret: 'nope' }))).status).toBe(401)
    expect(h.rebuild).not.toHaveBeenCalled()
  })

  it('401 on a missing / forged token, and never rebuilds', async () => {
    expect((await GET(req({ token: null }))).status).toBe(401)
    expect((await GET(req({ token: 'e30.forged' }))).status).toBe(401)
    expect(h.rebuild).not.toHaveBeenCalled()
  })

  it('rebuilds from the VERIFIED claims only, without schemas by default', async () => {
    const res = await GET(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ systemPrompt: 'P' })
    const [claims, opts] = h.rebuild.mock.calls[0]
    expect(claims).toMatchObject(CLAIMS)
    expect(opts).toEqual({ schemas: false })
  })

  it('?schemas=1 asks the rebuild for real input schemas', async () => {
    await GET(req({ query: '?schemas=1' }))
    expect(h.rebuild.mock.calls[0][1]).toEqual({ schemas: true })
  })

  it('404 TURN_NOT_FOUND when the turn can’t be rebuilt', async () => {
    h.rebuild.mockResolvedValue(null)
    const res = await GET(req())
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ code: 'TURN_NOT_FOUND' })
  })
})
