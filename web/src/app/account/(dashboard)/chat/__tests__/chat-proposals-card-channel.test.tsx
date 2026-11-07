// @vitest-environment jsdom
/**
 * ChatProposalsCard's Realtime channel (one-chat audit fix c): each copy of
 * the card takes its own topic (`chat-proposals:<capture>:<instance>`). The
 * browser's Supabase client is a singleton, so two copies under one topic (the
 * HUD's live chat and another view of the same call) would share one channel,
 * and closing one would remove it from under the other.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type FakeChannel = { name: string; on: () => FakeChannel; subscribe: () => FakeChannel }
const realtime = vi.hoisted(() => ({ channels: [] as FakeChannel[], removed: [] as FakeChannel[] }))

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    channel: (name: string) => {
      const ch: FakeChannel = { name, on: () => ch, subscribe: () => ch }
      realtime.channels.push(ch)
      return ch
    },
    removeChannel: (ch: FakeChannel) => {
      realtime.removed.push(ch)
    },
  }),
}))

import { ChatProposalsCard } from '../chat-proposals-card'

let container: HTMLDivElement
let roots: Root[]

beforeEach(() => {
  realtime.channels = []
  realtime.removed = []
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ changes: [] }) })))
  container = document.createElement('div')
  document.body.appendChild(container)
  roots = []
})
afterEach(() => {
  for (const root of roots) act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

function mountCard(): Root {
  const host = document.createElement('div')
  container.appendChild(host)
  const root = createRoot(host)
  roots.push(root)
  act(() => root.render(h(ChatProposalsCard, { captureId: 'cap-1', proposalIds: ['p1'] })))
  return root
}

describe('ChatProposalsCard — its Realtime channel', () => {
  it('two copies on one capture open two channels; closing one leaves the other', () => {
    const first = mountCard()
    mountCard()
    expect(realtime.channels).toHaveLength(2)
    for (const ch of realtime.channels) expect(ch.name).toMatch(/^chat-proposals:cap-1:[0-9a-f-]{36}$/)
    expect(realtime.channels[0].name).not.toBe(realtime.channels[1].name)

    act(() => first.unmount())
    roots = roots.filter((r) => r !== first)
    expect(realtime.removed).toEqual([realtime.channels[0]])
  })
})
