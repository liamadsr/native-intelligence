'use client'

/**
 * The app rail (Liam, 11-09, from his references, then Miro's): the way to
 * move between the pages, floating at the window's left.
 *
 *   the header  one pill at the top left, over the top bar: the
 *               workspace's thumbnail (its account menu), For you's button,
 *               and Search (Liam, 11-09).
 *   the bar     down the left, centred under the header: every page the
 *               workspace has on (./rail-pages.ts) in one floating pill, a
 *               hairline between its groups (your work, plans, customers,
 *               agents). Where the window is too short it scrolls.
 *
 *   Search   the `/` palette, as ⌘K and `/` open it (the top bar's own
 *            Search is a phone's only now: Liam, 11-09).
 *   (No Home or New button, Liam 11-09: "we don't need this button". A
 *   page's X and Esc put it away; the composer is the chat's.)
 *   a page   opens as `/` opens it (openTarget `page`): full screen in the
 *            main chat, the same card brought back when it was opened before.
 *            Another page open already is switched in place.
 *   workspace  the workspace and account menu (WorkspaceSwitcher `header`:
 *            switch workspace, Settings, sign out…), the one place it lives
 *            from `md` up (Liam, 11-09: the top bar's pill is a phone's only now).
 *
 * The page in front is lit (components/chat-cards/front-card.ts). A page full screen starts at the rail's edge and under the header
 * (show-tool-card.tsx), so both stay at hand while a page is open.
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
 * Flat cost: no animation, no polling; it redraws when a card enters or leaves
 * full screen, or the workspace's edition changes.
 */
import { useLayoutEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react'
import {
  AudioLines,
  Brain,
  Building2,
  Calendar,
  Contact,
  FlaskConical,
  Folder,
  FolderKanban,
  HandCoins,
  LayoutList,
  ListChecks,
  Mail,
  Megaphone,
  MessagesSquare,
  Search,
  Send,
  Sparkles,
  Target,
  Telescope,
  Users,
  Workflow,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { getMountedServerSnapshot, getMountedSnapshot, subscribeMounted, useHasTrafficLights, useIsDesktop } from '@/components/desktop-titlebar'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { WorkspaceSwitcher, useWorkspaceEdition } from '@/app/account/workspace-switcher'
import { pagesFor } from '@/lib/chat-cards/page-menu'
import { openTarget } from '@/lib/chat-cards/open-card'
import { openSearch } from '@/lib/chat/open-search'
import { ForYouToggle } from '../side-panels/side-panel-toggles'
import { useModKeyLabel } from '@/lib/hotkeys'
import { frontCard, subscribeFrontCard } from '@/components/chat-cards/front-card'
import { COLUMN_CARD_SKIN } from '@/components/attention/card-skin'
import { activeRailItem, railPagesFor, type RailPageId } from './rail-pages'

/** On the shell root (server markup) and <html> (for the layer on <body>): defines `--app-rail-w`. */
export const APP_RAIL_ATTR = 'data-app-rail'

/** On <html>: the header's right edge and bottom, px (0 while it is hidden, below `md`). */
export const HEADER_RIGHT_VAR = '--app-header-right'
export const HEADER_BOTTOM_VAR = '--app-header-bottom'

/** The header, centred on the top bar's row: 8px in on the web; past the traffic lights, level with them, in the Mac app. */
const HEADER_STYLE: React.CSSProperties = { left: 8, top: 3 }
const HEADER_STYLE_LIGHTS: React.CSSProperties = { left: 78, top: 9 }
/** The pills' column: the rail's width, under the header. */
const NAV_STYLE: React.CSSProperties = { width: 'var(--app-rail-w)', top: 'calc(var(--app-header-bottom, 0px) + 4px)' }
/** A floating pill: the panels' glass (COLUMN_CARD_SKIN), rounded, its buttons stacked. */
const PILL = cn('flex flex-col items-center gap-0.5 rounded-2xl border border-border/60 p-1', COLUMN_CARD_SKIN)

/** Each page's icon: the rail's own for Liam's reference pages, the `/` menu's for the rest (command-menu.tsx). */
const PAGE_ICONS: Record<RailPageId, LucideIcon> = {
  docs: Folder,
  mail: Mail,
  'team-chat': MessagesSquare,
  actions: ListChecks,
  calendar: Calendar,
  captures: AudioLines,
  projects: FolderKanban,
  initiatives: Target,
  knowledge: Brain,
  flows: Workflow,
  companies: Building2,
  contacts: Contact,
  deals: HandCoins,
  prospecting: Telescope,
  sequences: Send,
  campaigns: Megaphone,
  agents: Sparkles,
  evals: FlaskConical,
  teams: Users,
}

// A tint of the foreground for hover and the lit page: it reads on the rail's
// surface in light and dark alike (bg-muted is the surface's own shade in light).
// 32px, 2px apart: every page fits a 900px window (more scroll in a shorter one).
const ITEM =
  'relative flex size-8 shrink-0 items-center justify-center rounded-lg text-sidebar-foreground/65 transition-colors hover:bg-foreground/[0.05] hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none'
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
  const front = useSyncExternalStore(subscribeFrontCard, frontCard, () => null)
  const active = activeRailItem(front?.spec ?? null, pages)


  // The page groups, each its own floating pill (your work, plans, customers, agents).
  const groups = useMemo(() => {
    const out: Array<{ group: string; pages: typeof pages }> = []
    for (const p of pages) {
      const last = out[out.length - 1]
      if (last && last.group === p.def.group) last.pages.push(p)
      else out.push({ group: p.def.group, pages: [p] })
    }
    return out
  }, [pages])

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

  const pageButton = ({ def, page }: (typeof pages)[number]) => {
    const Icon = PAGE_ICONS[def.id] ?? LayoutList
    return (
      <RailButton
        key={def.id}
        label={page.label}
        active={active === def.id}
        onClick={() => {
          openTarget({ type: 'page', slug: page.slug }, { from: 'rail' })
          // Already in front: nothing changes, so the page takes the keys back (a click left them on this button).
          if (active === def.id) focusFrontPage()
        }}
        data={{ 'data-app-rail-item': def.id }}
      >
        <Icon className="size-[18px]" strokeWidth={1.75} />
      </RailButton>
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
          thumbnail (its account menu), For you, and Search, in one floating
          pill at the top left, over the top bar. */}
      <div
        ref={headerRef}
        data-app-rail-header=""
        className={cn('absolute z-[45] hidden items-center gap-0.5 rounded-2xl border border-border/60 p-1 md:flex', COLUMN_CARD_SKIN)}
        style={trafficLights ? HEADER_STYLE_LIGHTS : HEADER_STYLE}
      >
        {mounted ? (
          <TooltipProvider delayDuration={300}>
            <div data-app-rail-item="workspace" className="flex">
              <WorkspaceSwitcher variant="header" />
            </div>
            {/* For you's button (it shows only while the bots have brought something). */}
            <ForYouToggle variant="header" />
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
          </TooltipProvider>
        ) : (
          // Its size until the controls mount (after hydration), so nothing moves.
          <div aria-hidden className="h-8 w-[104px]" />
        )}
      </div>

      {/* The bar (Liam, 11-09, from Miro's toolbar: "one big bar instead of
          four"): every page in one floating pill, a hairline between its
          groups, down the left, centred in the room under the header; where
          the window is too short it scrolls. */}
      <nav
        data-app-rail-nav=""
        aria-label="Pages"
        className="absolute bottom-0 left-0 z-30 hidden md:flex"
        style={NAV_STYLE}
      >
        {mounted && (
          <TooltipProvider delayDuration={300}>
            <div className="flex min-h-0 w-full flex-1 flex-col overflow-y-auto overflow-x-hidden py-2 [scrollbar-width:none]">
              <div className="my-auto flex flex-col items-start gap-1.5 pl-2">
                <div data-app-rail-pill="pages" className={PILL}>
                  {groups.map((g, i) => (
                    <div key={g.group} data-app-rail-group={g.group} className="flex flex-col items-center gap-0.5">
                      {/* A hairline where a group starts (your work, plans, customers, agents). */}
                      {i > 0 && <div aria-hidden data-app-rail-group-line="" className="my-1 h-px w-5 shrink-0 bg-foreground/10" />}
                      {g.pages.map(pageButton)}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </TooltipProvider>
        )}
      </nav>
    </div>
  )
}
