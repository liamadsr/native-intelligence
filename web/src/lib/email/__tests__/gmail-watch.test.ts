import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock dependencies at top level
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({
    from: () => ({
      update: () => ({ match: () => Promise.resolve({ error: null }) }),
    }),
  }),
}))

vi.mock('@/lib/oauth/token-manager', () => ({
  getValidToken: vi.fn(),
  getValidTokenForAccount: vi.fn(),
}))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

import { setupGmailWatch } from '../gmail-watch'

beforeEach(() => {
  mockFetch.mockReset()
})

describe('setupGmailWatch', () => {
  it('calls Gmail watch API with correct topic and labels', async () => {
    vi.stubEnv('GMAIL_PUBSUB_TOPIC', 'projects/test-project/topics/gmail-notifications')

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ historyId: '12345', expiration: '1711612800000' }),
    })

    await setupGmailWatch('fake-token', 'user-1', 'account-1')

    const [url, options] = mockFetch.mock.calls[0]
    expect(url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/watch')
    expect(options.method).toBe('POST')

    const body = JSON.parse(options.body)
    expect(body.topicName).toBe('projects/test-project/topics/gmail-notifications')
    expect(body.labelIds).toEqual(['INBOX', 'SENT'])
    expect(body.labelFilterBehavior).toBe('INCLUDE')

    vi.unstubAllEnvs()
  })

  it('throws when GMAIL_PUBSUB_TOPIC is not set', async () => {
    vi.stubEnv('GMAIL_PUBSUB_TOPIC', '')

    await expect(setupGmailWatch('fake-token', 'user-1')).rejects.toThrow(
      'GMAIL_PUBSUB_TOPIC environment variable not set',
    )

    vi.unstubAllEnvs()
  })

  it('throws on non-OK response from Gmail API', async () => {
    vi.stubEnv('GMAIL_PUBSUB_TOPIC', 'projects/test/topics/test')

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => 'Forbidden',
    })

    await expect(setupGmailWatch('fake-token', 'user-1')).rejects.toThrow(
      'Gmail watch setup failed: 403',
    )

    vi.unstubAllEnvs()
  })
})
