'use client'

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { cn } from '@/lib/utils'
import { useModKeyLabel } from '@/lib/hotkeys'
import { ArrowLeft, Disc, Pause, Play, Square } from 'lucide-react'
import {
  useIsDesktop,
  subscribeMounted,
  getMountedSnapshot,
  getMountedServerSnapshot,
} from '@/components/desktop-titlebar'
import { useRecordingStable, useRecordingElapsed } from '@/hooks/recording-context'
import { formatTime } from '@/hooks/use-recording'
import { hudShowsRecordingControls, subscribeHudRecordingControls } from '@/lib/live-agent/hud-recording'
import { openActiveCapture, recordingDotClass, recordingStatusLabel } from '@/components/capture/recording-status'
import { CaptureCalendar } from './capture-calendar'
import {
  LiquidPill,
  LiquidPillCard,
  LiquidPillFace,
  useHangingCardFit,
  useLiquidPillHover,
  type LiquidPillCardSide,
} from '@/components/ui/liquid-pill'
import { useCardContentMounted, useRisingCardFit, useRisingCardLift } from '../chat/composer-liquid-pill'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

/**
 * The elapsed-time readout shown next to "Recording" in the capture button.
 * Isolated into its own component so only IT re-renders on every tick — elapsed
 * is an external store (useRecordingElapsed subscribes to it via
 * useSyncExternalStore), so only this <span> repaints each second. isPaused comes
 * from the STABLE context (it changes on pause/resume, not at frame rate). This
 * keeps the timer off the volatile full RecordingContext entirely — nothing in
 * this button subtree re-renders ~10×/s during a recording anymore.
 */
function RecordingTimer() {
  const elapsed = useRecordingElapsed()
  const { isPaused } = useRecordingStable()
  return (
    <span className={cn('text-[12px] tabular-nums', isPaused ? 'opacity-50' : 'opacity-70')}>
      {formatTime(elapsed)}
    </span>
  )
}

/** Today's calendar card, which pours out of the pill on hover. */
const CARD_WIDTH_PX = 320
const CARD_HEIGHT_PX = 320

/**
 * Capture button, in the top bar's trailing cluster, between the Interactive
 * switch and the workspace pill (top-bar.tsx). Its card hangs below the pill, the
 * default (`cardSide="bottom"`), the way the workspace menu does. It lived at
 * the end of the chat composer's top row for a while, its card rising out of
 * the pill (`cardSide="top"`); that side still works.
 * When idle — [Capture] alone.
 * When recording — [● Recording ←] | [❙❙ Pause] | [■ Stop].
 * Clicking "Recording" brings the live capture back: its card in the main chat,
 * docked beside it (the one already in the chat, when there is one).
 *
 * While a live agent's HUD shows those recording controls (Liam, 10-15: they
 * moved to the HUD's header; lib/live-agent/hud-recording.ts), the pill steps
 * aside and renders nothing: on web while the HUD panel is up, on desktop
 * once the HUD window has said it's listening. Until then, or if the HUD never
 * comes up, the pill stays, so a recording can always be paused and stopped
 * from here. Idle (and starting) it is always here: it starts captures.
 *
 * Idle, HOVERING it pours today's calendar out of the pill, with the same
 * liquid as the nav (see LiquidPill): the card falls out of the pill and
 * swells, joined to it by a neck of goo.
 * Clicking a meeting there starts a capture linked to it. Clicking the pill
 * itself still starts a capture straight away. Keyboard focus opens the card
 * too, and Tab walks into its meetings. It stays shut while a capture is
 * starting or recording, since another can't start then.
 *
 * Web and desktop render the SAME control and flow. The only difference is that
 * web captures the microphone only (no system-audio tap exists in the browser),
 * so the card's hint notes "mic only" and the in-capture banner (see
 * capture-detail-panel) points the user to the desktop app for full capture.
 */
export function CaptureBarButton({ cardSide = 'bottom' }: { cardSide?: LiquidPillCardSide }) {
  const {
    isRecording,
    isStarting,
    captureId,
    recordingError,
    transcriptionStatus,
    startRecording,
    isPaused,
    isAgentFinalizing,
    pauseRecording,
    resumeRecording,
    stopRecording,
  } = useRecordingStable()
  // The HUD shows this recording's controls: the pill steps aside.
  const inHud = useSyncExternalStore(
    subscribeHudRecordingControls,
    () => isRecording && hudShowsRecordingControls(captureId),
    () => false,
  )

  // ── The calendar card ─────────────────────────────────────────────────────
  const [open, setOpen] = useState(false)
  // A meeting can only be picked while nothing is starting or recording.
  const canOpen = !isRecording && !isStarting
  const shown = open && canOpen
  const rootRef = useRef<HTMLDivElement>(null)
  const pillRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const { openNow, closeNow, closeSoon, onPointerEnter } = useLiquidPillHover({
    open: shown,
    setOpen,
    enabled: canOpen,
    faceRef: pillRef,
    cardRef,
  })

  // A capture starting — from the pill, a meeting in the card, ⌘N or the tray —
  // puts the card away for good, rather than leaving it to pop back open the
  // moment that capture ends.
  useEffect(() => {
    if (!canOpen) closeNow()
  }, [canOpen, closeNow])

  // Escape closes, and so does a press anywhere outside.
  useEffect(() => {
    if (!shown) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeNow()
    }
    const onPointerDown = (e: PointerEvent) => {
      if (e.target instanceof Node && rootRef.current?.contains(e.target)) return
      closeNow()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [shown, closeNow])

  // The calendar mounts when the card opens and unmounts once it has shrunk
  // away: it re-centres on "now" each time, and fetches only while it's shown
  // (a fresh-enough shared cache means no request at all).
  const cardMounted = useCardContentMounted(shown)

  // A rising card lifts itself over the chat and the windows while it's out,
  // and until it has shrunk back (see CAPTURE_CARD_UP_ATTR in
  // composer-liquid-pill).
  const cardUp = cardSide === 'top' && (shown || cardMounted)
  useRisingCardLift(cardUp)


  // Defer both the mount gate and the desktop check to the post-hydration pass
  // (getServerSnapshot=false), so SSR and the first client render agree and this
  // button's Radix-id-consuming subtree mounts on the same pass as the other
  // deferred controls (the top bar's among them) — keeping the `useId` counter
  // stable during hydration (see useIsDesktop).
  const mounted = useSyncExternalStore(
    subscribeMounted,
    getMountedSnapshot,
    getMountedServerSnapshot,
  )
  const isDesktop = useIsDesktop()
  const captureKey = useModKeyLabel('N')

  // A rising card opens only as tall as the room above the pill (the chat
  // strip clips it; a short window or a tall draft leaves less), and is kept
  // fitted while closed too, so every pour comes out of the pill — see
  // useRisingCardFit. The calendar is always its full width there.
  const rising = useRisingCardFit({
    faceRef: pillRef,
    enabled: mounted && cardSide === 'top',
    shown,
    maxHeight: CARD_HEIGHT_PX,
  })
  // A hanging card (the top bar's) opens only as tall as the room below the
  // pill — a short window scrolls the calendar inside it rather than pushing
  // the card off screen — and only as wide as the room to the pill's right
  // edge on a very narrow one. See useHangingCardFit.
  const hanging = useHangingCardFit({
    faceRef: pillRef,
    enabled: mounted && cardSide === 'bottom',
    shown,
    maxHeight: CARD_HEIGHT_PX,
    maxWidth: CARD_WIDTH_PX,
  })
  const cardHeight = cardSide === 'top' ? rising.height : hanging.height
  const cardWidth = cardSide === 'top' ? CARD_WIDTH_PX : hanging.width

  if (!mounted || inHud) return null

  // Back to the live capture: its card in the main chat (openActiveCapture).
  const navigateToActiveCapture = () => {
    if (captureId) openActiveCapture(captureId)
  }

  // Click router for the left button. Recording → return to it. Otherwise →
  // start a real capture. In every case, put the calendar card away.
  const handleLeftClick = () => {
    closeNow()
    if (isRecording) {
      navigateToActiveCapture()
      return
    }
    // Mic spin-up in progress (optimistic start already opened the panel) —
    // don't re-enter start; the provider's guard would drop it anyway.
    if (isStarting) return
    startRecording()
  }

  // The card's header carries what the idle tooltip used to: the shortcut on
  // desktop, and on web that it records the mic only.
  const hint = isDesktop ? (
    <span className="flex items-center gap-1.5">
      <span>Capture now</span>
      <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] border bg-muted/60 px-1 text-[10px] font-medium text-muted-foreground">{captureKey}</kbd>
    </span>
  ) : (
    <span>Mic only on web</span>
  )

  // A recording's tooltips open away from what's next to the pill: below it
  // in the header, above it in the chat composer (below is the textarea).
  const tooltipSide = cardSide === 'top' ? 'top' : 'bottom'

  return (
    // z-10 keeps the capture pill above its neighbours (in the top bar, the
    // WindowDragStrip); `z-[46]` while a rising card is out — see
    // CAPTURE_CARD_UP_ATTR in composer-liquid-pill.
    <div className={cn('relative shrink-0', cardUp ? 'z-[46]' : 'z-10')}>
      {recordingError && !recordingError.includes('already active') && (
        <span className="text-[10px] text-red-500 max-w-[200px] truncate" title={recordingError}>
          {recordingError}
        </span>
      )}
      <TooltipProvider delayDuration={300}>
        <LiquidPill
          ref={rootRef}
          open={shown}
          cardSide={cardSide}
          // In the chat composer (its card rises) it's one colour with the
          // composer's other pills — the app's own background; in the header
          // it keeps the header pills' pure white / black.
          appBackground={cardSide === 'top'}
          className="inline-flex"
          data-capture-liquid
          onFocus={openNow}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) closeSoon()
          }}
        >
          <LiquidPillFace ref={pillRef} onPointerEnter={onPointerEnter}>
            {/* Left: start capture or return to active capture */}
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={handleLeftClick}
                  data-onboarding-target="capture"
                  aria-haspopup={canOpen ? 'dialog' : undefined}
                  aria-expanded={canOpen ? shown : undefined}
                  className={cn(
                    // Rounds BOTH ends when idle — it's the whole pill. While
                    // recording the pause/stop controls trail it, so it rounds
                    // only its leading edge.
                    'flex h-full items-center gap-1.5 rounded-l-full pl-3 transition-colors',
                    isRecording ? 'pr-1' : 'rounded-r-full pr-3',
                    isRecording
                      ? 'text-sidebar-foreground hover:bg-muted'
                      : 'text-sidebar-foreground/70 hover:bg-muted hover:text-sidebar-foreground',
                  )}
                >
                  {isRecording ? (<>
                    <span className="relative flex h-2.5 w-2.5">
                      <span className={cn(
                        'absolute inline-flex h-full w-full animate-ping rounded-full opacity-75',
                        recordingDotClass(transcriptionStatus, true),
                      )} />
                      <span className={cn('relative inline-flex h-2.5 w-2.5 rounded-full', recordingDotClass(transcriptionStatus))} />
                    </span>
                    <span className="text-[12px]">{recordingStatusLabel(transcriptionStatus)}</span>
                    <RecordingTimer />
                    {/* The way back to the live capture (its card, full screen). */}
                    <ArrowLeft className="h-3 w-3 text-muted-foreground" />
                  </>) : isStarting ? (<>
                    {/* Optimistic-start window: the panel is already open; the
                        mic is spinning up. Pulse like recording so the button
                        reads as "underway", not idle. */}
                    <span className="relative flex h-2.5 w-2.5">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
                      <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
                    </span>
                    <span className="text-[12px]">Starting…</span>
                  </>) : (<>
                    <Disc className="h-4 w-4" />
                    {/* Icon-only on a very narrow window, so the top bar's
                        trailing cluster leaves the leading one room. */}
                    <span className="text-[12px] max-[520px]:hidden">Capture</span>
                  </>)}
                </button>
              </TooltipTrigger>
              {/* Idle, hovering shows the card instead (its header carries
                  the hint), so the tooltip is only for a recording. */}
              {isRecording && (
                <TooltipContent side={tooltipSide} sideOffset={6} collisionPadding={8} avoidCollisions={false} className="rounded-lg bg-popover px-2.5 py-1.5 text-xs text-popover-foreground border shadow-md">
                  <span>Return to active capture</span>
                </TooltipContent>
              )}
            </Tooltip>

            {/* Recording controls — pause/resume + stop. These live here (the
                globally-visible Capture button) rather than the capture's side
                panel, so they're reachable from anywhere during a recording and
                always in one consistent place. Only shown while recording. */}
            {isRecording && (<>
              {/* Divider before the controls */}
              <div className="w-px self-stretch bg-border/60" />
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={isPaused ? resumeRecording : pauseRecording}
                    disabled={isAgentFinalizing}
                    className="flex h-full items-center px-1.5 text-sidebar-foreground/80 transition-colors hover:bg-muted hover:text-sidebar-foreground disabled:opacity-40 disabled:hover:bg-transparent"
                    aria-label={isPaused ? 'Resume recording' : 'Pause recording'}
                  >
                    {isPaused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
                  </button>
                </TooltipTrigger>
                <TooltipContent side={tooltipSide} sideOffset={6} collisionPadding={8} avoidCollisions={false} className="rounded-lg bg-popover px-2.5 py-1.5 text-xs text-popover-foreground border shadow-md">
                  <span>{isPaused ? 'Resume recording' : 'Pause recording'}</span>
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => stopRecording()}
                    disabled={isAgentFinalizing}
                    data-onboarding-target="stop-recording"
                    className="flex h-full items-center rounded-r-full pl-1.5 pr-2.5 text-red-500 transition-colors hover:bg-muted hover:text-red-600 disabled:opacity-40 disabled:hover:bg-transparent"
                    aria-label="Stop recording"
                  >
                    <Square className="h-3 w-3 fill-current" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side={tooltipSide} sideOffset={6} collisionPadding={8} avoidCollisions={false} className="rounded-lg bg-popover px-2.5 py-1.5 text-xs text-popover-foreground border shadow-md">
                  <span>Stop recording</span>
                </TooltipContent>
              </Tooltip>
            </>)}
          </LiquidPillFace>

          {/* Today's calendar — mounted only while the card is out (see
              cardMounted). */}
          <LiquidPillCard
            ref={cardRef}
            width={cardWidth}
            height={cardHeight}
            data-capture-calendar
            role="dialog"
            aria-label="Today's meetings"
            className="rounded-2xl"
          >
            {cardMounted && <CaptureCalendar hint={hint} />}
          </LiquidPillCard>
        </LiquidPill>
      </TooltipProvider>
    </div>
  )
}
