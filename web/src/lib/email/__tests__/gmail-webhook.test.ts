import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock dependencies before importing the route
const mockInngestSend = vi.fn()
vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: (...args: unknown[]) => mockInngestSend(...args) },
}))

const mockSupabaseFrom = vi.fn()
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({
    from: (table: string) => mockSupabaseFrom(table),
  }),
}))

// Import after mocks
const { POST } = await import('@/app/api/webhooks/gmail/route')

beforeEach(() => {
  mockInngestSend.mockReset()
  mockSupabaseFrom.mockReset()
  // Ensure webhook token verification is skipped in tests
  delete process.env.GMAIL_WEBHOOK_TOKEN
})

function buildPubSubRequest(emailAddress: string, historyId: number): Request {
  const payload = Buffer.from(JSON.stringify({ emailAddress, historyId })).toString('base64')
  return new Request('https://www.nativeintelligence.dev/api/webhooks/gmail', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { data: payload } }),
  })
}

function mockAccountLookup(account: { id: string; user_id: string; workspace_id: string } | null) {
  mockSupabaseFrom.mockReturnValue({
    select: () => ({
      eq: () => ({
        eq: () => ({
          eq: () => ({
            limit: () => ({
              maybeSingle: async () => ({ data: account, error: null }),
            }),
          }),
        }),
      }),
    }),
  })
}

describe('Gmail Webhook POST', () => {
  it('always returns 200 (even on error)', async () => {
    // Invalid JSON body
    const req = new Request('https://www.nativeintelligence.dev/api/webhooks/gmail', {
      method: 'POST',
      body: 'not json',
    })
    const res = await POST(req)
    expect(res.status).toBe(200)
  })

  it('decodes base64 Pub/Sub payload and looks up account by email', async () => {
    mockAccountLookup({
      id: 'acc-123',
      user_id: 'user-456',
      workspace_id: 'ws-789',
    })
    mockInngestSend.mockResolvedValue(undefined)

    const req = buildPubSubRequest('test@gmail.com', 12345)
    const res = await POST(req)

    expect(res.status).toBe(200)
    expect(mockSupabaseFrom).toHaveBeenCalledWith('connected_account')
  })

  it('sends Inngest event with correct data when account found', async () => {
    mockAccountLookup({
      id: 'acc-123',
      user_id: 'user-456',
      workspace_id: 'ws-789',
    })
    mockInngestSend.mockResolvedValue(undefined)

    const req = buildPubSubRequest('test@gmail.com', 99999)
    await POST(req)

    expect(mockInngestSend).toHaveBeenCalledWith({
      name: 'email/webhook-received',
      data: {
        accountId: 'acc-123',
        userId: 'user-456',
        workspaceId: 'ws-789',
        provider: 'google',
        historyId: '99999',
      },
    })
  })

  it('converts historyId to string', async () => {
    mockAccountLookup({
      id: 'acc-1',
      user_id: 'user-1',
      workspace_id: 'ws-1',
    })
    mockInngestSend.mockResolvedValue(undefined)

    const req = buildPubSubRequest('test@gmail.com', 11780920)
    await POST(req)

    const sentData = mockInngestSend.mock.calls[0][0].data
    expect(typeof sentData.historyId).toBe('string')
    expect(sentData.historyId).toBe('11780920')
  })

  it('returns 200 even when no account or token is found', async () => {
    // Account lookup returns null
    mockAccountLookup(null)
    // Legacy token lookup also returns null
    mockSupabaseFrom.mockReturnValue({
      select: () => ({
        eq: () => ({
          eq: () => ({
            eq: () => ({
              limit: () => ({
                maybeSingle: async () => ({ data: null, error: null }),
              }),
            }),
          }),
        }),
      }),
    })

    const req = buildPubSubRequest('unknown@example.com', 12345)
    const res = await POST(req)
    expect(res.status).toBe(200)
    expect(mockInngestSend).not.toHaveBeenCalled()
  })

  // Fail-closed guard: in a production-like env (VERCEL_ENV injected), an
  // UNSET secret must reject instead of falling open. setup.ts scrubs
  // VERCEL_ENV from the build env, so these set it explicitly.
  it('rejects when the secret is unset in a production-like env', async () => {
    process.env.VERCEL_ENV = 'production'
    try {
      const res = await POST(buildPubSubRequest('test@gmail.com', 12345))
      expect(res.status).toBe(401)
      expect(mockInngestSend).not.toHaveBeenCalled()
    } finally {
      delete process.env.VERCEL_ENV
    }
  })

  it('accepts in a production-like env when the token matches', async () => {
    process.env.VERCEL_ENV = 'production'
    process.env.GMAIL_WEBHOOK_TOKEN = 'sekret'
    try {
      mockAccountLookup(null)
      const req = new Request('https://www.nativeintelligence.dev/api/webhooks/gmail?token=sekret', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            data: Buffer.from(
              JSON.stringify({ emailAddress: 'test@gmail.com', historyId: 12345 }),
            ).toString('base64'),
          },
        }),
      })
      const res = await POST(req)
      expect(res.status).toBe(200)
    } finally {
      delete process.env.VERCEL_ENV
      delete process.env.GMAIL_WEBHOOK_TOKEN
    }
  })
})
