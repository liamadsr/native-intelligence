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
 * From a hub (Liam, 11-23; rail-pages.ts HUB_PLACES): a press in home's
 * Recent or Inbox's list (they wear HUB_PLACE_ATTR) keeps that hub selected
 * for the card it opens, whatever card that is. A team chat channel opened
 * from Recent is Team chat's own card on that channel (open-card.ts
 * cardForTarget: one team chat card), which selected Team chat and put its
 * sub-nav beside it: the bug the owner reported.
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
import { homeSideOfCard, isHubPlace, nextSelectedPlace, ownPageOfCard, type SelectedPlace } from './rail-pages'
import { setHomeSide } from '../page-panel/home-side'
import { GROUP_OF_PAGE, rememberGroupPage } from './page-groups'
import { useRailShown } from './rail-media'

export type { SelectedPlace } from './rail-pages'
export { HUB_PLACES, isHubPlace } from './rail-pages'

/**
 * On a hub's panel (home's Recent, Inbox's list: rail-pages.ts HUB_PLACES),
 * its value the hub: a press in it keeps that hub selected for whatever it
 * opens, a page's own card included (Liam, 11-23: "nothing from the home page
 * should open the full page"). page-panel-frame.tsx puts it on.
 */
export const HUB_PLACE_ATTR = 'data-hub-place'

/** On a page's own panel (My Actions' sub-nav, page-panel/tasks-panel.tsx): a press in it keeps the page selected, as one in the page's card does. */
export const KEEP_PLACE_ATTR = 'data-keep-place'

/** Where a press counts as inside the place on screen: the full-screen card's layer, or a page's own panel. */
const INSIDE_SELECTOR = `[data-chat-card-fullscreen], [${KEEP_PLACE_ATTR}]`
/** Where a press opens from a hub (HUB_PLACE_ATTR). */
const HUB_SELECTOR = `[${HUB_PLACE_ATTR}]`
/** A menu: a press in it is the one that opened it. */
const MENU_SELECTOR = '[role="menu"]'
/** How long a press counts toward the card it opens (a click's open is at once; a slow read is no longer the press). */
export const PRESS_COUNTS_MS = 1500

let place: SelectedPlace = 'home'
let frontId: string | null = null
let lastPress: { inside: boolean; hub: SelectedPlace | null; at: number } = { inside: false, hub: null, at: Number.NEGATIVE_INFINITY }
let scheduled = false
let stopFollowing: (() => void) | null = null
const listeners = new Set<() => void>()

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

function notePress(e: Event): void {
  const target = e.target
  if (!(target instanceof Element)) {
    lastPress = { inside: false, hub: null, at: now() }
    return
  }
  if (target.closest(MENU_SELECTOR)) return
  const hub = target.closest(HUB_SELECTOR)?.getAttribute(HUB_PLACE_ATTR) ?? null
  lastPress = { inside: !!target.closest(INSIDE_SELECTOR), hub: isHubPlace(hub) ? hub : null, at: now() }
}

function settle(): void {
  scheduled = false
  const front = frontCard()
  const recent = now() - lastPress.at <= PRESS_COUNTS_MS
  const fromInside = lastPress.inside && recent
  const fromHub = recent ? lastPress.hub : null
  const next = nextSelectedPlace({ place, frontId }, front ? { id: front.id, spec: front.spec } : null, fromInside, undefined, fromHub)
  // A group member page's own card come in front: the group's last used member here.
  if (front && front.id !== frontId) {
    const own = ownPageOfCard(front.spec)
    if (own && GROUP_OF_PAGE.has(own.slug)) rememberGroupPage(own.slug)
    // The Inbox page's card come in front (`/`, Search, G J, a link, Home's Inbox side): Home on its Inbox side (Liam, 11-24).
    const side = homeSideOfCard(front.spec)
    if (side) setHomeSide(side)
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

/**
 * Whether a card in front shows as just its one item (Liam, 11-23): a hub
 * (home, Inbox) is selected, from `md` up (where its panel is). A team chat
 * card on a channel is then that conversation alone, a mail card on a thread
 * that thread alone (no channel list, no folders, no thread list). Below `md`
 * (no panel, the phone's layout) never: cards there are as they were.
 */
export function useHubSingle(): boolean {
  const selected = useSelectedPlace()
  const railShown = useRailShown()
  return railShown && isHubPlace(selected)
}

/** Tests: home, no card judged, no press noted. */
export function __resetSelectedPlaceForTests(): void {
  place = 'home'
  frontId = null
  lastPress = { inside: false, hub: null, at: Number.NEGATIVE_INFINITY }
  scheduled = false
}
