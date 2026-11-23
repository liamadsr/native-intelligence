'use client'

/**
 * Traditional's sidebar (docs/plans/traditional-layout.md), from `md` up (a
 * phone keeps today's layout in both): two flat, opaque panes down the
 * window's left, in place of the app rail and its floating page panel
 * (the owner, 11-23: "the icons have their own panel then the details panel
 * for team-chat and other options that currently show in the sub-menu").
 *
 *   the strip   a narrow column of icons: Create and Search, Home, then the
 *               person's pinned pages in their order with a hairline
 *               between the rail's sections (the same list the rail shows,
 *               ./use-rail-nav.ts, opened the same way: openRailEntry), and
 *               at its foot Customize bar and the workspace and account menu.
 *   the details beside it, the selected place's sub-nav under its name:
 *               Home's Recent, Mail's folders, Team chat's channels and DMs,
 *               My Actions' views and projects, a group's member pages.
 *               Those are the page panel's own panels, drawn into this pane
 *               (./sidebar-slots.ts, ../page-panel/page-panel-frame.tsx), so
 *               both layouts share one sub-nav per page. A page with no
 *               sub-nav (Inbox, Reviews) has no details pane: the page takes
 *               the room. It is the left part of the frame (below). Resizable by its right edge (a drag, or ←/→ on the
 *               handle) and foldable (its button; the top bar's, or a press
 *               on the lit icon, brings it back), both kept on this device
 *               (./sidebar-size.ts) and applied before paint.
 *
 * Its width is the shell's `--app-rail-w` in Traditional (tailwind.css: the
 * strip, plus the details pane while it shows): the top bar, the chat and a
 * page's layer all start after it.
 */
import { useCallback, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { House, LayoutList, PanelLeftClose, Plus, Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getMountedServerSnapshot, getMountedSnapshot, subscribeMounted, useHasTrafficLights } from '@/components/desktop-titlebar'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { WorkspaceSwitcher } from '@/app/account/workspace-switcher'
import { openCreateDialog } from '@/lib/create/open-create'
import { openSearch } from '@/lib/chat/open-search'
import { useModKeyLabel } from '@/lib/hotkeys'
import { minimizeFrontCards } from '@/components/chat-cards/front-card'
import { useLayoutMode } from '@/lib/layout-mode-store'
import { resetRailPrefs, setRailPagePinned, type OfferedRailPage, type RailPageId } from './rail-pages'
import { GROUP_PAGE_ICONS, RAIL_ICONS, loneMemberSlug } from './rail-icons'
import { CustomizeBar, GoToHint, KBD, commitRailPrefs, focusFrontPage } from './app-rail'
import { openRailEntry, useRailNav } from './use-rail-nav'
import { setSidebarSlot } from './sidebar-slots'
import { SIDEBAR_COLLAPSED_ATTR, SIDEBAR_MAX_W, SIDEBAR_MIN_W, setSidebarCollapsed, setSidebarWidth, sidebarWidthNow } from './sidebar-size'

const ICON =
  'relative flex size-9 shrink-0 items-center justify-center rounded-lg text-sidebar-foreground/60 transition-colors hover:bg-foreground/[0.06] hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none'
const ICON_ACTIVE = 'bg-foreground/[0.08] text-sidebar-foreground hover:bg-foreground/[0.08]'
const TIP = 'flex items-center gap-1.5 rounded-lg border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md'
const HAIRLINE = 'my-1.5 h-px w-6 shrink-0 bg-foreground/10'

/** A strip icon with its tooltip (its name, and its keys). */
function StripButton({
  label,
  hint,
  active = false,
  onClick,
  item,
  buttonRef,
  children,
}: {
  label: string
  hint?: ReactNode
  active?: boolean
  onClick: () => void
  item: string
  buttonRef?: React.Ref<HTMLButtonElement>
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
          data-sidebar-item={item}
          onClick={onClick}
          className={cn(ICON, active && ICON_ACTIVE)}
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

/** The slot a page's sub-nav is drawn into (./sidebar-slots.ts): one per place, only the selected one's shows. */
function SubnavSlot({ page }: { page: string }) {
  const ref = useCallback((el: HTMLDivElement | null) => setSidebarSlot(page, el), [page])
  return <div ref={ref} data-sidebar-subnav={page} className="contents" />
}

/** The resize handle on the details pane's right edge: a drag, or ←/→ (Shift: further); a double-click resets it. */
function ResizeHandle() {
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    const startX = e.clientX
    const startW = sidebarWidthNow()
    const move = (ev: globalThis.PointerEvent) => setSidebarWidth(startW + ev.clientX - startX, false)
    const up = (ev: globalThis.PointerEvent) => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
      setSidebarWidth(startW + ev.clientX - startX, true)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const step = e.shiftKey ? 40 : 10
    setSidebarWidth(sidebarWidthNow() + (e.key === 'ArrowRight' ? step : -step), true)
  }
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={SIDEBAR_MIN_W}
      aria-valuemax={SIDEBAR_MAX_W}
      tabIndex={0}
      data-sidebar-resize=""
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => setSidebarWidth(null, true)}
      className="absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize touch-none outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-transparent after:transition-colors hover:after:bg-primary/40 focus-visible:after:bg-primary/60"
    />
  )
}

export function TraditionalSidebar() {
  const mounted = useSyncExternalStore(subscribeMounted, getMountedSnapshot, getMountedServerSnapshot)
  const traditional = useLayoutMode() === 'traditional'
  const trafficLights = useHasTrafficLights()
  const { layout, prefs, groups, active } = useRailNav()
  const [customizeOpen, setCustomizeOpen] = useState(false)
  const searchRef = useRef<HTMLButtonElement>(null)
  const searchKey = useModKeyLabel('K')

  if (!traditional) return null

  const iconOf = (entry: OfferedRailPage) => {
    const Icon = GROUP_PAGE_ICONS[loneMemberSlug(entry) ?? ''] ?? RAIL_ICONS[entry.def.id] ?? LayoutList
    return <Icon className="size-[18px]" strokeWidth={1.75} />
  }
  // A press on the lit icon brings a folded details pane back.
  const unfoldIfLit = (id: string) => {
    if (active === id && document.documentElement.hasAttribute(SIDEBAR_COLLAPSED_ATTR)) setSidebarCollapsed(false)
  }
  const openEntry = (entry: OfferedRailPage) => {
    unfoldIfLit(entry.def.id)
    openRailEntry(entry)
    // Already in front: the page takes the keys back (the click left them here).
    if (active === entry.def.id) focusFrontPage()
  }
  const activeLabel = active === 'home' ? 'Home' : (layout.all.find((p) => p.def.id === active)?.label ?? '')
  const slotPages = ['home', ...layout.all.map((p) => p.def.id)]

  return (
    <>
    {/* The frame (the owner, 11-23: "the icons floating on their own on the left side
        panel then everything in one frame on the right"): one rounded, bordered pane
        from the strip to the window's right edge, a gutter in from the window's edges,
        holding the details pane, the top bar, the chat and a page in front. Drawn
        behind them; they sit inside it (tailwind.css, `--ni-frame-gap`). */}
    <div
      aria-hidden
      data-ni-frame=""
      className="pointer-events-none absolute z-[1] hidden rounded-[10px] border border-border bg-background md:block"
      style={{ left: 'var(--ni-strip-w)', top: 'var(--ni-frame-gap)', right: 'var(--ni-frame-gap)', bottom: 'var(--ni-frame-gap)' }}
    />
    <div data-ni-sidebar="" className="absolute bottom-0 left-0 top-0 z-30 hidden md:flex" style={{ width: 'var(--app-rail-w)' }}>
      {/* The window's drag surface above both panes in the Mac app, where the traffic lights sit. */}
      {trafficLights && <div data-tauri-drag-region="" aria-hidden className="absolute inset-x-0 top-0 z-0 h-11" />}

      {/* The strip: the pages as icons. */}
      <nav
        data-sidebar-strip=""
        aria-label="Pages"
        className={cn('relative z-[1] flex w-[var(--ni-strip-w,56px)] shrink-0 flex-col items-center', trafficLights ? 'pt-11' : 'pt-2')}
      >
        {mounted && (
          <TooltipProvider delayDuration={300}>
            <div className="flex flex-col items-center gap-1">
              <StripButton label="Create" hint={<kbd className={KBD}>C</kbd>} onClick={() => openCreateDialog()} item="create">
                <Plus className="size-[18px]" strokeWidth={2} />
              </StripButton>
              <StripButton label="Search" hint={<kbd className={KBD}>{searchKey}</kbd>} onClick={() => openSearch(searchRef.current)} item="search" buttonRef={searchRef}>
                <Search className="size-[18px]" strokeWidth={1.75} />
              </StripButton>
            </div>
            <div aria-hidden className={cn(HAIRLINE, 'my-2')} />
            <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto overflow-x-hidden pb-2 [scrollbar-width:none]">
              <StripButton
                label="Home"
                hint={<GoToHint home />}
                active={active === 'home'}
                onClick={() => {
                  unfoldIfLit('home')
                  minimizeFrontCards()
                }}
                item="home"
              >
                <House className="size-[18px]" strokeWidth={1.75} />
              </StripButton>
              {groups.map((g, i) => (
                <div key={g.group} data-sidebar-section={g.group} className="flex flex-col items-center gap-1">
                  {i > 0 && <div aria-hidden className={HAIRLINE} />}
                  {g.pages.map((entry) => (
                    <StripButton
                      key={entry.def.id}
                      label={entry.label}
                      hint={<GoToHint group={entry.members ? entry.def.id : undefined} slug={entry.page.slug} />}
                      active={active === entry.def.id}
                      onClick={() => openEntry(entry)}
                      item={entry.def.id}
                    >
                      {iconOf(entry)}
                    </StripButton>
                  ))}
                </div>
              ))}
            </div>
            <div data-sidebar-foot="" className="flex shrink-0 flex-col items-center gap-1 pb-2 pt-1">
              <CustomizeBar
                layout={layout}
                prefs={prefs}
                open={customizeOpen}
                onOpenChange={setCustomizeOpen}
                onPinned={(id: RailPageId, pinned: boolean) => commitRailPrefs(setRailPagePinned(prefs, id, pinned))}
                onReset={() => commitRailPrefs(resetRailPrefs(prefs))}
              />
              <div data-sidebar-item="workspace" className="flex">
                <WorkspaceSwitcher variant="rail" />
              </div>
            </div>
          </TooltipProvider>
        )}
      </nav>

      {/* The details: the selected place's sub-nav under its name. Hidden (tailwind.css) while it has none, or folded. */}
      <aside
        data-sidebar-column=""
        aria-label={activeLabel ? `${activeLabel} navigation` : 'Navigation'}
        className="relative z-[1] my-[var(--ni-frame-gap)] flex min-w-0 flex-1 flex-col border-r border-border text-sidebar-foreground"
      >
        <div data-sidebar-head="" className={cn('flex shrink-0 items-center gap-1 pl-4 pr-1.5', trafficLights ? 'h-[44px]' : 'h-[40px]')}>
          <h2 className="min-w-0 flex-1 truncate text-[14px] font-semibold">{activeLabel}</h2>
          <button
            type="button"
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
            data-sidebar-collapse=""
            onClick={() => setSidebarCollapsed(true)}
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/60 hover:bg-foreground/[0.05] hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <PanelLeftClose className="size-4" strokeWidth={1.75} />
          </button>
        </div>
        <div data-sidebar-details="" className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1.5 pb-2 [scrollbar-width:thin]">
          {slotPages.map((page) => (
            <SubnavSlot key={page} page={page} />
          ))}
        </div>
        <ResizeHandle />
      </aside>
    </div>
    </>
  )
}
