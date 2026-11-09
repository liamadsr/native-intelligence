'use client'

import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { usePostHog } from 'posthog-js/react'
import { cn } from '@/lib/utils'
import { MainChatProvider } from './main-chat/main-chat-context'
import { MainChatHost, RecordingNavigateBridge } from './main-chat/main-chat-host'
import { TopBar } from './top-bar/top-bar'
import { PixelCanvas } from './backdrop/pixel-canvas'
import { useBackdropMotionKind } from '@/components/sky/sky-gate'
import { WindowBackdropSync } from '@/components/window-backdrop-sync'
import { GreetingNameProvider } from '@/components/sky/conditions-line'
import { startSkyFeed } from '@/lib/sky/sky-state'
import { SkyDevPanelMount } from '@/components/sky/sky-dev-panel-mount'
import { lazyComponent } from '@/lib/lazy-component'
import { ForYouColumn } from './chat/for-you-column'
import { CardReplyBackdrop } from './chat/card-reply-chip'
import { INSET_LEFT_VAR, INSET_RIGHT_VAR, RightSidePanel, useSidePanelPlan } from './side-panels/side-panels'
import { RIGHT_RESERVE_PX, TOP_BAR_FADE_PX } from './side-panels/space-plan'
import { WorkspaceCacheProvider, useWorkspaceId } from '../workspace-switcher'
import { AutomationMount } from '@/lib/automation/automation-mount'
import { installPerfSnapshot, takePerfSnapshot } from '@/lib/perf/perf-snapshot'
import { startPerfSnapshotEvents } from '@/lib/perf/perf-snapshot-events'
import { createClient } from '@/lib/supabase/client'
import { CONTENT_PANEL_ID, WorkspaceTransitionProvider, useWorkspaceTransition } from '../workspace-transition'
import { WorkspacesVeil } from './workspaces-veil'
import { useRealtimeEntities } from '@/hooks/use-realtime-entities'
import { RealtimeWatchdogMount } from '@/components/realtime/realtime-watchdog-mount'
import { WindowDragStrip } from '@/components/desktop/window-drag-strip'
import { useHasTrafficLights } from '@/components/desktop-titlebar'
import { garbageCollectAbandonedDrafts } from '@/components/views/hooks/use-view'
import { TeamsProvider } from '../teams-context'
import { NotificationProvider } from '../notification-context'
import { InAppMessageProvider } from '../in-app-message-context'
import { InAppMessageToaster } from '../in-app-message-toaster'
import { InAppMessageDialog } from '../in-app-message-dialog'
import { DesktopNudgeToast } from './desktop-nudge-toast'
import { TrayStartCaptureHandler } from '@/components/desktop/tray-start-capture-handler'
import { VoiceIdHudPublisher } from '@/components/capture/voice-id-hud-publisher'
import { LiveHudMount } from '@/components/live-hud/web-hud'
import { ActiveCaptureDrop } from './active-capture-drop'
import { NativeNotificationClickHandler } from '@/components/desktop/native-notification-click-handler'
import { AppUpdater } from '@/components/desktop/app-updater'
import { CoreAudioHealthToast } from '@/components/desktop/core-audio-health-toast'
import { MicModeToast } from '@/components/desktop/mic-mode-toast'
import { CreateDialog } from '@/components/create-dialog'
import { UsageLimitDialog } from '@/components/usage-limit-dialog'
import { CaptureRecoveryPrompt } from '@/components/capture/capture-recovery-prompt'
import { SettingsOverlayProvider } from './settings-overlay'
import { CelebrationOverlay } from '@/components/celebration/celebration-overlay'
import { AgentWorkProvider } from '@/components/work/agent-work-provider'
import { AgentInfraHost } from '@/components/work/agent-infra-host'
import { EasterEggBird } from '@/components/birds/easter-egg-bird'
import { DashboardSuggestionsProvider } from '@/components/suggestions/dashboard-suggestions-provider'
import { OpenTeammateDevBridge } from '@/hooks/use-open-teammate'
import { TeammateChatTabBridge } from '@/components/bots/teammate-chat-tab-bridge'
import { VoiceNudgeCard } from '@/components/voice-enrollment/voice-nudge-card'
import { useUiSoundsRuntime } from '@/lib/sounds/runtime'
import { Toaster, toast } from 'sonner'
import { createPortal } from 'react-dom'
import { setClientWorkspaceId, patchFetch } from '@/lib/workspace-fetch'
import { AuthSessionPinger } from '@/components/analytics/auth-session-pinger'
import { InteractiveVoiceHost } from '@/components/read-aloud/interactive-voice-host'
import { TalkAnywhereHost } from '@/components/read-aloud/talk-anywhere-host'
import { SilentMicNotice } from '@/components/desktop/silent-mic-notice'
import { FadingBlur } from '@/components/ui/fading-blur'
import { APP_RAIL_ATTR, AppRail } from './rail/app-rail'

/** The top bar — always fully visible. The workspace switcher and the action
 *  buttons float over the chat, which scrolls on under them (Liam's
 *  reference: content passing beneath the bar, not stopping at a line). */
/** The blur under the top bar: the bar's height, then TOP_BAR_FADE_PX more. */
const TOP_BAR_BLUR_STYLE = { height: `calc(100% + ${TOP_BAR_FADE_PX}px)` }
/** The top bar and the chat row start clear of the app rail (rail/app-rail.tsx). */
const TOP_BAR_STYLE = { left: 'var(--app-rail-w, 0px)' }
const CHAT_ROW_STYLE = { marginLeft: 'var(--app-rail-w, 0px)' }

function DashboardTopBar() {
  // Web gets half the top pad (pt-1 = 4px); the desktop app keeps pt-2 because the
  // macOS traffic lights are pinned at 30pt from the window top (dial8-desktop
  // src-tauri/src/lib.rs TRAFFIC_LIGHT_CENTER_Y = 8pt pad + 22pt) — change both
  // together if this ever moves; the Windows app's title bar sits above the page,
  // so it gets the web's pad. `useHasTrafficLights` is hydration-safe (false on the
  // server and the first client render, true after mount in Tauri), so desktop
  // widens post-mount, the same pattern TopBar already uses for the
  // traffic-light paddingLeft.
  const trafficLights = useHasTrafficLights()
  // Out of the flow, so the chat reads the bar's height to keep its first line
  // and its overlays clear of it: --top-bar-h on the shell (ChatRow passes it
  // on as --chat-top-inset).
  const barRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const bar = barRef.current
    const shell = bar?.parentElement
    if (!bar || !shell) return
    const measure = () => shell.style.setProperty('--top-bar-h', `${bar.offsetHeight}px`)
    measure()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    observer?.observe(bar)
    return () => observer?.disconnect()
  }, [])
  return (
    // Over the chat and the shell-level photo; transparent, so both show
    // through the header row.
    <div
      ref={barRef}
      // The voice bird perches on its bottom edge (components/birds/easter-egg-bird.tsx).
      data-shell-top-bar=""
      style={TOP_BAR_STYLE}
      className={cn(
        // No side padding: the bar spans the window from the app rail to its
        // right edge, as the chat beneath it does (the trailing cluster
        // carries its own pr-2).
        'absolute right-0 top-0 flex items-center',
        'z-40',
        trafficLights ? 'pt-2' : 'pt-1',
      )}
    >
      {/* Under the bar the chat goes soft, a blur that fades out downward
          (Liam, 10-18: most blurry at the top, less and less going down, not
          one flat band), so what scrolls up passes beneath the bar instead of
          being cut off. The side panels start below it (TOP_BAR_FADE_PX). */}
      <FadingBlur direction="down" className="absolute inset-x-0 top-0" style={TOP_BAR_BLUR_STYLE} />
      {/* Window-drag layer for the desktop app: covers the ENTIRE strip at
          z-[5]; every interactive cluster in the bar sits at z-10 above it.
          (An attribute on this container alone would be dead — Tauri only
          drags when the mousedown target itself is attributed.) */}
      <WindowDragStrip />
      {/* TopBar owns ALL the in-flow controls: create, bots and the inbox
          bell lead the bar, and listen mode · capture · [workspace pill]
          trail at the window's right edge. Nothing in its middle: there is
          one chat (docs/plans/one-chat.md). */}
      <TopBar />
    </div>
  )
}

/** The live sky's WebGL module, fetched only when the sky is the background. */
const SkyCanvas = lazyComponent(() => import('@/components/sky/sky-canvas').then((m) => m.SkyCanvas))

/**
 * What moves in the shell backdrop: the live sky when it's the background
 * (Preferences → Background → Sky, the default), the dotted twinkle
 * otherwise. Nothing until the client knows which (the server and hydration
 * can't), so neither starts only to be swapped out; the plain backdrop
 * colour shows meanwhile. Also starts the one sky-state fetch the whole app
 * reads (useSkyState), whichever background is on.
 */
function BackdropMotion() {
  const kind = useBackdropMotionKind()
  useEffect(() => startSkyFeed(), [])
  if (kind === 'sky') return <SkyCanvas />
  if (kind === 'dots') return <PixelCanvas opacity={0.4} />
  return null
}

/**
 * The row under the top bar: the full-bleed main chat (there is one:
 * docs/plans/one-chat.md), and over it the layer a browser card's full screen is drawn in (see
 * CardStageLayerProvider). There are no page windows: every page is a card in
 * the chat.
 */
function ChatRow({ avatarUrl, initials }: { avatarUrl: string | null; initials: string }) {
  // The panels around the chat (side-panels/side-panels.tsx): where each goes
  // in this row. A new value only when a panel's mode changes (a toggle, or
  // a resize across its line), never per frame: how far the chat moves for
  // them is on the row's CSS variables (STRIP_STYLE).
  const rowRef = useRef<HTMLDivElement>(null)
  const plan = useSidePanelPlan(rowRef)
  return (
    // `relative z-10` so the whole row sits above the shell-level photo.
    // While one of the chat composer's rising cards (Capture, Transcripts,
    // Tools) is out it drops to `z-auto`, so the card can rise over the rest.
    // See CAPTURE_CARD_UP_ATTR in chat/composer-liquid-pill.
    <div
      ref={rowRef}
      // A workspace switch's curtain covers the chat stage (workspace-transition.tsx).
      id={CONTENT_PANEL_ID}
      data-windows-row=""
      // The top bar floats over this row (DashboardTopBar): what sits at the
      // row's top reads its height to stay clear of it. It starts clear of
      // the app rail.
      style={CHAT_ROW_STYLE}
      className="relative z-10 flex min-h-0 flex-1 overflow-hidden [--chat-top-inset:var(--top-bar-h,0px)] [html[data-capture-card-up]_&]:z-auto [html[data-card-reply-focus]_&]:z-auto"
    >
        {/* CHAT STRIP — transparent so the shell-level photo background shows
            through behind the chat. Its margins move its centred content
            just clear of a panel making room (space-plan.ts: nothing where
            the panel fits beside the content, twice the shortfall on the
            panel's side where it doesn't): set at once, never animated. */}
        <div
          id="dial8-chat-strip-slot"
          className={cn(
            'relative z-20 flex shrink-0 grow-0 flex-col overflow-hidden',
            // Not a stacking context while one of the composer's rising cards
            // is out, so the card isn't trapped with the rest of the chat. See
            // CAPTURE_CARD_UP_ATTR in chat/composer-liquid-pill.
            '[html[data-capture-card-up]_&]:z-auto',
            // Nor while a card waits as the Reply chip: the composer rises over
            // the blur (CARD_REPLY_FOCUS_ATTR in lib/chat/card-reply-focus.ts).
            '[html[data-card-reply-focus]_&]:z-auto',
          )}
          style={STRIP_STYLE}
        >
          <ChatStripContents avatarUrl={avatarUrl} initials={initials} />
        </div>
        {/* The For you column on the left and the side panel on the right
            (side-panels.tsx): beside the chat's content where they make room,
            over the chat's edge where they float. */}
        <ForYouColumn mode={plan.left} />
        <RightSidePanel mode={plan.right} />

      {/* Voice enrollment nudge, above the chat, in the top right corner:
          left of the side panel while it is open, so the two never overlap. */}
      <div
        className="pointer-events-none absolute inset-y-0 right-0 z-40 hidden max-w-[45%] items-start justify-end pr-3 pt-[calc(var(--chat-top-inset,0px)+0.5rem)] md:flex"
        style={plan.right !== 'off' ? { right: RIGHT_RESERVE_PX } : undefined}
      >
        <div className="pointer-events-auto flex flex-col items-end gap-2">
          <VoiceNudgeCard />
        </div>
      </div>
    </div>
  )
}

/** The chat strip's margins: the space plan's, from the row's CSS variables (useSidePanelPlan). */
const STRIP_STYLE = {
  marginLeft: `var(${INSET_LEFT_VAR}, 0px)`,
  flexBasis: `calc(100% - var(${INSET_LEFT_VAR}, 0px) - var(${INSET_RIGHT_VAR}, 0px))`,
}

/**
 * What the chat strip holds: the main chat, and the agents' page-wide pieces
 * beside it (AgentInfraHost: it draws nothing), and the voice bird (nothing
 * unless it was summoned: components/birds/voice-bird.ts). Memoized on its primitives,
 * so the row re-rendering for a panel toggle never re-renders the chat.
 */
const ChatStripContents = memo(function ChatStripContents({ avatarUrl, initials }: { avatarUrl: string | null; initials: string }) {
  return (
    <>
      <MainChatHost userAvatarUrl={avatarUrl} userInitials={initials} />
      <AgentInfraHost />
      <EasterEggBird />
    </>
  )
})

/** Lock body/html scrolling while the dashboard is mounted so macOS elastic
 *  overscroll doesn't move the entire shell (tabs, sidebar, header). */
function useBodyScrollLock() {
  useEffect(() => {
    const html = document.documentElement
    const body = document.body

    // Save originals
    const prevHtmlOverflow = html.style.overflow
    const prevBodyOverflow = body.style.overflow
    const prevHtmlOverscroll = html.style.overscrollBehavior
    const prevBodyOverscroll = body.style.overscrollBehavior

    html.style.overflow = 'hidden'
    body.style.overflow = 'hidden'
    html.style.overscrollBehavior = 'none'
    body.style.overscrollBehavior = 'none'

    return () => {
      html.style.overflow = prevHtmlOverflow
      body.style.overflow = prevBodyOverflow
      html.style.overscrollBehavior = prevHtmlOverscroll
      body.style.overscrollBehavior = prevBodyOverscroll
    }
  }, [])
}

/** Mounts the workspace-scoped Supabase Realtime subscriptions for every
 *  list-rendered entity (actions, projects, captures, contacts, …). Sits
 *  inside WorkspaceCacheProvider so useWorkspaceId() is available and
 *  re-subscribes on workspace switch. */
function RealtimeEntitiesMount() {
  const workspaceId = useWorkspaceId()
  useRealtimeEntities(workspaceId)
  return null
}

/** UI sounds' per-window runtime (the browser unlock, desktop voice sessions). */
function UiSoundsMount() {
  useUiSoundsRuntime()
  return null
}

/** Associates the identified person with their current workspace as a PostHog
 *  group, mirroring the server-side `groups: { workspace }` in trackServerEvent.
 *  This lets the launch dashboard count active workspaces and roll usage up per
 *  workspace. Sits inside WorkspaceCacheProvider so useWorkspaceId() resolves
 *  and re-groups on workspace switch. */
function PostHogWorkspaceGroup() {
  const posthog = usePostHog()
  const workspaceId = useWorkspaceId()
  useEffect(() => {
    if (posthog && workspaceId) {
      posthog.group('workspace', workspaceId)
    }
  }, [posthog, workspaceId])
  return null
}

/** Once-per-session sweep of localStorage view drafts that have been
 *  untouched for 90+ days. Active drafts are bumped on every write, so
 *  this only catches truly abandoned ones. */
function DraftGarbageCollector() {
  useEffect(() => { garbageCollectAbandonedDrafts() }, [])
  return null
}

/**
 * `window.__dial8PerfSnapshot()`: what the page holds, in counts
 * (src/lib/perf/perf-snapshot.ts). Nothing runs until it is called, except in
 * the desktop main window, which sends its counts to PostHog every 30 minutes
 * (perf-snapshot-events.ts).
 */
function PerfSnapshotMount() {
  const posthog = usePostHog()
  useEffect(() => {
    const sources = { realtimeTopics: () => createClient().getChannels().map((c) => c.topic) }
    const uninstall = installPerfSnapshot(sources)
    const stopEvents = posthog ? startPerfSnapshotEvents((event, props) => posthog.capture(event, props), () => takePerfSnapshot(document, sources)) : () => {}
    return () => {
      stopEvents()
      uninstall()
    }
  }, [posthog])
  return null
}

/** Backoff before the single switch retry. Short on purpose: someone is staring
 *  at a window that is currently showing the WRONG workspace. */
const WORKSPACE_SWITCH_RETRY_MS = 500

/**
 * POST the workspace switch, retrying ONCE on a failure that could plausibly
 * succeed a moment later. Resolves true only when the cookie really was
 * switched server-side.
 *
 * A network rejection and a 5xx are transient — a desktop window opened
 * straight into a cold app routinely races the first request out before the
 * connection is ready. A 4xx is a verdict (not a member, malformed id) that
 * retrying cannot change, so it fails fast.
 */
async function postWorkspaceSwitch(workspaceId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, WORKSPACE_SWITCH_RETRY_MS))
    }
    try {
      const res = await fetch('/api/account/workspace/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-workspace-id': workspaceId },
        body: JSON.stringify({ workspace_id: workspaceId }),
      })
      if (res.ok) return true
      if (res.status < 500) return false
    } catch {
      /* network error — fall through to the retry */
    }
  }
  return false
}

/** Auto-switch workspace when opened via `?switch_to=<id>` (multi-window).
 *  Exported for its spec — it is only ever rendered from DashboardShell. */
export function WorkspaceAutoSwitch() {
  // One-shot per mount, guarded against Strict Mode's double-invoke with a ref
  // armed on entry — the same shape as TeamsProvider's initial fetch. The guard
  // used to be implicit: the effect stripped `?switch_to` on its first line, so
  // a second pass found nothing to do. The param now SURVIVES until the switch
  // succeeds (see below), so without an explicit guard the POST — and, on
  // failure, the toast — would fire twice.
  //
  // Deliberately no cleanup-driven cancellation flag: under Strict Mode the
  // first pass's cleanup would cancel the only run that is allowed to happen,
  // and the second pass returns early on the armed ref. This component lives
  // for the life of the shell and the success path reloads the page anyway.
  const ranRef = useRef(false)

  useEffect(() => {
    if (ranRef.current) return
    ranRef.current = true

    const params = new URLSearchParams(window.location.search)
    const switchTo = params.get('switch_to')
    if (!switchTo) return

    // Point the fetch interceptor at the target workspace right away, so every
    // `/api/` request this window makes from here on carries `x-workspace-id`
    // and the in-flight session already reads the RIGHT workspace — before the
    // cookie has caught up, and whether or not the POST below ever lands. This
    // avoids mutating the shared httpOnly cookie from the client, which would
    // affect ALL windows.
    patchFetch()
    setClientWorkspaceId(switchTo)

    // Also switch the cookie so server-rendered pages pick it up. In a
    // multi-window setup each window has its own data_directory, so the cookie
    // write only affects this window's browsing context.
    //
    // THE PARAM IS STRIPPED ONLY AFTER THE POST SUCCEEDS. Stripping it up front
    // (the old order) made a failed switch unrecoverable: the rejection was
    // swallowed by a bare `.catch(() => {})`, nothing retried, and the param
    // was already gone from the URL. A fresh desktop window — isolated cookies
    // AND localStorage, see the note in lib/tauri-bridge — was then pinned to
    // the oldest-membership workspace with no way back short of closing it.
    // Leaving the param in place makes a manual reload a genuine retry.
    void postWorkspaceSwitch(switchTo).then((ok) => {
      if (!ok) {
        toast.error("Couldn't switch to that workspace — reload to retry")
        return
      }
      // Now that the cookie really is switched, drop the param and reload to
      // pick up the new workspace context server-side.
      window.history.replaceState({}, '', window.location.pathname)
      window.location.reload()
    })
  }, [])

  return null
}

export function DashboardShell({
  userId,
  email,
  name,
  avatarUrl,
}: {
  userId: string
  email: string
  name: string | null
  avatarUrl: string | null
}) {
  useBodyScrollLock()

  const posthog = usePostHog()
  useEffect(() => {
    if (userId && email) {
      // Identify by Supabase user.id (the same distinct_id server-side product
      // events use via trackServerEvent) so client + server events land on one
      // person profile. Enrich with name so the launch dashboard can show real
      // names alongside emails. `name` is read but intentionally NOT a dep —
      // identify should fire once per (user, email), not re-fire when the name
      // prop hydrates a beat later; PostHog person props are last-write-wins so
      // the name still lands. Keeping deps stable also avoids effect churn.
      //
      // The 3rd arg is $set_once: acquisition-channel props that must reflect
      // the user's FIRST touch and never be overwritten. posthog-js already
      // captures $initial_utm_* / $initial_referring_domain automatically, but
      // we also stamp an explicit `signup_channel` so the dashboard can break
      // down signups by channel with a single, stable property — the core lever
      // for knowing which acquisition sources actually convert.
      posthog?.identify(
        userId,
        { email, ...(name ? { name } : {}) },
        firstTouchAttribution(),
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [posthog, userId, email])

  const [mounted, setMounted] = useState(false)
  const [isDark, setIsDark] = useState(false)
  useEffect(() => {
    setMounted(true)
    setIsDark(document.documentElement.classList.contains('dark'))
    // Watch for dark mode changes
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains('dark'))
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  const initials = name
    ? name
        .split(' ')
        .map((n) => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2)
    : email[0].toUpperCase()

  return (
    <WorkspaceCacheProvider>
      <MainChatProvider>
      <TeamsProvider>
      <WorkspaceTransitionProvider>
      <NotificationProvider>
      <InAppMessageProvider>
      <SettingsOverlayProvider>
      {/* What the AI teammates are doing, loaded ONCE for the shell: the
          bots read the same rows, cards and per-teammate counts over the
          same channels (the light read, bot-characters.md Step 3). */}
      <AgentWorkProvider key={userId}>
      {/* One suggestions store for every surface (suggestions-everywhere):
          chat answers, documents and bot pages show the same rows live. */}
      <DashboardSuggestionsProvider>
        {/* Development only: open a bot from the console,
            window.__dial8OpenTeammate([teammateId, …]) (use-open-teammate.ts). */}
        {process.env.NODE_ENV !== 'production' && <OpenTeammateDevBridge />}
        {/* A teammate's page as a card in the chat (openTeammateChatTab: a
            bot's page, wherever it's opened from). */}
        <TeammateChatTabBridge userAvatarUrl={avatarUrl} userInitials={initials} />
        <RecordingNavigateBridge />
        {/* Interactive mode's voice: listens for the assistant's name while
            Interactive is on (desktop only), once for the app, never inside
            the chat panel (whose voice mode ends with its chat). */}
        <InteractiveVoiceHost />
        {/* Talk anywhere: words spoken to the agent from the right ⌥ key in any
            app reach the home thread here; the reply is read aloud (desktop only). */}
        <TalkAnywhereHost />
        {/* The mic in use sending only silence: one toast per episode while
            something listens (desktop only). */}
        <SilentMicNotice />
        <WorkspaceAutoSwitch />
        <RealtimeEntitiesMount />
        <RealtimeWatchdogMount />
        <UiSoundsMount />
        <PostHogWorkspaceGroup />
        <AuthSessionPinger />
        <DraftGarbageCollector />
        <PerfSnapshotMount />
        {/* window.__dial8Automation, only in the desktop app launched with the
            automation bridge (src/lib/automation): nothing, and no code, otherwise. */}
        <AutomationMount />
        {/* Glass: this desktop window see-through (window-backdrop.ts). */}
        <WindowBackdropSync />
        <div
          id="dial8-shell-root"
          // The app rail's width, `--app-rail-w` (tailwind.css): here in the
          // server markup, so the top bar and the chat start clear of it.
          {...{ [APP_RAIL_ATTR]: '' }}
          className="group/shell relative flex h-dvh flex-col overflow-hidden overscroll-none"
        >
          {/* The shell's own surface: the flat `bg-sidebar`, or the custom
              photo below, or (Glass) a tint over the see-through
              window (tailwind.css, `html[data-glass-window]`). */}
          <div
            aria-hidden
            data-shell-backdrop=""
            className="pointer-events-none absolute inset-0 z-0 bg-sidebar"
          >
            {/* Custom user-uploaded background — spans the WHOLE shell (full-width
                header included). It sits behind everything; the content panel
                paints its own opaque `bg-background` on top, so the image only
                shows through the transparent top bar + chat strip. Only shown when
                the user picks "Custom" in Preferences (`data-app-bg='custom'`,
                gated in CSS); by default the flat `bg-sidebar` surface shows.
                Each layer reads its image from a CSS var set by the upload flow
                (custom-background.ts) / pre-hydration script. When a mode has no
                uploaded image its var is unset → `background-image: var(--…)`
                resolves to nothing and the flat `bg-sidebar` surface shows
                through, so a light-only or dark-only upload works cleanly. */}
            <div
              aria-hidden
              className="app-bg-custom app-bg-custom-light pointer-events-none absolute inset-0 z-0 bg-cover bg-center bg-no-repeat dark:hidden"
            />
            <div
              aria-hidden
              className="app-bg-custom app-bg-custom-dark pointer-events-none absolute inset-0 z-0 hidden bg-cover bg-center bg-no-repeat dark:block"
            />
            {/* The sky (or the dots) spans the main chat and top bar, behind
                the chat. */}
            <BackdropMotion />
          </div>

          {/* The app rail down the left: the pages, a click away (rail/app-rail.tsx). */}
          <AppRail />
          {/* Top bar (from the rail to the right edge) — always visible (see TopBar). */}
          <DashboardTopBar />
          {/* Below the top bar: the full-bleed main chat. */}
          {/* The name the empty chat greets the person by (conditions-line.tsx). */}
          <GreetingNameProvider value={name}>
            <ChatRow avatarUrl={avatarUrl} initials={initials} />
          </GreetingNameProvider>
          {/* A card waiting as the chat's Reply chip: the rest goes soft, top bar too (card-reply-chip.tsx). */}
          <CardReplyBackdrop />

          {/* First run has no overlay of its own: the researcher's brief lands
              as the opening message in the member's home chat (finish_research +
              use-home-conversation-adoption), and the main agent walks them
              through getting started there (docs/plans/getting-started-skill.md). */}

          {/* Dismissible "Get the Mac app" nudge — a persistent lower-right
              toast in the same banner style as admin in-app messages.
              Auto-hides inside the desktop app. */}
          <DesktopNudgeToast />

          {/* Dev only: the floating sky preview (Settings → Developer → Sky
              preview). Renders nothing in production. */}
          <SkyDevPanelMount />
        </div>
      {/* Every workspace, behind the app: "View all workspaces" sends the
          shell above into the background (see WorkspacesVeil). A sibling of
          the shell, not inside it, since the shell is what moves. */}
      <WorkspacesVeil />
      <TrayStartCaptureHandler />
      {/* Desktop, during a live capture: Voice ID in the live agent's HUD. */}
      <VoiceIdHudPublisher />
      {/* Web, during a live capture: the live agent's HUD, a floating panel
          with its own chat (one-chat Slice 3). Nothing on desktop (the HUD
          has a window of its own there) or while nothing records. */}
      <LiveHudMount />
      {/* Files dropped outside a drop zone: to the live capture, if any;
          otherwise nowhere (never a navigation to the file). */}
      <ActiveCaptureDrop />
      <NativeNotificationClickHandler />
      <AppUpdater />
      {/* macOS audio stuck → Restart audio; Voice Isolation on while
          recording → Mic Mode. Desktop-only, main window only. */}
      <CoreAudioHealthToast />
      <MicModeToast />
      <CreateDialog />
      <UsageLimitDialog />
      <CaptureRecoveryPrompt />
      <InAppMessageToaster />
      <InAppMessageDialog />
      <CelebrationOverlay />
      {mounted && createPortal(
        <Toaster
          position="bottom-right"
          closeButton
          duration={5000}
          theme={isDark ? 'dark' : 'light'}
          style={{ zIndex: 2147483647 }}
          toastOptions={{
            className: 'rounded-lg',
            style: {
              background: 'hsl(var(--card))',
              color: 'hsl(var(--card-foreground))',
              borderColor: 'hsl(var(--border))',
            },
            classNames: {
              closeButton: 'right-2 left-auto top-2',
              actionButton: 'rounded-lg',
            },
          }}
        />,
        document.body,
      )}
      </DashboardSuggestionsProvider>
      </AgentWorkProvider>
      </SettingsOverlayProvider>
      </InAppMessageProvider>
      </NotificationProvider>
      </WorkspaceTransitionProvider>
      </TeamsProvider>
      </MainChatProvider>
    </WorkspaceCacheProvider>
  )
}

/**
 * First-touch acquisition attribution, returned as PostHog `$set_once` person
 * props so they're stamped on the profile exactly once (at first identify) and
 * never overwritten on later logins. Channel attribution is the single most
 * important growth lever: it answers "which sources actually convert to
 * signups?", not just "which drive traffic?".
 *
 * Reads UTM params from the current URL plus the document referrer. posthog-js
 * also auto-captures `$initial_utm_*`; this adds a single derived
 * `signup_channel` so the dashboard can group by one clean property.
 */
function firstTouchAttribution(): Record<string, unknown> {
  if (typeof window === 'undefined') return {}
  const params = new URLSearchParams(window.location.search)
  const utmSource = params.get('utm_source') || undefined
  const utmMedium = params.get('utm_medium') || undefined
  const utmCampaign = params.get('utm_campaign') || undefined
  const referrer =
    typeof document !== 'undefined' && document.referrer
      ? document.referrer
      : undefined

  return {
    signup_channel: deriveChannel(utmSource, utmMedium, referrer),
    ...(utmSource ? { initial_utm_source: utmSource } : {}),
    ...(utmMedium ? { initial_utm_medium: utmMedium } : {}),
    ...(utmCampaign ? { initial_utm_campaign: utmCampaign } : {}),
    ...(referrer ? { initial_referrer: referrer } : {}),
  }
}

/** Collapse UTM + referrer into one coarse channel bucket the dashboard groups
 *  by. Order matters: explicit UTM beats inferred referrer. */
function deriveChannel(
  utmSource?: string,
  utmMedium?: string,
  referrer?: string,
): string {
  const medium = utmMedium?.toLowerCase()
  if (medium === 'cpc' || medium === 'ppc' || medium === 'paid') return 'paid'
  if (medium === 'email') return 'email'
  if (medium === 'social') return 'social'
  if (medium === 'referral') return 'referral'
  if (utmSource) return `utm:${utmSource.toLowerCase()}`

  if (!referrer) return 'direct'
  try {
    const host = new URL(referrer).hostname.replace(/^www\./, '')
    if (host.includes('dial8.ai')) return 'internal'
    if (/google\.|bing\.|duckduckgo\.|yahoo\./.test(host)) return 'organic_search'
    if (/twitter\.|x\.com|linkedin\.|facebook\.|reddit\.|youtube\./.test(host))
      return 'social'
    return `referral:${host}`
  } catch {
    return 'direct'
  }
}
