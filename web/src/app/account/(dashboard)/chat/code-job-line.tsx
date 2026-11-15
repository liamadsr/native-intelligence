'use client'

/**
 * A Code tab job in the main thread: ONE compact line (lib/local-agent/
 * code-tab.ts codeThreadLayout puts it where the job's request was stored),
 * never the job itself. Which agent, which folder, its state, and Open,
 * which opens the job's own view the way the Agents panel does (its own
 * chat, composer, Stop, changes and pull request). When it finishes the line
 * says so and still opens it.
 *
 * Its state is read from the shell's shared ledger rows (AgentWorkProvider:
 * one channel for the whole app, the Agents panel's), its turn's row by the
 * session it names: no read, channel or timer of its own. Before a row is
 * there, the job as the chat's list last read it; before the list holds
 * the job, what its request's row names (the agent, the folder, the
 * session, a short excerpt of the words), so it draws and opens at once.
 */
import { memo } from 'react'
import { CheckCircle2, ChevronRight, CircleSlash, Laptop, Loader2, MessageCircleQuestion, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useOptionalAgentWork } from '@/components/work/agent-work-provider'
import { NATIVE_WORKER_LABEL, workerLabel } from '@/lib/environments/types'
import type { CodeJob, CodeLine } from '@/lib/local-agent/code-tab'

/** What the line says a job is doing: its newest turn row's status, else its session's. */
export type CodeLineState = 'starting' | 'working' | 'asking' | 'review' | 'done' | 'failed' | 'stopped'

const STATE_TEXT: Record<CodeLineState, string> = {
  starting: 'Starting',
  working: 'Working',
  asking: 'Needs your answer',
  review: 'Finished: ready for your review',
  done: 'Finished',
  failed: 'Couldn’t finish',
  stopped: 'Stopped',
}

interface TurnRow {
  id: string
  kind: string
  status: string
  created_at?: string | null
  source?: Record<string, unknown> | null
}

/** The job's newest turn row among the shared rows (by its turn number, then its time), or null. */
export function codeTurnRowOf(rows: readonly TurnRow[] | null | undefined, sessionId: string | null): TurnRow | null {
  if (!rows || !sessionId) return null
  let best: TurnRow | null = null
  const turnOf = (r: TurnRow) => (typeof r.source?.turn === 'number' ? r.source.turn : 0)
  for (const r of rows) {
    if (r.kind !== 'local_agent' || r.source?.local_agent_session_id !== sessionId) continue
    if (!best || turnOf(r) > turnOf(best) || (turnOf(r) === turnOf(best) && (r.created_at ?? '') > (best.created_at ?? ''))) best = r
  }
  return best
}

/** The line's state: from the turn row when there is one, else from the job's session. */
export function codeLineState(row: Pick<TurnRow, 'status'> | null, job: Pick<CodeJob, 'status'> | null): CodeLineState {
  switch (row?.status) {
    case 'queued':
      return 'starting'
    case 'running':
    case 'waiting_on_child':
      return 'working'
    case 'needs_input':
      return 'asking'
    case 'needs_review':
      return 'review'
    case 'done':
      return 'done'
    case 'failed':
      return 'failed'
    case 'canceled':
      return 'stopped'
  }
  switch (job?.status) {
    case 'running':
      return 'working'
    case 'waiting':
      return 'done'
    case 'interrupted':
      return 'asking'
    case 'failed':
    case 'expired':
      return 'failed'
    case 'cancelled':
      return 'stopped'
    default:
      return 'starting'
  }
}

function StateMark({ state }: { state: CodeLineState }) {
  const cls = 'size-3.5 shrink-0'
  if (state === 'starting' || state === 'working') return <Loader2 aria-hidden className={cn(cls, 'animate-spin text-muted-foreground motion-reduce:animate-none')} />
  if (state === 'asking') return <MessageCircleQuestion aria-hidden className={cn(cls, 'text-amber-600 dark:text-amber-400')} />
  if (state === 'failed') return <XCircle aria-hidden className={cn(cls, 'text-destructive')} />
  if (state === 'stopped') return <CircleSlash aria-hidden className={cn(cls, 'text-muted-foreground')} />
  return <CheckCircle2 aria-hidden className={cn(cls, 'text-emerald-600 dark:text-emerald-400')} />
}

/**
 * The line. Reading the shared rows re-renders this wrapper on every ledger
 * push (a context has no per-row subscription); it only picks its own turn's
 * row, and the drawn line (CodeJobLineView, memoized on plain values) renders
 * again only when its own row, job or words change.
 */
export function CodeJobLine({
  line,
  job,
  onOpen,
}: {
  line: CodeLine
  /** The job, as the chat's list read it (null until it is known, or when the list doesn't hold it). */
  job: CodeJob | null
  /**
   * Open its view: by its turn's ledger row when the line knows it (the
   * Agents panel's way), else by its session (one read names the row).
   * Absent outside the shell.
   */
  onOpen?: (workItemId: string | null, sessionId: string | null) => void
}) {
  const rows = useOptionalAgentWork()?.work.rows as readonly TurnRow[] | null | undefined
  const sessionId = line.sessionId ?? job?.sessionId ?? null
  const row = codeTurnRowOf(rows, sessionId)
  const state = codeLineState(row, job)
  // The agent and folder: the job's when it is known, else what the request's row names.
  const worker = job ? job.worker : line.worker
  const agent = worker === undefined ? 'Coding agent' : worker ? workerLabel(worker) : NATIVE_WORKER_LABEL
  const folder = job?.folderLabel || line.folder || null
  return (
    <CodeJobLineView
      lineKey={line.key}
      sessionId={sessionId}
      state={state}
      title={folder ? `${agent} in ${folder}` : agent}
      excerpt={line.request}
      workItemId={row?.id ?? job?.trackedJobId ?? null}
      onOpen={onOpen}
    />
  )
}

const CodeJobLineView = memo(function CodeJobLineView({
  lineKey,
  sessionId,
  state,
  title,
  excerpt,
  workItemId,
  onOpen,
}: {
  lineKey: string
  sessionId: string | null
  state: CodeLineState
  title: string
  excerpt: string | null
  workItemId: string | null
  onOpen?: (workItemId: string | null, sessionId: string | null) => void
}) {
  const canOpen = !!onOpen && (!!workItemId || !!sessionId)
  return (
    <div data-code-line={sessionId ?? lineKey} data-code-line-state={state} className="flex min-w-0 justify-start py-1">
      <button
        type="button"
        disabled={!canOpen}
        onClick={() => canOpen && onOpen?.(workItemId, sessionId)}
        aria-label={`${title}${excerpt ? `: ${excerpt}` : ''}. ${STATE_TEXT[state]}. Open its chat`}
        title={excerpt ? `${excerpt}\nOpen its chat` : 'Open its chat'}
        className="group flex min-w-0 max-w-full items-center gap-2.5 rounded-full border border-border/70 bg-muted/40 py-1.5 pl-2.5 pr-2 text-left text-[13px] transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:hover:bg-muted/40 motion-reduce:transition-none dark:bg-white/[0.04]"
      >
        <Laptop aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span data-code-line-title="" className="min-w-0 truncate font-medium text-foreground">
          {title}
        </span>
        {excerpt && (
          <span data-code-line-excerpt="" className="hidden min-w-0 flex-[1_1_0%] truncate text-muted-foreground sm:inline">
            {excerpt}
          </span>
        )}
        <span className="flex min-w-0 items-center gap-1 text-[12px] text-muted-foreground">
          <StateMark state={state} />
          <span data-code-line-status="" className="truncate">
            {STATE_TEXT[state]}
          </span>
        </span>
        {canOpen && (
          <span className="flex shrink-0 items-center text-[12px] text-muted-foreground group-hover:text-foreground">
            Open
            <ChevronRight aria-hidden className="size-3.5" />
          </span>
        )}
      </button>
    </div>
  )
})
