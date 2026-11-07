'use client'

/**
 * Run-history panel for the flow canvas. Loads the most recent runs from
 * /api/account/flows/:id/runs (unchanged endpoint) and renders them as an
 * expandable list. Lives in a collapsible drawer at the bottom of the canvas.
 *
 * Live-syncs on flow_run events scoped to this flow: a Test fire, a scheduled
 * run, or an MCP/teammate-triggered run all land here without a manual reload.
 * The flow_run realtime source is unfiltered, so its payloads carry the raw
 * row columns (including flow_id) in detail.fields — we match on that.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Boxes, CircleAlert, CircleCheck, CircleSlash, Clock, FileText } from 'lucide-react'
import { openTarget } from '@/lib/chat-cards/open-card'
import { Skeleton } from '@/components/ui/skeleton'
import { useEntityListSync } from '@/hooks/use-entity-sync'
import { cn } from '@/lib/utils'
import type { ActionResult, FlowRun } from './flow-types'

export function FlowRunHistory({
  flowId,
  highlightRunId = null,
}: {
  flowId: string
  /** A run to land on (a notification deep link): fetched even if it has aged
   *  out of the page, rendered expanded and scrolled into view. */
  highlightRunId?: string | null
}) {
  // Track which flow the loaded runs belong to. When it differs from the
  // current flowId we're loading — a switch between flows shows the skeleton
  // instead of briefly rendering the previous flow's runs, and without a
  // synchronous setState reset inside an effect (which cascades renders).
  const [state, setState] = useState<{ flowId: string; runs: FlowRun[] } | null>(null)

  const refetch = useCallback(() => {
    let cancelled = false
    const include = highlightRunId ? `&include=${encodeURIComponent(highlightRunId)}` : ''
    fetch(`/api/account/flows/${flowId}/runs?limit=20${include}`)
      .then((r) => r.json())
      .then((j) => {
        if (!cancelled) setState({ flowId, runs: j.runs || [] })
      })
      .catch(() => {
        if (!cancelled) setState({ flowId, runs: [] })
      })
    return () => {
      cancelled = true
    }
  }, [flowId, highlightRunId])

  // Reload when the flow changes.
  useEffect(() => refetch(), [refetch])

  // Live-sync: a new run for THIS flow (Test fire, schedule, MCP/teammate)
  // refetches. Match when the scoping key is absent — realtime DELETE payloads
  // carry an empty fields {} (so `!d.fields` is false), and locally-emitted
  // events may omit fields entirely — treat both as a match and let the
  // refetch confirm. Only reject events that carry a *different* flow_id.
  useEntityListSync(['flow_run'], refetch, {
    match: (d) => d.fields?.flow_id == null || d.fields.flow_id === flowId,
  })

  const runs = state?.flowId === flowId ? state.runs : null

  if (runs === null) {
    return (
      <div className="space-y-1.5 p-3">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    )
  }

  if (runs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-1 px-3 py-6 text-center">
        <Clock className="h-4 w-4 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">
          No runs yet. Use <span className="font-medium">Test</span> to send a sample request.
        </p>
      </div>
    )
  }

  return (
    <ul className="space-y-1 p-2">
      {runs.map((run) => {
        const highlighted = run.id === highlightRunId
        // The highlight is part of the key so a row re-mounts (and so re-derives
        // its initial expanded state) when a later deep link targets it.
        return <RunItem key={`${run.id}:${highlighted}`} run={run} highlighted={highlighted} />
      })}
    </ul>
  )
}

function RunItem({ run, highlighted = false }: { run: FlowRun; highlighted?: boolean }) {
  // A deep-linked run opens expanded — the notification said "N need you";
  // the ledger IS the answer, so it should be on screen without another click.
  const [expanded, setExpanded] = useState(highlighted)
  const itemRef = useRef<HTMLLIElement>(null)
  useEffect(() => {
    if (!highlighted) return
    const el = itemRef.current
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' })
  }, [highlighted])
  const success = run.status === 'success'
  // F4: parked on an approval card: waiting on the person, not failed.
  const waiting = run.status === 'pending'
  const Icon = success ? CircleCheck : waiting ? Clock : CircleAlert
  const iconColor = success ? 'text-emerald-500' : waiting ? 'text-amber-500' : 'text-destructive'
  const results = Array.isArray(run.action_results) ? run.action_results : []
  const fired = results.filter((r) => !r.skipped)
  const skipped = results.length - fired.length
  return (
    <li
      ref={itemRef}
      className={cn(
        'rounded-md border bg-card',
        highlighted ? 'border-primary/50 ring-1 ring-primary/30' : 'border-border',
      )}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs"
        onClick={() => setExpanded(!expanded)}
      >
        <Icon className={cn('h-3.5 w-3.5 shrink-0', iconColor)} />
        <span className="flex-1 truncate">
          {run.action?.identifier ? `${run.action.identifier} · ` : ''}
          {run.action?.title ?? 'Test fire'}
        </span>
        <span className="shrink-0 text-muted-foreground">
          {results.length > 0
            ? `${fired.length} fired${skipped > 0 ? `, ${skipped} skipped` : ''} · `
            : run.response_status_code
              ? `${run.response_status_code} · `
              : ''}
          {new Date(run.fired_at).toLocaleTimeString()}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-border">
          {results.length > 0 ? (
            <ul className="divide-y divide-border">
              {results.map((r, i) => (
                <ActionResultRow key={r.action_id ?? i} index={i} result={r} />
              ))}
            </ul>
          ) : (
            // Legacy single-action run (pre-conditions): show the flat preview.
            (run.response_body_preview || run.error_message) && (
              <pre className="overflow-x-auto bg-muted/30 p-2 font-mono text-[10px] leading-tight">
                {run.error_message || run.response_body_preview}
              </pre>
            )
          )}
        </div>
      )}
    </li>
  )
}

function ActionResultRow({ index, result }: { index: number; result: ActionResult }) {
  const [open, setOpen] = useState(false)
  const verdict = result.verdict ?? null
  // A verdict run's ledger summary line: what it decided. Counts derived from the
  // ledger entries (the source of truth for outcomes) so it's honest even when
  // cards_surfaced/revoked are the only top-level counts.
  const verdictCounts = verdict
    ? (verdict.entries ?? []).reduce(
        (acc, e) => {
          acc[e.outcome] = (acc[e.outcome] ?? 0) + 1
          return acc
        },
        {} as Record<string, number>,
      )
    : null
  const verdictChips: string[] = []
  if (verdict) {
    if (verdict.cards_surfaced > 0) verdictChips.push(`${verdict.cards_surfaced} card${verdict.cards_surfaced === 1 ? '' : 's'}`)
    if (verdictCounts?.applied) verdictChips.push(`${verdictCounts.applied} applied`)
    if (verdictCounts?.staged) verdictChips.push(`${verdictCounts.staged} left in capture`)
    if (verdictCounts?.dismissed) verdictChips.push(`${verdictCounts.dismissed} dismissed`)
    if (verdictCounts?.folded) verdictChips.push(`${verdictCounts.folded} folded`)
    if (verdict.revoked_count > 0) verdictChips.push(`${verdict.revoked_count} revoked`)
    // Surface skipped/failed so a run that examined proposals but changed nothing
    // (e.g. all already-resolved on a re-fire) doesn't read as "nothing to do".
    if (verdictCounts?.skipped) verdictChips.push(`${verdictCounts.skipped} skipped`)
    if (verdictCounts?.failed) verdictChips.push(`${verdictCounts.failed} failed`)
    if (verdict.verdict_missing) verdictChips.push('no verdict submitted')
  }
  // The verdict ledger makes a run expandable even without a body preview.
  const detail = result.error_message || result.response_body_preview
  const hasDetail = !!detail || !!verdict
  const outputDocId = result.output_document_id ?? null
  const agentRunId = result.agent_run_id ?? null
  // A run_agent result: a queued run carries its agent_run_id; the disarmed
  // (flag-off) path returns dispatched:false without being skipped. Older rows
  // from the removed desktop runtime also carry `dispatched` (with no
  // agent_run_id), so the flag alone does not mean "agent dispatch".
  const isAgentResult = !!agentRunId || (result.dispatched === false && !result.skipped)
  const agentInert = isAgentResult && !result.dispatched && !result.skipped
  let Icon = CircleCheck
  let color = 'text-emerald-500'
  if (result.parked) {
    // F4: this step waits on the person's approval card.
    Icon = Clock
    color = 'text-amber-500'
  } else if (result.skipped) {
    Icon = CircleSlash
    color = 'text-muted-foreground'
  } else if (result.status === 'failed') {
    Icon = CircleAlert
    color = 'text-destructive'
  }
  const openOutput = () => {
    if (!outputDocId) return
    // The output doc, as its own card in the chat. The result only carries
    // the id; the document panel loads its own title.
    openTarget({ type: 'document', id: outputDocId, title: 'Flow output' }, { from: 'flow' })
  }
  return (
    <li>
      {/* Sibling buttons (not nested) — the row toggles detail, the doc chip
          navigates. */}
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => hasDetail && setOpen((o) => !o)}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1 text-left text-[11px]',
            hasDetail ? 'cursor-pointer' : 'cursor-default',
          )}
        >
          <Icon className={cn('h-3 w-3 shrink-0', color)} />
          <span className={cn('flex-1 truncate', result.skipped && 'text-muted-foreground')}>
            Action {index + 1}
            {result.skipped && (
              <span className="ml-1.5 text-muted-foreground">
                ·{' '}
                {result.disabled
                  ? 'disabled'
                  : result.incomplete
                    ? 'needs setup'
                    : 'condition not met'}
              </span>
            )}
            {agentInert && (
              <span className="ml-1.5 text-muted-foreground">· agent dispatch not yet enabled</span>
            )}
            {isAgentResult && result.dispatched && (
              <span className="ml-1.5 text-teal-600 dark:text-teal-400">· agent run queued</span>
            )}
            {verdict && (
              <span className="ml-1.5 text-muted-foreground">
                · {verdictChips.length ? verdictChips.join(' · ') : 'nothing to do'}
              </span>
            )}
          </span>
          <span className="shrink-0 text-muted-foreground">
            {result.skipped
              ? ''
              : `${result.response_status_code ?? '—'}${result.duration_ms != null ? ` · ${result.duration_ms}ms` : ''}`}
          </span>
        </button>
        {outputDocId && (
          <button
            type="button"
            onClick={openOutput}
            className="mr-2 flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-muted/50 hover:text-foreground"
            title="Open the output document"
          >
            <FileText className="h-3 w-3" />
            View output
          </button>
        )}
        {agentRunId && (
          // Deep link to the Cloud-run view, keyed on the agent_run id.
          <a
            href={`/account/agent-runs/${agentRunId}`}
            className="mr-2 flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-muted/50 hover:text-foreground"
            title="Open the agent run"
          >
            <Boxes className="h-3 w-3" />
            View agent run
          </a>
        )}
      </div>
      {open && (verdict || detail) && (
        <div className="bg-muted/30 p-2">
          {verdict ? (
            <div className="space-y-1.5 text-[10px] leading-snug">
              {verdict.summary && <p className="text-foreground/80">{verdict.summary}</p>}
              {verdict.cards_overflow > 0 && (
                <p className="text-muted-foreground">
                  +{verdict.cards_overflow} more left in the capture (beyond the card cap)
                </p>
              )}
              {verdict.entries && verdict.entries.length > 0 && (
                <ul className="space-y-0.5">
                  {verdict.entries.slice(0, 30).map((e, i) => (
                    <li key={i} className="flex items-baseline gap-1.5 text-muted-foreground">
                      <span className="font-medium text-foreground/70">{e.outcome}</span>
                      <span className="truncate">{e.reason || e.detail || e.decision}</span>
                    </li>
                  ))}
                  {verdict.entries.length > 30 && (
                    <li className="text-muted-foreground/60">+{verdict.entries.length - 30} more…</li>
                  )}
                </ul>
              )}
            </div>
          ) : (
            <pre className="overflow-x-auto font-mono text-[10px] leading-tight">{detail}</pre>
          )}
        </div>
      )}
    </li>
  )
}
