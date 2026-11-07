'use client'

/**
 * Client detail view for a single cloud agent run, keyed on the run id (not an
 * action) so it serves FLOW-origin runs. Live without polling (plan 1.2): its
 * own `agent_run id=eq.<run>` channel — the workspace entity bridge misses a
 * cross-workspace deep link — patches the row in place, and a status
 * transition refetches /api/account/agent-runs/[id] for what only the route
 * derives (can_chat, the joins). Stop is here too, as on the Activity panel.
 * Reuses the shared agent-run presentational primitives (status vocabulary,
 * Terminal).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import {
  ArrowLeft,
  CircleAlert,
  ExternalLink,
  GitPullRequest,
  Loader2,
  RefreshCw,
  Square,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Terminal,
  STATUS_META,
  isLive,
  isCancelable,
  elapsed,
  metaLine,
  WorkTask,
  WorkResources,
  WorkDeliverables,
  type AgentRun,
} from '../../(dashboard)/views/agent-run-ui'
import { RunQuestionSection } from '@/components/agent-run/run-question-section'
import { RunFollowUpChat } from '@/components/agent-run/run-follow-up-chat'
import { useRowChanges } from '@/hooks/use-row-changes'
import { Linkify } from '@/components/ui/linkify'

/** Run shape from the by-id route — the base run plus its origin labels. */
interface AgentRunDetail extends AgentRun {
  action_id: string | null
  flow_id: string | null
  agent_recipe: { id: string; name: string } | null
  flow: { id: string; name: string } | null
}

/** The run row's own columns the page renders; everything else (the joins,
 *  can_chat) comes from the by-id route. */
const ROW_FIELDS = [
  'status',
  'log_tail',
  'pending_input',
  'result_summary',
  'error_message',
  'deliverables',
  'pr_url',
  'branch',
  'sandbox_id',
  'started_at',
  'finished_at',
] as const

export function AgentRunDetail({
  runId,
  initialRun,
}: {
  runId: string
  initialRun: AgentRunDetail | null
}) {
  const [run, setRun] = useState<AgentRunDetail | null>(initialRun)
  const [error, setError] = useState<string | null>(null)
  const logRef = useRef<HTMLPreElement>(null)
  const stuckToBottom = useRef(true)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/account/agent-runs/${runId}`, { cache: 'no-store' })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error || `Failed (${res.status})`)
      }
      const data = (await res.json()) as { run: AgentRunDetail }
      setRun(data.run)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load agent run')
    }
  }, [runId])

  // Fetch the full run once on mount, regardless of liveness. The server page's
  // initialRun omits can_chat/pending_input (derived only by the by-id API route),
  // so a terminal deep-linked run — the notification (work_run_ready) primary
  // path — needs this load to reveal the follow-up chat. Mirrors the drill-in.
  useEffect(() => {
    void load()
  }, [load])

  const live = run ? isLive(run.status) : false
  const statusRef = useRef(run?.status)
  statusRef.current = run?.status
  useRowChanges<Record<string, unknown>>({
    table: 'agent_run',
    filter: `id=eq.${runId}`,
    onRow: (row) => {
      const transitioned = typeof row.status === 'string' && row.status !== statusRef.current
      setRun((prev) => {
        if (!prev) return prev
        const next = { ...prev } as Record<string, unknown>
        for (const key of ROW_FIELDS) if (key in row) next[key] = row[key]
        return next as unknown as AgentRunDetail
      })
      if (transitioned) void load()
    },
    onResync: () => void load(),
  })

  const [stopping, setStopping] = useState(false)
  const stop = useCallback(async () => {
    setStopping(true)
    try {
      const res = await fetch(`/api/account/agent-runs/${runId}/cancel`, { method: 'POST' })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error || 'Could not stop the run')
      }
      // Optimistic; the channel confirms canceling → canceled.
      setRun((prev) => (prev ? { ...prev, status: 'canceling' } : prev))
    } catch (e) {
      toast.error('Couldn’t stop the run', { description: e instanceof Error ? e.message : undefined })
    } finally {
      setStopping(false)
    }
  }, [runId])

  // Auto-scroll the log as it grows unless the user scrolled up.
  useEffect(() => {
    const el = logRef.current
    if (!el || !stuckToBottom.current) return
    el.scrollTop = el.scrollHeight
  }, [run?.log_tail])

  const backLink = (
    <Link
      href="/account"
      className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="h-3.5 w-3.5" /> Back to workspace
    </Link>
  )

  if (!run && !error) {
    return (
      <div className="mx-auto max-w-2xl space-y-4 px-6 py-10">
        {backLink}
        <Skeleton className="h-16 w-full rounded-lg" />
        <Skeleton className="h-64 w-full rounded-lg" />
      </div>
    )
  }

  if (error && !run) {
    return (
      <div className="mx-auto flex max-w-2xl flex-col items-center gap-3 px-6 py-16 text-center">
        {backLink}
        <CircleAlert className="mt-4 h-5 w-5 text-destructive" />
        <p className="text-sm text-muted-foreground">{error}</p>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Retry
        </Button>
      </div>
    )
  }

  if (!run) return null

  const meta = STATUS_META[run.status] ?? STATUS_META.queued
  const StatusIcon = meta.icon
  const time = elapsed(run.started_at || run.created_at, run.finished_at)
  const isWorkspace = run.kind === 'workspace'
  // Origin label: for a work run, the tracked action; otherwise the flow it fired
  // from, or the persona/assignee that ran.
  const originName = isWorkspace
    ? run.action?.identifier || run.action?.title || null
    : run.flow?.name || run.agent?.name || run.agent_recipe?.name || null

  return (
    <div className="mx-auto max-w-2xl space-y-4 px-6 py-10">
      {backLink}

      {/* Status header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <StatusIcon
            className={cn(
              'h-4 w-4 shrink-0',
              meta.tone,
              meta.spin && 'animate-spin',
              meta.pulse && 'animate-pulse',
            )}
          />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-sm font-medium">
              <span className={meta.tone}>{meta.label}</span>
              {originName && <span className="font-normal text-muted-foreground">· {originName}</span>}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {/* Work runs carry no repo/branch — the meta line is just elapsed. */}
              {(isWorkspace ? metaLine(time) : metaLine(run.repo_full_name, run.branch, time)) || 'Preparing…'}
            </div>
          </div>
        </div>
        {isCancelable(run.status) && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 shrink-0 gap-1.5 text-xs"
            onClick={() => void stop()}
            disabled={stopping}
          >
            {stopping ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3 w-3" />}
            Stop
          </Button>
        )}
        {/* PR affordance is coding-only; a work run has no repo/PR. */}
        {!isWorkspace && run.pr_url && (
          <a href={run.pr_url} target="_blank" rel="noopener noreferrer" className="shrink-0">
            <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs">
              <GitPullRequest className="h-3.5 w-3.5" />
              View PR
              <ExternalLink className="h-3 w-3 text-muted-foreground" />
            </Button>
          </a>
        )}
      </div>

      {/* Mid-run question — the run parked awaiting the user's answer. Submit/skip
          resumes the run (optimistic flip to queued, then the channel takes over). */}
      {isWorkspace && run.status === 'needs_input' && run.pending_input && (
        <RunQuestionSection
          runId={run.id}
          pendingInput={run.pending_input}
          onResumed={() => {
            setRun((prev) => (prev ? { ...prev, status: 'queued', pending_input: null } : prev))
            void load()
          }}
        />
      )}

      {/* Work-run summary — the agent's "what I did", shown once settled. */}
      {isWorkspace && run.result_summary && (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/85"><Linkify text={run.result_summary} /></p>
      )}

      {/* Work-run task + resources. */}
      {isWorkspace && <WorkTask task={run.task_prompt} />}
      {isWorkspace && <WorkResources resources={run.resources} />}

      {/* Error detail */}
      {run.error_message && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="select-text whitespace-pre-wrap leading-relaxed">{run.error_message}</span>
        </div>
      )}

      {/* Work-run deliverables. No onOpen here: this standalone page lives outside
          the tab context, so deliverables render as receipts (the interactive
          drill-in in the Activity panel is where they navigate). */}
      {isWorkspace && <WorkDeliverables deliverables={run.deliverables} />}

      {/* Follow-up chat — a terminal work run whose parked session is reachable. */}
      {isWorkspace && run.can_chat && <RunFollowUpChat runId={run.id} />}

      {/* Terminal */}
      <Terminal
        log={run.log_tail}
        sandboxId={run.sandbox_id}
        live={live}
        logRef={logRef}
        onScroll={(e) => {
          const el = e.currentTarget
          stuckToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
      />
    </div>
  )
}
