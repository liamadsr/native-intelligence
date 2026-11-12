'use client'

/**
 * The app rail (Liam, 11-09, from his references, then Miro's): the way to
 * move between the pages, floating at the window's left.
 *
 *   the header  one pill at the top left, over the top bar: the
 *               workspace's thumbnail (its account menu) and Search (Liam,
 *               11-09; For you's button moved to the top bar's right header,
 *               beside the side panel's, 11-11: its cards are one of the
 *               side panel's views now), then the Recent panel's button
 *               (Liam, 11-11: "a button for opening and closing the new
 *               panel lets put it to the right of the search button";
 *               page-panel/page-panel-toggle.tsx), there only while the
 *               panel has something to show.
 *   the bar     down the left, just under the header: Home first, a
 *               hairline, then the pages the person has pinned, in their
 *               order (./rail-pages.ts railLayout; by default every page the
 *               workspace has on, a hairline between its groups: your work,
 *               customers, agents), then Customize bar's icon. Where
 *               the window is too short it scrolls. Liam, 11-11: Projects,
 *               Initiatives and Teams nest under Tasks: no icons of their own
 *               (rail-pages.ts NESTED_RAIL_PAGES), they open inside My
 *               Actions on its sub-nav's rows. Liam, 11-11: "Contacts:
 *               Companies, Contacts, Deals · Outreach: Prospecting,
 *               Sequences, Campaigns · Calendar: Captures": one icon per
 *               page group (./page-groups.ts), its member pages in its
 *               sub-nav in the page panel.
 *
 * The person's bar (Liam, 11-09: "customise the navigation like move them up
 * and down, right click and pin and unpin them … a setting icon that lets me
 * turn on and off what shows on the navbar"), kept on their account
 * (lib/rail-prefs-store.ts): drag an icon up or down (./rail-drag.ts), or
 * Alt+↑/↓ on it; right-click it for Unpin from bar, Move up, Move down and
 * Customize bar…; the icon at the bar's end opens Customize bar, a switch per
 * page. Hiding an icon never turns its page off: it still opens from `/`,
 * Search and links. A custom order is one list, no hairlines.
 *
 *   Search   the `/` palette, as ⌘K and `/` open it (the top bar's own
 *            Search is a phone's only now: Liam, 11-09).
 *   Home     (Liam, 11-11: "I think we should add a homepage icon on the
 *            navside for it", back after 11-09's "we don't need this
 *            button"): the chat. Puts away whatever card is in front, as a
 *            page's X and Esc do (front-card.ts minimizeFrontCards: into the tile). Fixed at
 *            the bar's top: not in Customize bar, never dragged, unpinned or
 *            counted in the person's saved order. Still no New button.
 *   a page   opens as `/` opens it (openTarget `page`): full screen in the
 *            main chat, the same card brought back when it was opened before.
 *            Another page open already is switched in place.
 *   a group  opens its member page last used on this device, else its
 *            default (page-groups.ts groupOpenSlug), the same way. Lit while
 *            any member page is selected.
 *   workspace  the workspace and account menu (WorkspaceSwitcher `header`:
 *            switch workspace, Settings, sign out…), the one place it lives
 *            from `md` up (Liam, 11-09: the top bar's pill is a phone's only now).
 *
 * The selected place is lit (Liam, 11-11: "when you open differnet artifacts
 * you don't see the pages like cal and actions page get selected"):
 * ./selected-place.ts. A page lights only while it is selected (its own card
 * in front, the person moving about inside it); Home with nothing in front
 * and under anything opened from home (the Recent panel, a chip, Search, a
 * notification). A page full screen starts at the rail's edge and under the
 * header (show-tool-card.tsx), so both stay at hand while a page is open.
 *
 * Its width is `--app-rail-w` (tailwind.css, `[data-app-rail]`): the shell
 * moves its top bar and chat clear of it. The header's right edge and bottom
 * are `--app-header-right` and `--app-header-bottom` on <html>: the top bar's
 * controls start after it. Below `md` all of it is hidden, as before. In the
 * Mac app the header sits past the traffic lights, level with them.
 *
 * Each pill is a panel like the others (Liam, 11-09: "match the glass effect
 * of the actual panels"): the floating cards' glass (attention/card-skin.ts
 * COLUMN_CARD_SKIN), their translucent fill, blur, fine edge and soft shadow.
 *
 * Flat cost: no animation, no polling; it redraws when the selected place
 * changes, or the workspace's edition changes.
 */
import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { House, LayoutList, Search, Settings2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getMountedServerSnapshot, getMountedSnapshot, subscribeMounted, useHasTrafficLights, useIsDesktop } from '@/components/desktop-titlebar'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { WorkspaceSwitcher, useWorkspaceEdition } from '@/app/account/workspace-switcher'
import { pagesFor } from '@/lib/chat-cards/page-menu'
import { openTarget } from '@/lib/chat-cards/open-card'
import { openSearch } from '@/lib/chat/open-search'
import { useModKeyLabel } from '@/lib/hotkeys'
import { minimizeFrontCards } from '@/components/chat-cards/front-card'
import { COLUMN_CARD_SKIN } from '@/components/attention/card-skin'
import { isDefaultRailPrefs, type RailPrefs } from '@/lib/rail-prefs'
import { saveRailPrefs, useRailPrefs } from '@/lib/rail-prefs-store'
import {
  activeRailItem,
  moveRailPage,
  moveRailPageBy,
  railLayout,
  railPagesFor,
  resetRailPrefs,
  setRailPagePinned,
  type OfferedRailPage,
  type RailLayout,
  type RailPageId,
} from './rail-pages'
import { startRailDrag } from './rail-drag'
import { groupOpenSlug, isPageGroupId } from './page-groups'
import { RAIL_ICONS } from './rail-icons'
import { useSelectedPlace } from './selected-place'
import { PagePanelToggle } from '../page-panel/page-panel-toggle'

/** On the shell root (server markup) and <html> (for the layer on <body>): defines `--app-rail-w`. */
export const APP_RAIL_ATTR = 'data-app-rail'

/** On <html>: the header's right edge and bottom, px (0 while it is hidden, below `md`). */
export const HEADER_RIGHT_VAR = '--app-header-right'
export const HEADER_BOTTOM_VAR = '--app-header-bottom'

/** The header, centred on the top bar's row: 8px in on the web; past the traffic lights, level with them, in the Mac app. */
const HEADER_STYLE: React.CSSProperties = { left: 8, top: 3 }
const HEADER_STYLE_LIGHTS: React.CSSProperties = { left: 78, top: 9 }
/** The pills' column: the rail's width, under the header. */
// Its top 5px under the header's: level with the panels' tops (half a gutter under the top bar).
const NAV_STYLE: React.CSSProperties = { width: 'var(--app-rail-w)', top: 'calc(var(--app-header-bottom, 0px) + 5px)' }
/** A floating pill: the panels' glass (COLUMN_CARD_SKIN), rounded, its buttons stacked. */
// A capsule (rounded-full): its ends follow the round buttons inside it, 4px
// round them (Liam, 11-09: the circles and their containers didn't match).
const PILL = cn('relative flex flex-col items-center gap-0.5 rounded-full border border-border/60 p-1', COLUMN_CARD_SKIN)
/** The hairline between two of the bar's groups, and before Customize bar. */
const HAIRLINE = 'my-1 h-px w-5 shrink-0 bg-foreground/10'

// A tint of the foreground for hover and the lit page: it reads on the rail's
// surface in light and dark alike (bg-muted is the surface's own shade in light).
// 32px, 2px apart: every page fits a 900px window (more scroll in a shorter one).
// Round (Liam, 11-09: "the hover states should be circle"), the lit one too.
const ITEM =
  'relative flex size-8 shrink-0 items-center justify-center rounded-full text-sidebar-foreground/65 transition-colors hover:bg-foreground/[0.05] hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none'
const ITEM_ACTIVE = 'bg-foreground/[0.08] text-sidebar-foreground hover:bg-foreground/[0.08]'
const TIP = 'flex items-center gap-1.5 rounded-lg border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md'
const KBD = 'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] border bg-muted/60 px-1 text-[10px] font-medium text-muted-foreground'

/** The page in front takes the keys (its own: mail's j/k, Esc). */
function focusFrontPage(): void {
  const layer = document.querySelector<HTMLElement>('[data-chat-card-fullscreen]')
  if (layer && !layer.contains(document.activeElement)) layer.focus({ preventScroll: true })
}

function RailButton({
  label,
  hint,
  active = false,
  onClick,
  buttonRef,
  data,
  children,
}: {
  label: string
  hint?: ReactNode
  active?: boolean
  onClick: () => void
  buttonRef?: React.Ref<HTMLButtonElement>
  data?: Record<string, string>
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          ref={buttonRef}
          type="button"
          aria-label={label}
          aria-current={active ? 'page' : undefined}
          onClick={onClick}
          className={cn(ITEM, active && ITEM_ACTIVE)}
          {...data}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8} collisionPadding={8} className={TIP}>
        <span>{label}</span>
        {hint}
      </TooltipContent>
    </Tooltip>
  )
}

/** Save the bar (when it changed): the bar moves at once, then the account takes it. */
function commit(next: RailPrefs | null): boolean {
  if (!next) return false
  void saveRailPrefs(next)
  return true
}

/** A page's icon in the bar: a click opens it, a drag or Alt+↑/↓ moves it, a right-click offers its menu. */
function PageButton({
  entry: { def, label },
  index,
  count,
  active,
  onOpen,
  onMoveTo,
  onUnpin,
  onCustomize,
  onMenuClosed,
}: {
  entry: OfferedRailPage
  index: number
  count: number
  active: boolean
  onOpen: () => void
  onMoveTo: (to: number) => void
  onUnpin: () => void
  onCustomize: () => void
  onMenuClosed: (event: Event) => void
}) {
  const Icon = RAIL_ICONS[def.id] ?? LayoutList
  return (
    <ContextMenu modal={false}>
      <Tooltip>
        <TooltipTrigger asChild>
          <ContextMenuTrigger asChild>
            <button
              type="button"
              aria-label={label}
              aria-current={active ? 'page' : undefined}
              aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
              data-app-rail-item={def.id}
              data-app-rail-page=""
              onClick={onOpen}
              onPointerDown={(e) => {
                if (e.button !== 0 || e.ctrlKey || e.metaKey) return
                startRailDrag(e.currentTarget, e.pointerId, e.clientY, onMoveTo)
              }}
              onKeyDown={(e) => {
                if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return
                if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
                e.preventDefault()
                onMoveTo(index + (e.key === 'ArrowUp' ? -1 : 1))
              }}
              className={cn(ITEM, 'data-[dragging]:opacity-40', active && ITEM_ACTIVE)}
            >
              <Icon className="size-[18px]" strokeWidth={1.75} />
            </button>
          </ContextMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8} collisionPadding={8} className={TIP}>
          <span>{label}</span>
        </TooltipContent>
      </Tooltip>
      <ContextMenuContent data-app-rail-menu={def.id} className="min-w-44" onCloseAutoFocus={onMenuClosed}>
        <ContextMenuItem data-app-rail-menu-item="unpin" onSelect={onUnpin}>
          Unpin from bar
        </ContextMenuItem>
        <ContextMenuItem data-app-rail-menu-item="up" disabled={index === 0} onSelect={() => onMoveTo(index - 1)}>
          Move up
        </ContextMenuItem>
        <ContextMenuItem data-app-rail-menu-item="down" disabled={index === count - 1} onSelect={() => onMoveTo(index + 1)}>
          Move down
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem data-app-rail-menu-item="customize" onSelect={onCustomize}>
          Customize bar…
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

/** Customize bar: its icon at the bar's end, and beside the bar a switch per page (on: its icon shows). */
function CustomizeBar({
  layout,
  prefs,
  open,
  onOpenChange,
  onPinned,
  onReset,
}: {
  layout: RailLayout
  prefs: RailPrefs | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onPinned: (id: RailPageId, pinned: boolean) => void
  onReset: () => void
}) {
  // Read as the bar reads them (a group hidden only when all its members are: rail-pages.ts railLayout).
  const unpinned = new Set(layout.all.filter((p) => !layout.shown.includes(p)).map((p) => p.def.id))
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button type="button" aria-label="Customize bar" data-app-rail-item="customize" className={cn(ITEM, open && ITEM_ACTIVE)}>
              <Settings2 className="size-[18px]" strokeWidth={1.75} />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={8} collisionPadding={8} className={TIP}>
          <span>Customize bar</span>
        </TooltipContent>
      </Tooltip>
      <PopoverContent
        side="right"
        align="end"
        sideOffset={12}
        collisionPadding={8}
        data-app-rail-customize=""
        aria-label="Navigation bar"
        className="flex max-h-[var(--radix-popover-content-available-height)] w-64 flex-col p-2"
      >
        <div className="px-2 pb-2 pt-1.5">
          <h2 className="text-sm font-medium">Navigation bar</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">Hidden pages still open from Search and /.</p>
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {layout.all.map(({ def, label }) => {
            const Icon = RAIL_ICONS[def.id] ?? LayoutList
            return (
              <li key={def.id} data-app-rail-customize-row={def.id}>
                <label className="flex cursor-pointer items-center gap-2.5 rounded-xl px-2 py-1.5 text-sm hover:bg-accent/60">
                  <Icon className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                  <Switch
                    checked={!unpinned.has(def.id)}
                    onCheckedChange={(on) => onPinned(def.id, on)}
                    aria-label={`Show ${label} in the bar`}
                  />
                </label>
              </li>
            )
          })}
        </ul>
        <div className="mt-1 border-t border-border/60 px-1 pt-2">
          <Button type="button" variant="ghost" size="sm" className="w-full justify-start shadow-none" disabled={isDefaultRailPrefs(prefs)} onClick={onReset} data-app-rail-customize-reset="">
            Reset to default
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function AppRail() {
  // Hydration-safe (false on the server and the first client render), as the
  // top bar's controls are: the icons mount after hydration, the band itself
  // is in the server markup so nothing moves.
  const mounted = useSyncExternalStore(subscribeMounted, getMountedSnapshot, getMountedServerSnapshot)
  const trafficLights = useHasTrafficLights()
  const desktop = useIsDesktop()
  const edition = useWorkspaceEdition()
  const searchRef = useRef<HTMLButtonElement>(null)
  const searchKey = useModKeyLabel('K')

  // <html> carries the rail's width too, for the full-screen layer on <body>.
  useLayoutEffect(() => {
    const html = document.documentElement
    html.setAttribute(APP_RAIL_ATTR, '')
    return () => html.removeAttribute(APP_RAIL_ATTR)
  }, [])

  // Calendar and Mail always: the main chat opens the person's own pages
  // whatever drives it (chat-panel.tsx openCardHere), as a chip or a notice
  // does; only `/` leaves them out where its chat may not read them.
  const pages = useMemo(() => railPagesFor(pagesFor(edition, { desktop })), [edition, desktop])
  const offeredIds = useMemo(() => pages.map((p) => p.def.id), [pages])
  const active = activeRailItem(useSelectedPlace(), pages)

  // The person's bar: their pinned pages in their order (the default: every page, the rail's).
  const prefs = useRailPrefs()
  const layout = useMemo(() => railLayout(pages, prefs), [pages, prefs])

  // The bar's groups, a hairline between two (your work, customers, agents;
  // a section with no page on draws nothing), while the order is the default; the person's own order is one list.
  const groups = useMemo(() => {
    if (layout.custom) return layout.shown.length ? [{ group: 'custom', pages: layout.shown }] : []
    const out: Array<{ group: string; pages: OfferedRailPage[] }> = []
    for (const p of layout.shown) {
      const last = out[out.length - 1]
      if (last && last.group === p.def.group) last.pages.push(p)
      else out.push({ group: p.def.group, pages: [p] })
    }
    return out
  }, [layout])

  const [customizeOpen, setCustomizeOpen] = useState(false)
  /** Customize bar…, picked from an icon's menu: opened once the menu has closed (so its focus doesn't close it again). */
  const customizeAfterMenu = useRef(false)

  // A move keeps the focus on the moved icon (React moves or remounts it, and
  // a moved node loses its focus), and says where it went (side-panels.tsx).
  const [announcement, setAnnouncement] = useState('')
  const refocus = useRef<RailPageId | null>(null)
  const label = (id: RailPageId) => pages.find((p) => p.def.id === id)?.label ?? id
  const moveTo = (id: RailPageId, to: number) => {
    const count = layout.shown.length
    if (!commit(moveRailPage(prefs, offeredIds, id, to))) return
    refocus.current = id
    setAnnouncement(`${label(id)} moved to ${Math.max(0, Math.min(count - 1, to)) + 1} of ${count}`)
  }
  const setPinned = (id: RailPageId, pinned: boolean) => {
    if (commit(setRailPagePinned(prefs, id, pinned))) setAnnouncement(pinned ? `${label(id)} pinned to the bar` : `${label(id)} unpinned from the bar`)
  }
  useLayoutEffect(() => {
    const id = refocus.current
    refocus.current = null
    if (!id) return
    const button = document.querySelector<HTMLElement>(`[data-app-rail-nav] [data-app-rail-item="${id}"]`)
    if (button && document.activeElement !== button) button.focus()
  }, [layout])
  // An icon's menu closed: the focus back on its icon (where it stands now),
  // Customize bar's if it went, or Customize bar opened.
  const onMenuClosed = (id: RailPageId) => (event: Event) => {
    event.preventDefault()
    if (customizeAfterMenu.current) {
      customizeAfterMenu.current = false
      setCustomizeOpen(true)
      return
    }
    const nav = document.querySelector<HTMLElement>('[data-app-rail-nav]')
    // Closed by a press elsewhere (the composer, a page): the focus stays where that put it.
    const now = document.activeElement
    if (now && now !== document.body && !nav?.contains(now)) return
    ;(nav?.querySelector<HTMLElement>(`[data-app-rail-item="${id}"]`) ?? nav?.querySelector<HTMLElement>('[data-app-rail-item="customize"]'))?.focus()
  }

  // Where the header ends, on <html>: the top bar's controls start after it,
  // and a page full screen starts under it (top-bar.tsx, show-tool-card.tsx).
  // 0 while it is hidden (below `md`). Measured again only when it resizes.
  const headerRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = headerRef.current
    if (!el) return
    const html = document.documentElement
    const measure = () => {
      const r = el.getBoundingClientRect()
      html.style.setProperty(HEADER_RIGHT_VAR, `${Math.round(r.right)}px`)
      html.style.setProperty(HEADER_BOTTOM_VAR, `${Math.round(r.bottom)}px`)
    }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(el)
    return () => {
      observer?.disconnect()
      html.style.removeProperty(HEADER_RIGHT_VAR)
      html.style.removeProperty(HEADER_BOTTOM_VAR)
    }
  }, [mounted])

  const pageButton = (entry: OfferedRailPage) => {
    const { def, page, members } = entry
    return (
      <PageButton
        key={def.id}
        entry={entry}
        index={layout.shown.indexOf(entry)}
        count={layout.shown.length}
        active={active === def.id}
        onOpen={() => {
          // A group: its member last used here, else its default (Liam, 11-11: page groups).
          const slug = members && isPageGroupId(def.id) ? (groupOpenSlug(def.id, members.map((m) => m.slug)) ?? page.slug) : page.slug
          openTarget({ type: 'page', slug }, { from: 'rail' })
          // Already in front: nothing changes, so the page takes the keys back (a click left them on this button).
          if (active === def.id) focusFrontPage()
        }}
        onMoveTo={(to) => moveTo(def.id, to)}
        onUnpin={() => setPinned(def.id, false)}
        onCustomize={() => {
          customizeAfterMenu.current = true
        }}
        onMenuClosed={onMenuClosed(def.id)}
      />
    )
  }

  return (
    // One host element (display: contents): the header and the pills place
    // themselves on the shell.
    <div className="contents">
      {/* Window drag surface at the top-left in the Mac app (childless: Tauri
          drags only on the attributed target), where the traffic lights sit. */}
      {trafficLights && <div data-tauri-drag-region="" aria-hidden className="absolute left-0 top-0 z-30 hidden h-11 md:block" style={{ width: 'var(--app-rail-w)' }} />}

      {/* The header (Liam, 11-09, from Miro's board header): the workspace's
          thumbnail (its account menu), Search and the Recent panel's
          button, in one floating pill at the top left, over the top bar. */}
      <div
        ref={headerRef}
        data-app-rail-header=""
        className={cn('absolute z-[45] hidden items-center gap-0.5 rounded-full border border-border/60 p-1 md:flex', COLUMN_CARD_SKIN)}
        style={trafficLights ? HEADER_STYLE_LIGHTS : HEADER_STYLE}
      >
        {mounted ? (
          <TooltipProvider delayDuration={300}>
            <div data-app-rail-item="workspace" className="flex">
              <WorkspaceSwitcher variant="header" />
            </div>
            <RailButton
              label="Search"
              hint={<kbd className={KBD}>{searchKey}</kbd>}
              buttonRef={searchRef}
              onClick={() => openSearch(searchRef.current)}
              // ⌘K and `/` fly the palette out of this one while the top bar is hidden under a page (open-search.ts).
              data={{ 'data-app-rail-item': 'search', 'data-search-button': 'rail' }}
            >
              <Search className="size-[18px]" strokeWidth={1.75} />
            </RailButton>
            {/* The Recent panel beside the rail: opens and closes it (only while it has rows). */}
            <PagePanelToggle />
          </TooltipProvider>
        ) : (
          // Its size until the controls mount (after hydration), so nothing moves.
          // The Recent button isn't counted: it comes only once its rows are read, after mount.
          <div aria-hidden className="h-8 w-56" />
        )}
      </div>

      {/* The bar (Liam, 11-09, from Miro's toolbar: "one big bar instead of
          four"): every page in one floating pill, a hairline between its
          groups, down the left, at the top just under the header ("top align
          it so it's not center"); where the window is too short it scrolls. */}
      <nav
        data-app-rail-nav=""
        aria-label="Pages"
        className="absolute bottom-0 left-0 z-30 hidden md:flex"
        style={NAV_STYLE}
      >
        {mounted && (
          <TooltipProvider delayDuration={300}>
            <div className="flex min-h-0 w-full flex-1 flex-col overflow-y-auto overflow-x-hidden pb-2 [scrollbar-width:none]">
              <div className="flex flex-col items-start gap-1.5 pl-2">
                <div data-app-rail-pill="pages" className={PILL}>
                  {/* Home (Liam, 11-11), fixed at the top: the chat, every card in front put away. Not one of the person's pages. */}
                  <RailButton label="Home" active={active === 'home'} onClick={minimizeFrontCards} data={{ 'data-app-rail-item': 'home' }}>
                    <House className="size-[18px]" strokeWidth={1.75} />
                  </RailButton>
                  <div aria-hidden data-app-rail-home-line="" className={HAIRLINE} />
                  {groups.map((g, i) => (
                    <div key={g.group} data-app-rail-group={g.group} className="flex flex-col items-center gap-0.5">
                      {/* A hairline where a group starts (your work, customers, agents). */}
                      {i > 0 && <div aria-hidden data-app-rail-group-line="" className={HAIRLINE} />}
                      {g.pages.map(pageButton)}
                    </div>
                  ))}
                  {/* Customize bar, after a hairline (alone when every page is hidden). */}
                  {groups.length > 0 && <div aria-hidden data-app-rail-customize-line="" className={HAIRLINE} />}
                  <CustomizeBar
                    layout={layout}
                    prefs={prefs}
                    open={customizeOpen}
                    onOpenChange={setCustomizeOpen}
                    onPinned={setPinned}
                    onReset={() => {
                      if (commit(resetRailPrefs(prefs))) setAnnouncement('The bar is back to its default')
                    }}
                  />
                  {/* Where a dragged icon would land (rail-drag.ts): hidden at rest. */}
                  <div aria-hidden data-app-rail-drop-line="" className="pointer-events-none absolute inset-x-1.5 hidden h-0.5 -translate-y-1/2 rounded-full bg-primary" />
                </div>
                <div aria-live="polite" data-app-rail-announce="" className="sr-only">
                  {announcement}
                </div>
              </div>
            </div>
          </TooltipProvider>
        )}
      </nav>
    </div>
  )
}
