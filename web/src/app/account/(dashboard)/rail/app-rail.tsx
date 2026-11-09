'use client'

/**
 * The app rail (Liam, 11-09, from his reference): a thin band of icons down
 * the window's left, the way to move between the pages. Top to bottom: New,
 * Search, Home, then the pages (./rail-pages.ts: Docs, Mail, Team chat,
 * My Actions, Calendar, Agents & skills, the CRM), and the person's avatar at
 * the foot.
 *
 *   New      puts any page away and puts the cursor in the composer: the
 *            agent makes things on request (no Create dialog: Liam, 10-20).
 *   Search   the `/` palette, as ⌘K and `/` open it (the top bar's own
 *            Search is a phone's only now: Liam, 11-09).
 *   Home     the chat: puts the page in front away.
 *   a page   opens as `/` opens it (openTarget `page`): full screen in the
 *            main chat, the same card brought back when it was opened before.
 *            Another page open already is switched in place.
 *   avatar   the workspace and account menu (WorkspaceSwitcher `rail`: switch
 *            workspace, Settings, sign out…), the one place it lives from `md`
 *            up (Liam, 11-09: the top bar's pill is a phone's only now).
 *
 * The page in front is lit (components/chat-cards/front-card.ts), Home with
 * none. The full-screen layer starts at the rail's edge (show-tool-card.tsx),
 * so the rail stays at hand while a page is open.
 *
 * Its width is `--app-rail-w` (tailwind.css, `[data-app-rail]`): the shell
 * moves its top bar and chat clear of it, and the full-screen layer starts
 * after it. Below `md` the rail is hidden and the width is 0, as before.
 * In the Mac app the window has no title bar: the rail's top is window drag
 * surface, with room for the traffic lights over it.
 *
 * Its surface is the panels' glass (Liam, 11-09: "match the glass effect of
 * the actual panels"): the page cards' and floating cards' own translucent
 * fill and blur (chat-cards/card-glass.tsx, attention/card-skin.ts), with
 * their fine edge. Like them it re-composites while the sky moves.
 *
 * Flat cost: no animation, no polling; it redraws when a card enters or leaves
 * full screen, or the workspace's edition changes.
 */
import { useLayoutEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { Building2, Calendar, Folder, House, ListChecks, Mail, MessagesSquare, Plus, Search, Sparkles, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getMountedServerSnapshot, getMountedSnapshot, subscribeMounted, useHasTrafficLights, useIsDesktop } from '@/components/desktop-titlebar'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { WorkspaceSwitcher, useWorkspaceEdition } from '@/app/account/workspace-switcher'
import { pagesFor } from '@/lib/chat-cards/page-menu'
import { openTarget } from '@/lib/chat-cards/open-card'
import { openSearch } from '@/lib/chat/open-search'
import { useModKeyLabel } from '@/lib/hotkeys'
import { closeFrontCards, frontCard, subscribeFrontCard } from '@/components/chat-cards/front-card'
import { activeRailItem, railPagesFor, type RailPageId } from './rail-pages'

/** On the shell root (server markup) and <html> (for the layer on <body>): defines `--app-rail-w`. */
export const APP_RAIL_ATTR = 'data-app-rail'

const PAGE_ICONS: Record<RailPageId, LucideIcon> = {
  docs: Folder,
  mail: Mail,
  'team-chat': MessagesSquare,
  actions: ListChecks,
  calendar: Calendar,
  agents: Sparkles,
  crm: Building2,
}

// A tint of the foreground for hover and the lit page: it reads on the rail's
// surface in light and dark alike (bg-muted is the surface's own shade in light).
const ITEM =
  'relative flex size-9 shrink-0 items-center justify-center rounded-lg text-sidebar-foreground/65 transition-colors hover:bg-foreground/[0.05] hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none'
const ITEM_ACTIVE = 'bg-foreground/[0.08] text-sidebar-foreground hover:bg-foreground/[0.08]'
const TIP = 'flex items-center gap-1.5 rounded-lg border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md'
const KBD = 'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] border bg-muted/60 px-1 text-[10px] font-medium text-muted-foreground'

/** How often, and how long, New tries for the cursor. */
const FOCUS_RETRY_MS = 25
const FOCUS_WAIT_MS = 600

/**
 * The cursor in the main chat's composer, once it can take it. Under a
 * full-screen page the chat doesn't paint (visibility: hidden takes no focus);
 * the page leaves on the chat's next commit, and the composer then eases back
 * in (its `transition: all` takes visibility too, hidden for its first frame).
 * So it tries until the field has the focus, for a moment at most: a short
 * poll on a click, nothing at rest.
 */
function focusComposerWhenClear(): void {
  const started = Date.now()
  const attempt = () => {
    const field = document.querySelector<HTMLTextAreaElement>('#dial8-chat-strip-slot [data-chat-input-root] textarea')
    if (!frontCard() && field) {
      field.focus({ preventScroll: true })
      if (document.activeElement === field) return
    }
    if (Date.now() - started < FOCUS_WAIT_MS) window.setTimeout(attempt, FOCUS_RETRY_MS)
  }
  attempt()
}

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

  const onNew = () => {
    closeFrontCards()
    focusComposerWhenClear()
  }

  return (
    <nav
      data-app-rail-nav=""
      aria-label="Pages"
      className="absolute inset-y-0 left-0 z-30 hidden flex-col items-center bg-background/70 backdrop-blur-md md:flex"
      style={{ width: 'var(--app-rail-w)' }}
    >
      {/* Its edge, a hairline: in the Mac app from under the traffic lights
          down, so it never runs between them (the third sits past the rail,
          as in Liam's reference). */}
      <div aria-hidden className={cn('pointer-events-none absolute bottom-0 right-0 w-px bg-border/60', trafficLights ? 'top-11' : 'top-0')} />
      {/* Window drag surface over the top (childless: Tauri drags only on
          the attributed target), with room for the Mac's traffic lights. */}
      <div data-tauri-drag-region="" aria-hidden className={cn('w-full shrink-0', trafficLights ? 'h-11' : 'h-1.5')} />
      {mounted && (
        <TooltipProvider delayDuration={300}>
          <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto overflow-x-hidden pb-2.5 [scrollbar-width:none]">
            <RailButton label="New" hint={<span className="text-muted-foreground">Ask your agent</span>} onClick={onNew} data={{ 'data-app-rail-item': 'new' }}>
              <Plus className="size-[18px]" strokeWidth={1.75} />
            </RailButton>
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
            <div aria-hidden className="h-2.5 shrink-0" />
            <RailButton label="Home" active={active === 'home'} onClick={closeFrontCards} data={{ 'data-app-rail-item': 'home' }}>
              <House className="size-[18px]" strokeWidth={1.75} />
            </RailButton>
            {pages.map(({ def, page }) => {
              const Icon = PAGE_ICONS[def.id]
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
            })}
            <div className="flex-1" />
            <div data-app-rail-item="workspace">
              <WorkspaceSwitcher variant="rail" />
            </div>
          </div>
        </TooltipProvider>
      )}
    </nav>
  )
}
