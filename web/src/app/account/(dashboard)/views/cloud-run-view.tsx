'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Loader2,
  GitPullRequest,
  CircleAlert,
  Cloud,
  RefreshCw,
  ExternalLink,
  Square,
  RotateCcw,
  Boxes,
  ChevronDown,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { openTarget, type OpenTarget } from '@/lib/chat-cards/open-card'
import {
  Terminal,
  STATUS_META,
  isLive,
  isCancelable,
  elapsed,
  WorkTask,
  WorkResources,
  WorkDeliverables,
  type AgentRun,
} from './agent-run-ui'
import type { WorkDeliverable, WorkResourceRef } from '@/lib/agent-run/types'
import { RunQuestionSection } from '@/components/agent-run/run-question-section'
import { useRowChanges } from '@/hooks/use-row-changes'
// The FULL run chat (B1) — reuses the main chat's components (chat-message.tsx +
// Tool chips + QuestionPicker) via its own transport. Mounted here because the
// panel is inside the dashboard; the lighter run-follow-up-chat stays ONLY for
// the standalone /account/agent-runs/[id] page, which has no MainChatProvider.
import { RunChat, type RunChatVoice } from '@/components/agent-run/run-chat'
import { Linkify } from '@/components/ui/linkify'

/**
 * Cloud-run view for the action detail panel — the CANONICAL run surface (Loops
 * v3 interactive work runs, PR #242 review rework). Two shapes:
 *
 *   - Coding runs (kind !== 'workspace'): the original status + PR + streaming
 *     log-tail Terminal, unchanged.
 *   - Workspace runs (kind === 'workspace'): a full-height run surface — compact
 *     status header (agent Boxes icon + STATUS_META + elapsed + Stop), the parked
 *     question when needs_input, a collapsible Details block (task / resources /
 *     deliverables / result / error / the Terminal), and — once the run settles
 *     and its session is reachable — a FULL <RunChat> that fills the remaining
 *     height with its composer pinned to the bottom.
 *
 * Live without polling (plan 1.2): one `agent_run action_id=eq.<action>` channel
 * patches a run's own columns (status, log tail, the parked question) in place,
 * and a run the list does not hold yet, or a status transition, refetches the
 * action-scoped agent-runs route for its joins. A filtered channel rather than
 * the entity bus (the plan's useEntityListSync): the bus is bound to the ACTIVE
 * workspace, so an action opened from an All-workspaces list would go silent.
 */

/** Resource types that open as a record card; 'package' opens the Knowledge card on it. */
const RESOURCE_RECORDS = new Set(['action', 'capture', 'document', 'contact', 'project', 'initiative'])

/** A run's own columns, as the channel delivers them; the joins (agent, action)
 *  stay as the route loaded them. */
const RUN_ROW_FIELDS = [
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

function patchRun(run: AgentRun, row: Record<string, unknown>): AgentRun {
  const next = { ...run } as unknown as Record<string, unknown>
  for (const key of RUN_ROW_FIELDS) if (key in row) next[key] = row[key]
  return next as unknown as AgentRun
}

export function CloudRunView({
  actionId,
  onRerun,
  rerunning,
}: {
  actionId: string
  /** Launch a fresh run (coding only — the panel omits this on a work run). */
  onRerun?: () => void
  /** True while a re-run request is in flight, to disable the button. */
  rerunning?: boolean
}) {
  const [runs, setRuns] = useState<AgentRun[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [canceling, setCanceling] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(true)
  const logRef = useRef<HTMLPreElement>(null)
  const stuckToBottom = useRef(true)
  const runsRef = useRef<AgentRun[] | null>(null)
  runsRef.current = runs

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/account/actions/${actionId}/agent-runs`, {
        credentials: 'include',
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || 'Failed to load runs')
      const data = await res.json()
      const list: AgentRun[] = data.runs ?? []
      setRuns(list)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load runs')
    }
  }, [actionId])

  useEffect(() => {
    void load()
  }, [load])

  useRowChanges<Record<string, unknown>>({
    table: 'agent_run',
    filter: `action_id=eq.${actionId}`,
    onRow: (row) => {
      const id = row.id as string | undefined
      const known = runsRef.current?.find((r) => r.id === id)
      if (!known || (typeof row.status === 'string' && row.status !== known.status)) {
        void load()
        return
      }
      setRuns((prev) => (prev ? prev.map((r) => (r.id === id ? patchRun(r, row) : r)) : prev))
    },
    onResync: () => void load(),
  })

  const latest = runs && runs.length > 0 ? runs[0] : null
  const live = latest ? isLive(latest.status) : false

  // Stop a running job. Optimistically reflect 'canceling' and re-arm polling so
  // we observe the run settle to 'canceled'; the server stops the sandbox / tears
  // down the session.
  const cancelRun = useCallback(async () => {
    if (!latest || !isCancelable(latest.status)) return
    setCanceling(true)
    try {
      const res = await fetch(
        `/api/account/actions/${actionId}/agent-runs/${latest.id}/cancel`,
        { method: 'POST', credentials: 'include' },
      )
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || 'Failed to stop run')
      // Optimistic local flip; the channel confirms canceled shortly.
      setRuns((prev) => (prev ? [{ ...prev[0], status: 'canceling' }, ...prev.slice(1)] : prev))
    } catch (e) {
      toast.error('Couldn’t stop the run', {
        description: e instanceof Error ? e.message : 'Please try again.',
      })
    } finally {
      setCanceling(false)
    }
  }, [actionId, latest])

  // Answering the parked question flips the run optimistically to queued so the
  // picker unmounts; the channel carries queued → running from there.
  const onResumed = useCallback(() => {
    setRuns((prev) =>
      prev ? [{ ...prev[0], status: 'queued', pending_input: null }, ...prev.slice(1)] : prev,
    )
  }, [])

  const { openDeliverable, openResource } = useRunNavigation()

  // Auto-scroll the log to the bottom as it grows, unless the user scrolled up.
  useEffect(() => {
    const el = logRef.current
    if (!el || !stuckToBottom.current) return
    el.scrollTop = el.scrollHeight
  }, [latest?.log_tail])

  // ── Loading ───────────────────────────────────────────────────────
  if (runs === null && !error) {
    return (
      <ScrollArea className="h-full">
        <div className="mx-auto max-w-2xl space-y-4 px-8 pb-28 pt-8">
          <Skeleton className="h-16 w-full rounded-lg" />
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-64 w-full rounded-lg" />
        </div>
      </ScrollArea>
    )
  }

  // ── Error ─────────────────────────────────────────────────────────
  if (error) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
        <CircleAlert className="h-5 w-5 text-destructive" />
        <p className="text-sm text-muted-foreground">{error}</p>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Retry
        </Button>
      </div>
    )
  }

  // ── Empty (no run yet) ────────────────────────────────────────────
  if (!latest) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1.5 px-8 text-center">
        <Cloud className="h-5 w-5 text-muted-foreground" />
        <p className="text-sm font-medium">No cloud run yet</p>
        <p className="max-w-xs text-xs text-muted-foreground">
          Press <span className="font-medium">Play</span> in the header to launch
          this agent in a sandbox. Its progress and logs will stream here.
        </p>
      </div>
    )
  }

  const isWorkspace = latest.kind === 'workspace'
  return isWorkspace ? (
    <WorkspaceRunView
      run={latest}
      live={live}
      canceling={canceling}
      onCancel={cancelRun}
      onResumed={onResumed}
      openDeliverable={openDeliverable}
      openResource={openResource}
      detailsOpen={detailsOpen}
      setDetailsOpen={setDetailsOpen}
      logRef={logRef}
      onLogScroll={(e) => {
        const el = e.currentTarget
        stuckToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
      }}
    />
  ) : (
    <CodingRunView
      run={latest}
      live={live}
      canceling={canceling}
      onCancel={cancelRun}
      onRerun={onRerun}
      rerunning={rerunning}
      logRef={logRef}
      onLogScroll={(e) => {
        const el = e.currentTarget
        stuckToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
      }}
    />
  )
}

/**
 * Where a run's deliverables and resource chips open: as cards in the chat
 * (every way in opens a card).
 */
function useRunNavigation() {
  const open = useCallback((target: OpenTarget) => void openTarget(target, { from: 'run' }), [])
  // A deliverable: a document or an action, as its record card.
  const openDeliverable = useCallback(
    (d: WorkDeliverable) => {
      if (d.type === 'document' || d.type === 'action') open({ type: d.type, id: d.id, title: d.label })
    },
    [open],
  )

  // A declared resource chip: a record as its record card, a package on the
  // Knowledge card. WorkResources only ever calls this for an openable ref
  // (id present + supported type), so the else-branch is defensive.
  // Best-effort: a stale/foreign id opens an empty record (the resource
  // snapshot may name an id Start would have dropped).
  const openResource = useCallback(
    (r: WorkResourceRef) => {
      if (!r.id) return
      if (r.type === 'package') {
        open({ type: 'package', id: r.id, title: r.label })
        return
      }
      if (!RESOURCE_RECORDS.has(r.type)) return
      open({ type: r.type, id: r.id, title: r.label } as OpenTarget)
    },
    [open],
  )

  return { openDeliverable, openResource }
}

/** What a run's chat is told about where it's shown (a teammate's run tab): its agent's name, and the voice it talks in. */
export interface RunChatOptions {
  agentName?: string | null
  voice?: RunChatVoice
}

/**
 * One run's view keyed by the RUN, not an action (bots-v2.md "Items continue
 * their run's chat"): what a bot's Open on an item a work run produced shows,
 * in a tab of its own (TeammateChatPage with a run). The same surface as the
 * action panel's (WorkspaceRunView: the run's result, task, deliverables and,
 * once it has settled, its follow-up chat filling the rest; its question while
 * it waits on one), for any work run, an action or none. Read from the by-id
 * route in the run's own workspace (`workspaceId`, the x-workspace-id header:
 * the bubble spans workspaces), live on its own `agent_run id=eq.<run>`
 * channel. Its chat is useRunChat's: the same conversation the bubble replies
 * into.
 */
export function CloudRunByIdView({
  runId,
  workspaceId,
  chat,
}: {
  runId: string
  workspaceId: string | null
  /** The run chat's agent and voice (a teammate's run tab: the bot's name, and its voice in the desktop app). */
  chat?: RunChatOptions
}) {
  const { openDeliverable, openResource } = useRunNavigation()
  const [run, setRun] = useState<AgentRun | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [canceling, setCanceling] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(true)
  const logRef = useRef<HTMLPreElement>(null)
  const stuckToBottom = useRef(true)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/account/agent-runs/${encodeURIComponent(runId)}`, {
        credentials: 'include',
        cache: 'no-store',
        headers: workspaceId ? { 'x-workspace-id': workspaceId } : undefined,
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || 'Failed to load the run')
      const data = (await res.json()) as { run?: AgentRun }
      if (!data.run) throw new Error('Failed to load the run')
      setRun(data.run)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load the run')
    }
  }, [runId, workspaceId])

  useEffect(() => {
    void load()
  }, [load])

  const statusRef = useRef(run?.status)
  statusRef.current = run?.status
  useRowChanges<Record<string, unknown>>({
    table: 'agent_run',
    filter: `id=eq.${runId}`,
    onRow: (row) => {
      // A status transition refetches what only the route derives (can_chat, the joins).
      if (typeof row.status === 'string' && row.status !== statusRef.current) {
        void load()
        return
      }
      setRun((prev) => (prev ? patchRun(prev, row) : prev))
    },
    onResync: () => void load(),
  })

  const cancelRun = useCallback(async () => {
    if (!run || !isCancelable(run.status)) return
    setCanceling(true)
    try {
      const res = await fetch(`/api/account/agent-runs/${encodeURIComponent(runId)}/cancel`, {
        method: 'POST',
        credentials: 'include',
        // The run's own workspace, as it was read (the cancel route scopes to the header's workspace).
        headers: workspaceId ? { 'x-workspace-id': workspaceId } : undefined,
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || 'Failed to stop run')
      setRun((prev) => (prev ? { ...prev, status: 'canceling' } : prev))
    } catch (e) {
      toast.error('Couldn’t stop the run', { description: e instanceof Error ? e.message : 'Please try again.' })
    } finally {
      setCanceling(false)
    }
  }, [run, runId, workspaceId])

  const onResumed = useCallback(() => {
    setRun((prev) => (prev ? { ...prev, status: 'queued', pending_input: null } : prev))
  }, [])

  useEffect(() => {
    const el = logRef.current
    if (!el || !stuckToBottom.current) return
    el.scrollTop = el.scrollHeight
  }, [run?.log_tail])

  if (!run && !error) {
    return (
      <div data-run-view-loading="" className="mx-auto w-full max-w-2xl space-y-4 px-6 pt-6">
        <Skeleton className="h-16 w-full rounded-lg" />
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-64 w-full rounded-lg" />
      </div>
    )
  }
  if (!run) {
    return (
      <div data-run-view-error="" className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
        <CircleAlert className="h-5 w-5 text-destructive" />
        <p className="text-sm text-muted-foreground">{error}</p>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Retry
        </Button>
      </div>
    )
  }
  const live = isLive(run.status)
  const onLogScroll = (e: React.UIEvent<HTMLPreElement>) => {
    const el = e.currentTarget
    stuckToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }
  return run.kind === 'workspace' ? (
    <WorkspaceRunView
      run={run}
      chat={{ ...chat, workspaceId }}
      live={live}
      canceling={canceling}
      onCancel={cancelRun}
      onResumed={onResumed}
      openDeliverable={openDeliverable}
      openResource={openResource}
      detailsOpen={detailsOpen}
      setDetailsOpen={setDetailsOpen}
      logRef={logRef}
      onLogScroll={onLogScroll}
    />
  ) : (
    <CodingRunView run={run} live={live} canceling={canceling} onCancel={cancelRun} logRef={logRef} onLogScroll={onLogScroll} />
  )
}

// ── Shared run header ────────────────────────────────────────────────────────
// ONE header language for both run kinds: the task title WRAPS (up to two
// lines, full text on hover) instead of truncating into an unreadable sliver,
// and everything about the run — status, identifier, elapsed, agent, repo —
// reads on a single metadata row beneath it. Actions (Stop / Re-run / View PR)
// sit top-right, matching the rest of the app's detail headers.
function RunHeader({
  run,
  live,
  canceling,
  onCancel,
  onRerun,
  rerunning,
}: {
  run: AgentRun
  live: boolean
  canceling: boolean
  onCancel: () => void
  onRerun?: () => void
  rerunning?: boolean
}) {
  const meta = STATUS_META[run.status] ?? STATUS_META.queued
  const StatusIcon = meta.icon
  const time = elapsed(run.started_at || run.created_at, run.finished_at)
  const isWorkspace = run.kind === 'workspace'
  const title =
    run.action?.title ||
    firstLine(run.task_prompt) ||
    (isWorkspace ? 'Work run' : 'Coding run')

  const repoLine =
    !isWorkspace && run.repo_full_name
      ? `${run.repo_full_name}${run.branch ? ` @ ${run.branch}` : ''}`
      : null
  const subline = [run.agent?.name, repoLine].filter(Boolean).join(' · ')

  return (
    <div className="shrink-0 border-b border-border/50 px-6 py-4">
      <div className="flex items-start justify-between gap-3">
        {/* Left: title (wraps to two lines, full text on hover) + a muted
            agent / repo subline when there's one. No identifier — the panel
            breadcrumb already names the ticket. */}
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <Boxes className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <h2 className="text-sm font-medium leading-snug line-clamp-2" title={title}>
              {title}
            </h2>
            {subline && (
              <div className="mt-0.5 truncate text-xs text-muted-foreground">{subline}</div>
            )}
          </div>
        </div>

        {/* Right: status + elapsed across from the title, then the actions. */}
        <div className="flex shrink-0 items-center gap-2">
          <span className="inline-flex items-center gap-1.5 text-xs">
            <StatusIcon
              className={cn('h-3.5 w-3.5', meta.tone, meta.spin && 'animate-spin', meta.pulse && 'animate-pulse')}
            />
            <span className={cn('font-medium', meta.tone)}>{meta.label}</span>
            {time && <span className="tabular-nums text-muted-foreground">· {time}</span>}
          </span>
          {isCancelable(run.status) && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-xs text-destructive hover:text-destructive"
              onClick={onCancel}
              disabled={canceling}
            >
              {canceling ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Square className="h-3 w-3 fill-current" />
              )}
              Stop
            </Button>
          )}
          {!live && onRerun && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 text-xs"
              onClick={onRerun}
              disabled={rerunning}
            >
              {rerunning ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCcw className="h-3.5 w-3.5" />
              )}
              Re-run
            </Button>
          )}
          {run.pr_url && (
            <a href={run.pr_url} target="_blank" rel="noopener noreferrer">
              <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs">
                <GitPullRequest className="h-3.5 w-3.5" />
                View PR
                <ExternalLink className="h-3 w-3 text-muted-foreground" />
              </Button>
            </a>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Coding run (repo → PR) ───────────────────────────────────────────────────
// The shared RunHeader pinned on top; the error detail + streaming log-tail
// Terminal scroll beneath it.
function CodingRunView({
  run,
  live,
  canceling,
  onCancel,
  onRerun,
  rerunning,
  logRef,
  onLogScroll,
}: {
  run: AgentRun
  live: boolean
  canceling: boolean
  onCancel: () => void
  onRerun?: () => void
  rerunning?: boolean
  logRef: React.RefObject<HTMLPreElement | null>
  onLogScroll: (e: React.UIEvent<HTMLPreElement>) => void
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <RunHeader
        run={run}
        live={live}
        canceling={canceling}
        onCancel={onCancel}
        onRerun={onRerun}
        rerunning={rerunning}
      />
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 px-6 pb-28 pt-4">
          {/* Error detail */}
          {run.error_message && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
              <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="select-text whitespace-pre-wrap leading-relaxed">{run.error_message}</span>
            </div>
          )}

          {/* Terminal */}
          <Terminal
            log={run.log_tail}
            sandboxId={run.sandbox_id}
            live={live}
            logRef={logRef}
            onScroll={onLogScroll}
          />
        </div>
      </ScrollArea>
    </div>
  )
}

// ── Workspace run (Loops v3 work) ────────────────────────────────────────────
// The full-height run surface. While live, the Terminal is prominent (the agent
// visibly working). Once terminal AND its session is reachable (can_chat), the
// <RunChat> becomes the PRIMARY element (fills remaining height, composer at the
// bottom) and the Terminal collapses into the Details block.
function WorkspaceRunView({
  run,
  chat,
  live,
  canceling,
  onCancel,
  onResumed,
  openDeliverable,
  openResource,
  detailsOpen,
  setDetailsOpen,
  logRef,
  onLogScroll,
}: {
  run: AgentRun
  /** The run chat's agent, voice and workspace (CloudRunByIdView's); absent in the action panel. */
  chat?: RunChatOptions & { workspaceId?: string | null }
  live: boolean
  canceling: boolean
  onCancel: () => void
  onResumed: () => void
  openDeliverable: (d: WorkDeliverable) => void
  openResource: (r: WorkResourceRef) => void
  detailsOpen: boolean
  setDetailsOpen: (v: boolean) => void
  logRef: React.RefObject<HTMLPreElement | null>
  onLogScroll: (e: React.UIEvent<HTMLPreElement>) => void
}) {
  const parked = run.status === 'needs_input'
  const chatPrimary = !live && !!run.can_chat

  // The Details block: task, resources, deliverables, result, error, and — when
  // the chat is primary — the collapsed Terminal. While live, the Terminal lives
  // OUTSIDE this block (prominent), so it isn't rendered here.
  const details = (
    <div className="space-y-3">
      {run.result_summary && (
        <p className="whitespace-pre-wrap text-xs leading-relaxed text-foreground/85">
          <Linkify text={run.result_summary} />
        </p>
      )}
      <WorkTask task={run.task_prompt} />
      <WorkResources resources={run.resources} onOpen={openResource} />
      {run.error_message && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-2.5 text-[11px] text-destructive">
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="select-text whitespace-pre-wrap leading-relaxed">{run.error_message}</span>
        </div>
      )}
      <WorkDeliverables deliverables={run.deliverables} onOpen={openDeliverable} />
      {/* When the chat is primary, the Terminal lives here (collapsed by default
          via the Details disclosure) so the working log stays inspectable. */}
      {chatPrimary && (
        <Terminal
          log={run.log_tail}
          sandboxId={run.sandbox_id}
          live={false}
          logRef={logRef}
          onScroll={onLogScroll}
        />
      )}
    </div>
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <RunHeader run={run} live={live} canceling={canceling} onCancel={onCancel} />

      {chatPrimary ? (
        // Settled + chattable: the chat is the PRIMARY element. Details (incl. the
        // collapsed Terminal) ride above it in a disclosure; the chat fills the
        // remaining height with its own internal scroll + bottom composer.
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="shrink-0 border-b border-border/50 px-6 pb-3 pt-3">
            <DetailsDisclosure open={detailsOpen} onToggle={() => setDetailsOpen(!detailsOpen)}>
              {details}
            </DetailsDisclosure>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden px-6 py-3">
            <RunChat runId={run.id} workspaceId={chat?.workspaceId ?? null} agentName={chat?.agentName ?? run.agent?.name ?? null} voice={chat?.voice} />
          </div>
        </div>
      ) : (
        // Live (or terminal-without-chat): scrollable column. The parked question
        // sits at the top; the Terminal is prominent below the details.
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-4 px-6 pb-28 pt-4">
            {parked && run.pending_input && (
              <RunQuestionSection
                runId={run.id}
                pendingInput={run.pending_input}
                onResumed={onResumed}
              />
            )}
            {details}
            <Terminal
              log={run.log_tail}
              sandboxId={run.sandbox_id}
              live={live}
              logRef={logRef}
              onScroll={onLogScroll}
            />
          </div>
        </ScrollArea>
      )}
    </div>
  )
}

/** A "Details" disclosure — a toggle row over the run's task/resources/etc. */
function DetailsDisclosure({
  open,
  onToggle,
  children,
}: {
  open: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/60 transition-colors hover:text-muted-foreground"
      >
        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', !open && '-rotate-90')} />
        Details
      </button>
      {open && <div className="mt-3 max-h-[40vh] overflow-y-auto">{children}</div>}
    </div>
  )
}

function firstLine(s: string | null | undefined): string | null {
  if (!s) return null
  const line = s.split('\n', 1)[0]?.trim()
  return line ? line : null
}
