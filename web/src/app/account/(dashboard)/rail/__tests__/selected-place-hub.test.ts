// @vitest-environment jsdom
/**
 * The selected place's store (../selected-place.ts) with real presses
 * (Liam, 11-23; docs/plans/hub-panels.md): a press in a hub's panel (it
 * wears HUB_PLACE_ATTR) keeps that hub selected for the card it opens, a
 * page's own card included; a press elsewhere (the rail) lets a page's own
 * card select the page, as before.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { holdFrontCard } from '@/components/chat-cards/front-card'
import { cardForTarget } from '@/lib/chat-cards/open-card'
import { CARD_PAGES } from '@/lib/chat-cards/page-menu'
import type { CardSpec } from '@/lib/chat-cards/kinds'
import { HUB_PLACE_ATTR, __resetSelectedPlaceForTests, selectedPlace, subscribeSelectedPlace } from '../selected-place'

const settle = () => new Promise<void>((r) => queueMicrotask(r))
const pageSpec = (slug: string) => CARD_PAGES.find((p) => p.slug === slug)!.spec(new Date()) as CardSpec
const teamChatChannel = () => cardForTarget({ type: 'team_chat', channelId: 'ch1' })!.spec

let off: () => void
let releases: Array<() => void> = []
let hub: HTMLElement
let rail: HTMLElement

function press(el: HTMLElement) {
  el.dispatchEvent(new Event('pointerdown', { bubbles: true }))
}
function front(id: string, spec: CardSpec) {
  releases.forEach((r) => r())
  releases = [holdFrontCard({ id, spec, close: () => {} })]
}

beforeEach(() => {
  __resetSelectedPlaceForTests()
  off = subscribeSelectedPlace(() => {})
  hub = document.createElement('aside')
  rail = document.createElement('nav')
  document.body.append(hub, rail)
})
afterEach(() => {
  releases.forEach((r) => r())
  releases = []
  off()
  hub.remove()
  rail.remove()
})

describe('the selected place, from a hub', () => {
  it('a team chat channel opened from Recent keeps Home (the bug: it selected Team chat)', async () => {
    hub.setAttribute(HUB_PLACE_ATTR, 'home')
    const row = document.createElement('button')
    hub.append(row)
    press(row)
    front('tc', teamChatChannel())
    await settle()
    expect(selectedPlace()).toBe('home')
  })

  it('a key in the hub (J / K flipping) counts as its press', async () => {
    hub.setAttribute(HUB_PLACE_ATTR, 'home')
    front('r1', { kind: 'record', title: 'Doc', record: { type: 'document', id: 'd1' } })
    await settle()
    hub.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }))
    front('m1', pageSpec('mail'))
    await settle()
    expect(selectedPlace()).toBe('home')
  })

  it('Inbox’s list keeps Inbox for what it opens', async () => {
    press(rail)
    front('in1', pageSpec('inbox'))
    await settle()
    expect(selectedPlace()).toBe('inbox')
    hub.setAttribute(HUB_PLACE_ATTR, 'inbox')
    press(hub)
    front('tc', teamChatChannel())
    await settle()
    expect(selectedPlace()).toBe('inbox')
  })

  it('a rail press selects the page, as before', async () => {
    press(rail)
    front('tc', pageSpec('team-chat'))
    await settle()
    expect(selectedPlace()).toBe('team-chat')
  })
})
