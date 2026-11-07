/**
 * The cloud browser's approval card (src/lib/cloud-browser/approval-card.ts):
 * raised only for a task the asking relay holds, for exactly the step it
 * names, in the chat that asked for the task; the stored call is the same
 * task, continuing in the step's tab.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({ row: null as Record<string, unknown> | null, filters: [] as [string, unknown][], create: vi.fn() }))
vi.mock('@/lib/safety/approvals', () => ({ createToolApproval: mock.create }))
vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => ({ from: () => {
    const q = { select: () => q, gt: () => q,
      eq: (key: string, value: unknown) => { mock.filters.push([key, value]); return q },
      maybeSingle: async () => ({ data: mock.row }) }
    return q
  } }),
}))
import { requestBrowserApproval } from '../approval-card'

const actor = { userId: 'user-1', workspaceId: 'ws-1', deviceId: 'cloud:browser-abc' }
const ask = (body: unknown) => requestBrowserApproval(actor, 'cmd-1', new Request('https://x/', { method: 'POST', body: JSON.stringify(body) }))
const summary = 'Place order\nTotal $42.10\nhttps://shop.example.com'

beforeEach(() => {
  mock.filters = []
  mock.row = { id: 'cmd-1', command: 'run_task', workspace_id: 'ws-1', lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    request: { task: { goal: 'Buy the blue mug', startUrl: 'https://shop.example.com/mug', completion: [], goalDriven: true },
      attribution: { conversation_id: 'conv-1' } } }
  mock.create.mockReset().mockResolvedValue({ ok: true, approvalId: 'approval-1', cardId: 'card-1' })
})

describe('requestBrowserApproval', () => {
  it('raises a card for the step, in the task’s chat, for a replay of the same task in its tab', async () => {
    const response = await ask({ summary, tabId: 'tab-7' })
    expect(await response.json()).toEqual({ approvalId: 'approval-1' })
    const [, approval] = mock.create.mock.calls[0]
    expect(approval).toMatchObject({ door: 'chat', userId: 'user-1', workspaceId: 'ws-1', toolName: 'run_browser_task',
      sideEffect: 'external-write', conversationId: 'conv-1',
      input: { goal: 'Buy the blue mug', startUrl: 'https://shop.example.com/mug', completion: [], tab_id: 'tab-7' },
      context: { browser: { origin: 'https://shop.example.com', target: 'Place order', context_hash: expect.any(String) } } })
    expect(approval.card.title).toBe('Place order on shop.example.com')
  })

  it('only for a task this relay holds', async () => {
    await ask({ summary })
    expect(mock.filters).toEqual(expect.arrayContaining([['user_id', 'user-1'], ['workspace_id', 'ws-1'],
      ['claimed_by_device_id', 'cloud:browser-abc'], ['status', 'claimed'], ['command', 'run_task']]))
    mock.row = null
    expect((await ask({ summary })).status).toBe(409)
  })

  it('refuses a step it can’t read, and says when the person has too many waiting', async () => {
    expect((await ask({ summary: 'Place order' })).status).toBe(400)
    expect((await ask({})).status).toBe(400)
    expect(mock.create).not.toHaveBeenCalled()
    mock.create.mockResolvedValue({ ok: false, code: 'TOO_MANY_PENDING', error: 'too many' })
    expect((await ask({ summary })).status).toBe(429)
  })
})
