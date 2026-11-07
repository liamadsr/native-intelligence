// @vitest-environment jsdom
/**
 * UI sounds from the attention cards' hook: a card arriving LIVE (realtime
 * INSERT) is an agent needing the user. Cards from the initial fetch or a
 * catch-up refetch, a card already held, a non-pending row and a revert UPDATE
 * back to pending never play.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const hoisted = vi.hoisted(() => ({
  handlers: {} as Record<string, (p: { new: unknown }) => void>,
  status: undefined as undefined | ((s: string) => void),
  announce: vi.fn(),
  channels: [] as string[],
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => {
    const ch: Record<string, unknown> = {}
    ch.on = (_evt: string, cfg: { event?: string }, cb: (p: { new: unknown }) => void) => {
      if (cfg?.event) hoisted.handlers[cfg.event] = cb
      return ch
    }
    ch.subscribe = (cb?: (s: string) => void) => {
      if (cb) hoisted.status = cb
      return ch
    }
    return {
      channel: (name: string) => {
        hoisted.channels.push(name)
        return ch
      },
      removeChannel: () => {},
    }
  },
}))
vi.mock('@/lib/sounds/triggers', () => ({ announceAttentionItem: hoisted.announce }))

import { useAttentionItems } from '../use-attention-items'

function card(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    workspace_id: 'ws-1',
    member_id: 'm-1',
    kind: 'action_card',
    title: `card ${id}`,
    why: null,
    payload: {},
    proposal_id: null,
    source_flow_run_id: null,
    status: 'pending',
    expires_at: null,
    created_at: new Date().toISOString(),
    run_key: 'fire-1',
    ...over,
  }
}

const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ items: [card('fetched-1')] }) }) as unknown as Response)

function Harness() {
  useAttentionItems()
  return null
}

let root: Root

async function settle() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(async () => {
  hoisted.handlers = {}
  hoisted.channels = []
  vi.stubGlobal('fetch', fetchMock)
  root = createRoot(document.createElement('div'))
  await act(async () => root.render(h(Harness)))
  await settle()
})

afterEach(() => {
  act(() => root.unmount())
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('useAttentionItems UI sounds', () => {
  it('the initial fetch plays nothing; a live card plays once', async () => {
    expect(hoisted.announce).not.toHaveBeenCalled()
    await act(async () => hoisted.handlers.INSERT({ new: card('live-1') }))
    expect(hoisted.announce).toHaveBeenCalledTimes(1)
    expect(hoisted.announce.mock.calls[0][0]).toMatchObject({ id: 'live-1', run_key: 'fire-1' })
  })

  it('a card already held (fetch race), a non-pending or an expired row plays nothing', async () => {
    await act(async () => {
      hoisted.handlers.INSERT({ new: card('fetched-1') })
      hoisted.handlers.INSERT({ new: card('done-1', { status: 'accepted' }) })
      hoisted.handlers.INSERT({ new: card('old-1', { expires_at: new Date(Date.now() - 1000).toISOString() }) })
    })
    expect(hoisted.announce).not.toHaveBeenCalled()
  })

  it('a revert UPDATE back to pending re-shows the card silently', async () => {
    await act(async () => hoisted.handlers.UPDATE({ new: card('reverted-1') }))
    expect(hoisted.announce).not.toHaveBeenCalled()
  })

  it('a catch-up refetch after a reconnect plays nothing', async () => {
    fetchMock.mockImplementationOnce(
      async () => ({ ok: true, json: async () => ({ items: [card('missed-1'), card('missed-2')] }) }) as unknown as Response,
    )
    await act(async () => {
      hoisted.status!('CHANNEL_ERROR')
      hoisted.status!('SUBSCRIBED')
    })
    await settle()
    expect(hoisted.announce).not.toHaveBeenCalled()
  })

  it('a second surface subscribes on its own channel and stays silent (the provider’s mount plays the sound)', async () => {
    act(() => root.unmount())
    hoisted.handlers = {}
    hoisted.channels = []
    function PageHarness() {
      useAttentionItems({ channel: 'agent-work-attention', announce: false })
      return null
    }
    root = createRoot(document.createElement('div'))
    await act(async () => root.render(h(PageHarness)))
    await settle()
    expect(hoisted.channels).toEqual(['agent-work-attention'])
    await act(async () => hoisted.handlers.INSERT({ new: card('live-2') }))
    expect(hoisted.announce).not.toHaveBeenCalled()
  })

  it('a mount with no channel name keeps the default one', () => {
    expect(hoisted.channels).toEqual(['attention-rail'])
  })
})
