'use client'

import { useSyncExternalStore } from 'react'
import { cn } from '@/lib/utils'
import { useHasTrafficLights, subscribeMounted, getMountedSnapshot, getMountedServerSnapshot } from '@/components/desktop-titlebar'
import { topBarLeftInset } from './insets'
import { useRecordingStable } from '@/hooks/recording-context'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useOptionalSettingsOverlay } from '../settings-overlay'
import { useHotkeys } from '@/lib/hotkeys'
import { WorkspaceSwitcher } from '../../workspace-switcher'
import { ListenModeToggle } from '@/components/read-aloud/listen-mode-toggle'
import { ForYouToggle, SidePanelToggle } from '../side-panels/side-panel-toggles'
import { ComposerCaptureButton } from '../chat/composer-capture-button'
import { COLUMN_CARD_SKIN } from '@/components/attention/card-skin'
import { SearchButton } from './search-button'

/**
 * Where the bar's first control starts: past the traffic lights (or 4px in),
 * and from `md` up past the app rail's header too (rail/app-rail.tsx, Liam
 * 11-09: Home, the workspace and Search in one pill at the top left), 8px
 * after it (`--app-header-right`, the header's right edge from the window's,
 * 0 while it is hidden).
 */
function leadInset(trafficLights: boolean): string {
  const base = topBarLeftInset(trafficLights)
  return `max(${typeof base === 'number' ? `${base}px` : base}, calc(var(--app-header-right, 0px) - var(--app-rail-w, 0px) + 8px))`
}

/**
 * The top bar's controls: For you's toggle leads it at the far left (from
 * `md` up only where its column has no room to show by itself), then Search
 * on a phone (from `md` up the app rail has it); Listen, the side panel's
 * toggle and the workspace pill trail it (Capture is in the chat's composer:
 * chat/composer-capture-button.tsx). There is nothing in its middle: the
 * main chat is one never-ending conversation (docs/plans/one-chat.md), so the
 * tabs, "New chat" and the chat history that sat there are gone.
 */
export function TopBar() {
  // The macOS app's window buttons overlay the bar's left end (the Windows
  // app's title bar sits above the page instead).
  const trafficLights = useHasTrafficLights()
  // Hydration-safe mount flag: false on SSR AND the first client render, true
  // only post-hydration. The nav-controls block below mounts Radix Tooltips
  // (each consumes `useId`); the bar and the chat input share one tree-wide
  // `useId` counter, so if this block's id-count differs between the server
  // HTML and the first client render it shifts the chat input's popover ids →
  // an `aria-controls` hydration mismatch. Gating on `mounted` guarantees the
  // block renders NOTHING on both SSR and the first client render, keeping the
  // counter identical. This matters MORE now that the block is no longer
  // desktop-only — it renders on the web build too, where SSR actually runs.
  const mounted = useSyncExternalStore(subscribeMounted, getMountedSnapshot, getMountedServerSnapshot)
  const settingsOverlay = useOptionalSettingsOverlay()
  const recording = useRecordingStable()
  const { isRecording, startRecording } = recording

  // Global hotkeys
  useHotkeys([
    { key: ',', mod: true, handler: () => settingsOverlay?.openSettings() },
    { key: 'n', mod: true, handler: () => { if (!isRecording) startRecording() } },
  ])

  return (
    // On the web the row is 36px (2px above/below the 32px pills). In the
    // desktop app it stays 44px because the macOS traffic lights are pinned at
    // 30pt from the window top (desktop/src-tauri/src/lib.rs
    // TRAFFIC_LIGHT_CENTER_Y) to match the 8pt pad + 22pt half-row — change
    // both together if this ever moves.
    <div
      data-tauri-drag-region
      data-tab-bar-row
      className={cn(
        'relative min-w-0 flex-1 items-center',
        // Three columns — leading cluster, an empty middle, trailing cluster.
        // The two `minmax(max-content, 1fr)` halves are equal until one hits
        // its contents; grid tracks, unlike flex halves, stay equal whatever
        // padding the sides carry (the traffic-light gutter). The middle is
        // drag surface.
        'grid grid-cols-[minmax(max-content,1fr)_minmax(0,auto)_minmax(max-content,1fr)]',
        // Pills cast a shadow below themselves; a clipping row would shear it.
        'overflow-visible',
        // Web is 40 rather than 36: the bar's clusters grew from 32px to 36px
        // (see the h-9 pills below), and the row keeps 2px of clearance above
        // and below them.
        //
        // Desktop STAYS 44: its row is centred on the macOS traffic lights,
        // which the desktop app pins at 30pt (8pt top pad + 22 — dial8-desktop
        // src-tauri/src/lib.rs TRAFFIC_LIGHT_CENTER_Y). At 48 the row's centre
        // moved to 32 and every cluster sat 2px below the window buttons. The
        // 36px pills still fit, with 4px to spare. Change both together.
        trafficLights ? 'h-[44px]' : 'h-[40px]'
      )}
    >
      {/* `contents`, so the leading cluster and the middle become grid items
          of the row itself. */}
      <div className="contents">
      {/* Leading cluster: For you's toggle, then Search,
          starting at the window's left edge. It carries the macOS
          traffic-light padding because it is the leftmost element and the
          lights overlay that gutter.
          `mounted` stays — see the useId note above; it is a hydration guard,
          not a platform one. */}
      {mounted && (
        <div
          data-tab-bar-lead
          className={cn(
            'relative z-10 flex items-center gap-1.5',
            // The grid's first column (see the row) — content-sized at its
            // start, so the rest of the column stays drag surface.
            'justify-self-start pr-2',
          )}
          style={{ paddingLeft: leadInset(trafficLights) }}
        >
          <TooltipProvider delayDuration={300}>
            {/* For you's toggle (side-panels/side-panel-toggles.tsx), on a
                phone only, at the far left over its column: from `md` up it's
                in the app rail's header (rail/app-rail.tsx; Liam, 11-09: the
                workspace's thumbnail, then For you, then Search). */}
            <div data-tab-bar-phone-only="" className="contents md:hidden">
              <ForYouToggle />
            </div>
            {/* Search, on a phone only (below `md`, where there is no app
                rail): from `md` up the rail has it (rail/app-rail.tsx; Liam,
                11-09). A round pill of its own: the `/` palette, flying out
                of it (search-button.tsx). */}
            <div data-tab-bar-phone-only="" className="contents md:hidden">
              <SearchButton />
            </div>
            {/* No Inbox bell after it (removed 2026-10-20, Liam): every
                notice reaches the agent, which tells the person in the chat
                (docs/plans/retire-notifications-page.md). No Create button
                (removed 2026-10-20, Liam): the agent creates things on
                request. No Agents button either (removed 2026-10-18): the
                agents are in the Library (Agents & skills) and the side
                panel's Agents row. */}
          </TooltipProvider>
        </div>
      )}
      {/* Traffic-light gutter for the ONLY case where the nav-controls block
          above renders nothing: pre-hydration. The macOS lights still overlay
          the top-left. */}
      {!mounted && (
        <div
          className="shrink-0 self-stretch"
          style={{ width: leadInset(trafficLights) }}
          data-tauri-drag-region
        />
      )}

      {/* The workspace + account menu is the [ ◍ ] avatar pill at the FAR
          RIGHT of the bar (WorkspaceSwitcher variant="pill", the trailing
          cluster's last). tab-bar keeps the `W` hotkey → the workspaces veil. */}

      {/* The middle: nothing, drag surface (see the row). */}
      <div aria-hidden className="min-w-0" />
      </div>

      {/* Trailing control cluster — the grid's last column. In this order:
            Getting started · Interactive · the side panel's toggle (over the
          panel it opens) · [◍], which ends the bar at the window's right
          edge. (For you's toggle starts the bar at the left, then Search.)
          The column is content-sized (`minmax(max-content, 1fr)`).
          (Getting started expands into a card anchored below the bar.) */}
      <div
        // Deliberately NOT elevated above the top bar's WindowDragStrip: this
        // container's own gaps are drag surface. Only the interactive clusters
        // inside it carry z-10.
        // The grid's last column (see the row), pinned to its end.
        data-tab-bar-trail
        className={cn(
          'flex items-center gap-1.5 self-stretch',
          // Its gap from the window's right edge lives here, not on the bar, so
          // the row spans the whole window.
          'justify-self-end pr-2',
        )}
      >
        {/* Interactive (listen mode, desktop read-aloud), once for the whole
            app: on, each email, action or document
            you open reads itself, as does what you highlight in the in-app
            browser, the card being read pulses (ListenFrame), and on a
            desktop that can, you talk back by saying your assistant's name
            (its mic button sits beside it).
            Draws nothing where read-aloud can't play (a browser). z-10 lifts
            it above the WindowDragStrip. */}
        <ListenModeToggle className="z-10" />
        {/* From `md` up, the right header (Liam, 11-09: "move the capture
            button and make a component like the one we have on the left"):
            one glass pill, as the app rail's header is (rail/app-rail.tsx),
            holding Capture (moved out of the chat's composer:
            chat/composer-capture-button.tsx, the recording's controls while
            one runs) and the side panel's toggle (Agents · Plan ·
            Connections, side-panels/side-panels.tsx), over the panel it
            opens. Below `md` the toggle is the bar's pill, as before, and
            Capture stays in the composer. After hydration only (their
            Tooltips take a useId, see above). */}
        {mounted && (
          <TooltipProvider delayDuration={300}>
            <div
              data-top-bar-right-header=""
              // -my-px: its 42px in the bar's 40px row, level with the rail's header (3px from the top, as it is).
              // A capsule, as the rail's header: its ends follow the round buttons inside.
              className={cn('relative z-10 -my-px hidden items-center gap-0.5 rounded-full border border-border/60 p-1 md:flex', COLUMN_CARD_SKIN)}
            >
              <ComposerCaptureButton recording={recording} variant="header" />
              <SidePanelToggle variant="header" />
            </div>
            <div data-tab-bar-phone-only="" className="contents md:hidden">
              <SidePanelToggle />
            </div>
          </TooltipProvider>
        )}
        {/* The workspace + account pill (the avatar), at the very end of the
            bar (Liam, 10-19). z-10 lifts it above the WindowDragStrip. Its
            menu pours down out of the pill's own liquid, right-aligned, so it
            stays inside the window. */}
        {/* On a phone only (below `md`): from `md` up it is the app rail's
            foot, the one workspace menu (rail/app-rail.tsx; Liam, 11-09). */}
        <div data-tab-bar-workspace-pill="" className="relative z-10 flex h-8 min-w-0 shrink items-center md:hidden">
          <WorkspaceSwitcher variant="pill" />
        </div>
      </div>

    </div>
  )
}
