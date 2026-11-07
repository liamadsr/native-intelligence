/**
 * startMcpOAuth: the desktop window asks for a desktop flow and holds its
 * claim secret (the deep link's code is claimable only with it); the web asks
 * for a web flow, whose binding is the start route's cookie (security review
 * 2026-10-31, src/lib/mcp-client/oauth-binding.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ desktop: false, hold: vi.fn() }))
vi.mock('@/lib/platform', () => ({ isDesktopApp: () => h.desktop }))
vi.mock('../desktop-oauth-claims', () => ({ holdDesktopMcpClaim: h.hold }))

const { startMcpOAuth } = await import('../start-mcp-oauth')
const SERVER = { display_name: 'Linear', server_url: 'https://mcp.linear.app/mcp', transport: 'streamable_http' as const }

function answer(body: Record<string, unknown>, status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  h.desktop = false
  h.hold.mockReset()
  vi.unstubAllGlobals()
})

describe('startMcpOAuth', () => {
  it('web: asks for a web flow and holds nothing', async () => {
    const fetchMock = answer({ authorize_url: 'https://auth/x' })
    expect(await startMcpOAuth(SERVER)).toBe('https://auth/x')
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toMatchObject({ source: 'web' })
    expect(h.hold).not.toHaveBeenCalled()
  })

  it('desktop: asks for a desktop flow and holds its state and claim secret', async () => {
    h.desktop = true
    const fetchMock = answer({ authorize_url: 'https://auth/x', state: 'desk.s', claim_secret: 'secret' })
    expect(await startMcpOAuth(SERVER)).toBe('https://auth/x')
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toMatchObject({ source: 'desktop' })
    expect(h.hold).toHaveBeenCalledWith('desk.s', 'secret')
  })

  it('desktop: an answer without the claim secret never opens a flow it could not finish', async () => {
    h.desktop = true
    answer({ authorize_url: 'https://auth/x' })
    await expect(startMcpOAuth(SERVER)).rejects.toThrow()
    expect(h.hold).not.toHaveBeenCalled()
  })
})
