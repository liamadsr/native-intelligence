'use client'

/**
 * A question card (always-on-agent.md decision 13): a work run parked on a
 * question it asked you (`needs_input`), in the chat's For you column, on the
 * column skin beside the attention and review cards.
 *
 * Answered where its item answers it: the run's parked question
 * (`run.pending_input`, read with its row: full-rows.ts useFullReads) as the
 * item's panel shows it, RunQuestionSection (the chat's QuestionPicker:
 * options, Other, Skip), posting to the run's respond route. Once that lands
 * the shared source's `answered` takes the row out of waiting, so it leaves
 * the bots in the same render; answered in the bot's item, the ledger's
 * UPDATE takes it out of here. Without a question to show (no run read, a
 * delegation, a read that failed) it keeps the bubble's verbs: Answer opens
 * the item where any item opens (useOpenWorkItem: its bot's page, beside its
 * run's chat), and a question nobody can answer any more (stop-waiting.ts)
 * offers Stop waiting. Its chevron opens the item too.
 *
 * A local agent's question (`kind: 'local_agent'`, local-agents contract G)
 * has no run to read: it is never stale, and Answer opens the item, whose
 * panel's reply box answers it (as you, to the session; the message route
 * resumes the turn).
 */
import { useRef, useState } from 'react'
import { Building2, ChevronRight, Eye, Loader2, MessageCircleQuestion } from 'lucide-react'
import { usePostHog } from 'posthog-js/react'
import { Button } from '@/components/ui/button'
import { RunQuestionSection } from '@/components/agent-run/run-question-section'
import { useWorkspaces } from '@/app/account/workspace-switcher'
import { useOpenWorkItem } from '@/hooks/use-open-teammate'
import type { PendingInput } from '@/lib/agent-run/types'
import type { BubbleRow } from '@/lib/bots/bubble-items'
import { questionsOf } from '@/lib/bots/narration'
import type { FullRead } from '@/lib/work/full-rows'
import { WORK_STATUS_TEXT, kindLabel, relativeTime, waitingSince } from '@/lib/work/presentation'
import { questionIsStale, requestStopWaiting } from '@/lib/work/stop-waiting'
import type { WorkItem } from '@/lib/work/types'
import { cn } from '@/lib/utils'
import { CardControlBar } from './card-control-bar'
import { COLUMN_CARD_SKIN, useCardImpression } from './attention-card'

const CHIP = 'flex h-5 shrink-0 items-center gap-1 rounded-full border border-border/60 px-1.5 text-[10px] font-medium text-muted-foreground'

export function QuestionCard({
  row,
  read,
  seen = false,
  teammateId,
  onAnswered,
}: {
  /** The row as the shared source holds it (light or whole). */
  row: BubbleRow
  /** Its read: the whole row and its run (null: the read failed). */
  read: FullRead | null
  /** You've opened it since it started waiting. */
  seen?: boolean
  /** The bot it came from (whose page the item opens on). */
  teammateId: string
  /** Its answer went through (the shared source's `answered`). */
  onAnswered: (workId: string) => void
}) {
  const posthog = usePostHog()
  const openWorkItem = useOpenWorkItem()
  const { workspaces, currentId } = useWorkspaces()
  const [stopping, setStopping] = useState(false)

  const rootRef = useRef<HTMLDivElement>(null)
  useCardImpression(rootRef, row.id, 'column', () =>
    posthog?.capture('attention_card_impression', { kind: 'work_question', work_kind: row.kind, surface: 'column' }),
  )

  const title = read?.item.title || kindLabel(row.kind)
  const run = read?.run ?? null
  // As the item's panel: the picker while the run is parked on its question.
  const pendingInput = row.status === 'needs_input' && run?.status === 'needs_input' && run.pending_input ? (run.pending_input as PendingInput) : null
  // Its run gone, or (once read) no longer parked on it: nobody can answer it.
  // A local agent's is answered in its panel, never through a run.
  const stale = row.kind !== 'local_agent' && questionIsStale(row, read ? (run?.status ?? null) : undefined)
  const questions = questionsOf(row.needs)
  const asked = questions[0]?.text ?? null
  const since = waitingSince(row as WorkItem)
  const foreign = !!currentId && row.workspace_id !== currentId
  const foreignName = foreign ? (workspaces.find((w) => w.id === row.workspace_id)?.name ?? null) : null

  // Where any item opens, as the bubble's Answer: its bot's page, beside its run's chat.
  const openItem = () => {
    openWorkItem(row.id, [teammateId], { workspaceId: row.workspace_id, title: read?.item.title ?? null, teammateId })
  }
  const stopWaiting = async () => {
    setStopping(true)
    try {
      await requestStopWaiting(row.id)
    } finally {
      setStopping(false)
    }
  }

  return (
    <div ref={rootRef} data-question-card={row.id} className={cn('flex h-auto w-full min-w-0 flex-col rounded-xl border border-border/60', COLUMN_CARD_SKIN)}>
      <div className="flex min-w-0 flex-col px-3.5 pb-1 pt-3">
        <div className="flex items-start gap-1.5">
          <div className="min-w-0 flex-1">
            <p className="line-clamp-2 text-sm font-medium leading-snug text-foreground/90">{title}</p>
            {/* The picker says the question itself; without it, the question's words. */}
            {!pendingInput && (
              <p data-question-card-text="" className="mt-0.5 line-clamp-3 text-xs leading-snug text-muted-foreground">
                {asked ?? 'It needs your answer to go on.'}
                {questions.length > 1 && ` (+${questions.length - 1} more)`}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={openItem}
            aria-label="Open it"
            title="Open it"
            className="-mr-1 -mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>

        {pendingInput && run && (
          <div data-question-card-picker="" className="mt-2">
            {/* Never takes focus as it mounts: the chat's composer keeps it. */}
            <RunQuestionSection runId={run.id} pendingInput={pendingInput} onResumed={() => onAnswered(row.id)} autoFocus={false} />
          </div>
        )}

        <div className="mb-2 mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
          <span className={cn(CHIP, 'min-w-0')}>
            <MessageCircleQuestion className="h-2.5 w-2.5 shrink-0 text-muted-foreground/70" />
            <span className="truncate">{WORK_STATUS_TEXT.needs_input}</span>
          </span>
          {seen && (
            <span data-question-card-seen="" className={CHIP} title="You’ve opened this; it still waits on you">
              <Eye className="h-2.5 w-2.5 shrink-0" />
              Seen
            </span>
          )}
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">{relativeTime(since)}</span>
          {foreignName && (
            <span className={cn(CHIP, 'min-w-0')} title={`In ${foreignName}`}>
              <Building2 className="h-2.5 w-2.5 shrink-0 text-muted-foreground/70" />
              <span className="truncate">{foreignName}</span>
            </span>
          )}
        </div>
      </div>

      {/* No picker: the bubble's verbs, Answer (or Open, and Stop waiting, once nobody can answer it). */}
      {!pendingInput && (
        <CardControlBar
          busy={stopping}
          extra={
            stale ? (
              <Button
                size="sm"
                variant="ghost"
                data-question-card-stop=""
                className="h-6 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
                onClick={() => void stopWaiting()}
                disabled={stopping}
              >
                {stopping && <Loader2 className="h-3 w-3 animate-spin" />}
                Stop waiting
              </Button>
            ) : undefined
          }
          primary={
            <Button size="sm" className="h-6 gap-1 px-2.5 text-[11px]" onClick={openItem} disabled={stopping}>
              <ChevronRight className="h-3 w-3" />
              {stale ? 'Open' : 'Answer'}
            </Button>
          }
        />
      )}
    </div>
  )
}
