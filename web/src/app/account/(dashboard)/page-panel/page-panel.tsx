'use client'

/**
 * The page panel, beside the navigation (Liam, 11-11: "on the home page I
 * want to build a floating panel next to the navigation that's going to
 * show you all the recent pages, docs, chats, or anything else that needs
 * your attention. I want to start this with homepage first then later we're
 * going to make it so that every page has it's own version of it that shows
 * you helpful things you can control").
 *
 *   One host   this: which place's panel holds the slot (pageKeyOf), and
 *              each place's panel from PAGE_PANELS: home's recents
 *              (home-recents.tsx) and My Actions' sub-nav (tasks-panel.tsx,
 *              Liam, 11-11); a page adds its own there,
 *              wearing the same frame (page-panel-frame.tsx: place, card,
 *              slide).
 *   Whose      the selected place's (Liam, 11-11: "when you actually select
 *              the page itself we want to change our menu to be specific
 *              for controls that would be on that page";
 *              rail/selected-place.ts): home's Recent on home, and beside
 *              anything opened from home; a selected page's own panel (a
 *              page group's: its sub-nav). A page with none (all but My
 *              Actions and the groups, for now) leaves the slot empty:
 *              the panel slides out, the page's card takes the room
 *              (PAGE_PANEL_W_VAR cleared), the Recent button goes, and the
 *              person's saved open or closed stays as it was for home.
 *   Where      only where the app rail is (from `md` up, rail/rail-media.ts, as the
 *              rail's own CSS): below it, the phone's layout, no panel at
 *              all, never floating, opened by hand or not, no button, and a
 *              card's layer starts at the window's edge (Liam, 11-11: at a
 *              741px window "the page looks all crazy at this size").
 *              Crossing back, it is as the person left it.
 *   When       it has something to show (with nothing, nothing at all, and
 *              no button), it is open (its button right of Search in the
 *              rail's header, page-panel-toggle.tsx; Liam, 11-11: "we also
 *              need a button for opening and closing the new panel lets put
 *              it to the right of the search button"; remembered per
 *              device, open by default), the capture's notepad doesn't hold
 *              the left (live-capture-dock.tsx), and the row has room for it
 *              beside the chat's content (space-plan.ts: it makes room,
 *              moving the content by just the shortfall where it must, and
 *              never floats over the chat unasked). Opened by hand this
 *              session, it floats over the chat's left edge where there's
 *              no room. A page's sub-nav with its card in front shows
 *              whenever it is open, room or not (Liam, 11-11: the cards
 *              draw no navigation of their own from `md` up, so the
 *              sub-nav is the one place; only its button hides it). Off
 *              screen (closed, or no room), a card's layer starts at the
 *              rail as before.
 *   Opening    an item opens exactly as it does today: a record's card full
 *              screen (home-recents.tsx openRecent). The panel persists
 *              (Liam, 11-11: "I want the panel to persist when you open
 *              something, it should just make room for both things to be
 *              open"): it stays beside the card, the card's layer starting
 *              after it (PAGE_PANEL_W_VAR on <html>, set here while it
 *              shows; show-tool-card.tsx), and the open item's row is lit.
 *
 *   At once    a page's sub-nav is there in the commit its page is selected
 *              (Liam, 11-11: "It still feels kind of laggy like it goes away
 *              completely and reappears every time" … "it's only on first
 *              load"): its rows are what it knows without its card (Tasks'
 *              views, Mail's folders, Team chat's switch and headings, a
 *              group's members); what only the card knows (saved views,
 *              counts, conversations, the lit row) fills in when it says. A
 *              press before then waits for the card (pending-move.ts). And a
 *              page change never leaves the slot empty: the last panel is
 *              held, inert, while the next has nothing known yet, at most
 *              PAGE_PANEL_HOLD_MAX_MS.
 *
 *   Covers    which page's sub-nav is on screen goes to the cards
 *              (subnav-on-screen.ts): a page's card hides its own
 *              navigation from `md` up only while its page's sub-nav is
 *              really there (Liam, 11-11), not while the capture's notepad
 *              holds the left, the panel is closed, or Recent shows beside a
 *              Mail card opened from home. Undecided while things settle (a
 *              refresh, the selected place catching up with the card in
 *              front, a held panel), so the card keeps today's look then.
 *
 * The store hears whether the page panel has something for the left
 * (side-panel-store.ts setPagePanelContent), the row's plan answers with its
 * mode (dashboard-shell.tsx ChatRow), passed back down here, and the host
 * tells the store whether it is on screen (setPagePanelShown: what lights
 * its button).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore, type ComponentType } from 'react'
import { railMediaNow, useRailShown } from '../rail/rail-media'
import { PAGE_PANEL_W_VAR, frontCard, subscribeFrontCard } from '@/components/chat-cards/front-card'
import { useHasTrafficLights } from '@/components/desktop-titlebar'
import { setPagePanelContent, setPagePanelShown } from '../side-panels/side-panel-store'
import { pageOfCard, type RailPageId } from '../rail/rail-pages'
import { useSelectedPlace, type SelectedPlace } from '../rail/selected-place'
import { useSidePanelState } from '../side-panels/side-panels'
import type { PanelMode } from '../side-panels/space-plan'
import { HomeRecentsPanel } from './home-recents'
import { TasksPanel } from './tasks-panel'
import { MailPanel } from './mail-panel'
import { TeamChatPanel } from './team-chat-panel'
import { PAGE_GROUP_PANELS } from './page-group-panel'
import { PagePanelHeldContext, PagePanelSwapContext, pagePanelReserve } from './page-panel-frame'
import type { PageKey, PagePanelProps } from './page-panel-types'
import { setSubnavOnScreen } from './subnav-on-screen'

export type { PageKey, PagePanelProps } from './page-panel-types'

type PagePanel = ComponentType<PagePanelProps>

/**
 * Each place's panel: home's always; a rail page's by its id, when it has
 * one. A page with none has no entry (the slot stays empty on it).
 *
 * The first page's (Liam, 11-11: "eventually I want to get to the point
 * where we have one todo icon on the main nav and when you click it the
 * sub-nav would show things like milestone and projects that way it's
 * nested and clean and not at the top level"): `actions`, the Tasks sub-nav
 * (tasks-panel.tsx: the page's views, projects, milestones, initiatives and
 * saved views, nested under My Actions). A page's panel wears
 * KEEP_PLACE_ATTR (rail/selected-place.ts) so what it opens keeps the page
 * selected.
 *
 * The page groups' (Liam, 11-11: "Contacts: Companies, Contacts, Deals ·
 * Outreach: Prospecting, Sequences, Campaigns · Calendar: Captures";
 * rail/page-groups.ts): each its sub-nav, a row per member page
 * (page-group-panel.tsx), there only with two members or more on.
 */
export const PAGE_PANELS: Readonly<{ home: PagePanel } & Partial<Record<RailPageId, PagePanel>>> = {
  home: HomeRecentsPanel,
  actions: TasksPanel,
  // Mail's sub-nav (Liam, 11-11: "see and select all the accounts … the
  // inbox, faves, sent … and any tags that are available for email"):
  // mail-panel.tsx.
  mail: MailPanel,
  // Team chat's sub-nav (Liam, 11-11: "make the team-chat one look like
  // this"): team-chat-panel.tsx.
  'team-chat': TeamChatPanel,
  ...PAGE_GROUP_PANELS,
}

/**
 * The place whose panel holds the slot: the selected place, when it has a
 * panel (home always: the Recent panel, persisting beside what is opened
 * from home, Liam, 11-11); null on a page with none.
 */
export function pageKeyOf(place: SelectedPlace): PageKey | null {
  return PAGE_PANELS[place] ? place : null
}

/**
 * The longest the last page's panel is held on screen for the next page's
 * (Liam, 11-11: "it goes away completely and reappears every time"): a page
 * whose panel never gets anything to show doesn't keep the old one.
 */
export const PAGE_PANEL_HOLD_MAX_MS = 600

export function PagePanelHost({ mode }: { mode: PanelMode }) {
  const front = useSyncExternalStore(subscribeFrontCard, frontCard, () => null)
  const place = useSelectedPlace()
  const { captureDock, pagePanelOpen } = useSidePanelState()
  const railShown = useRailShown()
  // The left is the notepad's while a capture is docked there; below `md`
  // (no rail, the phone's layout) there is no page panel at all. Its saved
  // open state stays as it was.
  // A selected page with no panel of its own: none either.
  const page = captureDock || !railShown ? null : pageKeyOf(place)

  // What each page's panel has to show: true, false, or null (not known yet).
  // The sub-navs know their rows without their card (Liam, 11-11: "it's only
  // on first load that's it's a bit laggy"), and say so from their first
  // commit, so a page's comes with the page.
  const [content, setContent] = useState<Partial<Record<PageKey, boolean | null>>>({})
  const onContent = useCallback((key: PageKey, has: boolean | null) => {
    setContent((was) => (was[key] === has ? was : { ...was, [key]: has }))
  }, [])
  const wants = page !== null && content[page] === true

  // The page whose panel was last on screen. While the selected page is
  // another one (a page change, not an open or a close), the frames swap
  // without sliding: the one leaving goes at once, and the next makes the
  // search palette's entrance when it shows (page-panel-frame.tsx
  // PagePanelSwapContext; Liam, 11-11). Closed or out of room on the same
  // page, it is forgotten: opening again slides, as the button does.
  const [lastShown, setLastShown] = useState<PageKey | null>(null)
  const swapping = lastShown !== null && page !== lastShown

  // Never an empty slot on a page change (Liam, 11-11: "it goes away
  // completely and reappears every time"): while the next page's panel has
  // nothing known yet (not a definite nothing, and not a page with no panel),
  // the last one stays on screen, inert (page-panel-frame.tsx
  // PagePanelHeldContext), and the card keeps making room for it; the swap
  // then happens as above. At most PAGE_PANEL_HOLD_MAX_MS.
  const holdKey = swapping && page !== null && !wants && content[page] !== false ? `${lastShown}>${page}` : null
  const [expired, setExpired] = useState<string | null>(null)
  if (holdKey === null && expired !== null) setExpired(null)
  const held = holdKey !== null && holdKey !== expired ? lastShown : null
  useEffect(() => {
    if (holdKey === null || holdKey === expired) return
    const timer = setTimeout(() => setExpired(holdKey), PAGE_PANEL_HOLD_MAX_MS)
    return () => clearTimeout(timer)
  }, [holdKey, expired])
  // The page whose panel holds the slot: the selected page's, or the one held for it.
  const slot = wants ? page : held

  // A page's sub-nav (not home's Recent), with that page's card in front
  // (a page is selected only so, rail/selected-place.ts): its card draws no
  // navigation of its own from `md` up, so the panel shows while it is open,
  // room or not (side-panels/space-plan.ts leftPinned; Liam, 11-11).
  const pinned = slot !== null && slot !== 'home'
  // Before paint: the plan makes room in the same frame the page comes back.
  useLayoutEffect(() => {
    setPagePanelContent(slot !== null, pinned)
  }, [slot, pinned])
  useEffect(() => () => setPagePanelContent(false), [])

  // On screen (making room or floating): a full-screen card's layer starts
  // after it (front-card.ts PAGE_PANEL_W_VAR), set at once, never animated;
  // gone with it (closed by its button too); kept while one is held.
  const shown = slot !== null && mode !== 'off'
  useLayoutEffect(() => {
    setPagePanelShown(shown)
  }, [shown])
  useEffect(() => () => setPagePanelShown(false), [])
  // Which page's sub-nav is on screen, for the cards (subnav-on-screen.ts):
  // a page's card hides its own navigation from `md` up only while its
  // page's is (Liam, 11-11). Undecided (the card keeps today's look) only
  // while the answer is still settling, each for a commit or a moment:
  //   - no card in front (no full-screen card to cover: one coming in front
  //     first draws as today, never its own navigation shown then taken away);
  //   - the rail's hook not yet the window's (a refresh's hydration);
  //   - a page's own card in front, its page not yet selected (selected-place.ts settles a microtask later);
  //   - the last page's panel held for the next one (at most PAGE_PANEL_HOLD_MAX_MS);
  //   - the page's panel not yet said what it has (it says in its first commit);
  //   - its sub-nav open, the plan not yet answered (it never leaves an open one off: space-plan.ts leftPinned).
  const frontPage = useMemo(() => (front ? pageOfCard(front.spec) : null), [front])
  const unknown = page !== null && page !== 'home' && content[page] == null
  useLayoutEffect(() => {
    const undecided =
      front === null ||
      railShown !== railMediaNow() ||
      (frontPage !== null && place !== frontPage) ||
      held !== null ||
      unknown ||
      (pinned && mode === 'off' && pagePanelOpen)
    setSubnavOnScreen(undecided ? undefined : shown ? slot : null)
  }, [front, railShown, frontPage, place, held, unknown, pinned, mode, pagePanelOpen, shown, slot])
  useEffect(() => () => setSubnavOnScreen(undefined), [])
  const trafficLights = useHasTrafficLights()
  useLayoutEffect(() => {
    if (!shown) return
    const html = document.documentElement
    html.style.setProperty(PAGE_PANEL_W_VAR, pagePanelReserve(trafficLights))
    return () => {
      html.style.removeProperty(PAGE_PANEL_W_VAR)
    }
  }, [shown, trafficLights])

  // Noted as it shows (a held one is the last shown already), so a hold that
  // ran out still lets the next page's panel arrive as a swap.
  const shownKey = shown ? slot : null
  useLayoutEffect(() => {
    if (shownKey !== null) setLastShown(shownKey)
    else if (page === lastShown) setLastShown(null)
  }, [shownKey, page, lastShown])

  return (
    <PagePanelSwapContext.Provider value={swapping}>
      <PagePanelHeldContext.Provider value={held}>
        {(Object.keys(PAGE_PANELS) as PageKey[]).map((key) => {
          const Panel = PAGE_PANELS[key]
          if (!Panel) return null
          return <Panel key={key} active={page === key} mode={slot === key ? mode : 'off'} front={front} onContent={onContent} />
        })}
      </PagePanelHeldContext.Provider>
    </PagePanelSwapContext.Provider>
  )
}
