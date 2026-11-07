/**
 * The meeting's scheduled time in the live agent's HUD (live sidekick plan,
 * Phase 2; Liam, 10-17): a thin bar that drains as the scheduled end comes
 * near, and "N min left" in the header (components/live-hud/hud-schedule-bar.tsx).
 *
 * The time is the capture's own (`captures.scheduled_start` / `scheduled_end`,
 * stamped from its calendar event), read once per call through the capture
 * route's `?fields=schedule` variant, and again when the capture's event is
 * re-linked mid-call (`dial8:content-edited` for it). The web HUD reads it in
 * its own page (components/live-hud/in-page-hud-feed.tsx); the desktop's HUD
 * window hears it from the recording window's publisher
 * (components/capture/voice-id-hud-publisher.tsx):
 *   - HUD_SCHEDULE_EVENT (recording window → HUD, Tauri emitTo): a
 *     HudSchedule whenever it changes and again when the HUD says it's
 *     listening, or `{ captureId: null }` when the capture has none.
 *
 * No scheduled end, no schedule: the HUD shows no bar at all.
 *
 * Client-safe: no server imports. Everything that crosses a window is
 * checked, not trusted.
 */

/** Recording window → the HUD (Tauri, emitTo): a HudSchedule, or `{ captureId: null }`. */
export const HUD_SCHEDULE_EVENT = 'live-hud:schedule'

/** The bar turns amber this close to the scheduled end. */
export const HUD_SCHEDULE_WARN_MS = 10 * 60_000

/** The meeting's scheduled start and end, ms since the epoch. JSON: it crosses windows. */
export interface HudSchedule {
  captureId: string
  start: number
  end: number
}

const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0

function msOf(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (!isText(v)) return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}

/** The capture row's scheduled time as a schedule: null without both ends, or when the end isn't after the start. */
export function hudScheduleOf(
  captureId: string,
  row: { scheduled_start?: unknown; scheduled_end?: unknown } | null | undefined,
): HudSchedule | null {
  const start = msOf(row?.scheduled_start)
  const end = msOf(row?.scheduled_end)
  if (!captureId || start == null || end == null || end <= start) return null
  return { captureId, start, end }
}

/** `payload` as a schedule, or null if it isn't one (none sends `{ captureId: null }`). */
export function readHudSchedule(payload: unknown): HudSchedule | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  if (!isText(p.captureId)) return null
  return hudScheduleOf(p.captureId, { scheduled_start: p.start, scheduled_end: p.end })
}

export function sameHudSchedule(a: HudSchedule | null, b: HudSchedule | null): boolean {
  return a === b || (!!a && !!b && a.captureId === b.captureId && a.start === b.start && a.end === b.end)
}

/** The capture's scheduled time, from its route's light `schedule` variant. Null when it has none, or on any failure. */
export async function fetchHudSchedule(captureId: string, signal?: AbortSignal): Promise<HudSchedule | null> {
  try {
    const res = await fetch(`/api/account/captures/${encodeURIComponent(captureId)}?fields=schedule`, { signal })
    if (!res.ok) return null
    const json = (await res.json()) as { capture?: { scheduled_start?: unknown; scheduled_end?: unknown } } | null
    return hudScheduleOf(captureId, json?.capture)
  } catch {
    return null
  }
}

export interface HudScheduleProgress {
  /** How much of the scheduled time is left, 1 (at or before the start) to 0 (at or past the end). */
  remaining: number
  /** Ms to the scheduled end (negative past it). */
  msLeft: number
  /** Not yet started. */
  before: boolean
  /** Past the scheduled end. */
  over: boolean
  /** In the last HUD_SCHEDULE_WARN_MS before the end. */
  warn: boolean
}

export function hudScheduleProgress(schedule: HudSchedule, now: number): HudScheduleProgress {
  const total = schedule.end - schedule.start
  const msLeft = schedule.end - now
  const remaining = Math.min(1, Math.max(0, msLeft / total))
  const over = msLeft <= 0
  return { remaining, msLeft, before: now < schedule.start, over, warn: !over && msLeft <= HUD_SCHEDULE_WARN_MS }
}

/** "45 min", "1 h", "1 h 5 min". */
function minutesText(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m ? `${h} h ${m} min` : `${h} h`
}

/** The header's words for it: "12 min left", "Starts in 3 min", "5 min over". */
export function hudScheduleLabel(schedule: HudSchedule, now: number): string {
  const p = hudScheduleProgress(schedule, now)
  // Time to go rounds up (20 s left is "1 min left"); time over rounds down.
  const up = (ms: number) => Math.max(1, Math.ceil(ms / 60_000))
  if (p.before) return `Starts in ${minutesText(up(schedule.start - now))}`
  if (p.over) return -p.msLeft < 60_000 ? 'At time' : `${minutesText(Math.floor(-p.msLeft / 60_000))} over`
  return `${minutesText(up(p.msLeft))} left`
}
