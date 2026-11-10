/**
 * The Outlook webhook's clientState check (security review 2026-10-31): only
 * "<OUTLOOK_WEBHOOK_SECRET>:<id>", the form setupOutlookSubscription signs,
 * reaches a sync. A bare id (the old secret-less form), a wrong secret, or no
 * secret configured is dropped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({ send: vi.fn(), from: vi.fn() }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: hoisted.send } }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ from: hoisted.from }) }))

const { POST } = await import('../route')

const SECRET = 'outlook-secret-for-tests'
const ACCOUNT = { id: 'acc-1', user_id: 'user-1', workspace_id: 'ws-1' }

/** connected_account answers ACCOUNT for its id; nothing else matches. */
function stubAccounts() {
  hoisted.from.mockImplementation(() => {
    let id: unknown
    const q: Record<string, unknown> = {}
    q.select = () => q
    q.eq = (col: string, value: unknown) => {
      if (col === 'id') id = value
      return q
    }
    q.maybeSingle = async () => ({ data: id === ACCOUNT.id ? ACCOUNT : null, error: null })
    return q
  })
}

function notify(clientState: string): Request {
  return new Request('https://nativeintelligence.dev/api/webhooks/outlook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: [{ subscriptionId: 'sub-1', clientState, changeType: 'created' }] }),
  })
}

beforeEach(() => {
  hoisted.send.mockReset().mockResolvedValue(undefined)
  hoisted.from.mockReset()
  stubAccounts()
  vi.stubEnv('OUTLOOK_WEBHOOK_SECRET', SECRET)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('POST /api/webhooks/outlook', () => {
  it('syncs the account a signed clientState names', async () => {
    expect((await POST(notify(`${SECRET}:${ACCOUNT.id}`))).status).toBe(202)
    expect(hoisted.send).toHaveBeenCalledWith({
      name: 'email/webhook-received',
      data: { accountId: ACCOUNT.id, userId: ACCOUNT.user_id, workspaceId: ACCOUNT.workspace_id, provider: 'microsoft' },
    })
  })

  it('drops a bare id (the old secret-less form) without reading anything', async () => {
    expect((await POST(notify(ACCOUNT.id))).status).toBe(202)
    expect(hoisted.from).not.toHaveBeenCalled()
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('drops a wrong secret, an empty id, or a secret that is only a prefix', async () => {
    for (const state of [`not-the-secret:${ACCOUNT.id}`, `${SECRET}:`, `${SECRET}x:${ACCOUNT.id}`, `${SECRET.slice(0, -1)}:${ACCOUNT.id}`]) {
      await POST(notify(state))
    }
    expect(hoisted.from).not.toHaveBeenCalled()
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('drops everything when no secret is configured, in any environment', async () => {
    vi.stubEnv('OUTLOOK_WEBHOOK_SECRET', '')
    vi.stubEnv('VERCEL_ENV', '')
    vi.stubEnv('NODE_ENV', 'development')
    await POST(notify(ACCOUNT.id))
    await POST(notify(`:${ACCOUNT.id}`))
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it("echoes Microsoft's validation token on subscription", async () => {
    const res = await POST(new Request('https://nativeintelligence.dev/api/webhooks/outlook?validationToken=abc', { method: 'POST' }))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('abc')
  })
})
