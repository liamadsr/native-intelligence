'use client'

/**
 * The selected place (Liam, 11-11): home, or the rail page the person
 * selected. What the rail lights (./app-rail.tsx, Home or a page) and whose
 * panel holds the slot beside it (../page-panel/page-panel.tsx pageKeyOf).
 * Not the card in front: an artifact opened from home (the Recent panel, a
 * chip in the chat, Search, a notification) leaves Home selected, so the
 * page it belongs to isn't lit and its panel doesn't take the slot. Only the
 * page itself selects it ("when you actually select the page itself we want
 * to change our menu to be specific for controls that would be on that
 * page").
 *
 * It follows the card in front (components/chat-cards/front-card.ts) by
 * ./rail-pages.ts nextSelectedPlace: a page's own card coming in front
 * selects the page; a record opened from inside the page keeps it; anything
 * else coming in front selects home, and so does nothing in front.
 *
 * "From inside" is the person's last press (a pointer down or a key) before
 * the card came in front: in the full-screen card's layer, or in a page's
 * own panel (it wears KEEP_PLACE_ATTR), within a moment. A press in a menu
 * (a row's right-click menu, portalled out of the card) is the press that
 * opened it, so it isn't counted. Most moves inside a page never change the
 * card in front at all (a row opened in its own card is a step of that
 * card's history), so this only decides a record opened over the page as a
 * card of its own.
 *
 * Settled a microtask after the front changes: one card leaving full screen
 * for the next (release, then hold, in one commit) never passes through
 * "nothing in front", which would select home.
 *
 * Page groups (Liam, 11-11: "Contacts: Companies, Contacts, Deals ·
 * Outreach: Prospecting, Sequences, Campaigns · Calendar: Captures";
 * ./page-groups.ts): a member page's own card in front selects its group
 * (rail-pages.ts pageOfCard), and is noted as the group's last used member
 * on this device, whatever opened it (the rail, the group's sub-nav, `/`,
 * Search, a link), for the group's icon to open next time.
 *
 * Flat cost: two capture listeners that note a press (no work beyond a
 * `closest`), and one decision per change of the card in front. Listening
 * only while something reads it.
 */
import { useSyncExternalStore } from 'react'
import { frontCard, subscribeFrontCard } from '@/components/chat-cards/front-card'
import { nextSelectedPlace, ownPageOfCard, type SelectedPlace } from './rail-pages'
import { GROUP_OF_PAGE, rememberGroupPage } from './page-groups'

export type { SelectedPlace } from './rail-pages'

/** On a page's own panel (My Actions' sub-nav, page-panel/tasks-panel.tsx): a press in it keeps the page selected, as one in the page's card does. */
export const KEEP_PLACE_ATTR = 'data-keep-place'

/** Where a press counts as inside the place on screen: the full-screen card's layer, or a page's own panel. */
const INSIDE_SELECTOR = `[data-chat-card-fullscreen], [${KEEP_PLACE_ATTR}]`
/** A menu: a press in it is the one that opened it. */
const MENU_SELECTOR = '[role="menu"]'
/** How long a press counts toward the card it opens (a click's open is at once; a slow read is no longer the press). */
export const PRESS_COUNTS_MS = 1500

let place: SelectedPlace = 'home'
let frontId: string | null = null
let lastPress: { inside: boolean; at: number } = { inside: false, at: Number.NEGATIVE_INFINITY }
let scheduled = false
let stopFollowing: (() => void) | null = null
const listeners = new Set<() => void>()

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

function notePress(e: Event): void {
  const target = e.target
  if (!(target instanceof Element)) {
    lastPress = { inside: false, at: now() }
    return
  }
  if (target.closest(MENU_SELECTOR)) return
  lastPress = { inside: !!target.closest(INSIDE_SELECTOR), at: now() }
}

function settle(): void {
  scheduled = false
  const front = frontCard()
  const fromInside = lastPress.inside && now() - lastPress.at <= PRESS_COUNTS_MS
  const next = nextSelectedPlace({ place, frontId }, front ? { id: front.id, spec: front.spec } : null, fromInside)
  // A group member page's own card come in front: the group's last used member here.
  if (front && front.id !== frontId) {
    const own = ownPageOfCard(front.spec)
    if (own && GROUP_OF_PAGE.has(own.slug)) rememberGroupPage(own.slug)
  }
  frontId = front?.id ?? null
  if (next === place) return
  place = next
  for (const listener of [...listeners]) listener()
}

function onFrontChange(): void {
  if (scheduled) return
  scheduled = true
  queueMicrotask(settle)
}

function follow(): () => void {
  const offFront = subscribeFrontCard(onFrontChange)
  if (typeof window === 'undefined') return offFront
  window.addEventListener('pointerdown', notePress, true)
  window.addEventListener('keydown', notePress, true)
  return () => {
    offFront()
    window.removeEventListener('pointerdown', notePress, true)
    window.removeEventListener('keydown', notePress, true)
  }
}

export function subscribeSelectedPlace(listener: () => void): () => void {
  listeners.add(listener)
  if (!stopFollowing) {
    stopFollowing = follow()
    // Caught up with the card in front now (no press to judge: its own page, or home).
    settle()
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size || !stopFollowing) return
    stopFollowing()
    stopFollowing = null
  }
}

export function selectedPlace(): SelectedPlace {
  return place
}

/** The selected place, redrawn when it changes; home on the server. */
export function useSelectedPlace(): SelectedPlace {
  return useSyncExternalStore(subscribeSelectedPlace, selectedPlace, () => 'home')
}

/** Tests: home, no card judged, no press noted. */
export function __resetSelectedPlaceForTests(): void {
  place = 'home'
  frontId = null
  lastPress = { inside: false, at: Number.NEGATIVE_INFINITY }
  scheduled = false
}
