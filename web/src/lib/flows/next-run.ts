/**
 * flow.next_run_at bookkeeping, shared by every writer of a flow row (the REST
 * routes and the chat's create_flow / update_flow tools) so the queue slot the
 * cron tick scans (src/app/api/cron/flow-schedule) is set the same way
 * everywhere.
 *
 * A page watch (page_changed) uses the same column for its own clock: the
 * watch pass reads each enabled page_changed loop whose next_run_at has come
 * and moves it on by PAGE_WATCH_INTERVAL_MINUTES. Switched on (or saved on
 * with a new page) it is due now, so its first read comes within one pass;
 * switched off it holds none. The schedule tick never sees it: its scans are
 * for trigger_type 'schedule' and 'calendar_event' only.
 */
import { validateScheduleConfig } from './queries'
import { computeNextRun } from './schedule'
import type { FlowTriggerConfig, ScheduleTriggerConfig } from './types'

/**
 * next_run_at for a trigger being written now (a create, or a trigger change):
 * a schedule's next occurrence (a once-schedule's run_at; NULL once it has
 * passed); a page watch due now while it is on (`enabled`, which only a page
 * watch reads), NULL while off; NULL for every other trigger. A
 * calendar_event flow starts NULL and the tick's re-anchor pass computes it
 * from live calendar data.
 */
export function nextRunAtOnWrite(triggerType: string, config: FlowTriggerConfig, now: Date, enabled = true): string | null {
  if (triggerType === 'page_changed') return enabled ? now.toISOString() : null
  return triggerType === 'schedule' ? (computeNextRun(config as ScheduleTriggerConfig, now)?.toISOString() ?? null) : null
}

/**
 * next_run_at when an existing flow is switched on without a trigger change.
 * A schedule recomputes from now, so a stale past-due slot can't make the tick
 * fire it at once; a once-schedule whose time has passed stays NULL (switching
 * a finished one-time loop back on doesn't run it again: give it a new time);
 * a calendar flow goes NULL for the tick to re-anchor; a page watch is due
 * now, so the watch pass reads its page again soon.
 * `undefined` = leave the column alone (other triggers, or a stored schedule
 * config that no longer validates).
 */
export function nextRunAtOnEnable(triggerType: string, storedConfig: unknown, now: Date): string | null | undefined {
  if (triggerType === 'page_changed') return now.toISOString()
  if (triggerType === 'schedule') {
    const cfg = validateScheduleConfig(storedConfig)
    return cfg instanceof Error ? undefined : (computeNextRun(cfg, now)?.toISOString() ?? null)
  }
  if (triggerType === 'calendar_event') return null
  return undefined
}

/**
 * next_run_at when an existing flow is switched off without a trigger change:
 * a page watch holds no slot while off (the watch pass reads only enabled
 * loops anyway; a cleared slot keeps the row honest). `undefined` = leave the
 * column alone (every other trigger: a schedule's slot is recomputed when it
 * is switched back on).
 */
export function nextRunAtOnDisable(triggerType: string): null | undefined {
  return triggerType === 'page_changed' ? null : undefined
}

/**
 * A one-time loop's switch, from a save of its trigger: a NEW time in the
 * future arms it (on, due at that time), whatever `enabled` the editor sent
 * (a finished loop's toggle reads off); a time that has passed leaves it
 * finished (off, no next run), so a stale editor re-sending `enabled: true`
 * with the old time never reads as on. The same time re-saved while still
 * ahead keeps the switch as sent. Null: not a one-time loop.
 */
export function onceArming(
  nextType: string,
  nextConfig: unknown,
  currentType: string,
  storedConfig: unknown,
  nextRunAt: string | null,
): { enabled: boolean; next_run_at: string | null } | { enabled: true } | null {
  const next = nextConfig as Partial<ScheduleTriggerConfig> | null
  if (nextType !== 'schedule' || next?.cadence !== 'once') return null
  if (!nextRunAt) return { enabled: false, next_run_at: null }
  const stored = storedConfig as Partial<ScheduleTriggerConfig> | null
  const sameTime = currentType === 'schedule' && stored?.cadence === 'once' && stored.run_at === next.run_at && stored.timezone === next.timezone
  return sameTime ? null : { enabled: true }
}
