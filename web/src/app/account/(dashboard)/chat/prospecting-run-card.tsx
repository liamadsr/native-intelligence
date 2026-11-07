'use client'

/**
 * What a Scout run looks like INSIDE the chat (§B8).
 *
 * The generic `<Tool>` chip renders a prospecting run as "Run discovery · Done"
 * with a collapsed blob of JSON behind a chevron. That is the wrong shape for
 * the one tool family whose result is a MACHINE STILL WORKING: the numbers the
 * engine writes are the whole point, the run may still be live when the model
 * hands the turn back, and a live run is the only tool result in the app the
 * user can act on (cancel) while reading it. So the prospecting run tools get
 * the same rail the Prospecting page uses, rendered in the message stream.
 *
 * WHY REUSE THE PAGE'S RAIL AND NOT A CHAT-SHAPED COPY: the rail is one
 * kind-aware sentence over `progress`, and a second implementation would be a
 * second place for its wording to drift. `RunRail` is pure — kind + progress
 * in, markup out — so it costs nothing to share. It is shown only while the
 * run is LIVE: a settled run's verdict is `statusLine` below, and a
 * present-tense "Finding companies" above a past-tense ledger would be the
 * card contradicting itself. `RunOutcome` is
 * NOT shared: it needs five page callbacks (Resume / Raise cap / Retry /
 * Dismiss / Edit ICP), none of which the chat can honour. Its two pure string
 * helpers (`completedSummary`, `targetedSummary`) are, so the sentence the card
 * prints is character-identical to the page's.
 *
 * WHY EVERY READ IS DEFENSIVE: these outputs cross a model. A tool result is
 * replayed out of persisted message history written by an older build, and a
 * card that throws takes the whole transcript down with it. Anything this file
 * cannot read falls back to the generic `<Tool>` chip, which renders any JSON.
 *
 * WHY STOP LIVES HERE. `wait_for_prospecting_run` returns after four minutes
 * whether or not the run finished, and `find_prospects` returns the moment the
 * people leg STARTS — so the common case is a card describing a run that is
 * still spending money while the user reads it. The page's cancel button is a
 * tab away and the user is looking at this. It calls the same route the page
 * does, so a cancel from chat and a cancel from the list are one code path.
 */

import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { ProspectingRunKind } from '@/lib/prospecting/types'
import type { EntityLink } from '@/components/prompt-kit/tool'
import { RunRail } from '../prospecting/run-rail'
import { completedSummary, targetedSummary } from '../prospecting/run-outcome'
import { readCounts, readProgress } from '../prospecting/ui-helpers'
import { cancelRun, errorMessage } from '../prospecting/api'

/**
 * The tools whose RESULT this card renders instead of the generic chip. Kept
 * as a set exported for chat-message's dispatch so the two can never disagree
 * about which tools have a card.
 *
 * `find_prospects` is in here even though its output is not a run summary — it
 * is TWO of them (cards leg, people leg), and the card renders both rows.
 */
export const SCOUT_RUN_CARD_TOOLS = new Set([
  'run_prospect_discovery',
  'research_prospect_companies',
  'find_prospect_people',
  'find_prospects',
  'wait_for_prospecting_run',
  'cancel_prospecting_run',
])

/** How each run kind names itself at the top of a row. */
const KIND_LABEL: Record<ProspectingRunKind, string> = {
  discover: 'Discovery',
  account_card: 'Account research',
  people: 'People',
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null
}

function asNumber(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) ? n : 0
}

/**
 * The subset of a run summary this card can render. Everything is optional on
 * the wire — the shape is produced by a tool the model called, replayed from
 * history — so the reader normalises rather than trusting.
 *
 * Returns null when there is no `run_id`: without one there is no run to
 * describe and no cancel to offer, and the generic chip is the honest fallback.
 */
interface RunView {
  runId: string
  kind: ProspectingRunKind
  status: string
  live: boolean
  error: string | null
  progress: ReturnType<typeof readProgress>
  counts: ReturnType<typeof readCounts>
  stillRunning: boolean
}

function readRun(raw: unknown): RunView | null {
  const o = asRecord(raw)
  if (!o) return null
  const runId = asString(o.run_id) ?? asString(asRecord(o.run)?.id) ?? asString(o.id)
  if (!runId) return null
  const kindRaw = asString(o.kind)
  const kind: ProspectingRunKind =
    kindRaw === 'discover' || kindRaw === 'account_card' || kindRaw === 'people'
      ? kindRaw
      : 'discover'
  const status = asString(o.status) ?? 'running'
  const progress = readProgress(o.progress)
  return {
    runId,
    kind,
    status,
    // `is_live` is the server's own verdict; the status fallback keeps a card
    // built from an older payload (no `is_live`) from claiming a queued run is
    // finished — the difference decides whether Stop is offered at all.
    live:
      typeof o.is_live === 'boolean'
        ? o.is_live
        : status === 'queued' || status === 'running' || status === 'canceling',
    error: asString(o.error),
    progress,
    counts: readCounts(o.counts),
    stillRunning: o.still_running === true,
  }
}

/**
 * The one-line verdict under the rail, per terminal status.
 *
 * The three kinds report DIFFERENT numbers and the discovery ledger reads as a
 * catastrophe on the other two ("0 candidates · 0 new" for a run that just
 * researched eighteen companies) — the exact fork `RunOutcome` makes on the
 * page, made here from the same two exported helpers so the sentences match.
 *
 * `budget_exhausted` is NOT an error: the run did what it was told, stopped
 * where it was told, and kept everything. Saying so is the difference between
 * a user trusting their cap and fearing it.
 */
function statusLine(run: RunView, canceled = false): string {
  const targeted = run.kind === 'account_card' || run.kind === 'people'
  const yieldLine = targeted
    ? targetedSummary(run.kind, run.progress)
    : completedSummary(run.progress, run.counts)

  if (run.status === 'failed') {
    return `The run failed. ${run.error || 'Something went wrong.'}`
  }
  if (run.status === 'canceled') {
    return `Cancelled — ${yieldLine}`
  }
  if (run.status === 'budget_exhausted') {
    return `Stopped early — kept everything. ${yieldLine}`
  }
  if (run.live || run.stillRunning) {
    // The user stopped it from this card; the tool output still says live.
    return canceled ? 'Cancelled.' : 'Still running.'
  }
  return yieldLine
}

/**
 * One run, as a row: kind, list chip, rail, verdict, money.
 *
 * `find_prospects` stacks two of these; every other tool renders exactly one.
 */
function RunRow({
  run,
  label,
  listLink,
  onEntityClick,
}: {
  run: RunView
  label: string
  /** Rendered on the FIRST row only — a two-leg card names its list once. */
  listLink: EntityLink | null
  onEntityClick?: (link: EntityLink) => void
}) {
  const [canceling, setCanceling] = useState(false)
  const [cancelError, setCancelError] = useState<string | null>(null)
  // Optimistically stops offering Stop once the request lands, so the button
  // does not sit there inviting a second cancel of a run already canceling.
  const [canceled, setCanceled] = useState(false)

  const live = run.live && !canceled

  async function handleCancel() {
    setCanceling(true)
    setCancelError(null)
    try {
      await cancelRun(run.runId)
      setCanceled(true)
    } catch (err) {
      setCancelError(errorMessage(err, 'Could not stop the run'))
    } finally {
      setCanceling(false)
    }
  }

  return (
    <div className="min-w-0">
      {/* flex-wrap, not a row: the chat column bottoms out near 345px and the
          list name is user-typed, so the chip has to be allowed to drop. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 pb-1">
        <span className="text-xs font-medium text-foreground">{label}</span>
        {listLink && (
          <button
            type="button"
            className="inline-flex max-w-full items-center gap-1 truncate rounded px-1.5 py-0.5 text-xs font-medium text-primary transition-colors hover:bg-primary/10"
            onClick={() => onEntityClick?.(listLink)}
          >
            {listLink.label}
          </button>
        )}
      </div>

      {/* The rail owns the -mx margins the page gives it; neutralised here so
          it sits inside the card rather than bleeding past its border. */}
      {live && (
        <div className="[&>div]:mx-0 [&>div]:mb-0">
          <RunRail
            kind={run.kind}
            progress={run.progress}
            live
            canceling={canceling}
            onCancel={handleCancel}
          />
        </div>
      )}

      <p
        className={cn(
          'mt-1.5 px-1 text-xs leading-snug',
          run.status === 'failed' ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground',
        )}
      >
        {statusLine(run, canceled)}
      </p>

      {cancelError && (
        <p className="mt-1 px-1 text-xs text-amber-600 dark:text-amber-400">{cancelError}</p>
      )}
      {canceling && (
        <p className="mt-1 flex items-center gap-1 px-1 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          Stopping…
        </p>
      )}
    </div>
  )
}

/**
 * What `find_prospects` returns, read defensively.
 *
 * Two legs commit under one consent decision, so they are ONE card with two
 * rows rather than two cards: splitting them would suggest the user could have
 * approved one and not the other, which the tool's contract explicitly does not
 * allow. The cards leg may be absent entirely (`run: null` when every company
 * was already researched) — that is the skip line, not a missing row.
 */
function readTwoLeg(raw: unknown): {
  cardsRun: RunView | null
  skipped: number
  peopleRun: RunView | null
  phase: string | null
} | null {
  const o = asRecord(raw)
  if (!o) return null
  const cards = asRecord(o.cards)
  const people = asRecord(o.people)
  if (!cards && !people) return null
  const cardsRun = readRun(cards?.run)
  const peopleRun = readRun(people?.run)
  // A shape with neither leg readable has nothing to draw — let the generic
  // chip render the JSON rather than showing an empty card.
  if (!cardsRun && !peopleRun) return null
  return {
    cardsRun,
    skipped: asNumber(cards?.skipped_already_researched),
    peopleRun,
    phase: asString(o.phase),
  }
}

/** The list chip a run card carries, when the output names a list. */
function listLinkFrom(o: Record<string, unknown>): EntityLink | null {
  const run = asRecord(o.run)
  const id =
    asString(o.list_id) ??
    asString(run?.list_id) ??
    asString(asRecord(asRecord(o.cards)?.run)?.list_id) ??
    asString(asRecord(asRecord(o.people)?.run)?.list_id)
  if (!id) return null
  const name = asString(o.list_name) ?? asString(run?.list_name)
  return { id, label: name || 'Prospect list', type: 'prospect_list' }
}

/**
 * Whether this output has enough in it to draw a card.
 *
 * Exported so chat-message can DECIDE between the card and the generic `<Tool>`
 * chip before rendering either. A component that returns null for an
 * unreadable shape would render nothing at all — the tool call would vanish
 * from the transcript, which is strictly worse than the JSON chip it replaced.
 */
export function canRenderProspectingRunCard(output: unknown): boolean {
  const o = asRecord(output)
  if (!o) return false
  return readTwoLeg(o) !== null || readRun(o) !== null
}

export function ProspectingRunCard({
  output,
  onEntityClick,
}: {
  output: unknown
  onEntityClick?: (link: EntityLink) => void
}) {
  const o = asRecord(output)
  if (!o) return null

  const listLink = listLinkFrom(o)
  const twoLeg = readTwoLeg(o)

  if (twoLeg) {
    return (
      <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-muted/10 p-2">
        {twoLeg.cardsRun ? (
          <RunRow
            run={twoLeg.cardsRun}
            label="Account research"
            listLink={listLink}
            onEntityClick={onEntityClick}
          />
        ) : (
          // No cards run happened. Saying WHY is the whole value of the line:
          // it is the one place the user learns they were not billed twice for
          // companies Scout had already researched.
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Account research</span>
            {listLink && (
              <button
                type="button"
                className="inline-flex max-w-full items-center truncate rounded px-1.5 py-0.5 text-xs font-medium text-primary transition-colors hover:bg-primary/10"
                onClick={() => onEntityClick?.(listLink)}
              >
                {listLink.label}
              </button>
            )}
            <span>
              {twoLeg.skipped > 0
                ? `Skipped — ${twoLeg.skipped} already researched`
                : 'Skipped'}
            </span>
          </p>
        )}

        {twoLeg.peopleRun ? (
          /* listLink={null}: the chip rides on the FIRST row only — a two-leg
             card names its list once, and two identical chips would read as
             two different lists. */
          <RunRow
            run={twoLeg.peopleRun}
            label="People"
            listLink={null}
            onEntityClick={onEntityClick}
          />
        ) : (
          <p className="px-1 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">People</span>{' '}
            {twoLeg.phase === 'cards_running'
              ? '· Not started — the card run is still going.'
              : '· Not started.'}
          </p>
        )}
      </div>
    )
  }

  const run = readRun(o)
  if (!run) return null

  return (
    <div className="rounded-lg border border-border bg-muted/10 p-2">
      <RunRow
        run={run}
        label={KIND_LABEL[run.kind]}
        listLink={listLink}
        onEntityClick={onEntityClick}
      />
    </div>
  )
}
