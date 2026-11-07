// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'

/**
 * The fetch patch is the free half of "new deploy → reload when idle"
 * (lib/deploy-reload.ts): it installs the visibility / focus check and hands
 * every same-origin /api and /eve response to noteResponseBuild. Cross-origin
 * and non-API responses are not read.
 */

const noteResponseBuild = vi.fn()
const installDeployReload = vi.fn()
vi.mock('../deploy-reload', () => ({ noteResponseBuild, installDeployReload }))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { getSession: async () => ({ data: { session: null } }), refreshSession: async () => ({ data: {}, error: null }) } }),
}))
vi.mock('../usage-limit-store', () => ({ openUsageLimit: vi.fn(), parseUsageLimitResponse: vi.fn().mockResolvedValue(null) }))

describe('the fetch patch reports every same-origin API response’s build', () => {
  it('installs the check, and notes /api and /eve responses but nothing else', async () => {
    const underlying = vi.fn(async () => new Response('{}', { status: 200, headers: { 'x-dial8-build': 'dpl_NEW' } }))
    vi.stubGlobal('fetch', underlying)
    ;(window as unknown as { fetch: typeof fetch }).fetch = underlying as unknown as typeof fetch
    await import('../workspace-fetch')
    expect(installDeployReload).toHaveBeenCalledTimes(1)

    const api = await window.fetch('/api/account/chat/eve-session')
    expect(noteResponseBuild).toHaveBeenLastCalledWith(api)
    const eve = await window.fetch('/eve/chat-agent/v1/session')
    expect(noteResponseBuild).toHaveBeenLastCalledWith(eve)
    expect(noteResponseBuild).toHaveBeenCalledTimes(2)

    await window.fetch('https://elsewhere.example/api/x')
    await window.fetch('/_next/static/chunk.js')
    expect(noteResponseBuild).toHaveBeenCalledTimes(2)
  })
})
