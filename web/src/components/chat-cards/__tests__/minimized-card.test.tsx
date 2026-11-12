// @vitest-environment jsdom
/**
 * Liam, 11-11: "anytime you click an empty area it does close it" (the same
 * on every page), and the card in front "minimize[s] and animate[s] that same
 * way [as Search] and go[es] to the bottom left … click on it again and bring
 * it back into the view". One rule for empty presses (outside-card-press.ts
 * isEmptyAppPress, read by EmptyPressMinimizes), the tile
 * (minimized-card-tile.tsx, minimized-card.ts), and the search's flight both
 * ways (card-reply-flight.ts flyHome / launchFlight / landFlight). And the
 * tile is a mini window (Liam, 11-11: "I want it to have a preview of the
 * window not just a tab like a square"): the frame's still copy, scaled, the
 * frame shrinking into it and growing back out of it. The flights are the
 * tile's own (lib/chat/tile-flight.ts; Liam, 11-11: "its better but the
 * animation isnt as smooth", "match the speed and motion to the search panel
 * cmd+k panel", "it like flikers when it goes to the bottom left").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, hydrateRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { act, createElement as h, Fragment, Suspense } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../card-body', () => ({
  default: function Body() {
    return h(
      'div',
      { 'data-test-page': '' },
      h('button', { id: 'in-page' }, 'Row'),
      h('iframe', { id: 'mail-frame' }),
      h('span', { id: 'spinner', className: 'size-3 animate-spin motion-safe:animate-pulse' }),
      h('input', { type: 'radio', name: 'pick', defaultChecked: true, tabIndex: 0 }),
      h('a', { href: '/account/mail', id: 'mail-link' }, 'Open'),
      h('video', { id: 'clip' }),
    )
  },
}))

import { ShowToolCard } from '../show-tool-card'
import { ChatCardHostProvider } from '../card-host'
import { ChatCardStore } from '../card-store'
import { closeFrontCards, frontCard, minimizeFrontCards } from '../front-card'
import { EMPTY_PRESS_ZONE_ATTR, isEmptyAppPress } from '../outside-card-press'
import { __resetMinimizedForTests, minimizedCard } from '../minimized-card'
import { EmptyPressMinimizes, MinimizedCardTile, minimizedTileWidth } from '@/app/account/(dashboard)/minimized-card-tile'
import { coverScale, coverTransform } from '@/lib/chat/card-reply-flight'
import { MINIMIZE_FLIGHT_MS, TILE_HANDOFF_MS, __resetTileFlightForTests, panelClip } from '@/lib/chat/tile-flight'
import { PALETTE_ENTRANCE_EASING } from '@/lib/motion/palette-entrance'
import { MINIMIZED_TILE_H_PX, MINIMIZED_TILE_W_PX, PAGE_PANEL_WIDTH_PX } from '@/app/account/(dashboard)/side-panels/space-plan'
import type { CardSpec } from '@/lib/chat-cards/kinds'
import { CARD_PAGES } from '@/lib/chat-cards/page-menu'

const pageSpec = (slug: string) => CARD_PAGES.find((p) => p.slug === slug)!.spec(new Date()) as CardSpec
const TEAM = pageSpec('team-chat')
const MAIL = pageSpec('mail')
const LIST: CardSpec = { kind: 'list', title: 'Due this week', entity_type: 'action', filters: [] } as unknown as CardSpec

/** A rect for each part the flights measure: the card's frame and the tile. */
const FRAME_RECT = { left: 400, top: 60, width: 1000, height: 640 }
// The tile at its widest (the page panel's width, 16:10), 12px above a 900px window's bottom.
const TILE_RECT = { left: 64, top: 900 - 12 - MINIMIZED_TILE_H_PX, width: MINIMIZED_TILE_W_PX, height: MINIMIZED_TILE_H_PX }
// The page panel's column beside the rail, above the tile.
const PANEL_RECT = { left: 64, top: 50, width: PAGE_PANEL_WIDTH_PX, height: 513 }

let shell: HTMLElement
let container: HTMLDivElement
let stage: HTMLDivElement
let root: Root
let animate: ReturnType<typeof vi.fn>
let finish: Array<() => void>
let wide: boolean
let reducedMotion: boolean
/** The tile's slot and the page panel are measured (a minimize can launch before its card leaves). */
let laidOut: boolean
const realRect = HTMLElement.prototype.getBoundingClientRect

beforeEach(() => {
  window.localStorage.clear()
  __resetMinimizedForTests()
  __resetTileFlightForTests()
  wide = true
  reducedMotion = false
  laidOut = false
  window.matchMedia = ((query: string) => ({
    matches: query.includes('reduce') ? reducedMotion : query.includes('min-width') ? wide : false,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia
  document.documentElement.setAttribute('data-app-rail', '')
  finish = []
  animate = vi.fn(() => {
    let resolve!: () => void
    let reject!: (e: unknown) => void
    const finished = new Promise<void>((res, rej) => {
      resolve = res
      reject = rej
    })
    finished.catch(() => {})
    finish.push(resolve)
    return { finished, cancel: vi.fn(() => reject(new Error('cancelled'))) }
  })
  ;(HTMLElement.prototype as unknown as { animate: unknown }).animate = animate
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const r = this.hasAttribute('data-chat-card-frame')
      ? FRAME_RECT
      : this.hasAttribute('data-minimized-card') || (laidOut && this.hasAttribute('data-minimized-tile-slot'))
        ? TILE_RECT
        : laidOut && this.hasAttribute('data-page-panel')
          ? PANEL_RECT
          : null
    if (!r) return realRect.call(this)
    return { ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height, toJSON: () => ({}) } as DOMRect
  }
  // The app around the card: the shell, the chat row (its children stop
  // painting under a card), the page panel's column and card, the strip,
  // the composer's dock, its zone, its reading column and the composer box.
  shell = document.createElement('div')
  shell.id = 'ni-shell-root'
  shell.innerHTML = `
    <div data-app-rail-header id="rail-header"><button id="search">Search</button></div>
    <nav data-app-rail-nav id="rail-nav"><div id="rail-scroll"><div data-app-rail-pill id="rail-pill"><button id="home">Home</button></div></div></nav>
    <div data-windows-row id="ni-content-panel">
      <div id="ni-chat-strip-slot">
        <div data-chat-composer-dock id="dock">
          <div data-chat-composer id="composer-zone">
            <div ${EMPTY_PRESS_ZONE_ATTR} id="reading-col"><div id="composer-box"><textarea id="field"></textarea><span id="composer-pad"></span></div></div>
          </div>
        </div>
      </div>
      <aside data-page-panel id="page-panel"><div data-page-panel-card id="panel-card"><div id="panel-row">Channels</div></div></aside>
      <aside data-side-panel id="side-panel"><div id="side-card">For you</div></aside>
    </div>`
  document.body.append(shell)
  container = document.createElement('div')
  stage = document.createElement('div')
  document.body.append(container, stage)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('data-app-rail')
  delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate
  HTMLElement.prototype.getBoundingClientRect = realRect
  __resetMinimizedForTests()
  __resetTileFlightForTests()
})

/** A frame or two into a flight: before its hand-over. */
const nextFrame = () => act(async () => new Promise((r) => setTimeout(r, 60)))
/** Past a flight's hand-over (tile-flight.ts TILE_HANDOFF_MS: the card leaves or enters full screen then, the copy still flying). */
const pastHandOver = () => act(async () => new Promise((r) => setTimeout(r, TILE_HANDOFF_MS + 40)))
/** The flyer's parts: the window that moves, the frame's shade, the copy, the tile's edge. */
const flightWindow = () => document.querySelector<HTMLElement>('[data-tile-flight-window]')

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)))
const el = (id: string) => document.getElementById(id) as HTMLElement
const tile = () => document.querySelector<HTMLElement>('[data-minimized-card]')
const reopen = () => tile()!.querySelector<HTMLButtonElement>('button[aria-label^="Reopen"]')!
const preview = () => tile()?.querySelector<HTMLElement>('[data-minimized-card-preview]') ?? null
const layer = () => document.querySelector<HTMLElement>('[data-chat-card-fullscreen]')
function press(target: Element, button = 0): MouseEvent {
  const e = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button })
  target.dispatchEvent(e)
  return e
}

/** The cards in one chat's store, each a ShowToolCard (`kept` for a page the person opened), with the shell's tile and rule. */
async function mount(cards: Array<{ id: string; spec: CardSpec; kept?: boolean }>, store = new ChatCardStore()) {
  store.setCards(cards.map((c) => ({ id: c.id, spec: c.spec, ...(c.kept ? { opened: true } : {}) })))
  await act(async () => {
    root.render(
      h(
        Fragment,
        null,
        h(Suspense, { fallback: null }, h(ChatCardHostProvider, {
          value: { wide: true, store, stage },
          children: cards.map((c) => h(ShowToolCard, { key: c.id, toolCallId: c.id, spec: c.spec, count: null, ...(c.kept ? { place: 'kept' as const, opened: true } : {}) })),
        })),
        h(EmptyPressMinimizes),
        h(MinimizedCardTile),
      ),
    )
  })
  await flush()
  return store
}

async function open(store: ChatCardStore, id: string) {
  await act(async () => store.enterFullScreen(id))
  await flush()
}

describe('isEmptyAppPress: one test of what is empty', () => {
  beforeEach(() => {
    const l = document.createElement('div')
    l.setAttribute('data-chat-card-fullscreen', 'x')
    l.id = 'layer'
    l.innerHTML = `<div data-full-screen-control id="listen"><span id="listen-inner"></span></div>
      <div id="stage"><div id="column"><div data-chat-card-frame id="frame"><div id="title">Mail</div></div><div id="controls"><button id="min">Min</button></div></div></div>`
    document.body.append(l)
    const pop = document.createElement('div')
    pop.innerHTML = '<div role="menu" id="menu-item">Item</div><div data-sonner-toaster id="toast">Saved</div>'
    document.body.append(pop)
  })

  it('every empty zone: the card layer round the card, the row under the panel, the strip, the dock and the bands beside the composer', () => {
    for (const id of ['layer', 'stage', 'column', 'controls', 'ni-shell-root', 'ni-content-panel', 'ni-chat-strip-slot', 'dock', 'composer-zone', 'reading-col']) {
      expect(isEmptyAppPress(el(id)), id).toBe(true)
    }
    expect(isEmptyAppPress(document.body)).toBe(true)
  })

  it('never a surface: the card, a control, the composer box, the panels’ cards, the rail, anything portalled', () => {
    for (const id of ['frame', 'title', 'min', 'listen', 'listen-inner', 'composer-box', 'field', 'composer-pad', 'panel-card', 'panel-row', 'side-card', 'rail-header', 'search', 'rail-pill', 'home', 'rail-nav', 'rail-scroll', 'menu-item', 'toast']) {
      expect(isEmptyAppPress(el(id)), id).toBe(false)
    }
    expect(isEmptyAppPress(null)).toBe(false)
  })
})

describe('an empty press minimizes the card in front, from md up beside the rail', () => {
  it('on every empty zone, Team chat’s lower left included, once per press', async () => {
    const store = await mount([{ id: 'team', spec: TEAM, kept: true }])
    const exit = vi.spyOn(store, 'exitFullScreen')
    for (const id of ['ni-content-panel', 'composer-zone', 'reading-col', 'dock', 'ni-shell-root']) {
      await open(store, 'team')
      expect(frontCard()?.id, id).toBe('team')
      exit.mockClear()
      let e!: MouseEvent
      await act(async () => {
        e = press(el(id))
      })
      expect(e.defaultPrevented, id).toBe(true)
      expect(exit, id).toHaveBeenCalledTimes(1)
      expect(store.fullScreen(), id).toBeNull()
    }
    // The card's own layer, around the card: the rule, not the layer's handler a second time.
    await open(store, 'team')
    exit.mockClear()
    await act(async () => {
      press(layer()!)
    })
    expect(exit).toHaveBeenCalledTimes(1)
    expect(store.fullScreen()).toBeNull()
  })

  it('never on a surface: the card, its page, the composer box, the panel’s card, the rail; nor a secondary press', async () => {
    const store = await mount([{ id: 'team', spec: TEAM, kept: true }])
    await open(store, 'team')
    const frame = document.querySelector('[data-chat-card-frame]')!
    for (const target of [frame, el('in-page'), el('composer-box'), el('field'), el('panel-card'), el('panel-row'), el('rail-pill'), el('rail-header')]) {
      await act(async () => {
        press(target)
      })
      expect(store.fullScreen(), target.id || 'frame').toBe('team')
    }
    await act(async () => {
      press(el('ni-content-panel'), 2)
    })
    expect(store.fullScreen()).toBe('team')
  })

  it('below md: as before, only the layer’s own press puts it back, and no tile', async () => {
    wide = false
    const store = await mount([{ id: 'team', spec: TEAM, kept: true }])
    await open(store, 'team')
    await act(async () => {
      press(el('ni-content-panel'))
    })
    expect(store.fullScreen()).toBe('team')
    await act(async () => {
      press(layer()!)
    })
    expect(store.fullScreen()).toBeNull()
    await flush()
    expect(tile()).toBeNull()
    expect(minimizedCard()).toBeNull()
  })
})

describe('the tile at the bottom left', () => {
  it('draws nothing on the server or while hydrating: its slot and tile only once mounted, only in <body>', async () => {
    const tree = () => h(Fragment, null, h('main', { id: 'shell-main' }, 'App'), h(EmptyPressMinimizes), h(MinimizedCardTile, { resetKey: null }))
    expect(renderToString(h(MinimizedCardTile, { resetKey: null }))).toBe('')
    const host = document.createElement('div')
    host.innerHTML = renderToString(tree())
    expect(host.innerHTML).toBe('<main id="shell-main">App</main>')
    document.body.append(host)
    const recoverable = vi.fn()
    let hydrated!: Root
    await act(async () => {
      hydrated = hydrateRoot(host, tree(), { onRecoverableError: recoverable })
    })
    await flush()
    expect(recoverable).not.toHaveBeenCalled()
    // Mounted: the slot is drawn, in <body>, never in the shell's tree.
    const slot = document.querySelector('[data-minimized-tile-slot]')
    expect(slot).not.toBeNull()
    expect(host.contains(slot)).toBe(false)
    expect(slot!.parentElement).toBe(document.body)
    act(() => hydrated.unmount())
  })

  it('shows the card that was minimized, however it was: a preview, nothing over it, its title its label and tooltip', async () => {
    const store = await mount([
      { id: 'team', spec: TEAM, kept: true },
      { id: 'list', spec: LIST },
    ])
    const exits: Array<[string, string, () => void]> = [
      ['team', 'Esc', () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))],
      ['team', 'its X', () => (layer()!.querySelector('[data-testid="card-close"]') as HTMLElement).click()],
      ['team', 'Home', () => minimizeFrontCards()],
      ['team', 'a send', () => closeFrontCards()],
      ['team', 'an empty press', () => press(el('ni-content-panel'))],
      ['list', 'Back into the chat', () => (layer()!.querySelector('[data-testid="card-minimize"]') as HTMLElement).click()],
    ]
    for (const [id, how, leave] of exits) {
      await open(store, id)
      // A card in front: the tile, if any, is away meanwhile (faded, inert).
      if (tile()) {
        expect(tile()!.hasAttribute('data-minimized-away'), how).toBe(true)
        expect(tile()!.hasAttribute('inert'), how).toBe(true)
      }
      await act(async () => leave())
      await flush()
      expect(store.fullScreen(), how).toBeNull()
      expect(tile()?.getAttribute('data-minimized-card'), how).toBe(id)
      const title = id === 'team' ? 'Team chat' : 'Due this week'
      expect(tile()!.hasAttribute('data-minimized-away'), how).toBe(false)
      expect(tile()!.querySelector('button')!.getAttribute('aria-label'), how).toBe(`Reopen ${title}`)
      expect(tile()!.querySelector('button')!.getAttribute('title'), how).toBe(title)
      // Nothing over the preview (Liam, 11-11: the strip with the page's icon "is not needed").
      expect(tile()!.querySelector('[data-minimized-card-strip]'), how).toBeNull()
    }
    // The card's fate is as before: the chat card back in its message, the page put away.
    expect(document.querySelector('[data-chat-card="list"]')).not.toBeNull()
  })

  it('its own flight into it: one copy, the ⌘K palette’s curve over MINIMIZE_FLIGHT_MS, onto the preview’s rectangle with the tile’s outline and edge; home fading in behind it; the tile whole in the frame the copy goes, no opacity transition, no settle', async () => {
    const store = await mount([{ id: 'mail', spec: MAIL, kept: true }])
    await open(store, 'mail')
    animate.mockClear()
    finish.length = 0
    await act(async () => store.exitFullScreen())
    await flush()
    const flyer = document.querySelector<HTMLElement>('[data-card-reply-flight]')
    expect(flyer).not.toBeNull()
    // One window in it, one copy: the frame's, light (its page's embedded frame left out), at the frame's measured height; not the preview itself.
    expect(flyer!.children).toHaveLength(1)
    const mover = flightWindow()!
    const shade = mover.querySelector<HTMLElement>('[data-tile-flight-shade]')!
    const edge = mover.querySelector<HTMLElement>('[data-tile-flight-edge]')!
    const copy = mover.children[1] as HTMLElement
    expect([...mover.children]).toEqual([shade, copy, edge])
    expect(copy.querySelector('iframe')).toBeNull()
    expect(copy.textContent).toContain('Row')
    expect(copy.style.height).toBe(`${FRAME_RECT.height}px`)
    expect(copy).not.toBe(minimizedCard()!.preview!.copy)
    expect(preview()!.firstElementChild).toBe(minimizedCard()!.preview!.copy)
    // The window's move, the copy's outline, the tile's edge (its box, its fade) and the frame's shade; and home
    // (what the card hid: here the row's side panel) fading in behind the window, clear until it is off the chat.
    expect(animate.mock.contexts).toEqual([mover, copy, edge, edge, shade, el('side-panel')])
    const [frames, timing] = animate.mock.calls[0] as [Array<{ offset: number; transform: string }>, KeyframeAnimationOptions]
    expect(timing).toEqual({ duration: MINIMIZE_FLIGHT_MS, easing: PALETTE_ENTRANCE_EASING, fill: 'forwards' })
    const [arrive, arriving] = animate.mock.calls[5] as [Keyframe[], KeyframeAnimationOptions]
    expect(arrive).toEqual([{ opacity: 0, offset: 0 }])
    expect(arriving.fill).toBe('backwards')
    expect(arriving.delay).toBeGreaterThan(0)
    // From the frame, to the preview's rectangle in the tile: the window into its own thumbnail.
    expect(frames[0].transform).toBe(`translate(${FRAME_RECT.left}px, ${FRAME_RECT.top}px) scale(1)`)
    const s = coverScale(FRAME_RECT.width, FRAME_RECT.height, TILE_RECT.width, TILE_RECT.height)
    expect(frames.at(-1)!.transform).toBe(`translate(${TILE_RECT.left}px, ${TILE_RECT.top}px) scale(${s})`)
    // The tile hidden meanwhile, with no opacity transition.
    expect(tile()!.style.opacity).toBe('0')
    expect(tile()!.style.transitionProperty).not.toContain('opacity')
    // Landed: the flyer goes and the tile shows in one go; nothing settles after.
    finish[0]()
    await flush()
    expect(document.querySelector('[data-card-reply-flight]')).toBeNull()
    expect(tile()!.style.opacity).toBe('')
    expect(animate).toHaveBeenCalledTimes(6)
  })

  it('an empty press: the flight first, round the page panel and under it, the tile drawn for the hand-over; the card put away half way through the flight, home arriving as the window lands', async () => {
    laidOut = true
    const store = await mount([{ id: 'team', spec: TEAM, kept: true }])
    await open(store, 'team')
    animate.mockClear()
    finish.length = 0
    await act(async () => void press(el('ni-content-panel')))
    // In the air already, the card still full screen, its frame hidden under its copy.
    const flyer = document.querySelector<HTMLElement>('[data-card-reply-flight]')
    expect(flyer).not.toBeNull()
    expect(flyer!.style.clipPath).toBe(panelClip({ left: PANEL_RECT.left, top: PANEL_RECT.top, right: PANEL_RECT.left + PANEL_RECT.width, bottom: PANEL_RECT.top + PANEL_RECT.height }))
    expect(store.fullScreen()).toBe('team')
    expect(document.querySelector<HTMLElement>('[data-chat-card-frame]')!.style.opacity).toBe('0')
    const [frames] = animate.mock.calls[0] as [Array<{ transform: string }>]
    // Never over the panel: right of it until below it.
    for (const f of frames) {
      const [x, y] = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(f.transform)!.slice(1).map(Number)
      expect(x >= PANEL_RECT.left + PANEL_RECT.width || y >= PANEL_RECT.top + PANEL_RECT.height, f.transform).toBe(true)
    }
    // The tile is drawn now, for the hand-over: not away though the card is in front, hidden, not to be pressed yet.
    await flush()
    expect(tile()?.getAttribute('data-minimized-card')).toBe('team')
    expect(tile()!.hasAttribute('data-minimized-away')).toBe(false)
    expect(tile()!.hasAttribute('inert')).toBe(true)
    expect(tile()!.style.opacity).toBe('0')
    expect(preview()?.firstElementChild?.textContent).toContain('Row')
    // A frame on, on its way out: the card is not put away yet (nothing else runs while the window leaves), and nothing but the window moves.
    await nextFrame()
    expect(store.fullScreen()).toBe('team')
    expect(animate).toHaveBeenCalledTimes(5)
    // Half way (the window all but in the tile): the card leaves full screen, the copy still flying over a tile still hidden;
    // home (what the card hid) fades in from that commit.
    await pastHandOver()
    expect(store.fullScreen()).toBeNull()
    expect(frontCard()).toBeNull()
    expect(document.querySelector('[data-card-reply-flight]')).not.toBeNull()
    expect(tile()!.style.opacity).toBe('0')
    expect(tile()!.hasAttribute('inert')).toBe(false)
    expect(animate).toHaveBeenCalledTimes(6)
    expect(animate.mock.contexts[5]).toBe(el('side-panel'))
    expect(animate.mock.calls[5][0]).toEqual([{ opacity: 0, offset: 0 }])
    // Landed: the flyer goes and the tile is whole, in one go.
    finish[0]()
    await flush()
    expect(document.querySelector('[data-card-reply-flight]')).toBeNull()
    expect(store.fullScreen()).toBeNull()
    expect(tile()?.getAttribute('data-minimized-card')).toBe('team')
    expect(tile()!.style.opacity).toBe('')
    expect(tile()!.hasAttribute('inert')).toBe(false)
  })

  it('the page’s X and Home on the rail minimize the same way: the flight first, the card put away half way', async () => {
    laidOut = true
    const store = await mount([{ id: 'team', spec: TEAM, kept: true }])
    for (const leave of [() => (layer()!.querySelector('[data-testid="card-close"]') as HTMLElement).click(), () => minimizeFrontCards()]) {
      await open(store, 'team')
      finish.length = 0
      await act(async () => leave())
      expect(document.querySelector('[data-tile-flight="into"]')).not.toBeNull()
      expect(store.fullScreen()).toBe('team')
      await pastHandOver()
      expect(store.fullScreen()).toBeNull()
      finish[0]()
      await flush()
      expect(document.querySelector('[data-card-reply-flight]')).toBeNull()
      expect(tile()?.getAttribute('data-minimized-card')).toBe('team')
    }
  })

  it('under reduced motion: the tile, no flight', async () => {
    reducedMotion = true
    const store = await mount([{ id: 'mail', spec: MAIL, kept: true }])
    await open(store, 'mail')
    animate.mockClear()
    finish.length = 0
    await act(async () => store.exitFullScreen())
    await flush()
    expect(tile()).not.toBeNull()
    expect(document.querySelector('[data-card-reply-flight]')).toBeNull()
    expect(animate).not.toHaveBeenCalled()
    // The preview is no flight: it is there all the same.
    expect(preview()?.firstElementChild?.textContent).toContain('Row')
  })

  it('a click grows the card back out of it at once, home leaving with its first move; the card full screen half way through the flight, its frame mounted under the copy and shown in the frame the copy goes', async () => {
    const store = await mount([{ id: 'team', spec: TEAM, kept: true }])
    await open(store, 'team')
    await act(async () => store.exitFullScreen())
    await flush()
    finish[0]?.()
    await flush()
    animate.mockClear()
    finish.length = 0
    await act(async () => reopen().click())
    // In the air at once, out of the tile (gone in that frame), back the way it came.
    expect(document.querySelector('[data-tile-flight="out"]')).not.toBeNull()
    expect(tile()!.style.opacity).toBe('0')
    const [frames, timing] = animate.mock.calls[0] as [Array<{ transform: string }>, KeyframeAnimationOptions]
    expect(timing).toEqual({ duration: MINIMIZE_FLIGHT_MS, easing: PALETTE_ENTRANCE_EASING, fill: 'forwards' })
    expect(frames[0].transform).toMatch(new RegExp(`^translate\\(${TILE_RECT.left}px, ${TILE_RECT.top}px\\)`))
    expect(frames.at(-1)!.transform).toBe(`translate(${FRAME_RECT.left}px, ${FRAME_RECT.top}px) scale(1)`)
    // Home leaves with the window's first move (what the card will hide: here the row's side panel), before the window is over it:
    // its glass is never seen through (Liam, 11-11: "the panel is transparent and you see thorugh it and looks broken").
    expect(animate).toHaveBeenCalledTimes(6)
    expect(animate.mock.contexts[5]).toBe(el('side-panel'))
    const [leave, leaving] = animate.mock.calls[5] as [Keyframe[], KeyframeAnimationOptions]
    expect(leave).toEqual([{ opacity: 0, offset: 1 }])
    expect(leaving.fill).toBe('forwards')
    const homeFade = animate.mock.results[5].value as { cancel: ReturnType<typeof vi.fn> }
    // Its first frames: the page is not asked for yet; a second click does nothing meanwhile.
    await nextFrame()
    expect(store.fullScreen()).toBeNull()
    await act(async () => reopen().click())
    expect(animate).toHaveBeenCalledTimes(6)
    expect(homeFade.cancel).not.toHaveBeenCalled()
    // Half way: the card is full screen, its frame mounted hidden under the copy still flying; home's fade is let go (the card's CSS hides it now).
    await pastHandOver()
    expect(store.fullScreen()).toBe('team')
    const frame = document.querySelector<HTMLElement>('[data-chat-card-frame]')!
    expect(frame.style.opacity).toBe('0')
    expect(document.querySelector('[data-card-reply-flight]')).not.toBeNull()
    expect(homeFade.cancel).toHaveBeenCalledTimes(1)
    // Landed: the copy goes and the frame shows in one go; nothing settles.
    finish[0]()
    await flush()
    expect(frame.style.opacity).toBe('')
    expect(document.querySelector('[data-card-reply-flight]')).toBeNull()
    expect(animate).toHaveBeenCalledTimes(6)
    // The tile fades away while a card is full screen (Liam, 11-11), kept to fade back.
    expect(tile()!.hasAttribute('data-minimized-away')).toBe(true)
    expect(tile()!.className).toContain('opacity-0')
    // Minimized again: back in the tile.
    await act(async () => store.exitFullScreen())
    await flush()
    expect(tile()?.getAttribute('data-minimized-card')).toBe('team')
  })

  it('a page switch leaves it as it was, and it is away while any card is full screen (Liam, 11-11: "it should only show when you minimize")', async () => {
    const store = await mount([
      { id: 'team', spec: TEAM, kept: true },
      { id: 'mail', spec: MAIL, kept: true },
    ])
    await open(store, 'team')
    await act(async () => store.exitFullScreen())
    await flush()
    expect(tile()?.getAttribute('data-minimized-card')).toBe('team')
    // Mail opened: the tile (still Team chat) fades away.
    await open(store, 'mail')
    expect(tile()?.getAttribute('data-minimized-card')).toBe('team')
    expect(tile()!.hasAttribute('data-minimized-away')).toBe(true)
    // Mail to Team chat in place (a page switch): Mail is not minimized, nothing flies.
    animate.mockClear()
    const flyersBefore = document.querySelectorAll('[data-card-reply-flight]').length
    await act(async () => store.enterFullScreen('team'))
    await flush()
    expect(store.fullScreen()).toBe('team')
    expect(tile()?.getAttribute('data-minimized-card')).toBe('team')
    expect(tile()!.hasAttribute('data-minimized-away')).toBe(true)
    expect(document.querySelectorAll('[data-card-reply-flight]').length).toBe(flyersBefore)
    // Team chat to Mail in place: still not.
    await act(async () => store.enterFullScreen('mail'))
    await flush()
    expect(tile()?.getAttribute('data-minimized-card')).toBe('team')
    // Mail minimized: now it is the tile's, and the tile is back.
    await act(async () => store.exitFullScreen())
    await flush()
    expect(tile()?.getAttribute('data-minimized-card')).toBe('mail')
    expect(tile()!.hasAttribute('data-minimized-away')).toBe(false)
  })

  it('a newer card replaces it: one tile', async () => {
    const store = await mount([
      { id: 'team', spec: TEAM, kept: true },
      { id: 'mail', spec: MAIL, kept: true },
    ])
    await open(store, 'team')
    await act(async () => store.exitFullScreen())
    await open(store, 'mail')
    await act(async () => store.exitFullScreen())
    await flush()
    expect(document.querySelectorAll('[data-minimized-card]').length).toBe(1)
    expect(tile()?.getAttribute('data-minimized-card')).toBe('mail')
    // One preview: Mail's.
    expect(document.querySelectorAll('[data-minimized-card-preview]').length).toBe(1)
    expect(preview()!.firstElementChild).toBe(minimizedCard()!.preview!.copy)
  })

  it('its × clears it', async () => {
    const store = await mount([{ id: 'team', spec: TEAM, kept: true }])
    await open(store, 'team')
    await act(async () => store.exitFullScreen())
    await flush()
    const copy = minimizedCard()!.preview!.copy
    expect(copy.isConnected).toBe(true)
    const clear = tile()!.querySelector<HTMLButtonElement>('[data-minimized-card-clear]')!
    expect(clear.getAttribute('aria-label')).toBe('Clear Team chat')
    // The open view's header close (Liam, 11-11: "make it match the x button on the open view with the round border behind it"):
    // a 28px circle, the X at size-4 and 1.75, muted to foreground, the same hover tint, on a round backing with a 1px edge.
    const close = ['grid', 'size-7', 'place-items-center', 'rounded-full', 'text-muted-foreground', 'hover:text-foreground']
    for (const c of [...close, 'border', 'border-border/60', 'bg-background/70', 'backdrop-blur-md', 'hover:before:bg-foreground/[0.06]']) expect(clear.classList.contains(c), c).toBe(true)
    const icon = clear.querySelector('svg')!
    expect(icon.getAttribute('class')).toContain('size-4')
    expect(icon.getAttribute('stroke-width')).toBe('1.75')
    // Inside the tile's 24px corner curve.
    expect(clear.className).toContain('right-2.5')
    expect(clear.className).toContain('top-2.5')
    await act(async () => clear.click())
    expect(tile()).toBeNull()
    expect(minimizedCard()).toBeNull()
    // Its copy let go: out of the page, held by nothing here.
    expect(copy.isConnected).toBe(false)
  })

  it('goes when its card is no more: dropped from its chat, or folded for good', async () => {
    const store = await mount([
      { id: 'team', spec: TEAM, kept: true },
      { id: 'list', spec: LIST },
    ])
    await open(store, 'list')
    await act(async () => store.exitFullScreen())
    await flush()
    expect(tile()).not.toBeNull()
    await act(async () => store.collapse('list'))
    await flush()
    expect(tile()).toBeNull()

    await open(store, 'team')
    await act(async () => store.exitFullScreen())
    await flush()
    expect(tile()).not.toBeNull()
    // Another conversation: its cards gone.
    await act(async () => store.setCards([{ id: 'other', spec: LIST }]))
    await flush()
    expect(tile()).toBeNull()
  })
})

describe('the tile is a mini window (Liam, 11-11: "a preview of the window not just a tab")', () => {
  it('holds a still copy of the frame as it left: no ids, data, names, links, focus, media or animations; inert, hidden, scaled to cover', async () => {
    const store = await mount([{ id: 'mail', spec: MAIL, kept: true }])
    await open(store, 'mail')
    await act(async () => store.exitFullScreen())
    await flush()
    const box = preview()!
    expect(box.hasAttribute('inert')).toBe(true)
    expect(box.getAttribute('aria-hidden')).toBe('true')
    expect(box.className).toContain('pointer-events-none')
    expect(box.className).toContain('[contain:strict]')
    expect(box.className).toContain('[&_*]:[animation:none]!')
    expect(box.className).toContain('[&_*]:[transition:none]!')
    expect(box.children.length).toBe(1)
    const copy = box.firstElementChild as HTMLElement
    expect(copy.textContent).toContain('Row')
    expect(copy.querySelector('iframe, video, audio, canvas, object, embed')).toBeNull()
    for (const node of [copy, ...copy.querySelectorAll('*')]) {
      expect(node.id, node.localName).toBe('')
      const banned = node.getAttributeNames().filter((n) => n.startsWith('data-') || ['name', 'tabindex', 'href', 'autofocus', 'contenteditable'].includes(n))
      expect(banned, node.localName).toEqual([])
      expect(node.getAttribute('class') ?? '', node.localName).not.toContain('animate-')
    }
    // The spinner kept its other classes.
    expect(copy.querySelector('span.size-3')).not.toBeNull()
    // Still: no animation, transition or compositing hint of its own; scaled to cover the tile's box (296×185) from its top-left.
    expect(copy.style.animation).toContain('none')
    expect(copy.style.transition).toContain('none')
    expect(copy.style.willChange).toBe('auto')
    expect(copy.style.transformOrigin).toBe('0 0')
    expect(copy.style.transform).toBe(coverTransform(FRAME_RECT.width, FRAME_RECT.height, MINIMIZED_TILE_W_PX, MINIMIZED_TILE_H_PX))
    // Nothing animates it or anything in it.
    expect(animate.mock.contexts.some((c) => c === copy || copy.contains(c as Node))).toBe(false)
  })

  it('covers its box keeping the frame’s aspect: centred across, cut at the foot', () => {
    // 16:10 into 16:10: just the scale.
    expect(coverTransform(1000, 625, 192, 120)).toBe('translate(0px, 0px) scale(0.192)')
    // Taller: the width fills, the foot is cut.
    expect(coverTransform(1000, 800, 192, 120)).toBe('translate(0px, 0px) scale(0.192)')
    // Wider: the height fills, centred across.
    expect(coverTransform(1600, 625, 192, 120)).toBe('translate(-57.6px, 0px) scale(0.192)')
    expect(coverTransform(0, 0, 192, 120)).toBe('none')
  })

  it('as wide as the page panel at the most (296×185; Liam, 11-11: "the width should match the width of the sub-nav panel"), narrower where the centred composer would be under it, 120 wide at the least, at 16:10', async () => {
    expect(MINIMIZED_TILE_W_PX).toBe(PAGE_PANEL_WIDTH_PX)
    expect(MINIMIZED_TILE_H_PX).toBe(185)
    const width = minimizedTileWidth(4)
    expect(width.startsWith('clamp(120px, calc(')).toBe(true)
    expect(width.endsWith(`, ${PAGE_PANEL_WIDTH_PX}px)`)).toBe(true)
    expect(width).toContain('var(--chat-reading-max, 634px)')
    // Worked through at 1024px wide on the web (rail 60px, inset 4px): the composer's box starts 175px past the rail.
    const strip = 1024 - 60
    const composerLeft = (strip - Math.min(0.9 * strip, 634)) / 2 + 10
    const w = Math.min(MINIMIZED_TILE_W_PX, Math.max(120, composerLeft - 4 - 12))
    expect(w).toBe(159)
    expect(4 + w + 12).toBeLessThanOrEqual(composerLeft)
    const store = await mount([{ id: 'team', spec: TEAM, kept: true }])
    await open(store, 'team')
    await act(async () => store.exitFullScreen())
    await flush()
    expect(tile()!.className).toContain('aspect-[16/10]')
    // The page panel's 24px corners, as wide as it.
    expect(tile()!.className).toContain('rounded-3xl')
    expect(tile()!.style.bottom).toBe('12px')
    // Keyboard: its button first and reachable, the × shown while the focus is in the tile.
    expect(tile()!.querySelector('button')).toBe(reopen())
    expect(tile()!.querySelector('[data-minimized-card-clear]')!.className).toContain('group-has-[:focus-visible]/tile:opacity-100')
  })
})
