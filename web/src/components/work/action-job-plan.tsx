'use client'

/**
 * The plan of the job working an action, in the action's panel (decision 9:
 * "the job's plan shows in the action"; docs/plans/always-on-agent.md §4b).
 *
 * Reads the run's ledger row (`tracked_job` by `agent_run_id`) once and keeps
 * it live on ONE filtered row binding (useRowChanges), so the checklist ticks
 * as the agent rewrites it. `tracked_job` is owner-only under RLS: the person
 * who started the job sees the plan; a teammate reads nothing and sees only
 * "Working" while the action's run is live. Stop halts the job through the
 * action's run cancel route (the same route the Cloud run view's Stop uses,
 * stopRouteOf in agent-work-lanes.ts), which stops a coding or a work run.
 *
 * Renders nothing when there is neither a plan nor a live run.
 */
import { useCallback, useEffect, useState } from 'react'
import { ListChecks, Loader2, Square } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useRowChanges } from '@/hooks/use-row-changes'
import { planStepLabel, planStepsFrom } from '@/lib/work/plan'
import { isWorkLive } from '@/lib/work/types'
import { PlanChecklist } from './plan-checklist'

interface JobRow {
  id: string
  status: string
  plan?: unknown
}

export function ActionJobPlan({
  actionId,
  agentRunId,
  runLive,
}: {
  actionId: string
  /** The action's latest run (the panel's agent-runs read). */
  agentRunId: string | null
  /** Whether the action's run is live (its agent_run_status), for the teammate's "Working". */
  runLive: boolean
}) {
  const [job, setJob] = useState<JobRow | null>(null)
  const [stopping, setStopping] = useState(false)

  const load = useCallback(() => {
    if (!agentRunId) return
    let cancelled = false
    void createClient()
      .from('tracked_job')
      .select('id, status, plan')
      .eq('agent_run_id', agentRunId)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) setJob((data as JobRow | null) ?? null)
      })
    return () => {
      cancelled = true
    }
  }, [agentRunId])

  useEffect(() => {
    setJob(null)
    return load()
  }, [load])

  useRowChanges<JobRow>({
    table: 'tracked_job',
    filter: agentRunId ? `agent_run_id=eq.${agentRunId}` : null,
    onRow: (row) => setJob((prev) => ({ ...(prev ?? {}), ...row })),
    onResync: () => void load(),
  })

  const steps = planStepsFrom(job?.plan)
  const live = job ? isWorkLive(job.status) : runLive
  if (!steps && !live) return null

  async function stop() {
    if (!agentRunId) return
    setStopping(true)
    try {
      await fetch(`/api/account/actions/${actionId}/agent-runs/${agentRunId}/cancel`, { method: 'POST' })
    } finally {
      setStopping(false)
    }
  }

  return (
    <div data-action-job-plan="" className="space-y-2">
      <div className="flex items-center gap-2">
        <ListChecks className="h-3.5 w-3.5 text-muted-foreground" />
        <p className="text-sm font-medium">{steps ? 'Plan' : 'Working'}</p>
        {steps && live && <span className="text-[11px] text-muted-foreground">{planStepLabel(steps)}</span>}
        {!steps && live && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
        {live && agentRunId && (
          <button
            type="button"
            onClick={stop}
            disabled={stopping}
            className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            aria-label="Stop the agent's job"
          >
            {stopping ? <Loader2 className="h-3 w-3 animate-spin" /> : <Square className="h-3 w-3" />}
            Stop
          </button>
        )}
      </div>
      {steps && <PlanChecklist steps={steps} live={live} />}
    </div>
  )
}
