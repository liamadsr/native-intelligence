import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({
    from: () => ({ update: () => ({ match: () => Promise.resolve({ error: null }) }) }),
  }),
}))
vi.mock('@/lib/oauth/token-manager', () => ({ getValidToken: vi.fn(), getValidTokenForAccount: vi.fn() }))

const mockFetch = vi.fn()

import { setupOutlookSubscription } from '../outlook-webhook'

beforeEach(() => {
  mockFetch.mockReset()
  vi.stubGlobal('fetch', mockFetch)
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://dial8.ai')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('setupOutlookSubscription', () => {
  it('signs the clientState with the webhook secret (the only form the webhook takes)', async () => {
    vi.stubEnv('OUTLOOK_WEBHOOK_SECRET', 'outlook-secret')
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'sub-1', expirationDateTime: '2026-11-03T00:00:00Z' }) })
    await setupOutlookSubscription('access', 'user-1', 'acc-1')
    const body = JSON.parse(String(mockFetch.mock.calls[0][1].body))
    expect(body.clientState).toBe('outlook-secret:acc-1')
    expect(body.notificationUrl).toBe('https://dial8.ai/api/webhooks/outlook')
  })

  it('makes no subscription without the secret: the webhook would drop every notification', async () => {
    vi.stubEnv('OUTLOOK_WEBHOOK_SECRET', '')
    await expect(setupOutlookSubscription('access', 'user-1', 'acc-1')).rejects.toThrow(/OUTLOOK_WEBHOOK_SECRET/)
    expect(mockFetch).not.toHaveBeenCalled()
  })
})
