// @vitest-environment jsdom
/**
 * useCardImpression (attention-card.tsx), the `attention_card_impression`
 * rule both AttentionCard and ReviewCard use:
 *
 *   • on the deck surfaces (bubble, bot page, overlay), once per mount, as
 *     before;
 *   • in the For you column, once per card per session (a remount, or the
 *     column folding and opening, sends nothing new), and only once the card
 *     is half in view (an IntersectionObserver with a px rootMargin);
 *   • with no IntersectionObserver, the column still sends once per card.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/app/account/workspace-switcher', () => ({ useWorkspaces: () => ({ workspaces: [], currentId: 'w1' }) }))
vi.mock('@/lib/bots/bot-page', () => ({ openBotPage: vi.fn(() => true) }))
vi.mock('@/components/capture/action-target-picker', () => ({ ActionTargetPicker: () => null }))

import { __resetColumnImpressionsForTests, useCardImpression, type CardSurface } from '../attention-card'

/** The IntersectionObservers made, each with what it watches and its options. */
const ios: Array<{ cb: IntersectionObserverCallback; els: Set<Element>; init?: IntersectionObserverInit; disconnected: boolean }> = []
class FakeIntersectionObserver {
  private entry: (typeof ios)[number]
  constructor(cb: IntersectionObserverCallback, init?: IntersectionObserverInit) {
    this.entry = { cb, els: new Set(), init, disconnected: false }
    ios.push(this.entry)
  }
  observe(el: Element) {
    this.entry.els.add(el)
  }
  unobserve(el: Element) {
    this.entry.els.delete(el)
  }
  disconnect() {
    this.entry.els.clear()
    this.entry.disconnected = true
  }
  takeRecords() {
    return []
  }
}
/** Every watched element comes into (or stays out of) view. */
async function scrollIntoView(isIntersecting: boolean) {
  await act(async () => {
    for (const io of [...ios]) {
      for (const el of [...io.els]) io.cb([{ target: el, isIntersecting } as unknown as IntersectionObserverEntry], io as never)
    }
  })
}

const send = vi.fn()
function Card({ id, surface }: { id: string; surface?: CardSurface }) {
  const ref = useRef<HTMLDivElement>(null)
  useCardImpression(ref, id, surface, () => send(id))
  return h('div', { ref, 'data-card': id })
}

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  send.mockClear()
  ios.length = 0
  __resetColumnImpressionsForTests()
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const render = (cards: Array<{ id: string; surface?: CardSurface }>) =>
  act(async () => root.render(h('div', null, cards.map((c) => h(Card, { key: c.id, ...c })))))

describe('useCardImpression', () => {
  it.each(['bubble', 'bot_page', 'overlay', undefined] as const)('surface %s: once per mount, no observer', async (surface) => {
    await render([{ id: 'c1', surface }])
    expect(send).toHaveBeenCalledTimes(1)
    act(() => root.unmount())
    root = createRoot(container)
    await render([{ id: 'c1', surface }])
    expect(send).toHaveBeenCalledTimes(2)
    expect(ios).toHaveLength(0)
  })

  it('column: nothing until a card is half in view, then once (px rootMargin)', async () => {
    await render([
      { id: 'c1', surface: 'column' },
      { id: 'c2', surface: 'column' },
    ])
    expect(send).not.toHaveBeenCalled()
    expect(ios).toHaveLength(2)
    for (const io of ios) {
      expect(io.init?.threshold).toBe(0.5)
      expect(io.init?.rootMargin).toMatch(/^(-?\d+px\s*)+$/)
    }
    await scrollIntoView(false)
    expect(send).not.toHaveBeenCalled()
    await scrollIntoView(true)
    expect(send.mock.calls.map(([id]) => id).sort()).toEqual(['c1', 'c2'])
    // Seen: its observer is done.
    expect(ios.every((io) => io.disconnected)).toBe(true)
  })

  it('column: once per card per session, across remounts (a fold, a re-render of the list)', async () => {
    await render([{ id: 'c1', surface: 'column' }])
    await scrollIntoView(true)
    expect(send).toHaveBeenCalledTimes(1)
    act(() => root.unmount())
    root = createRoot(container)
    ios.length = 0
    await render([
      { id: 'c1', surface: 'column' },
      { id: 'c3', surface: 'column' },
    ])
    // c1 is not watched again; only c3 is.
    expect(ios).toHaveLength(1)
    await scrollIntoView(true)
    expect(send.mock.calls.map(([id]) => id)).toEqual(['c1', 'c3'])
  })

  it('column without IntersectionObserver: once per card per session', async () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    await render([{ id: 'c1', surface: 'column' }])
    act(() => root.unmount())
    root = createRoot(container)
    await render([{ id: 'c1', surface: 'column' }])
    expect(send).toHaveBeenCalledTimes(1)
  })
})
