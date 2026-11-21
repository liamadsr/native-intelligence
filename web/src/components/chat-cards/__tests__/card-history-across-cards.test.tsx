// @vitest-environment jsdom
/**
 * Back and Forward across cards (card-history.tsx "Across cards"): a card
 * opened from a link inside another card goes back to that card, where the
 * person left it, at the start of its own steps; the card gone back to goes
 * Forward to it again. Chains walk all the way back, a card gone from the
 * chat is never gone to, and a link into another workspace says why Back
 * can't follow it. The link's card is read from the click
 * (open-card.ts originCardOf) and carried on the open request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ChatCardStore } from '../card-store'
import { CardHistoryButtons } from '../card-history'
import { OPEN_CARD_EVENT, openTarget, originCardOf, parseOpenCardRequest, type OpenCardRequest } from '@/lib/chat-cards/open-card'
import type { CardSpec } from '@/lib/chat-cards/kinds'

const record = (type: 'action' | 'document', id: string, title: string): CardSpec => ({ kind: 'record', title, record: { type, id } })

/** Lets the same-event merge window close (a later click is a step of its own). */
const nextTask = () => new Promise((r) => setTimeout(r, 0))

/** A chat holding the person's opened cards, A full screen (as a card opened from a link is). */
function chat(...ids: string[]): ChatCardStore {
  const store = new ChatCardStore()
  store.setCards(ids.map((id) => ({ id, spec: record('action', id, `ENG-${id}`), opened: true })))
  store.enterFullScreen(ids[0])
  return store
}

/** What chat-panel.tsx openCardHere does for a link inside a card: the origin linked, then the new card in front. */
function openFrom(store: ChatCardStore, originId: string, id: string) {
  store.linkOrigin(id, originId)
  store.enterFullScreen(id)
}

beforeEach(() => window.localStorage.clear())
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('Back and Forward across cards', () => {
  it('goes back to the card the link was in, and Forward opens the new one again', () => {
    const store = chat('a', 'b')
    openFrom(store, 'a', 'b')
    const b = store.history('b')
    const a = store.history('a')
    expect(b.canGoBack).toBe(true)
    expect(b.hopFor(-1)?.cardId).toBe('a')
    expect(b.hopFor(-1)?.label).toBe('ENG-a')
    expect(a.canGoForward).toBe(false)

    expect(b.go(-1)).toBe(true)
    expect(store.fullScreen()).toBe('a')
    expect(a.canGoForward).toBe(true)
    expect(a.hopFor(1)?.cardId).toBe('b')

    expect(a.go(1)).toBe(true)
    expect(store.fullScreen()).toBe('b')
    // And back again: the hop is still B's first step's Back.
    expect(b.go(-1)).toBe(true)
    expect(store.fullScreen()).toBe('a')
  })

  it("walks the new card's own steps first, and lands the origin on the step it was left on", async () => {
    const store = chat('a', 'b')
    const a = store.history('a')
    a.read('open', () => null)
    a.push('open', { type: 'document', id: 'doc-1' })
    await nextTask()
    openFrom(store, 'a', 'b')
    // The origin moved on meanwhile (its body's own navigation): the hop brings it back to where the link was.
    a.go(-1)
    expect(a.read('open', () => 'x')).toBeNull()

    const b = store.history('b')
    b.read('open', () => null)
    b.push('open', { type: 'document', id: 'doc-2' })
    await nextTask()
    b.go(-1)
    expect(store.fullScreen()).toBe('b')
    expect(b.read('open', () => 'x')).toBeNull()
    b.go(-1)
    expect(store.fullScreen()).toBe('a')
    expect(a.read('open', () => 'x')).toEqual({ type: 'document', id: 'doc-1' })
    // Forward reopens B where it was.
    a.go(1)
    expect(store.fullScreen()).toBe('b')
    expect(b.read('open', () => 'x')).toBeNull()
    b.go(1)
    expect(b.read('open', () => 'x')).toEqual({ type: 'document', id: 'doc-2' })
  })

  it('chains: A → B → C, then Back, Back reaches A, and Forward, Forward reaches C', () => {
    const store = chat('a', 'b', 'c')
    openFrom(store, 'a', 'b')
    openFrom(store, 'b', 'c')
    store.history('c').go(-1)
    expect(store.fullScreen()).toBe('b')
    store.history('b').go(-1)
    expect(store.fullScreen()).toBe('a')
    store.history('a').go(1)
    expect(store.fullScreen()).toBe('b')
    store.history('b').go(1)
    expect(store.fullScreen()).toBe('c')
  })

  it("a new step on the card gone back to drops its Forward to the other, as a browser's does", async () => {
    const store = chat('a', 'b')
    openFrom(store, 'a', 'b')
    store.history('b').go(-1)
    const a = store.history('a')
    expect(a.canGoForward).toBe(true)
    a.push('open', { type: 'document', id: 'doc-9' })
    expect(a.canGoForward).toBe(false)
  })

  it('stays where it is when the card it came from is gone from the chat, never an error', () => {
    const store = chat('a', 'b')
    openFrom(store, 'a', 'b')
    store.setCards([{ id: 'b', spec: record('action', 'b', 'ENG-b'), opened: true }])
    const b = store.history('b')
    expect(b.canGoBack).toBe(false)
    expect(b.hopFor(-1)).toBeNull()
    expect(b.go(-1)).toBe(false)
  })

  it('stays where it is when the card it came from was an inline card the person closed', () => {
    const store = new ChatCardStore()
    store.setCards([
      { id: 'inline', spec: record('document', 'd', 'Spec doc') },
      { id: 'b', spec: record('action', 'b', 'ENG-b'), opened: true },
    ])
    openFrom(store, 'inline', 'b')
    expect(store.history('b').canGoBack).toBe(true)
    store.collapse('inline')
    expect(store.history('b').canGoBack).toBe(false)
  })

  it('puts the new card away to show an inline card the link was in, instead of making it full screen', () => {
    const store = new ChatCardStore()
    store.setCards([
      { id: 'inline', spec: record('document', 'd', 'Spec doc') },
      { id: 'b', spec: record('action', 'b', 'ENG-b'), opened: true },
    ])
    openFrom(store, 'inline', 'b')
    store.history('b').go(-1)
    expect(store.fullScreen()).toBeNull()
    expect(store.history('inline').hopFor(1)?.cardId).toBe('b')
    store.history('inline').go(1)
    expect(store.fullScreen()).toBe('b')
  })

  it('a link into another workspace: Back is disabled and says why', () => {
    const store = chat('b')
    store.linkOrigin('b', 'gone', { unavailable: 'the card you came from is in another workspace' })
    const b = store.history('b')
    expect(b.canGoBack).toBe(false)
    expect(b.hopFor(-1)?.unavailable).toMatch(/another workspace/)
    expect(b.go(-1)).toBe(false)
  })

  it('does nothing for a link that opens the card it is in, or names a card not in this chat', () => {
    const store = chat('a')
    store.linkOrigin('a', 'a')
    store.linkOrigin('a', 'elsewhere')
    expect(store.history('a').canGoBack).toBe(false)
  })
})

describe('the Back button across cards', () => {
  let host: HTMLDivElement
  let root: Root
  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('names where it goes, and the unavailable one says why', async () => {
    const store = chat('a', 'b', 'c')
    openFrom(store, 'a', 'b')
    store.linkOrigin('c', 'x', { unavailable: 'the card you came from is in another workspace' })
    await act(async () => root.render(React.createElement(CardHistoryButtons, { history: store.history('b') })))
    const back = host.querySelector<HTMLButtonElement>('[data-testid="card-back"]')!
    expect(back.disabled).toBe(false)
    expect(back.getAttribute('aria-label')).toBe('Back to ENG-a')
    expect(back.title).toBe('Back to ENG-a (⌘/Ctrl+[)')
    await act(async () => back.click())
    expect(store.fullScreen()).toBe('a')

    await act(async () => root.render(React.createElement(CardHistoryButtons, { history: store.history('c') })))
    const disabled = host.querySelector<HTMLButtonElement>('[data-testid="card-back"]')!
    expect(disabled.disabled).toBe(true)
    expect(disabled.title).toBe('Go back: the card you came from is in another workspace')
  })
})

describe('the open request carries the card the link was in', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('reads the card a clicked chip is in, inline or full screen, and nothing outside every card', () => {
    document.body.innerHTML = `
      <div data-chat-card="card-1"><span id="in-inline">chip</span></div>
      <div data-chat-card-fullscreen="card-2"><p><span id="in-full">chip</span></p></div>
      <div id="composer"><span id="outside">chip</span></div>`
    expect(originCardOf(document.getElementById('in-inline'))).toBe('card-1')
    expect(originCardOf(document.getElementById('in-full'))).toBe('card-2')
    expect(originCardOf(document.getElementById('outside'))).toBeNull()
    // No event being handled and no node: no origin (a timer, a notification's own open).
    expect(originCardOf()).toBeNull()
  })

  it("follows a popover portaled out of the card back to its trigger (an entity chip's quick edit)", () => {
    document.body.innerHTML = `
      <div data-chat-card-fullscreen="card-4"><button aria-controls="radix-:r7:">ENG-42</button></div>
      <div data-radix-popper-content-wrapper=""><div id="radix-:r7:" role="dialog"><button id="open">Open</button></div></div>
      <div data-radix-popper-content-wrapper=""><div id="radix-:r9:"><button id="loose">Open</button></div></div>`
    expect(originCardOf(document.getElementById('open'))).toBe('card-4')
    expect(originCardOf(document.getElementById('loose'))).toBeNull()
  })

  it('openTarget sends it, from the click being handled or as given, and the request keeps it', () => {
    const seen: OpenCardRequest[] = []
    const listen = (e: Event) => seen.push(parseOpenCardRequest((e as CustomEvent).detail)!)
    window.addEventListener(OPEN_CARD_EVENT, listen)
    try {
      openTarget({ type: 'document', id: 'doc-1', title: 'Spec' }, { from: 'document', origin: 'card-9' })
      openTarget({ type: 'document', id: 'doc-1', title: 'Spec' }, { from: 'composer' })
      expect(seen[0].origin).toEqual({ cardId: 'card-9' })
      expect(seen[1].origin).toBeUndefined()
    } finally {
      window.removeEventListener(OPEN_CARD_EVENT, listen)
    }
    expect(parseOpenCardRequest({ spec: record('action', 'a', 'A'), from: 'x', origin: { cardId: 7 } })?.origin).toBeUndefined()
    expect(parseOpenCardRequest({ spec: record('action', 'a', 'A'), from: 'x', origin: { cardId: 'c', elsewhere: true } })?.origin).toEqual({
      cardId: 'c',
      elsewhere: true,
    })
  })

  it('reads the clicked chip from the event being handled (a trusted click)', () => {
    // jsdom's own clicks are untrusted: stand in for the browser's window.event.
    document.body.innerHTML = `<div data-chat-card-fullscreen="card-3"><button id="chip">ENG-42</button></div>`
    const chip = document.getElementById('chip')!
    const spy = vi.spyOn(window as unknown as { event: Event | undefined }, 'event', 'get').mockReturnValue({ isTrusted: true, target: chip } as unknown as Event)
    try {
      expect(originCardOf()).toBe('card-3')
    } finally {
      spy.mockRestore()
    }
  })
})
