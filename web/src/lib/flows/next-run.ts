/**
 * flow.next_run_at bookkeeping, shared by every writer of a flow row (the REST
 * routes and the chat's create_flow / update_flow tools) so the queue slot the
 * cron tick scans (src/app/api/cron/flow-schedule) is set the same way
 * everywhere.
 */
import { validateScheduleConfig } from './queries'
import { computeNextRun } from './schedule'
import type { FlowTriggerConfig, ScheduleTriggerConfig } from './types'

/**
 * next_run_at for a trigger being written now (a create, or a trigger change):
 * a schedule's next occurrence (a once-schedule's run_at; NULL once it has
 * passed); NULL for every other trigger. A calendar_event flow starts NULL and
 * the tick's re-anchor pass computes it from live calendar data.
 */
export function nextRunAtOnWrite(triggerType: string, config: FlowTriggerConfig, now: Date): string | null {
  return triggerType === 'schedule' ? (computeNextRun(config as ScheduleTriggerConfig, now)?.toISOString() ?? null) : null
}

/**
 * next_run_at when an existing flow is switched on without a trigger change.
 * A schedule recomputes from now, so a stale past-due slot can't make the tick
 * fire it at once; a once-schedule whose time has passed stays NULL (switching
 * a finished one-time loop back on doesn't run it again: give it a new time);
 * a calendar flow goes NULL for the tick to re-anchor.
 * `undefined` = leave the column alone (other triggers, or a stored schedule
 * config that no longer validates).
 */
export function nextRunAtOnEnable(triggerType: string, storedConfig: unknown, now: Date): string | null | undefined {
  if (triggerType === 'schedule') {
    const cfg = validateScheduleConfig(storedConfig)
    return cfg instanceof Error ? undefined : (computeNextRun(cfg, now)?.toISOString() ?? null)
  }
  if (triggerType === 'calendar_event') return null
  return undefined
}
