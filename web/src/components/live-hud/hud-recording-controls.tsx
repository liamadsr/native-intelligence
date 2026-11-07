'use client'

/**
 * The recording's controls in the HUD's header, on the right of the live
 * agent's name tag (lib/live-agent/hud-recording.ts): the top bar Capture
 * pill's recording face, moved — [● Recording 5:36 ←] | [❙❙] | [■] — sized
 * down for the glass tag (472px desktop window, the web panel).
 *
 * Two differences from the top bar's, both for a card that's up all call in a
 * window that's never throttled: the dot is still (no ping halo: an infinite
 * animation would run all call), and the elapsed time is its own leaf
 * (HudElapsed) that writes its text straight into its span once a second from
 * the reading it was handed. One timeout at a time, none while paused or
 * while the page is hidden, and nothing around it ever re-renders for it.
 *
 * Memoized on what it draws, so a feed change that isn't the recording's
 * (Voice ID, who spoke, the chat) never re-renders it.
 *
 * Each control acts on the mouse press (./use-press-action.ts): the first
 * click that brings the HUD forward from the call app counts.
 */
import { memo, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { ArrowLeft, Pause, Play, Square } from 'lucide-react'
import { cn } from '@/lib/utils'
import { BOT_GLASS_MUTED } from '@/components/agent-ui/glass'
import { recordingDotClass, recordingStatusLabel } from '@/components/capture/recording-status'
import type { HudRecordingActionType, HudRecordingState } from '@/lib/live-agent/hud-recording'
import { usePressAction } from './use-press-action'

/** "m:ss", minutes running on past the hour: the top bar's formatTime (hooks/use-recording). */
export function formatElapsed(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function subscribeVisibility(onChange: () => void) {
  document.addEventListener('visibilitychange', onChange)
  return () => document.removeEventListener('visibilitychange', onChange)
}
const getIsHidden = () => document.hidden

/**
 * The elapsed time: `elapsedSec` as read at `at`, counted on by itself. Writes
 * its own text (no React render per second), one timeout chained to the next
 * second boundary at a time; still while paused or hidden.
 */
export const HudElapsed = memo(function HudElapsed({
  elapsedSec,
  at,
  paused,
}: {
  elapsedSec: number
  at: number
  paused: boolean
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const hidden = useSyncExternalStore(subscribeVisibility, getIsHidden, () => false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const msNow = () => elapsedSec * 1000 + (paused ? 0 : Math.max(0, Date.now() - at))
    const paint = () => {
      el.textContent = formatElapsed(msNow() / 1000)
    }
    paint()
    if (paused || hidden) return
    let timer: ReturnType<typeof setTimeout>
    const next = () => {
      // To just past the next whole second, so each paint lands on a new one.
      timer = setTimeout(() => {
        paint()
        next()
      }, 1000 - (msNow() % 1000) + 10)
    }
    next()
    return () => clearTimeout(timer)
  }, [elapsedSec, at, paused, hidden])
  return <span ref={ref} data-hud-elapsed="" className={cn('text-[11px] tabular-nums', paused ? 'opacity-50' : 'opacity-70')} />
})

export const HudRecordingControls = memo(function HudRecordingControls({
  state,
  onAction,
}: {
  state: HudRecordingState
  onAction: (type: HudRecordingActionType) => void
}) {
  const { paused, finalizing, transcription } = state
  const label = recordingStatusLabel(transcription)
  const open = usePressAction(() => onAction('open'))
  const pauseOrResume = usePressAction(() => onAction(paused ? 'resume' : 'pause'))
  const stop = usePressAction(() => onAction('stop'))
  return (
    <div
      role="group"
      aria-label="Recording"
      data-hud-recording=""
      data-paused={paused ? '' : undefined}
      // Opaque (the inset glass's own look, solid): the meeting's time fills the header behind it, never through it.
      className="flex h-7 shrink-0 items-stretch overflow-hidden rounded-full bg-zinc-100 text-foreground dark:bg-zinc-700"
    >
      {/* Back to the capture: its card in the main chat. */}
      <button
        type="button"
        {...open}
        title="Return to active capture"
        aria-label={`${label}: return to active capture`}
        className="flex items-center gap-1.5 rounded-l-full pl-2.5 pr-1 transition-colors hover:bg-black/[0.06] dark:hover:bg-white/[0.08]"
      >
        <span aria-hidden className={cn('inline-flex h-2 w-2 shrink-0 rounded-full', recordingDotClass(transcription))} />
        <span className="text-[11px] max-[380px]:hidden">{label}</span>
        <HudElapsed elapsedSec={state.elapsedSec} at={state.at} paused={paused} />
        <ArrowLeft aria-hidden className={cn('h-3 w-3', BOT_GLASS_MUTED)} />
      </button>
      <div aria-hidden className="w-px self-stretch bg-black/[0.08] dark:bg-white/[0.1]" />
      <button
        type="button"
        {...pauseOrResume}
        disabled={finalizing}
        title={paused ? 'Resume recording' : 'Pause recording'}
        aria-label={paused ? 'Resume recording' : 'Pause recording'}
        className="flex items-center px-1.5 text-foreground/80 transition-colors hover:bg-black/[0.06] hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent dark:hover:bg-white/[0.08]"
      >
        {paused ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
      </button>
      <button
        type="button"
        {...stop}
        disabled={finalizing}
        title="Stop recording"
        aria-label="Stop recording"
        className="flex items-center rounded-r-full pl-1.5 pr-2.5 text-red-500 transition-colors hover:bg-black/[0.06] hover:text-red-600 disabled:opacity-40 disabled:hover:bg-transparent dark:hover:bg-white/[0.08]"
      >
        <Square className="h-3 w-3 fill-current" />
      </button>
    </div>
  )
},
(a, b) =>
  a.onAction === b.onAction &&
  a.state.captureId === b.state.captureId &&
  a.state.paused === b.state.paused &&
  a.state.finalizing === b.state.finalizing &&
  a.state.transcription === b.state.transcription &&
  a.state.elapsedSec === b.state.elapsedSec &&
  a.state.at === b.state.at)
