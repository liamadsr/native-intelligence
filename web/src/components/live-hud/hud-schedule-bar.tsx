'use client'

/**
 * The meeting's scheduled time in the HUD (live sidekick plan, Phase 2;
 * lib/live-agent/hud-schedule.ts), two leaves over one stepped clock:
 *   - HudScheduleFill: the header pill's own background fills up with the
 *     call, from the left (Liam, 10-19, in place of a thin bar under the
 *     header that drained the other way: "fill up that header as the call
 *     goes on"). One colour that moves with the call, green at the start
 *     through purple to red at the end (hudFillColor), from the pill's left
 *     to a straight leading edge (Liam: curved only where it meets the pill's
 *     own end). Past the end the whole pill is red. Before the start: nothing
 *     yet. The background: the header's controls are opaque and sit on it
 *     (Liam: it "shouldn't go over the stop and time buttons");
 *   - HudTimeLeft: the header's "12 min left" ("Starts in 3 min" before it,
 *     "5 min over" after, in the same quiet grey).
 * Without a schedule neither is rendered (the view leaves them out).
 *
 * The HUD window is never throttled, so nothing here may run all call at
 * frame rate: the clock is one timeout at a time, to the next HUD_CLOCK_STEP_MS
 * boundary, shared by every leaf showing it and stopped when none is. Its
 * reading is the time floored to that step, so a leaf re-renders twice a
 * minute and only these leaves ever do. No animation.
 */
import { memo, useSyncExternalStore, type CSSProperties } from 'react'
import { cn } from '@/lib/utils'
import { BOT_GLASS_MUTED } from '@/components/agent-ui/glass'
import { hudScheduleLabel, hudScheduleProgress, type HudSchedule } from '@/lib/live-agent/hud-schedule'

/** How often the schedule's leaves move. */
export const HUD_CLOCK_STEP_MS = 30_000

const clockListeners = new Set<() => void>()
let clockTimer: ReturnType<typeof setTimeout> | null = null

function armClock() {
  // Just past the next step boundary, so the reading there is the new step.
  clockTimer = setTimeout(() => {
    clockTimer = null
    for (const listener of [...clockListeners]) listener()
    if (clockListeners.size > 0) armClock()
  }, HUD_CLOCK_STEP_MS - (Date.now() % HUD_CLOCK_STEP_MS) + 5)
}

function subscribeClock(listener: () => void) {
  clockListeners.add(listener)
  if (!clockTimer) armClock()
  return () => {
    clockListeners.delete(listener)
    if (clockListeners.size === 0 && clockTimer) {
      clearTimeout(clockTimer)
      clockTimer = null
    }
  }
}

const clockReading = () => Math.floor(Date.now() / HUD_CLOCK_STEP_MS) * HUD_CLOCK_STEP_MS

/** The time, floored to HUD_CLOCK_STEP_MS: changes (and re-renders the caller) once a step. */
export function useHudClock(): number {
  return useSyncExternalStore(subscribeClock, clockReading, clockReading)
}

/** The fill's colour over the call, as RGB stops at 0, ½ and 1 of the time used: emerald, violet, rose. */
const FILL_STOPS: ReadonlyArray<readonly [number, number, number]> = [
  [16, 185, 129],
  [139, 92, 246],
  [225, 29, 72],
]

/** The fill's colour `used` (0 to 1) of the way through the call, as "r g b" for rgb(). Pure, for the tests. */
export function hudFillColor(used: number): string {
  const t = Math.min(1, Math.max(0, used)) * (FILL_STOPS.length - 1)
  const i = Math.min(FILL_STOPS.length - 2, Math.floor(t))
  const f = t - i
  return FILL_STOPS[i].map((c, k) => Math.round(c + (FILL_STOPS[i + 1][k] - c) * f)).join(' ')
}

/** How strong the fill is, light and dark. */
const FILL_ALPHA = '[--hud-a:0.2] dark:[--hud-a:0.3]'
/** The fill, in the call's colour now. */
const FILL_SWEEP = 'bg-[rgb(var(--hud-c)/var(--hud-a))]'
/** Past the scheduled end: the whole pill red. */
const FILL_OVER = 'bg-[rgb(225_29_72/0.26)] dark:bg-[rgb(244_63_94/0.36)]'

/**
 * How much of the scheduled time has gone, 0 to 1 (0 before the start, 1 at
 * or past the end), and whether it's over. Pure, for the tests.
 */
export function hudScheduleUsed(schedule: HudSchedule, now: number): { used: number; over: boolean } {
  const p = hudScheduleProgress(schedule, now)
  return { used: p.before ? 0 : 1 - p.remaining, over: p.over }
}

/**
 * Inside the header (its first child: the header is `relative isolate`), under
 * its words and controls: the pill's shape (`rounded-[inherit]`, its overflow
 * clipped), and in it the fill from the left to how much of the call has gone,
 * its edge straight; or, past the end, all red.
 */
export const HudScheduleFill = memo(function HudScheduleFill({ schedule }: { schedule: HudSchedule }) {
  const now = useHudClock()
  const { used, over } = hudScheduleUsed(schedule, now)
  const percent = Math.round(used * 1000) / 10
  return (
    <div
      role="progressbar"
      aria-label="Meeting time used"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
      aria-valuetext={hudScheduleLabel(schedule, now)}
      data-hud-schedule-fill=""
      data-over={over ? '' : undefined}
      className={cn('pointer-events-none absolute inset-0 -z-10 overflow-hidden rounded-[inherit]', over ? FILL_OVER : FILL_ALPHA)}
      style={over ? undefined : ({ '--hud-used': `${percent}%`, '--hud-c': hudFillColor(used) } as CSSProperties)}
    >
      {!over && <div data-hud-schedule-sweep="" className={cn('absolute inset-y-0 left-0 w-[var(--hud-used)]', FILL_SWEEP)} />}
    </div>
  )
})

export const HudTimeLeft = memo(function HudTimeLeft({ schedule }: { schedule: HudSchedule }) {
  const now = useHudClock()
  return (
    <span data-hud-time-left="" className={cn('truncate tabular-nums', BOT_GLASS_MUTED)}>
      {hudScheduleLabel(schedule, now)}
    </span>
  )
})
