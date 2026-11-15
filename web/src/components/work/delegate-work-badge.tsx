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
 *
 * What it says, most urgent first (delegateBadgeFor): needs you, working
 * ("step 3 of 5" for our own agent's planned work), ready to review, PR open,
 * failed. A job a Start put on the person's Mac on one of their own coding
 * agents (migration 658) is named too ("Claude Code · needs you"): its
 * ledger row carries the agent and the action (`worker`,
 * `local_agent_action_id`). List rows and board cards use this one badge.
 */
import { useMemo } from 'react'
import { cn } from '@/lib/utils'
import { useOptionalAgentWork } from './agent-work-provider'
import { planStepLabel, planStepsFrom, type PlanStep } from '@/lib/work/plan'
import { isWorkLive } from '@/lib/work/types'
import { isWorkerId, workerLabel } from '@/lib/environments/types'

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

/** The coding agent of the live Mac job working `actionId` among the held rows, or null (our own agent, or none). Pure. */
export function delegateWorkerFor(
  rows: ReadonlyArray<{ status: string; source?: unknown }> | null | undefined,
  actionId: string,
): string | null {
  if (!rows) return null
  for (const r of rows) {
    if (!isWorkLive(r.status)) continue
    const source = r.source as { local_agent_action_id?: unknown; worker?: unknown } | null | undefined
    if (source?.local_agent_action_id === actionId && isWorkerId(source.worker)) return source.worker
  }
  return null
}

/** What a card or row says about the delegate's run, most urgent first. */
export type DelegateBadgeState = 'needs_you' | 'working' | 'queued' | 'ready_to_review' | 'pr_open' | 'failed'

export interface DelegateBadge {
  state: DelegateBadgeState
  /** The words: "needs you", "step 2 of 4", "working", "queued", "ready to review", "PR open", "failed". */
  text: string
  /** The person's own coding agent doing it (migration 658), when their job says so. */
  worker: string | null
}

const OPEN_ROW_STATUSES: ReadonlySet<string> = new Set(['queued', 'running', 'needs_input', 'needs_review', 'waiting_on_child'])

/**
 * What a person needs to know about the action's delegate at a glance, in
 * this order: needs you (a question, the job's own or the action's), working
 * ("step 2 of 4" where our own agent's work run has a plan), queued (a job
 * waiting for a slot on the Mac, or for the Mac), ready to review
 * (a finished job left something to look at), PR open, failed. Null: nothing
 * to say. The rows are the owner's own jobs (a teammate holds none and reads
 * the action's run status alone). Pure: list rows and board cards agree.
 */
export function delegateBadgeFor(
  rows: ReadonlyArray<{ status: string; source?: unknown; plan?: unknown }> | null | undefined,
  actionId: string,
  agentRunStatus: string | null | undefined,
): DelegateBadge | null {
  const mine = (rows ?? []).filter((r) => {
    if (!OPEN_ROW_STATUSES.has(r.status)) return false
    const source = r.source as { action_id?: unknown; local_agent_action_id?: unknown } | null | undefined
    return source?.action_id === actionId || source?.local_agent_action_id === actionId
  })
  const workerOf = (r: { source?: unknown } | undefined): string | null => {
    const w = (r?.source as { worker?: unknown } | null | undefined)?.worker
    return isWorkerId(w) ? w : null
  }
  const anyWorker = workerOf(mine.find((r) => workerOf(r)))
  const asking = mine.find((r) => r.status === 'needs_input')
  if (asking || agentRunStatus === 'needs_input') return { state: 'needs_you', text: 'needs you', worker: workerOf(asking) ?? anyWorker }
  // Something actually working wins over a job still waiting for a slot or for the Mac.
  const working = mine.find((r) => isWorkLive(r.status) && r.status !== 'queued')
  const queued = mine.find((r) => r.status === 'queued')
  if (!working && queued) {
    // On the server's line or the Mac's, one word: queued (on the Mac, where its name is known).
    const mac = (queued.source as { device_name?: unknown } | null | undefined)?.device_name
    return { state: 'queued', text: typeof mac === 'string' && mac.trim() ? `queued on ${mac.trim()}` : 'queued', worker: workerOf(queued) ?? anyWorker }
  }
  if (working || LIVE_RUN_STATUSES.has(agentRunStatus ?? '')) {
    const steps = working && !workerOf(working) ? planStepsFrom(working.plan) : null
    return { state: 'working', text: steps ? planStepLabel(steps) : 'working', worker: workerOf(working) ?? anyWorker }
  }
  const review = mine.find((r) => r.status === 'needs_review')
  if (review) return { state: 'ready_to_review', text: 'ready to review', worker: workerOf(review) }
  if (agentRunStatus === 'pr_open') return { state: 'pr_open', text: 'PR open', worker: null }
  if (agentRunStatus === 'failed') return { state: 'failed', text: 'failed', worker: null }
  return null
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
  const badge = useMemo(
    () => delegateBadgeFor(rows as ReadonlyArray<{ status: string; source?: unknown; plan?: unknown }> | null, actionId, agentRunStatus),
    [rows, actionId, agentRunStatus],
  )
  if (!badge) return null
  return (
    <span
      data-delegate-work={badge.state}
      {...(badge.worker ? { 'data-delegate-worker': badge.worker } : {})}
      className={cn(
        'inline-flex shrink-0 align-middle text-[11px] font-normal text-muted-foreground',
        badge.state === 'needs_you' && 'font-medium text-amber-700 dark:text-amber-400',
        // The product's readable error pair: dark red on light, a light red on dark surfaces.
        badge.state === 'failed' && 'text-red-700 dark:text-red-400',
        className,
      )}
    >
      {badge.worker ? `${workerLabel(badge.worker)} · ${badge.text}` : badge.text}
    </span>
  )
}
