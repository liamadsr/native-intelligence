// @vitest-environment jsdom
/**
 * A reused card that was collapsed: its history lives on (in the chat's card
 * store), its body did not, so nothing heard the seed chat-panel openCardHere
 * wrote for it (a bot's page opened again on one of its items). When the body
 * mounts again it opens where the seed says at once, as a step: Back returns
 * to where the card was, and the next store notice adds nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act } from 'react'
import { makeStore, mountRoot } from './page-card-harness'

vi.mock('@/app/account/workspace-switcher', () => ({ useWorkspaceEdition: () => ({ views: [], extraAllowedViews: [] }), useWorkspaceId: () => 'ws-1' }))

import { CardHistoryProvider } from '../card-history'
import { usePagePlace } from '../pages/page-card'
import { useOpenRecords } from '../card-body'
import { seedCardState } from '../card-storage'
import type { ChatCardStore } from '../card-store'
import type { PageCardSpec } from '@/lib/chat-cards/pages'

const nextTask = () => new Promise((r) => setTimeout(r, 0))
const spec = { kind: 'bot', title: 'Ada', target: { type: 'bot', id: 'tm-ada', label: 'Ada' } } as PageCardSpec

function Probe({ store }: { store: ChatCardStore }) {
  const place = usePagePlace({ toolCallId: 'b1', spec, store, fullScreen: false })
  const records = useOpenRecords('b1', store)
  const at = place.at?.id ?? ''
  const open = records.current?.id ?? ''
  return React.createElement('i', { 'data-at': at, 'data-open': open })
}

/** As ShowToolCard holds it: the store's history for the card, the body under it. */
function Card({ store, body }: { store: ChatCardStore; body: boolean }) {
  return React.createElement(CardHistoryProvider, { value: store.history('b1') }, body ? React.createElement(Probe, { store }) : null)
}

describe('a collapsed card reused with a seed', () => {
  let mount: ReturnType<typeof mountRoot>
  beforeEach(() => {
    window.localStorage.clear()
    mount = mountRoot()
  })
  afterEach(() => mount.unmount())

  const shown = () => {
    const el = mount.container.querySelector('i')!
    return { at: el.getAttribute('data-at'), open: el.getAttribute('data-open') }
  }

  it('opens at the seeded place at once, and Back returns to the old one', async () => {
    const store = makeStore('b1', spec)
    const history = store.history('b1')
    await mount.render(React.createElement(Card, { store, body: true }))
    await act(async () => store.update('b1', { at: { type: 'work_item', id: 'item-a', label: 'A' } }, { touch: true, redraw: true }))
    await act(nextTask)
    expect(shown().at).toBe('item-a')
    const steps = history.length

    // Collapsed: the body unmounts, the history stays.
    await act(async () => store.collapse('b1'))
    await mount.render(React.createElement(Card, { store, body: false }))
    expect(mount.container.querySelector('i')).toBeNull()

    // chat-panel openCardHere's reuse path: the seed (no notice), then full screen.
    await act(async () => {
      store.update('b1', seedCardState({ at: { type: 'work_item', id: 'item-b', label: 'B' } }), { touch: true })
      store.enterFullScreen('b1')
    })
    await act(nextTask)
    // The step lands in a layout effect at mount, before the paint, with no
    // store notice to wait for.
    await mount.render(React.createElement(Card, { store, body: true }))
    expect(shown().at).toBe('item-b')
    expect(history.length).toBe(steps + 1)

    // The next notice adds nothing.
    await act(async () => store.exitFullScreen())
    await act(nextTask)
    expect(history.length).toBe(steps + 1)

    await act(async () => void history.go(-1))
    expect(shown().at).toBe('item-a')
    expect(store.state('b1').at).toMatchObject({ id: 'item-a' })
  })

  it('opens a seeded record the same way', async () => {
    const store = makeStore('b1', spec)
    const history = store.history('b1')
    await mount.render(React.createElement(Card, { store, body: true }))
    expect(shown().open).toBe('')
    await mount.render(React.createElement(Card, { store, body: false }))
    await act(async () => {
      store.update('b1', seedCardState({ open: { type: 'event', id: 'ev-1', label: 'Standup' } }), { touch: true })
    })
    await mount.render(React.createElement(Card, { store, body: true }))
    expect(shown().open).toBe('ev-1')
    await act(async () => void history.go(-1))
    expect(shown().open).toBe('')
    expect(store.state('b1').open).toBeNull()
  })

  it('adds no step when the store agrees with the history', async () => {
    const store = makeStore('b1', spec)
    const history = store.history('b1')
    await mount.render(React.createElement(Card, { store, body: true }))
    await mount.render(React.createElement(Card, { store, body: false }))
    await mount.render(React.createElement(Card, { store, body: true }))
    expect(history.length).toBe(1)
    expect(history.canGoBack).toBe(false)
  })
})

describe('the card store’s histories', () => {
  it('keeps one per card id, the same one each time it is asked', () => {
    const store = makeStore('c1', spec)
    const a = store.history('c1')
    expect(store.history('c1')).toBe(a)
    expect(store.history('c2')).not.toBe(a)
  })
})
