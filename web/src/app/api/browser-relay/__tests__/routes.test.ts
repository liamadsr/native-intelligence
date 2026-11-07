/**
 * The cloud browser relay's routes (src/app/api/browser-relay/*;
 * docs/plans/cloud-browser.md C2): only a valid relay token with its mark gets
 * in; the actor (user, workspace, device) comes from the token alone, never
 * from a body; the long-poll is scoped to the token's workspace and tells a
 * relay from another app build to restart; a claim and a settle count as activity.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mock = vi.hoisted(() => ({
  claim: vi.fn(), decide: vi.fn(), settle: vi.fn(), touch: vi.fn(), driver: vi.fn(),
  queue: [] as Record<string, unknown>[], filters: [] as [string, unknown][],
}))
vi.mock('@/lib/browser-agent/command-handlers', () => ({
  claimBrowserCommand: mock.claim, decideBrowserStep: mock.decide, settleBrowserCommand: mock.settle,
}))
vi.mock('@/lib/cloud-browser/host', () => ({ touchCloudBrowser: mock.touch }))
vi.mock('@/lib/cloud-browser/store', () => ({ readDriver: mock.driver }))
vi.mock('@/lib/browser-agent/queue', () => ({ ringComputer: async () => {} }))
vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => ({ from: () => {
    const q = {
      select: () => q, order: () => q, limit: () => q, gt: () => q,
      eq: (key: string, value: unknown) => { mock.filters.push([key, value]); return q },
      maybeSingle: async () => ({ data: mock.queue.shift() ?? null, error: null }),
    }
    return q
  } }),
}))

import { mintBrowserRelayToken, RELAY_MARK_HEADER, RELAY_TOKEN_HEADER } from '@/lib/cloud-browser/relay-token'
import { GET as NEXT } from '../next/route'
import { POST as CLAIM } from '../commands/[id]/claim/route'
import { POST as DECIDE } from '../commands/[id]/decision/route'
import { POST as SETTLE } from '../commands/[id]/settle/route'

const params = { params: Promise.resolve({ id: 'cmd-1' }) }
const actor = { userId: 'user-1', workspaceId: 'ws-1', deviceId: 'cloud:browser-abc' }
function relay(path: string, init: RequestInit = {}, token = mintBrowserRelayToken({ userId: 'user-1', workspaceId: 'ws-1', sandbox: 'browser-abc' }, 60_000)) {
  return new Request(`https://browser-relay.dial8.ai${path}`, { ...init, headers: { [RELAY_TOKEN_HEADER]: token, [RELAY_MARK_HEADER]: '1', ...(init.headers ?? {}) } })
}

beforeEach(() => {
  vi.stubEnv('BROWSER_INTERNAL_SECRET', 'browser-secret')
  vi.stubEnv('VERCEL_GIT_COMMIT_SHA', 'build-1')
  for (const fn of [mock.claim, mock.decide, mock.settle]) fn.mockReset().mockResolvedValue(Response.json({ ok: true }))
  mock.driver.mockReset().mockResolvedValue('agent')
  mock.touch.mockReset().mockResolvedValue(undefined)
  mock.queue = []
  mock.filters = []
})

describe('the relay routes', () => {
  it('turn away anything without a valid relay token and mark', async () => {
    const bare = new Request('https://browser-relay.dial8.ai/api/browser-relay/next?v=build-1')
    expect((await NEXT(bare)).status).toBe(401)
    expect((await CLAIM(new Request('https://x/', { method: 'POST' }), params)).status).toBe(401)
    expect((await SETTLE(relay('/', { method: 'POST' }, 'forged.token'), params)).status).toBe(401)
    expect(mock.claim).not.toHaveBeenCalled()
    expect(mock.settle).not.toHaveBeenCalled()
  })

  it('act as the token’s user, workspace and sandbox, whatever the body says', async () => {
    await CLAIM(relay('/', { method: 'POST', body: JSON.stringify({ deviceId: 'my-mac' }) }), params)
    expect(mock.claim).toHaveBeenCalledWith(actor, 'cmd-1')
    await DECIDE(relay('/', { method: 'POST', body: '{}' }), params)
    expect(mock.decide).toHaveBeenCalledWith(actor, 'cmd-1', expect.any(Request), expect.any(Number), expect.any(Number))
    await SETTLE(relay('/', { method: 'POST', body: '{}' }), params)
    expect(mock.settle).toHaveBeenCalledWith(actor, 'cmd-1', expect.any(Request))
  })

  it('count a claim and a settle as activity, never a refused one', async () => {
    await CLAIM(relay('/', { method: 'POST' }), params)
    await SETTLE(relay('/', { method: 'POST' }), params)
    expect(mock.touch).toHaveBeenCalledTimes(2)
    expect(mock.touch).toHaveBeenCalledWith({ userId: 'user-1', workspaceId: 'ws-1' })
    mock.claim.mockResolvedValue(Response.json({ error: 'Command not claimable' }, { status: 409 }))
    await CLAIM(relay('/', { method: 'POST' }), params)
    expect(mock.touch).toHaveBeenCalledTimes(2)
  })
})

describe('the long-poll', () => {
  it('hands over the oldest waiting command in the token’s workspace, with who drives', async () => {
    mock.queue = [{ id: 'cmd-9', command: 'run_task' }]
    const response = await NEXT(relay('/api/browser-relay/next?v=build-1'))
    expect(await response.json()).toEqual({ command: { id: 'cmd-9', command: 'run_task' }, driver: 'agent' })
    expect(mock.filters).toEqual(expect.arrayContaining([['user_id', 'user-1'], ['workspace_id', 'ws-1'], ['status', 'waiting_for_device']]))
    expect(mock.driver).toHaveBeenCalledWith({ userId: 'user-1', workspaceId: 'ws-1' })
  })

  it('says the person drives (the relay keeps the Mac’s address), and the agent when the row can’t be read', async () => {
    const command = { id: 'cmd-9', command: 'run_task' }
    mock.queue = [command, command]
    mock.driver.mockResolvedValueOnce('person')
    expect(await (await NEXT(relay('/api/browser-relay/next?v=build-1'))).json()).toEqual({ command, driver: 'person' })
    mock.driver.mockRejectedValueOnce(new Error('db down'))
    expect(await (await NEXT(relay('/api/browser-relay/next?v=build-1'))).json()).toEqual({ command, driver: 'agent' })
  })

  it('tells a relay from another app build to restart', async () => {
    const response = await NEXT(relay('/api/browser-relay/next?v=old-build'))
    expect(response.status).toBe(426)
    expect(await response.json()).toMatchObject({ version: 'build-1' })
  })

  it('answers null after waiting, and stops waiting when the relay hangs up', async () => {
    vi.useFakeTimers()
    try {
      const waiting = NEXT(relay('/api/browser-relay/next?v=build-1'))
      await vi.advanceTimersByTimeAsync(26_000)
      expect(await (await waiting).json()).toEqual({ command: null, driver: 'agent' })
      const controller = new AbortController()
      const hungUp = NEXT(new Request(relay('/api/browser-relay/next?v=build-1'), { signal: controller.signal }))
      controller.abort()
      await vi.advanceTimersByTimeAsync(1000)
      expect(await (await hungUp).json()).toEqual({ command: null, driver: 'agent' })
    } finally {
      vi.useRealTimers()
    }
  })
})
