'use client'

/**
 * "step 3 of 5" on the row of an action an agent is working (decision 9,
 * docs/plans/always-on-agent.md §4b). Mounted only on rows that carry a
 * delegate agent, and read off the shell's shared agent work (one
 * `tracked_job` channel for the whole app): no fetch and no channel of its
 * own, so the cost stays flat however many rows show.
 *
 * `tracked_job` is owner-only under RLS, so only the person who started the
 * job holds its row and sees the step. A teammate sees "working" while the
 * action's run is live (its `agent_run_status`), and nothing once it stops.
 * The plan is never written onto the action itself: that would be the board
 * fan-out §4b avoids.
 */
import { useMemo } from 'react'
import { cn } from '@/lib/utils'
import { useOptionalAgentWork } from './agent-work-provider'
import { planStepLabel, planStepsFrom, type PlanStep } from '@/lib/work/plan'
import { isWorkLive } from '@/lib/work/types'

const LIVE_RUN_STATUSES = new Set(['starting', 'working', 'needs_input'])

/** The plan of the live job working `actionId` among the held rows, or null. Pure. */
export function delegateStepsFor(
  rows: ReadonlyArray<{ status: string; source?: unknown; plan?: unknown }> | null | undefined,
  actionId: string,
): PlanStep[] | null {
  if (!rows) return null
  const row = rows.find(
    (r) => isWorkLive(r.status) && (r.source as { action_id?: unknown } | null | undefined)?.action_id === actionId,
  )
  return row ? planStepsFrom(row.plan) : null
}

export function DelegateWorkBadge({
  actionId,
  agentRunStatus,
  className,
}: {
  actionId: string
  agentRunStatus: string | null | undefined
  className?: string
}) {
  const shared = useOptionalAgentWork()
  const rows = shared?.work.rows ?? null
  const steps = useMemo(
    () => delegateStepsFor(rows as ReadonlyArray<{ status: string; source?: unknown; plan?: unknown }> | null, actionId),
    [rows, actionId],
  )
  const live = LIVE_RUN_STATUSES.has(agentRunStatus ?? '')
  if (!steps && !live) return null
  return (
    <span
      data-delegate-work=""
      className={cn('inline-flex shrink-0 align-middle text-[11px] font-normal text-muted-foreground', className)}
    >
      {steps ? planStepLabel(steps) : 'working'}
    </span>
  )
}
