'use client'

/**
 * Capture, in the main chat's composer, left of the mic and Send (Liam, 10-19:
 * moved out of the top bar, "just the icon", saying "Start capture" on hover).
 *
 *   idle       the record icon in a liquid-metal ring (Interactive's pill's
 *              metal, Liam 10-25, in place of the light red ring); a click
 *              starts a capture
 *              (⌘N too, on desktop; on the web it records the mic only,
 *              which the tooltip says).
 *   starting   a pulsing dot while the mic spins up.
 *   recording  the pulsing dot (back to the live capture: its card in the
 *              chat), then pause / resume and stop, so a recording can always
 *              be paused and stopped from here, as it could from the top bar.
 *
 * While the live agent's HUD shows the recording's controls
 * (lib/live-agent/hud-recording.ts) it steps aside, as the top bar's pill did.
 * The recording comes in as a prop from the chat panel, which reads it
 * already (useRecordingStable), so only the main chat's composer has one.
 * Icon buttons in the attach button's and the mic's look (32px, Send's
 * size), so the row never moves when a capture starts or stops.
 */
import { Suspense, lazy, useSyncExternalStore } from 'react'
import { Disc, Pause, Play, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PromptInputAction } from '@/components/ui/prompt-input'
import { cn } from '@/lib/utils'
import { useIsDesktop } from '@/components/desktop-titlebar'
import { useModKeyLabel } from '@/lib/hotkeys'
import type { useRecordingStable } from '@/hooks/recording-context'
import { hudShowsRecordingControls, subscribeHudRecordingControls } from '@/lib/live-agent/hud-recording'
import { openActiveCapture, recordingDotClass } from '@/components/capture/recording-status'

/**
 * The composer's own round buttons' look (the attach "+" and the mic): no fill
 * at rest, the muted ink; hovered, a 32px circle (the ghost button's), Send's
 * size, and the ink brightens (Liam, 10-19: one size with Send, and no
 * "selected" fill when not hovered).
 */
const ICON_BUTTON = 'h-8 w-8 shrink-0 rounded-full text-muted-foreground hover:text-foreground'

/**
 * Idle, a ring round the circle so it reads as the button that starts
 * capturing (Liam, 10-19): Interactive's liquid metal (Liam, 10-25), drawn
 * over the button edge to edge, click-through, so the button stays Send's
 * size. Fetched the first time the button shows, like Interactive's (the
 * dashboard's first load doesn't carry metal-fx: shell-heavy-deps.test.ts);
 * the plain button meanwhile, and wherever the metal can't draw.
 */
const MetalRing = lazy(() =>
  import('@/components/read-aloud/listen-metal')
    .then((m) => ({ default: m.MetalRing }))
    .catch(() => ({ default: () => null })),
)
/** Half Send's 32px: a circle. */
const RING_RADIUS = 16

const KBD = 'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] border bg-muted/60 px-1 text-[10px] font-medium text-muted-foreground'

/** The recording, as the chat panel reads it. */
export type ComposerRecording = ReturnType<typeof useRecordingStable>

/**
 * `composer` (a phone's chat composer): the composer's icon size. `header`
 * (the top bar's right header from `md` up): the header's 18px, 1.75 stroke,
 * as its other icons (Liam, 11-09: it looked smaller than the panel icon).
 */
export function ComposerCaptureButton({ recording: rec, variant = 'composer' }: { recording: ComposerRecording; variant?: 'composer' | 'header' }) {
  const isDesktop = useIsDesktop()
  const captureKey = useModKeyLabel('N')
  const isRecording = !!rec.isRecording
  const captureId = rec.captureId ?? null
  // The HUD shows this recording's controls: step aside.
  const inHud = useSyncExternalStore(
    subscribeHudRecordingControls,
    () => isRecording && hudShowsRecordingControls(captureId),
    () => false,
  )
  if (inHud) return null
  const { isStarting, transcriptionStatus, isPaused, isAgentFinalizing, startRecording, pauseRecording, resumeRecording, stopRecording } = rec

  if (isRecording) {
    return (
      <div data-composer-capture="recording" className="flex shrink-0 items-center">
        <PromptInputAction tooltip="Return to active capture">
          <Button
            variant="ghost"
            size="icon"
            className={ICON_BUTTON}
            aria-label="Return to active capture"
            onClick={() => {
              if (captureId) openActiveCapture(captureId)
            }}
          >
            <span className="relative flex h-2.5 w-2.5">
              <span className={cn('absolute inline-flex h-full w-full animate-ping rounded-full opacity-75', recordingDotClass(transcriptionStatus, true))} />
              <span className={cn('relative inline-flex h-2.5 w-2.5 rounded-full', recordingDotClass(transcriptionStatus))} />
            </span>
          </Button>
        </PromptInputAction>
        <PromptInputAction tooltip={isPaused ? 'Resume recording' : 'Pause recording'}>
          <Button
            variant="ghost"
            size="icon"
            className={ICON_BUTTON}
            aria-label={isPaused ? 'Resume recording' : 'Pause recording'}
            disabled={isAgentFinalizing}
            onClick={isPaused ? resumeRecording : pauseRecording}
          >
            {isPaused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
          </Button>
        </PromptInputAction>
        <PromptInputAction tooltip="Stop recording">
          <Button
            variant="ghost"
            size="icon"
            className={cn(ICON_BUTTON, 'text-red-500 hover:text-red-600')}
            aria-label="Stop recording"
            data-onboarding-target="stop-recording"
            disabled={isAgentFinalizing}
            onClick={() => stopRecording()}
          >
            <Square className="h-3 w-3 fill-current" />
          </Button>
        </PromptInputAction>
      </div>
    )
  }

  const tooltip = isStarting ? (
    'Starting…'
  ) : isDesktop ? (
    <span className="flex items-center gap-1.5">
      <span>Start capture</span>
      <kbd className={KBD}>{captureKey}</kbd>
    </span>
  ) : (
    <span>Start capture · mic only on web</span>
  )
  return (
    <span data-composer-capture-ring className="relative inline-flex shrink-0">
      <PromptInputAction tooltip={tooltip}>
        <Button
          variant="ghost"
          size="icon"
          // The header's icons are 18px; the Button sets its icons' size itself ([&_svg]:size-4).
          className={cn(ICON_BUTTON, variant === 'header' && '[&_svg]:size-[18px]')}
          aria-label="Start capture"
          data-composer-capture={isStarting ? 'starting' : 'idle'}
          data-onboarding-target="capture"
          // Mic spin-up in progress: don't start again.
          disabled={isStarting}
          onClick={() => startRecording()}
        >
          {isStarting ? (
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-red-500" />
            </span>
          ) : (
            <Disc className="h-4 w-4" strokeWidth={variant === 'header' ? 1.75 : 2} />
          )}
        </Button>
      </PromptInputAction>
      {/* Over the button (after it, so its hover fill doesn't hide the ring);
          its centre is clear and it takes no clicks. */}
      <Suspense fallback={null}>
        <MetalRing radius={RING_RADIUS} />
      </Suspense>
    </span>
  )
}
