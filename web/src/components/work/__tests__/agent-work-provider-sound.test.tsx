// @vitest-environment jsdom
/**
 * A new card's arrival sound (bots-v4 Phase 6). The rail and its ear are gone;
 * the provider's own attention hook is what plays it: a card arriving live
 * plays once, the cards from the first fetch play nothing, and the same card
 * pushed twice plays once.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const hoisted = vi.hoisted(() => ({
  /** Each channel's handlers, by channel name, then by event. */
  handlers: {} as Record<string, Record<string, (p: { new: unknown }) => void>>,
  announce: vi.fn(),
}))

vi.mock('@/app/account/notification-context', () => ({ useNotifications: () => ({ botNotices: [] }) }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }))
vi.mock('@/lib/sounds/triggers', () => ({ announceAttentionItem: hoisted.announce }))
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    channel: (name: string) => {
      const ch: Record<string, unknown> = {}
      ch.on = (_evt: string, cfg: { event?: string }, cb: (p: { new: unknown }) => void) => {
        if (cfg?.event) (hoisted.handlers[name] ??= {})[cfg.event] = cb
        return ch
      }
      ch.subscribe = (cb?: (status: string) => void) => {
        void Promise.resolve().then(() => cb?.('SUBSCRIBED'))
        return ch
      }
      return ch
    },
    removeChannel: () => {},
  }),
}))
vi.mock('@/app/account/(dashboard)/main-chat/main-chat-context', () => ({
  useReadTabsState: () => () => null,
}))
vi.mock('@/components/views/unified-view-layout', () => ({
  useIsWindowDrawn: () => true,
}))

import { AgentWorkProvider } from '../agent-work-provider'

function card(id: string) {
  return {
    id,
    workspace_id: 'w1',
    member_id: 'm1',
    kind: 'action_card',
    title: `Card ${id}`,
    why: null,
    payload: {},
    proposal_id: null,
    source_flow_run_id: null,
    status: 'pending',
    expires_at: null,
    created_at: new Date().toISOString(),
  }
}

let root: Root

async function flush() {
  await act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  })
}

/** The provider's attention channel: a name unique to the mount, `attention-rail-<n>`. */
function attentionInsert() {
  const name = Object.keys(hoisted.handlers).find((n) => /^attention-rail-\d+$/.test(n))
  expect(name).toBeDefined()
  return hoisted.handlers[name!].INSERT
}

beforeEach(async () => {
  hoisted.handlers = {}
  ;(window as unknown as { requestIdleCallback: unknown }).requestIdleCallback = () => 1
  ;(window as unknown as { cancelIdleCallback: unknown }).cancelIdleCallback = () => {}
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/account/attention-items') return new Response(JSON.stringify({ items: [card('fetched')] }), { status: 200 })
      return new Response('{}', { status: 404 })
    }),
  )
  root = createRoot(document.createElement('div'))
  await act(async () => root.render(h(AgentWorkProvider, null, null)))
  await flush()
})

afterEach(() => {
  act(() => root.unmount())
  delete (window as unknown as { requestIdleCallback?: unknown }).requestIdleCallback
  delete (window as unknown as { cancelIdleCallback?: unknown }).cancelIdleCallback
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('AgentWorkProvider — a new card’s sound', () => {
  it('the first fetch plays nothing; a card arriving live plays once, however often it is pushed', async () => {
    expect(hoisted.announce).not.toHaveBeenCalled()
    const insert = attentionInsert()
    // Two pushes, each its own event, as the socket delivers them.
    await act(async () => insert({ new: card('live') }))
    await act(async () => insert({ new: card('live') }))
    expect(hoisted.announce).toHaveBeenCalledTimes(1)
    expect(hoisted.announce.mock.calls[0][0]).toMatchObject({ id: 'live' })
  })

  it('a card the first fetch already brought plays nothing when it is pushed', async () => {
    await act(async () => attentionInsert()({ new: card('fetched') }))
    expect(hoisted.announce).not.toHaveBeenCalled()
  })
})
