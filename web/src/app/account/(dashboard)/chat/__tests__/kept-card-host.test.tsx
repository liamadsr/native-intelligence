// @vitest-environment jsdom
/**
 * The pages the person opened, kept mounted out of the thread
 * (kept-card-host.tsx, card-store.ts keptPages / hostedIds), and what they cost.
 *
 *   - The store keeps the LIVE_CARDS pages visited last (by `visitedAt`),
 *     whatever their place in the thread; an agent's card is never one.
 *   - A page full screen draws its overlay; put away (its X says Close), its
 *     page waits parked out of sight at its full-screen size, so opening it
 *     again never loads it again; one no longer among those visited last is
 *     let go, card and all.
 *   - However many pages the chat holds, at most 1 + LIVE_CARDS full cards
 *     are mounted.
 *   - A change to one card redraws that card only, not every card in the chat.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, Profiler, Suspense } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { mounts } = vi.hoisted(() => ({ mounts: new Map<string, number>() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/components/chat-cards/card-body', async () => {
  const React = await import('react')
  function PageBody(props: { toolCallId: string }) {
    React.useEffect(() => {
      mounts.set(props.toolCallId, (mounts.get(props.toolCallId) ?? 0) + 1)
    }, [props.toolCallId])
    return React.createElement('div', { 'data-page': props.toolCallId }, `page ${props.toolCallId}`)
  }
  return { default: PageBody }
})

import { DORMANT_AFTER_MS, ShowToolCard } from '@/components/chat-cards/show-tool-card'
import { ChatCardHostProvider } from '@/components/chat-cards/card-host'
import { ChatCardStore, LIVE_CARDS } from '@/components/chat-cards/card-store'
import { KeptCardHost } from '../kept-card-host'
import type { CardSpec } from '@/lib/chat-cards/kinds'

const spec = (title: string): CardSpec => ({ kind: 'list', title, entity_type: 'action', filters: [] })

let container: HTMLDivElement
let root: Root
let store: ChatCardStore
let t = 10_000
/** Each inline card's commits, by its id (a Profiler around each). */
const commits = new Map<string, number>()
const count = (id: string) => commits.set(id, (commits.get(id) ?? 0) + 1)

beforeEach(() => {
  mounts.clear()
  commits.clear()
  t = 10_000
  window.localStorage.clear()
  vi.spyOn(Date, 'now').mockImplementation(() => (t += 1000))
  // jsdom lays nothing out: give every element the full-screen frame's size.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ width: 1000, height: 625, top: 0, left: 0, right: 1000, bottom: 625, x: 0, y: 0, toJSON() {} }) as DOMRect,
  )
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  store = new ChatCardStore()
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

/** The host, and the agent's cards inline as its replies draw them. */
async function render(opened: string[], agent: string[] = []) {
  store.setCards([...agent.map((id) => ({ id, spec: spec(`Agent ${id}`) })), ...opened.map((id) => ({ id, spec: spec(`Title ${id}`), opened: true }))])
  await act(async () => {
    root.render(
      h(
        Suspense,
        { fallback: null },
        h(ChatCardHostProvider, {
          value: { wide: true, store, stage: null },
          children: [
            ...agent.map((id) =>
              h(Profiler, { key: id, id, onRender: () => void count(id) }, h(ShowToolCard, { toolCallId: id, spec: spec(`Agent ${id}`), count: 1 })),
            ),
            h('div', { key: 'kept', 'data-kept-host': '' }, h(KeptCardHost, { store })),
          ],
        }),
      ),
    )
  })
  await settle()
}

/** The full cards the host mounts (each has one hidden page anchor). */
const hostedCards = () => container.querySelectorAll('[data-kept-host] [data-card-body-anchor]').length

describe('the kept pages', () => {
  it('are the LIVE_CARDS opened pages visited last, whatever their place in the thread', () => {
    store.setCards([
      { id: 'a1', spec: spec('Agent') },
      ...['p1', 'p2', 'p3', 'p4', 'p5'].map((id) => ({ id, spec: spec(id), opened: true })),
    ])
    // Never visited: the thread's order, the newest kept.
    expect(store.keptPages().map((c) => c.id)).toEqual(['p3', 'p4', 'p5'])
    for (const id of ['p1', 'p4', 'p2']) store.enterFullScreen(id)
    store.exitFullScreen()
    expect(store.keptPages().map((c) => c.id)).toEqual(['p1', 'p4', 'p2'])
    // An agent's card full screen is never one of them, nor mounted by the host.
    store.enterFullScreen('a1')
    expect(store.keptPages().map((c) => c.id)).toEqual(['p1', 'p4', 'p2'])
    expect(store.hostedIds()).not.toContain('a1')
  })
})

describe('a page the person opened', () => {
  it('draws nothing out of full screen but its parked page; its X says Close', async () => {
    await render(['p1'])
    expect(container.querySelector('[data-chat-card="p1"]')).toBeNull()
    expect(container.querySelector('[data-chat-card-pill="p1"]')).toBeNull()
    await act(async () => store.enterFullScreen('p1'))
    await settle()
    const close = document.querySelector('[data-chat-card-fullscreen="p1"] [data-testid="card-close"]') as HTMLButtonElement
    expect(close.getAttribute('aria-label')).toBe('Close')
    await act(async () => close.click())
    expect(store.fullScreen()).toBeNull()
    expect(document.querySelector('[data-chat-card-fullscreen="p1"]')).toBeNull()
  })

  it('keeps a recent page mounted between visits, parked out of sight, so it never loads again', async () => {
    await render(['p1'])
    await act(async () => store.enterFullScreen('p1'))
    await settle()
    const page = document.querySelector('[data-page="p1"]') as HTMLElement
    expect(mounts.get('p1')).toBe(1)
    await act(async () => store.exitFullScreen())
    const parked = container.querySelector('[data-card-parked="p1"]') as HTMLElement
    expect(parked.contains(page)).toBe(true)
    expect(parked.className).toContain('invisible')
    expect(parked.hasAttribute('inert')).toBe(true)
    // At the size it had full screen.
    expect(parked.style.width).toBe('1000px')
    expect(parked.style.height).toBe('625px')

    await act(async () => store.enterFullScreen('p1'))
    await settle()
    expect(document.querySelector('[data-chat-card-fullscreen="p1"] [data-page="p1"]')).toBe(page)
    expect(mounts.get('p1')).toBe(1)
  })

  it('lets a page go, card and all, once it is no longer among those visited last', async () => {
    const ids = Array.from({ length: LIVE_CARDS + 1 }, (_, i) => `p${i}`)
    await render(ids)
    for (const id of ids) {
      await act(async () => store.enterFullScreen(id))
      await settle()
    }
    await act(async () => store.exitFullScreen())
    // The first visited is the oldest: its page is gone, the others parked.
    expect(document.querySelector('[data-page="p0"]')).toBeNull()
    for (const id of ids.slice(1)) expect(container.querySelector(`[data-card-parked="${id}"] [data-page="${id}"]`)).not.toBeNull()
    expect(hostedCards()).toBe(LIVE_CARDS)
  })

  it(`mounts at most 1 + ${LIVE_CARDS} full cards, however many pages the chat holds`, async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `p${i}`)
    await render(ids)
    expect(hostedCards()).toBeLessThanOrEqual(1 + LIVE_CARDS)
    // An old page full screen: it, plus the kept ones.
    await act(async () => store.enterFullScreen('p3'))
    await settle()
    expect(hostedCards()).toBeLessThanOrEqual(1 + LIVE_CARDS)
    for (const id of ['p10', 'p20', 'p30', 'p40']) {
      await act(async () => store.enterFullScreen(id))
      await settle()
    }
    expect(hostedCards()).toBeLessThanOrEqual(1 + LIVE_CARDS)
  })
})

describe('a page parked a while', () => {
  const parked = (id: string) => container.querySelector(`[data-card-parked="${id}"]`) as HTMLElement | null

  /** Opened full screen once, then put away: parked, on a fake clock and frames from here (render and settle need the real ones). */
  async function parkPage(id: string) {
    await render([id])
    await act(async () => store.enterFullScreen(id))
    await settle()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] })
    await act(async () => store.exitFullScreen())
  }
  const advance = (ms: number) => act(async () => void vi.advanceTimersByTime(ms))
  afterEach(() => vi.useRealTimers())

  it('goes dormant: display none, its page still mounted, never loaded again', async () => {
    await parkPage('p1')
    const page = document.querySelector('[data-page="p1"]') as HTMLElement
    await advance(DORMANT_AFTER_MS - 1)
    expect(parked('p1')!.style.display).toBe('')
    expect(parked('p1')!.hasAttribute('data-card-dormant')).toBe(false)
    await advance(1)
    expect(parked('p1')!.style.display).toBe('none')
    expect(parked('p1')!.getAttribute('data-card-dormant')).toBe('')
    expect(parked('p1')!.contains(page)).toBe(true)
    expect(mounts.get('p1')).toBe(1)
  })

  it('wakes out of sight first, then opens full screen on the same page', async () => {
    await parkPage('p1')
    const page = document.querySelector('[data-page="p1"]') as HTMLElement
    await advance(DORMANT_AFTER_MS)
    await act(async () => store.enterFullScreen('p1'))
    // Waking: displayed again in its parked slot, still invisible; no overlay yet.
    expect(document.querySelector('[data-chat-card-fullscreen="p1"]')).toBeNull()
    expect(parked('p1')!.style.display).toBe('')
    expect(parked('p1')!.getAttribute('data-card-dormant')).toBe('waking')
    expect(parked('p1')!.className).toContain('invisible')
    await advance(16 * 3)
    expect(document.querySelector('[data-chat-card-fullscreen="p1"] [data-page="p1"]')).toBe(page)
    expect(parked('p1')).toBeNull()
    expect(mounts.get('p1')).toBe(1)
    // Put away again: parked, awake, until it has waited again.
    await act(async () => store.exitFullScreen())
    expect(parked('p1')!.style.display).toBe('')
    expect(parked('p1')!.hasAttribute('data-card-dormant')).toBe(false)
  })

  it('wakes within WAKE_MAX_MS even with no frames (a hidden window runs none)', async () => {
    await parkPage('p1')
    await advance(DORMANT_AFTER_MS)
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0)
    await act(async () => store.enterFullScreen('p1'))
    expect(document.querySelector('[data-chat-card-fullscreen="p1"]')).toBeNull()
    await advance(150)
    expect(document.querySelector('[data-chat-card-fullscreen="p1"] [data-page="p1"]')).not.toBeNull()
  })

  it('keeps its scroll offsets through dormancy (a display: none box forgets them)', async () => {
    await parkPage('p1')
    const page = document.querySelector('[data-page="p1"]') as HTMLElement
    page.scrollTop = 240
    await advance(DORMANT_AFTER_MS)
    // What WebKit does to a box under display: none.
    page.scrollTop = 0
    await act(async () => store.enterFullScreen('p1'))
    expect(page.scrollTop).toBe(240)
    await advance(16 * 3)
    expect(document.querySelector('[data-chat-card-fullscreen="p1"] [data-page="p1"]')).toBe(page)
    expect(page.scrollTop).toBe(240)
  })

  it('ends a woken page’s one-shot animations (display: none restarts them); a spinner just runs', async () => {
    await parkPage('p1')
    await advance(DORMANT_AFTER_MS)
    const fadeIn = { effect: { getTiming: () => ({ iterations: 1 }) }, finish: vi.fn() }
    const spinner = { effect: { getTiming: () => ({ iterations: Infinity }) }, finish: vi.fn() }
    const getAnimations = vi.fn(() => [fadeIn, spinner])
    Object.defineProperty(HTMLElement.prototype, 'getAnimations', { value: getAnimations, configurable: true })
    try {
      await act(async () => store.enterFullScreen('p1'))
      expect(fadeIn.finish).toHaveBeenCalled()
      await advance(16 * 3)
      expect(spinner.finish).not.toHaveBeenCalled()
      expect(getAnimations).toHaveBeenCalledWith({ subtree: true })
    } finally {
      delete (HTMLElement.prototype as { getAnimations?: unknown }).getAnimations
    }
  })

  it('put away again before it woke: dormant still, its offsets kept for next time', async () => {
    await parkPage('p1')
    const page = document.querySelector('[data-page="p1"]') as HTMLElement
    page.scrollTop = 90
    await advance(DORMANT_AFTER_MS)
    page.scrollTop = 0
    await act(async () => store.enterFullScreen('p1'))
    await act(async () => store.exitFullScreen())
    expect(parked('p1')!.style.display).toBe('none')
    page.scrollTop = 0
    await act(async () => store.enterFullScreen('p1'))
    await advance(16 * 3)
    expect(document.querySelector('[data-chat-card-fullscreen="p1"] [data-page="p1"]')).toBe(page)
    expect(page.scrollTop).toBe(90)
  })
})

describe('redraws', () => {
  it('a change to one card redraws that card only, of 50', async () => {
    const agent = Array.from({ length: 50 }, (_, i) => `a${i}`)
    await render([], agent)
    commits.clear()
    // An old card expanded from its pill: only it draws again.
    await act(async () => store.expand('a0'))
    await settle()
    expect([...commits.keys()]).toEqual(['a0'])
    commits.clear()
    await act(async () => store.enterFullScreen('a49'))
    await settle()
    expect([...commits.keys()]).toEqual(['a49'])
    commits.clear()
    await act(async () => store.exitFullScreen())
    expect([...commits.keys()]).toEqual(['a49'])
  })
})
