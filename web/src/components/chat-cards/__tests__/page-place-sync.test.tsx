// @vitest-environment jsdom
/**
 * A page card's place follows a place written from outside it: a bot's page
 * opened again on one of its items reuses the card already in the chat
 * (chat-panel openCardHere writes the seed, then brings it full screen), and
 * the mounted card moves to that item.
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as React from 'react'
import { act } from 'react'
import { makeStore, mountRoot } from './page-card-harness'
import { usePagePlace } from '../pages/page-card'
import type { PageCardSpec } from '@/lib/chat-cards/pages'

const spec = { kind: 'bot', title: 'Ada', target: { type: 'bot', id: 'tm-ada', label: 'Ada' } } as PageCardSpec

function Probe({ store }: { store: ReturnType<typeof makeStore> }) {
  const place = usePagePlace({ toolCallId: 'b1', spec, store, fullScreen: false } as never)
  return React.createElement('i', { 'data-at': place.at?.id ?? '' })
}

const mount = mountRoot()
afterEach(() => mount.unmount())

describe('usePagePlace', () => {
  it('moves to a place written into the store from outside', async () => {
    const store = makeStore('b1', spec)
    await mount.render(React.createElement(Probe, { store }))
    expect(mount.container.querySelector('[data-at]')!.getAttribute('data-at')).toBe('tm-ada')
    await act(async () => {
      store.update('b1', { at: { type: 'work_item', id: 'item-9', label: 'Reply' } }, { touch: true })
      store.enterFullScreen('b1')
    })
    expect(mount.container.querySelector('[data-at]')!.getAttribute('data-at')).toBe('item-9')
  })
})
