'use client'

/**
 * The main chat's Agents and Plan, as sections of the right side panel
 * (side-panels/side-panel.tsx; docs/plans/always-on-agent.md decision 10).
 * They used to be their own toggles and floating panels in the chat's corner;
 * now there is one panel, opened one way, and these are two of its sections.
 * Each draws only when it has something (Liam's "hide empty widgets").
 *
 *   Plan     the newest update_plan in the main chat's loaded messages, as the
 *            chat publishes it (side-panels/chat-feed.tsx), drawn with the
 *            reply's own checklist (PlanChecklist), never animated. Only when
 *            there is one; a stale plan ("From earlier in this chat") is
 *            still a plan.
 *   Agents   ONLY what is working now, like Claude Code's task list (Liam,
 *            10-15: "only ones that are actively working"): agent work from
 *            the shell's shared rows (AgentWorkProvider: one `tracked_job`
 *            channel for the whole app, no fetch and no channel here, so the
 *            cost stays flat) that is queued, running or parked on a handoff
 *            (chat-widgets-model.ts agentWidgetGroups). A row goes the moment
 *            its work settles: no recent history, so no timer but the
 *            once-a-minute elapsed redraw while rows show. Rows waiting on the
 *            person are For you's and never listed. Handoff children under
 *            their root, and the chat's quick helpers while they work (the
 *            newest reply's `helpers` call, quickHelperBatch).
 *
 * Each row, sized for the panel's 360px (Liam, 10-15: the old rail was "a bit
 * too narrow for the information it's displaying"): its full title over two
 * lines at most; who, status and step on a muted line with the plan's "3/5"
 * and the elapsed time. Stop and steer are icons laid OVER the row's top right
 * corner, revealed on hover or focus, so hidden they take no space and showing
 * them moves nothing. A click opens the run's chat the way For you's Open does
 * (useOpenWorkItem: its bot's page in item view, the work panel live beside
 * its chat). A quick helper runs as an eve child session the browser can't
 * reach, so its click shows its task and progress in place. Steering (POST
 * /api/account/activity/[id]/steer: "You → …" in its history) sits behind the
 * row's steer icon; what was typed there survives the panel closing (the panel
 * stays mounted, only hidden). The rows follow the person's own "Show all
 * workspaces" switch, as the provider hands them on (lib/workspace-span).
 *
 * A local agent's turn (`kind: 'local_agent'`) is listed like any helper,
 * titled "Dial8 on <Mac> · <folder>: …" by its ledger row, with a laptop mark; its
 * steer goes to its session (the steer route's local_agent branch) and its
 * Stop to the session's stop route (stopRouteOf).
 *
 * Nothing animates at idle: a row's spinner turns only while it runs
 * (motion-reduce: still).
 */
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Clock, CornerDownRight, Laptop, Loader2, MessageSquare, Square } from 'lucide-react'
import { cn } from '@/lib/utils'
import { PlanChecklist } from '@/components/work/plan-checklist'
import { useOptionalAgentWork } from '@/components/work/agent-work-provider'
import { useOpenWorkItem } from '@/hooks/use-open-teammate'
import { planBadge, planProgress, planStepsFrom } from '@/lib/work/plan'
import { ownerOf, stopRouteOf } from '@/lib/work/agent-work-lanes'
import type { WorkItem } from '@/lib/work/types'
import {
  agentStatusText,
  agentWidgetGroups,
  elapsedText,
  isSteerable,
  quickHelperStatusText,
  shownQuickHelpers,
  startedAtOf,
  type AgentWidgetGroup,
  type AgentWidgetRow,
  type QuickHelperRow,
  type ThreadPlan,
} from './chat-widgets-model'
import type { HelperRowStatus } from './helpers-row'
import { useChatFeed } from '../side-panels/chat-feed'

/** What the Agents section lists: running work only. */
export interface AgentsSummary {
  groups: AgentWidgetGroup[]
  quick: QuickHelperRow[]
  quickHeadline: string | null
  /** How many are running (every listed row and helper is). */
  running: number
}

/**
 * The Agents section's data, flat cost: the shared rows (no fetch, no
 * channel) grouped when they change, and the main chat's quick helpers as it
 * publishes them. Read by the section and by the panel's toggle (its count).
 */
export function useAgentsSummary(): AgentsSummary {
  const shared = useOptionalAgentWork()
  const rows = shared?.work.rows as ReadonlyArray<AgentWidgetRow> | null | undefined
  const { conversationId, quick: batch } = useChatFeed()
  const groups = useMemo(() => agentWidgetGroups(rows, conversationId), [rows, conversationId])
  const quick = useMemo(() => shownQuickHelpers(batch), [batch])
  return useMemo(
    () => ({
      groups,
      quick,
      quickHeadline: batch?.headline ?? null,
      running: groups.reduce((n, g) => n + 1 + g.children.length, 0) + quick.length,
    }),
    [groups, quick, batch],
  )
}

export const PlanSection = memo(function PlanSection({ plan }: { plan: ThreadPlan }) {
  return (
    <div data-chat-widget="plan">
      {plan.stale && (
        <p data-plan-stale="" className="mb-1.5 px-2 text-[11px] text-muted-foreground/80">
          From earlier in this chat
        </p>
      )}
      <div className="px-2">
        <PlanChecklist steps={plan.steps} live={false} />
      </div>
    </div>
  )
})

/** The plan's progress, for its section's header: "3 of 5". */
export function planHeaderCount(plan: ThreadPlan): string {
  const { finished, total } = planProgress(plan.steps)
  return `${finished} of ${total}`
}

/**
 * Opens a background row's chat the one way any work item opens
 * (useOpenWorkItem, what For you's Open calls): on its teammate's bot's page,
 * in item view (the run's chat beside its live work panel), else its panel
 * on a card of its own, in its own workspace.
 */
function WithRowOpener({ children }: { children: (open: (row: AgentWidgetRow) => void) => ReactNode }) {
  const openWorkItem = useOpenWorkItem()
  const open = useCallback(
    (row: AgentWidgetRow) => {
      openWorkItem(row.id, row.ai_team_member_id ? [row.ai_team_member_id] : [], {
        workspaceId: row.workspace_id,
        title: row.title ?? null,
        teammateId: row.ai_team_member_id ?? null,
      })
    },
    [openWorkItem],
  )
  return <>{children(open)}</>
}

/** How often the elapsed times redraw, and only while rows show and the panel is open. */
export const ELAPSED_TICK_MS = 60_000

export function AgentsSection({
  summary,
  active,
}: {
  summary: AgentsSummary
  /** The panel is open: only then does the elapsed time tick. */
  active: boolean
}) {
  const { groups, quick, quickHeadline } = summary
  const shared = useOptionalAgentWork()
  const stop = shared?.work.stop
  const stopping = shared?.work.stopping
  // The elapsed times are computed at render: redrawn once a minute while the
  // panel is open AND something runs (it lists only running work); no timer
  // otherwise.
  const anyRunning = quick.length > 0 || groups.length > 0
  const ticking = anyRunning && active
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!ticking) return
    const t = setInterval(() => setTick((n) => n + 1), ELAPSED_TICK_MS)
    return () => clearInterval(t)
  }, [ticking])
  // The clock, read again when the rows change, the minute turns or the panel opens.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- groups, quick, tick and active re-read the clock
  const now = useMemo(() => Date.now(), [groups, quick, tick, active])

  // Never drawn empty: with nothing to list the panel leaves the section out.
  if (!anyRunning) return null
  const here = groups.filter((g) => g.mine)
  const elsewhere = groups.filter((g) => !g.mine)
  const hereCount = here.length + quick.length

  const list = (onOpen: ((row: AgentWidgetRow) => void) | undefined) => {
    const rowsOf = (gs: readonly AgentWidgetGroup[]) =>
      gs.flatMap((g) =>
        [g.root, ...g.children].map((row, i) => (
          <AgentRow
            key={row.id}
            row={row}
            child={i > 0}
            now={now}
            onOpen={onOpen}
            onStop={stop}
            stopping={stopping?.has(row.id) ?? false}
            steerable={isSteerable(row)}
          />
        )),
      )
    const quickRows = (rs: readonly QuickHelperRow[]) =>
      rs.map((r) => <QuickHelperItem key={r.id} row={r} headline={quickHeadline} />)
    const group = (key: string, label: string | null, items: ReactNode[]) =>
      items.length > 0 && (
        <div key={key} data-agents-section={key}>
          {label && <h4 className="mb-0.5 px-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80">{label}</h4>}
          <ul>{items}</ul>
        </div>
      )
    return (
      <div data-chat-widget="agents" className="space-y-2">
        {group('here', hereCount > 0 && elsewhere.length > 0 ? 'This chat' : null, [...quickRows(quick), ...rowsOf(here)])}
        {group('elsewhere', hereCount > 0 ? 'Elsewhere' : null, rowsOf(elsewhere))}
      </div>
    )
  }
  // No provider (rendered on its own): rows list, nothing to open them on.
  return shared ? <WithRowOpener>{list}</WithRowOpener> : list(undefined)
}

/** A row's state at a glance: a spinner while it works (nothing idle is listed), a clock while it is queued or waits on teammates. */
function StatusMark({ status }: { status: string | HelperRowStatus }) {
  const cls = 'mt-[3px] size-3.5 shrink-0'
  if (status === 'running' || status === 'working') {
    return <Loader2 aria-hidden className={cn(cls, 'animate-spin text-muted-foreground motion-reduce:animate-none')} />
  }
  return <Clock aria-hidden className={cn(cls, 'text-muted-foreground')} />
}

/**
 * The row's tools, laid over its top right corner: hidden they take no space
 * (absolute, invisible to the pointer), revealed on the row's hover or focus
 * without moving anything (always on a touch screen, which has no hover).
 */
const ROW_TOOLS_CLASS =
  'pointer-events-none absolute right-1.5 top-1.5 flex items-center gap-0.5 rounded-md bg-background/95 p-0.5 opacity-0 shadow-sm ring-1 ring-border/60 transition-opacity duration-100 motion-reduce:transition-none group-hover/row:pointer-events-auto group-hover/row:opacity-100 group-focus-within/row:pointer-events-auto group-focus-within/row:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100'

const ROW_TOOL_CLASS =
  'inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50'

const AgentRow = memo(function AgentRow({
  row,
  child,
  now,
  onOpen,
  onStop,
  stopping,
  steerable,
}: {
  row: AgentWidgetRow
  /** A handoff child, drawn under its root. */
  child: boolean
  /** The section's clock (epoch ms), for the elapsed time. */
  now: number
  /** Open its chat (useOpenWorkItem); absent outside the shell. */
  onOpen?: (row: AgentWidgetRow) => void
  onStop?: (item: WorkItem) => Promise<void>
  stopping: boolean
  steerable: boolean
}) {
  const [steering, setSteering] = useState(false)
  const steps = planStepsFrom(row.plan)
  const owner = ownerOf(row as Pick<WorkItem, 'kind' | 'ai_team_member_id' | 'teammate'>)
  const who = owner.type === 'teammate' ? owner.name : owner.label
  const title = row.title?.trim() || null
  const label = title ?? who
  const step = (steps ? planProgress(steps).current : null) ?? (row.current_step?.trim() || null)
  const elapsed = elapsedText(startedAtOf(row), now)
  const canStop = !!onStop && !!stopRouteOf(row as Pick<WorkItem, 'status' | 'kind' | 'agent_run_id' | 'source'>)
  const showSteer = steerable && steering
  const body = (
    <>
      <span className="flex min-w-0 items-start gap-1 text-[13px] font-medium leading-snug text-foreground">
        {child && <CornerDownRight className="mt-[3px] size-3 shrink-0 text-muted-foreground/60" aria-label="Handed off" />}
        {/* A local agent (its title reads "Dial8 on <Mac> · <folder>: …"): the laptop says where it works. */}
        {row.kind === 'local_agent' && (
          <Laptop data-agent-row-local="" className="mt-[3px] size-3 shrink-0 text-muted-foreground/70" aria-label="On your Mac" />
        )}
        <span data-agent-row-title="" className="line-clamp-2 break-words">
          {label}
        </span>
      </span>
      <span className="mt-0.5 flex min-w-0 items-baseline gap-1.5 text-[11px] text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">
          {title ? <span className="font-medium">{who} · </span> : null}
          <span data-agent-row-status="">{agentStatusText(row.status)}</span>
          {step ? <span data-agent-row-step=""> · {step}</span> : null}
        </span>
        {steps && (
          <span data-agent-row-plan="" className="shrink-0 tabular-nums">
            {planBadge(steps)}
          </span>
        )}
        {elapsed ? (
          <span data-agent-row-elapsed="" className="shrink-0 tabular-nums">
            {elapsed}
          </span>
        ) : null}
      </span>
    </>
  )
  return (
    <li data-agent-row={row.id} data-agent-row-child={child ? '' : undefined} className={cn('group/row relative rounded-lg', child && 'ml-5')}>
      <div className="flex items-start gap-2 rounded-lg px-2 py-2 transition-colors hover:bg-muted/60 focus-within:bg-muted/60 motion-reduce:transition-none">
        <StatusMark status={row.status} />
        {onOpen ? (
          <button
            type="button"
            data-agent-row-open=""
            onClick={() => onOpen(row)}
            title="Open its chat"
            className="min-w-0 flex-1 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {body}
          </button>
        ) : (
          <div className="min-w-0 flex-1">{body}</div>
        )}
      </div>
      {(steerable || canStop) && (
        <span data-agent-row-tools="" className={cn(ROW_TOOLS_CLASS, (steering || stopping) && 'pointer-events-auto opacity-100')}>
          {steerable && (
            <button
              type="button"
              data-agent-row-steer-toggle=""
              aria-expanded={steering}
              aria-label={`Steer ${label}`}
              title="Tell it something"
              onClick={() => setSteering((v) => !v)}
              className={ROW_TOOL_CLASS}
            >
              <MessageSquare className="size-3" />
            </button>
          )}
          {canStop && (
            <button
              type="button"
              data-agent-row-stop=""
              disabled={stopping}
              onClick={() => void onStop!(row as unknown as WorkItem)}
              aria-label={stopping ? `Stopping ${label}` : `Stop ${label}`}
              title={stopping ? 'Stopping' : 'Stop'}
              className={ROW_TOOL_CLASS}
            >
              <Square className="size-3" fill="currentColor" />
            </button>
          )}
        </span>
      )}
      {showSteer && (
        <div className="px-2 pb-2 pl-[30px]">
          <SteerLine row={row} label={label} />
        </div>
      )}
    </li>
  )
})

/**
 * One of the chat's quick helpers. It runs inside the reply's own turn, as an
 * eve child session the browser has no door to (the chat route's session ACL
 * refuses a child's id), so a click shows what it was asked and how the batch
 * is going here, in place: no transcript to open. Listed only while it works.
 */
const QuickHelperItem = memo(function QuickHelperItem({ row, headline }: { row: QuickHelperRow; headline: string | null }) {
  const [open, setOpen] = useState(false)
  const detailsId = useId()
  return (
    <li data-quick-helper={row.id} className="rounded-lg">
      <button
        type="button"
        data-quick-helper-open=""
        aria-expanded={open}
        aria-controls={open ? detailsId : undefined}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
      >
        <StatusMark status={row.status} />
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 break-words text-[13px] font-medium leading-snug text-foreground">{row.label}</span>
          <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
            <span className="font-medium">Quick helper · </span>
            <span data-agent-row-status="">{quickHelperStatusText(row.status)}</span>
          </span>
        </span>
      </button>
      {open && (
        <div id={detailsId} data-quick-helper-details="" className="space-y-1 px-2 pb-2 pl-[30px] text-[11px] text-muted-foreground">
          {row.task && <p className="line-clamp-4 whitespace-pre-wrap">{row.task}</p>}
          {headline && <p className="text-foreground/80">{headline}</p>}
        </div>
      )}
    </li>
  )
})

type SteerState = { kind: 'idle' } | { kind: 'sending' } | { kind: 'sent' } | { kind: 'error'; message: string }

/** POST the person's steer for one running helper. Exported for tests. */
export async function sendSteer(row: Pick<AgentWidgetRow, 'id' | 'workspace_id'>, message: string, requestId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const res = await fetch(`/api/account/activity/${row.id}/steer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-workspace-id': row.workspace_id },
      body: JSON.stringify({ message, request_id: requestId }),
    })
    if (res.ok) return { ok: true }
    const body = (await res.json().catch(() => ({}))) as { error?: unknown }
    return { ok: false, message: typeof body.error === 'string' && body.error ? body.error : 'Nothing was sent.' }
  } catch {
    return { ok: false, message: 'Nothing was sent.' }
  }
}

function newRequestId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`
  }
}

function SteerLine({ row, label }: { row: AgentWidgetRow; label: string }) {
  const [text, setText] = useState('')
  const [state, setState] = useState<SteerState>({ kind: 'idle' })
  const inputRef = useRef<HTMLInputElement>(null)
  const sending = state.kind === 'sending'
  const submit = async () => {
    const message = text.trim()
    if (!message || sending) return
    setState({ kind: 'sending' })
    const out = await sendSteer(row, message, newRequestId())
    if (out.ok) {
      setText('')
      setState({ kind: 'sent' })
    } else {
      setState({ kind: 'error', message: out.message })
    }
    // Focus stays where the person was typing.
    inputRef.current?.focus()
  }
  // Esc: with text, clears it; empty, leaves the line for its panel. Only the
  // panel's own Esc (the next one) closes the panel.
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    e.stopPropagation()
    if (text) {
      setText('')
      if (state.kind === 'error') setState({ kind: 'idle' })
      return
    }
    const panel = inputRef.current?.closest('[data-side-panel]') as HTMLElement | null
    if (panel) panel.focus()
    else inputRef.current?.blur()
  }
  const errorId = useId()
  return (
    <form
      className="mt-0.5"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <input
        ref={inputRef}
        type="text"
        value={text}
        maxLength={4000}
        readOnly={sending}
        aria-busy={sending || undefined}
        aria-invalid={state.kind === 'error' || undefined}
        aria-describedby={state.kind === 'error' ? errorId : undefined}
        onKeyDown={onKeyDown}
        onChange={(e) => {
          if (sending) return
          setText(e.target.value)
          if (state.kind !== 'idle') setState({ kind: 'idle' })
        }}
        aria-label={`Steer ${label}`}
        placeholder={state.kind === 'sent' ? 'Sent. Tell it more…' : 'Tell it…'}
        className={cn(
          'h-8 w-full rounded-md border border-border/60 bg-background/70 px-2 text-xs text-foreground placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          sending && 'opacity-60',
        )}
      />
      {state.kind === 'error' && (
        <p id={errorId} role="alert" className="mt-1 text-[11px] text-destructive">
          {state.message}
        </p>
      )}
    </form>
  )
}
