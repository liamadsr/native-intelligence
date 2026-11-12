/**
 * What a page's panel is given by the host (page-panel.tsx), and the pages
 * that have one. A plain module, so a page's panel and the host each import
 * it without importing each other.
 *
 * Liam, 11-11: the panel persists when you open something (the card makes
 * room for both), so a panel is told the card in front of it (`front`); and
 * it opens and closes by its button right of Search (PAGE_PANEL_ID).
 *
 * Liam, 11-11: the slot follows the selected place (../rail/selected-place.ts),
 * home or a rail page; a page gets its own panel by its id (PageKey).
 */
import type { FrontCard } from '@/components/chat-cards/front-card'
import type { RailPageId } from '../rail/rail-pages'
import type { PanelMode } from '../side-panels/space-plan'

/**
 * What each place's panel is called: its frame's label and its button's
 * (page-panel-toggle.tsx). Home's is the Recent list; My Actions' is its
 * sub-nav (tasks-panel.tsx; Liam, 11-11: "the sub-nav would show things like
 * milestone and projects").
 */
export const PAGE_PANEL_LABELS = {
  home: 'Recent',
  actions: 'Views and projects',
  // Mail's sub-nav (mail-panel.tsx; Liam, 11-11: "see and select all the accounts … the inbox, faves, sent … and any tags").
  mail: 'Mail',
  // Team chat's sub-nav (team-chat-panel.tsx; Liam, 11-11: "make the team-chat one look like this").
  'team-chat': 'Team chat',
  // The page groups' sub-navs (Liam, 11-11): the group's label (in the
  // workspace's words where it takes a member's: page-group-panel.tsx useRailEntry).
  contacts: 'Contacts',
  outreach: 'Outreach',
  calendar: 'Calendar',
} as const

/** The id on the page panel holding the slot: what its button in the rail's header controls (aria-controls). */
export const PAGE_PANEL_ID = 'ni-page-panel'

/**
 * A place whose panel may hold the slot: home, or a rail page by its id
 * (`actions`…). Home had the first (Liam, 11-11: "start this with homepage
 * first"), My Actions the next (its sub-nav); page-panel.tsx PAGE_PANELS
 * says which do.
 */
export type PageKey = 'home' | RailPageId

export interface PagePanelProps {
  /** Its page is on screen (and the capture's notepad doesn't hold the left): read and keep current. */
  active: boolean
  /**
   * Where the space plan put it: `room` on screen beside the chat, `float`
   * over the chat's left edge (only when opened by hand this session, where
   * there's no room), `off` not on screen (closed, or no room unasked).
   */
  mode: PanelMode
  /** The card full screen beside it, or null: what it opened lights its row; its closing reads again. */
  front: FrontCard | null
  /**
   * Say whether it has something to show on its page (with nothing, the row
   * gives it no room); null: not known yet (home's Recent before its first
   * read). While the next page's panel has nothing known yet, the host keeps
   * the last page's on screen, inert, a moment (page-panel.tsx; Liam, 11-11:
   * "it goes away completely and reappears every time").
   */
  onContent: (page: PageKey, has: boolean | null) => void
}
