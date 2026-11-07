// @vitest-environment jsdom
/**
 * The card's three states, the live cap, full screen over the stage (Esc and
 * a click outside put it back) and the narrow hosts' pill; its header (Back
 * and Forward, and the slots the page puts its own controls in) and its glass;
 * and its page gone dormant in its frame while far from what the chat shows.
 * The page inside (card-body.tsx) is stubbed: what it draws is
 * UnifiedViewLayout's business.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, Suspense } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../card-body', async () => {
  const { CardHeaderSlot } = await import('../card-header-slot')
  return {
    // A page that puts a control of its own in each of the header's slots.
    default: (props: { toolCallId: string; fullScreen: boolean }) =>
      h(
        'div',
        { 'data-card-body': props.toolCallId, 'data-focused': String(props.fullScreen) },
        'page',
        h(CardHeaderSlot, { side: 'left', children: h('button', { type: 'button', 'data-page-control': 'left' }, 'Crumb') }),
        h(CardHeaderSlot, { side: 'right', children: h('button', { type: 'button', 'data-page-control': 'right' }, 'Tool') }),
      ),
  }
})

import { INLINE_DORMANT_AFTER_MS, ShowToolCard } from '../show-tool-card'
import { ChatCardHostProvider } from '../card-host'
import { ChatCardStore } from '../card-store'
import type { CardSpec } from '@/lib/chat-cards/kinds'

const spec = (title: string): CardSpec => ({ kind: 'list', title, entity_type: 'action', filters: [] })

let container: HTMLDivElement
let stage: HTMLDivElement
let root: Root

beforeEach(() => {
  window.localStorage.clear()
  container = document.createElement('div')
  stage = document.createElement('div')
  document.body.append(container, stage)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  stage.remove()
})

async function render(node: ReturnType<typeof h>) {
  await act(async () => {
    root.render(h(Suspense, { fallback: null }, node))
  })
  // The lazy body resolves on a later tick.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

function wideHost(store: ChatCardStore, children: ReturnType<typeof h>[]) {
  return h(ChatCardHostProvider, { value: { wide: true, store, stage }, children })
}

describe('ShowToolCard', () => {
  it('draws the newest card inline with its header, and an older one as its pill', async () => {
    const store = new ChatCardStore()
    const ids = ['c1', 'c2', 'c3', 'c4']
    store.setCards(ids.map((id) => ({ id, spec: spec(`Title ${id}`) })))
    await render(wideHost(store, ids.map((id) => h(ShowToolCard, { key: id, toolCallId: id, spec: spec(`Title ${id}`), count: 12 }))))
    expect(container.querySelector('[data-chat-card-pill="c1"]')?.textContent).toBe('Showed 12 actions · Title c1')
    const inline = container.querySelector('[data-chat-card="c4"]') as HTMLElement
    expect(inline.style.height).toBe('420px')
    expect(inline.textContent).toContain('Title c4')
    // The header is the title and the controls: no count, no card number.
    expect(inline.querySelector('[data-card-header]')?.textContent).not.toMatch(/12 actions|card 4/)
    expect(inline.querySelector('[data-card-body="c4"]')?.getAttribute('data-focused')).toBe('false')
    // The pill expands the old card again.
    await act(async () => (container.querySelector('[data-chat-card-pill="c1"]') as HTMLElement).click())
    await act(async () => new Promise((r) => setTimeout(r, 0)))
    expect(container.querySelector('[data-chat-card="c1"]')).not.toBeNull()
  })

  it('gives the title its room: the header holds no count and no card number', async () => {
    const store = new ChatCardStore()
    store.setCards([{ id: 'c1', spec: spec('Open actions') }])
    await render(wideHost(store, [h(ShowToolCard, { key: 'c1', toolCallId: 'c1', spec: spec('Open actions'), count: 12 })]))
    const header = container.querySelector('[data-chat-card="c1"] [data-card-header]') as HTMLElement
    expect(header.className).toContain('@container')
    const title = Array.from(header.children).find((el) => el.textContent === 'Open actions') as HTMLElement
    expect(title.className).toMatch(/min-w-\[6rem\]/)
    expect(header.textContent).not.toMatch(/12 actions|card 1/)
  })

  it('leads its header with Back and Forward, and draws the page’s own controls in its slots', async () => {
    const store = new ChatCardStore()
    store.setCards([{ id: 'c1', spec: spec('Open actions') }])
    await render(wideHost(store, [h(ShowToolCard, { key: 'c1', toolCallId: 'c1', spec: spec('Open actions'), count: 12 })]))
    const header = container.querySelector('[data-chat-card="c1"] [data-card-header]') as HTMLElement
    const history = header.querySelector('[role="group"][aria-label="Card history"]') as HTMLElement
    expect(header.firstElementChild?.contains(history)).toBe(true)
    expect(Array.from(history.querySelectorAll('button')).map((b) => [b.getAttribute('aria-label'), b.disabled])).toEqual([
      ['Go back', true],
      ['Go forward', true],
    ])
    // The left slot after Back and Forward; the right one before Save as view.
    const left = header.querySelector('[data-card-header-slot="left"] [data-page-control="left"]') as HTMLElement
    const right = header.querySelector('[data-card-header-slot="right"] [data-page-control="right"]') as HTMLElement
    expect(left.textContent).toBe('Crumb')
    expect(right.textContent).toBe('Tool')
    const save = header.querySelector('[aria-label="Save as view"]') as HTMLElement
    expect(right.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(history.compareDocumentPosition(left) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Not in the page's body.
    expect(container.querySelector('[data-card-body] [data-page-control]')).toBeNull()
  })

  it('is glass, inline and full screen: a translucent blurred layer behind its content', async () => {
    const store = new ChatCardStore()
    store.setCards([{ id: 'c1', spec: spec('Due') }])
    await render(wideHost(store, [h(ShowToolCard, { key: 'c1', toolCallId: 'c1', spec: spec('Due'), count: 3 })]))
    const inline = container.querySelector('[data-chat-card="c1"]') as HTMLElement
    expect(inline.className).not.toMatch(/(^|\s)bg-background(\s|$)/)
    const glass = inline.querySelector(':scope > [data-card-glass]') as HTMLElement
    expect(glass.className).toContain('bg-background/70')
    expect(glass.className).toContain('backdrop-blur-md')
    expect(glass.className).toContain('pointer-events-none')
    // The content paints above it.
    expect((glass.nextElementSibling as HTMLElement).className).toMatch(/relative z-10/)

    await act(async () => store.enterFullScreen('c1'))
    await act(async () => new Promise((r) => setTimeout(r, 0)))
    const frame = document.querySelector('[data-chat-card-fullscreen="c1"] [data-chat-card-frame]') as HTMLElement
    expect(frame.className).not.toMatch(/(^|\s)bg-background(\s|$)/)
    expect(frame.querySelector(':scope > [data-card-glass]')?.className).toContain('backdrop-blur-md')
  })

  it('goes full screen on the stage, focused, and Esc or a click outside puts it back', async () => {
    const store = new ChatCardStore()
    store.setCards([{ id: 'c1', spec: spec('Due') }])
    await render(wideHost(store, [h(ShowToolCard, { key: 'c1', toolCallId: 'c1', spec: spec('Due'), count: 3 })]))
    await act(async () => (container.querySelector('[aria-label="Full screen"]') as HTMLElement).click())
    await act(async () => new Promise((r) => setTimeout(r, 0)))
    const overlay = document.querySelector('[data-chat-card-fullscreen="c1"]') as HTMLElement
    expect(overlay).not.toBeNull()
    expect(overlay.querySelector('[data-card-body]')?.getAttribute('data-focused')).toBe('true')
    expect(container.textContent).toContain('full screen')

    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(document.querySelector('[data-chat-card-fullscreen]')).toBeNull()

    await act(async () => store.enterFullScreen('c1'))
    const again = document.querySelector('[data-chat-card-fullscreen="c1"]') as HTMLElement
    await act(async () => again.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })))
    expect(document.querySelector('[data-chat-card-fullscreen]')).toBeNull()
  })

  it('folds to one line from its Close button', async () => {
    const store = new ChatCardStore()
    store.setCards([{ id: 'c1', spec: spec('Due') }])
    await render(wideHost(store, [h(ShowToolCard, { key: 'c1', toolCallId: 'c1', spec: spec('Due'), count: 1 })]))
    await act(async () => (container.querySelector('[aria-label="Close"]') as HTMLElement).click())
    expect(container.querySelector('[data-chat-card="c1"]')).toBeNull()
    expect(container.querySelector('[data-chat-card-pill="c1"]')?.textContent).toBe('Showed 1 action · Due')
  })

  it('is a pill in a narrow host (the bot bubble, a run chat) that opens full screen over the window', async () => {
    await render(h(ShowToolCard, { toolCallId: 'n1', spec: spec('Mine'), count: 2 }))
    expect(container.querySelector('[data-chat-card="n1"]')).toBeNull()
    await act(async () => (container.querySelector('[data-chat-card-pill="n1"]') as HTMLElement).click())
    await act(async () => new Promise((r) => setTimeout(r, 0)))
    expect(document.body.querySelector('[data-chat-card-fullscreen="n1"]')).not.toBeNull()
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(document.body.querySelector('[data-chat-card-fullscreen="n1"]')).toBeNull()
  })
})

/**
 * A press anywhere outside a full-screen card puts it back: above, beside or
 * below it, on the layout wrappers that fill that space (the stage, the
 * column, the row under the card). Not a
 * press on the card, on a control, or while a popover is open (its own
 * outside press closes only it).
 */
describe('a press outside a full-screen card', () => {
  const press = async (el: Element, init: PointerEventInit = {}) => {
    await act(async () => {
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, ...init }))
    })
  }

  async function openCard(): Promise<{ store: ChatCardStore; layer: () => HTMLElement | null; done: () => void }> {
    const store = new ChatCardStore()
    store.setCards([{ id: 'c1', spec: spec('Due') }])
    await render(wideHost(store, [h(ShowToolCard, { key: 'c1', toolCallId: 'c1', spec: spec('Due'), count: 3 })]))
    await act(async () => store.enterFullScreen('c1'))
    await act(async () => new Promise((r) => setTimeout(r, 0)))
    return { store, layer: () => document.querySelector('[data-chat-card-fullscreen="c1"]'), done: () => {} }
  }

  // The empty space around the card, each of the wrappers a press there lands on.
  const outsideSpots = (layer: HTMLElement): [string, Element][] => {
    const frame = layer.querySelector('[data-chat-card-frame]')!
    const column = frame.parentElement!
    const controlsRow = frame.nextElementSibling!
    return [
      ['the layer (above)', layer],
      ['the stage (beside)', column.parentElement!],
      ['the column', column],
      ['the row under the card', controlsRow],
    ]
  }

  for (const kind of ['card'] as const) {
    const open = openCard
    describe('the card layer', () => {
      it('closes from every empty spot around the card', async () => {
        const { store, layer, done } = await open()
        const spots = outsideSpots(layer()!).map(([name]) => name)
        for (const name of spots) {
          await act(async () => store.enterFullScreen('c1'))
          const l = layer()!
          const el = outsideSpots(l).find(([n]) => n === name)![1]
          expect(el, name).not.toBeNull()
          await press(el)
          expect(layer(), name).toBeNull()
        }
        done()
      })

      it('stays for a press on the card, its header, its controls, a non-primary button or with a popover open', async () => {
        const { layer, done } = await open()
        const l = layer()!
        const frame = l.querySelector('[data-chat-card-frame]')!
        await press(frame)
        await press(frame.querySelector('[data-card-header]')!)
        await press(frame.querySelector('[data-card-header] span')!)
        await press(frame.querySelector('[data-card-body]')!)
        // The listen toggle's corner, and the round buttons (pressed, not clicked).
        await press(l.querySelector('[data-full-screen-control]')!)
        for (const b of Array.from(l.querySelectorAll('button[aria-label="Back into the chat"]'))) await press(b)
        await press(l.querySelector('svg') ?? l, { button: 2 })
        await press(l, { button: 1 })
        expect(layer()).toBe(l)

        // A popover open (on <body>, out of the card): only it closes.
        const popover = document.createElement('div')
        popover.setAttribute('data-radix-popper-content-wrapper', '')
        popover.innerHTML = '<div role="dialog" data-state="open">Pick</div>'
        document.body.append(popover)
        await press(l)
        await press(frame.parentElement!)
        expect(layer()).toBe(l)
        popover.remove()

        // A lingering tooltip is not a popover: the press closes.
        const tip = document.createElement('div')
        tip.setAttribute('data-radix-popper-content-wrapper', '')
        tip.innerHTML = '<div data-state="delayed-open"><span role="tooltip">Interactive</span></div>'
        document.body.append(tip)
        await press(l)
        expect(layer()).toBeNull()
        tip.remove()
        done()
      })
    })
  }

  it('cancels the press it closes on, so its mousedown never lands on the chat under the layer', async () => {
    const { layer } = await openCard()
    const ev = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 })
    await act(async () => {
      layer()!.dispatchEvent(ev)
    })
    expect(layer()).toBeNull()
    expect(ev.defaultPrevented).toBe(true)
  })
})

describe('an inline card’s page far from view', () => {
  /** An IntersectionObserver the test reports to (jsdom has none). */
  class FakeObserver {
    static all: FakeObserver[] = []
    targets = new Set<Element>()
    constructor(
      public callback: IntersectionObserverCallback,
      public options: IntersectionObserverInit = {},
    ) {
      FakeObserver.all.push(this)
    }
    observe(el: Element) {
      this.targets.add(el)
    }
    unobserve(el: Element) {
      this.targets.delete(el)
    }
    disconnect() {
      this.targets.clear()
    }
  }
  const report = (el: Element, isIntersecting: boolean) =>
    act(async () => {
      for (const o of [...FakeObserver.all]) {
        if (o.targets.has(el)) o.callback([{ target: el, isIntersecting } as IntersectionObserverEntry], o as unknown as IntersectionObserver)
      }
    })
  const frame = () => container.querySelector('[data-chat-card="c1"]') as HTMLElement
  const page = () => container.querySelector('[data-card-body="c1"]') as HTMLElement
  /** The slot the page sleeps in, inside its frame. */
  const slot = () => page().closest('[data-card-body-host]')!.parentElement as HTMLElement
  const advance = (ms: number) => act(async () => void vi.advanceTimersByTime(ms))
  let store: ChatCardStore
  /** Where the frame sits, against the chat's scroller (0 to 600): far down by default. */
  let frameTop = 5000

  beforeEach(() => {
    FakeObserver.all = []
    frameTop = 5000
    vi.stubGlobal('IntersectionObserver', FakeObserver)
    // The chat's scroller, as the card finds it: its nearest ancestor that scrolls.
    container.style.overflowY = 'auto'
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const [top, height] = this === container ? [0, 600] : this.hasAttribute('data-chat-card') ? [frameTop, 420] : [0, 0]
      return { top, bottom: top + height, height, left: 0, right: 800, width: 800, x: 0, y: top, toJSON() {} } as DOMRect
    })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /** A card seen once, its page drawn, then far from view: on a fake clock and frames from here (the lazy page needs the real ones). */
  async function farCard() {
    store = new ChatCardStore()
    store.setCards([{ id: 'c1', spec: spec('Open actions') }])
    await render(wideHost(store, [h(ShowToolCard, { key: 'c1', toolCallId: 'c1', spec: spec('Open actions'), count: 3 })]))
    await report(frame(), true)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(page()).not.toBeNull()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] })
    await report(frame(), false)
  }

  it('is watched on the chat’s scroller, a window’s height around it, in px', async () => {
    await farCard()
    const near = FakeObserver.all.find((o) => o.options.root === container)!
    expect(near.options.rootMargin).toBe(`${window.innerHeight}px 0px`)
  })

  it('goes dormant in its frame after a while far: display none, the frame still its height, the same page', async () => {
    await farCard()
    const drawn = page()
    await advance(INLINE_DORMANT_AFTER_MS - 1)
    expect(slot().style.display).toBe('')
    expect(slot().hasAttribute('data-card-dormant')).toBe(false)
    await advance(1)
    expect(slot().style.display).toBe('none')
    expect(slot().getAttribute('data-card-dormant')).toBe('')
    // Nothing around it moves: the frame keeps its fixed height, header and all.
    expect(frame().style.height).toBe('420px')
    expect(frame().querySelector('[data-card-header]')).not.toBeNull()
    expect(page()).toBe(drawn)
    expect(frame().contains(drawn)).toBe(true)
  })

  it('stays awake when it comes back near before then', async () => {
    await farCard()
    await advance(INLINE_DORMANT_AFTER_MS - 1000)
    await report(frame(), true)
    await advance(INLINE_DORMANT_AFTER_MS * 2)
    expect(slot().style.display).toBe('')
    expect(slot().hasAttribute('data-card-dormant')).toBe(false)
  })

  it('never sleeps while the focus is in it (display: none would drop it)', async () => {
    await farCard()
    await act(async () => frame().focus())
    await advance(INLINE_DORMANT_AFTER_MS * 2)
    expect(slot().style.display).toBe('')
    // A blur waits a task for the focus that may follow it.
    await act(async () => frame().blur())
    await advance(0)
    await advance(INLINE_DORMANT_AFTER_MS)
    expect(slot().style.display).toBe('none')
  })

  it('wakes as it comes back within a window’s height, out of sight: its scroll and its one-shot animations back', async () => {
    await farCard()
    const drawn = page()
    drawn.scrollTop = 240
    await advance(INLINE_DORMANT_AFTER_MS)
    // What WebKit does to a box under display: none.
    drawn.scrollTop = 0
    const fadeIn = { effect: { getTiming: () => ({ iterations: 1 }) }, finish: vi.fn() }
    const spinner = { effect: { getTiming: () => ({ iterations: Infinity }) }, finish: vi.fn() }
    Object.defineProperty(HTMLElement.prototype, 'getAnimations', { value: () => [fadeIn, spinner], configurable: true })
    try {
      await report(frame(), true)
      expect(slot().style.display).toBe('')
      expect(slot().getAttribute('data-card-dormant')).toBe('waking')
      expect(drawn.scrollTop).toBe(240)
      expect(fadeIn.finish).toHaveBeenCalled()
      expect(spinner.finish).not.toHaveBeenCalled()
      await advance(16 * 3)
      expect(slot().hasAttribute('data-card-dormant')).toBe(false)
      expect(page()).toBe(drawn)
      expect(drawn.scrollTop).toBe(240)
    } finally {
      delete (HTMLElement.prototype as { getAnimations?: unknown }).getAnimations
    }
  })

  it('wakes in the scroll itself when a jump could bring it into view before the observer reports', async () => {
    await farCard()
    const drawn = page()
    drawn.scrollTop = 90
    await advance(INLINE_DORMANT_AFTER_MS)
    drawn.scrollTop = 0
    const scroll = (top: number, cardTop: number) => {
      container.scrollTop = top
      frameTop = cardTop
      container.dispatchEvent(new Event('scroll'))
    }
    // A step of 1000 with the card 3400 below the chat's foot: three steps can't reach it.
    scroll(1000, 4000)
    expect(slot().style.display).toBe('none')
    // The spring speeds up: 1500 a step, the card 2400 below. Awake now, in
    // the event, before that frame paints: no React render needed.
    await act(async () => {
      scroll(2500, 3000)
      expect(slot().style.display).toBe('')
      expect(drawn.scrollTop).toBe(90)
    })
    await advance(16 * 3)
    expect(slot().hasAttribute('data-card-dormant')).toBe(false)
    expect(slot().style.display).toBe('')
  })

  it('wakes on any scroll that finds it in view (a resize, a step too small to foresee)', async () => {
    await farCard()
    await advance(INLINE_DORMANT_AFTER_MS)
    frameTop = 300
    await act(async () => void window.dispatchEvent(new Event('resize')))
    expect(slot().style.display).toBe('')
  })

  it('goes full screen from asleep: wakes in its frame first, out of sight, then opens on the same page', async () => {
    await farCard()
    const drawn = page()
    await advance(INLINE_DORMANT_AFTER_MS)
    await act(async () => store.enterFullScreen('c1'))
    expect(document.querySelector('[data-chat-card-fullscreen="c1"]')).toBeNull()
    expect(slot().getAttribute('data-card-dormant')).toBe('waking')
    expect(frame().style.height).toBe('420px')
    expect(frame().contains(drawn)).toBe(true)
    await advance(16 * 3)
    expect(document.querySelector('[data-chat-card-fullscreen="c1"] [data-card-body="c1"]')).toBe(drawn)
    expect(frame().textContent).toContain('full screen')
  })

  it('folded to its pill while asleep, its page draws again awake', async () => {
    await farCard()
    await advance(INLINE_DORMANT_AFTER_MS)
    await act(async () => store.collapse('c1'))
    expect(page()).toBeNull()
    vi.useRealTimers()
    await act(async () => store.expand('c1'))
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(page()).not.toBeNull()
    expect(slot().style.display).toBe('')
    expect(slot().hasAttribute('data-card-dormant')).toBe(false)
  })
})
