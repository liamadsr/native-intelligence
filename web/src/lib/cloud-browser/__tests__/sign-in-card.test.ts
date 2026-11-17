/**
 * The sign-in card (src/lib/cloud-browser/sign-in-card.ts): raised only for a
 * task the asking relay holds, naming the site from the address alone, in the
 * chat that asked; the stored call is the same task in the same tab, with no
 * grant.
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
const gate = vi.hoisted(() => ({ driver: 'agent' as string | null, blocked: [] as string[] | null }))
vi.mock('../store', () => ({ readDriver: async () => { if (gate.driver === null) throw new Error('down'); return gate.driver } }))
vi.mock('@/lib/browser-agent/blocked-sites-server', () => ({ loadBlockedSites: async () => { if (gate.blocked === null) throw new Error('down'); return gate.blocked } }))
import { requestBrowserSignIn, signInCardWhy } from '../sign-in-card'

const actor = { userId: 'user-1', workspaceId: 'ws-1', deviceId: 'cloud:browser-abc' }
const ask = (body: unknown) => requestBrowserSignIn(actor, 'cmd-1', new Request('https://x/', { method: 'POST', body: JSON.stringify(body) }))
const url = 'https://www.shop.example.com/login?next=%2Forders'

beforeEach(() => {
  mock.filters = []
  mock.row = { id: 'cmd-1', command: 'run_task', workspace_id: 'ws-1', lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    request: { task: { goal: 'List my open orders', startUrl: 'https://shop.example.com/orders', completion: [], goalDriven: true },
      attribution: { conversation_id: 'conv-1' } } }
  mock.create.mockReset().mockResolvedValue({ ok: true, approvalId: 'approval-1', cardId: 'card-1' })
})

describe('requestBrowserSignIn', () => {
  it('raises a card that names the site, in the task’s chat, for a replay of the same task in its tab, with no grant', async () => {
    const response = await ask({ url, tabId: 'tab-7' })
    expect(await response.json()).toEqual({ approvalId: 'approval-1' })
    const [, approval] = mock.create.mock.calls[0]
    expect(approval).toMatchObject({ door: 'chat', userId: 'user-1', workspaceId: 'ws-1', toolName: 'run_browser_task',
      conversationId: 'conv-1', reason: 'browser_sign_in',
      input: { goal: 'List my open orders', startUrl: 'https://shop.example.com/orders', completion: [], tab_id: 'tab-7' },
      context: { browserSignIn: { site: 'shop.example.com' } } })
    expect(approval.context.browser).toBeUndefined()
    expect(approval.card.title).toBe('shop.example.com needs you to sign in')
    expect(approval.card.why).toBe('I was working on "List my open orders" and it asked me to sign in. I never type passwords, so sign in yourself and I\'ll pick up where I stopped.')
    expect(signInCardWhy(`${'Find every invoice '.repeat(20)}`).length).toBeLessThan(280)
    // Nothing of the address beyond its site reaches the card.
    expect(JSON.stringify(approval.card)).not.toContain('next=')
  })

  it('only for a task this relay holds', async () => {
    await ask({ url })
    expect(mock.filters).toEqual(expect.arrayContaining([['user_id', 'user-1'], ['workspace_id', 'ws-1'],
      ['claimed_by_device_id', 'cloud:browser-abc'], ['status', 'claimed'], ['command', 'run_task']]))
    mock.row = null
    expect((await ask({ url })).status).toBe(409)
  })

  it('refuses an address that is no web page, and says when the person has too many waiting', async () => {
    expect((await ask({ url: 'javascript:alert(1)' })).status).toBe(400)
    expect((await ask({ url: 'about:blank' })).status).toBe(400)
    expect((await ask({})).status).toBe(400)
    expect(mock.create).not.toHaveBeenCalled()
    mock.create.mockResolvedValue({ ok: false, code: 'TOO_MANY_PENDING', error: 'too many' })
    expect((await ask({ url })).status).toBe(429)
  })
})

describe('allowSignInFill', () => {
  it('says yes only while the relay holds the task, the agent drives, and the site is not blocked', async () => {
    const { allowSignInFill } = await import('../sign-in-card')
    const may = (body: unknown) => allowSignInFill(actor, 'cmd-1', new Request('https://x/', { method: 'POST', body: JSON.stringify(body) }))
    gate.driver = 'agent'
    gate.blocked = []
    expect(await (await may({ url })).json()).toEqual({ ok: true })
    gate.driver = 'person'
    expect(await (await may({ url })).json()).toEqual({ error: 'taken_over' })
    gate.driver = null
    expect((await may({ url })).status).toBe(409)
    gate.driver = 'agent'
    gate.blocked = ['shop.example.com']
    expect(await (await may({ url })).json()).toEqual({ error: 'site_blocked' })
    gate.blocked = null
    expect((await may({ url })).status).toBe(409)
    gate.blocked = []
    mock.row = null
    expect((await may({ url })).status).toBe(409)
    expect((await may({ url: 'about:blank' })).status).toBe(400)
  })
})
