'use client'

import { Activity } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useOpenOutput } from '@/hooks/use-open-output'
import { deliverableIcon } from '@/components/attention/column-card-copy'
import { SENTENCE_ICON_GLYPHS } from '@/components/attention/sentence-icon'
import {
  isTeammateReportStatus,
  partDeliverable,
  teammateReportOutput,
  type TeammateReportPartData,
  type TeammateReportStatus,
} from '@/lib/chat/teammate-report'
import { deliverableNoun } from '@/lib/work/presentation'
import { ThreadHook } from './thread-hook'

/** The chip's data off a stored part, or null when it isn't one (a part is data). */
export function teammateReportPartData(value: unknown): TeammateReportPartData | null {
  if (!value || typeof value !== 'object') return null
  const d = value as Partial<TeammateReportPartData>
  if (typeof d.work_item_id !== 'string' || !d.work_item_id || !isTeammateReportStatus(d.status)) return null
  const deliverable = partDeliverable(d.deliverable)
  return {
    work_item_id: d.work_item_id,
    workspace_id: typeof d.workspace_id === 'string' ? d.workspace_id : '',
    status: d.status,
    title: typeof d.title === 'string' ? d.title : 'Work item',
    ...(deliverable ? { deliverable } : {}),
  }
}

/** What a report with nothing to open says it is, under its title. */
function statusLine(status: TeammateReportStatus): string {
  switch (status) {
    case 'needs_input':
      return 'Needs your answer'
    case 'failed':
      return 'Couldn’t finish'
    case 'canceled':
      return 'Canceled'
    case 'done':
      return 'Done'
    default:
      return 'Ready for review'
  }
}

const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)

/**
 * A teammate's report in the chat (bots v2 phase 7, `data-teammate-report`):
 * what it made, as a card (Liam, 10-18: the "Open document" pill read as an
 * afterthought; a deliverable should look like one). About half the message
 * column wide (at least 15rem), in the long reply's document frame
 * (reply-document.tsx: a tinted frame round a white page), so every artifact
 * in the chat reads as one family: the kind's icon in a tile, the
 * deliverable's title (two lines at most) and its kind under it.
 *
 * A result opens to its OUTPUT (Liam, 10-15: "it should go to the output and
 * not to the process"): the item's primary deliverable on its own surface
 * (the document, the draft in Mail, the link: useOpenOutput). `metadata`: the
 * report row's, whose report names the deliverable for a row written before
 * the chip carried it. A question, a failure, a cancel, or a result with
 * nothing to open is the same card with the work item's icon and what it
 * waits on, and opens the work item where any item opens (useOpenWorkItem).
 *
 * `joined`: the report's own words sit right above it (chat-message.tsx), so
 * the ╰ hook (thread-hook.tsx) ties the card to them, as a reply is tied in a
 * messaging app. Set in from the column's edge to leave the hook room. A
 * panel (`data-chat-panel`, tailwind.css): the prep's goal box rides its foot.
 */
export function TeammateReportChip({
  data,
  metadata,
  joined = false,
  now,
}: {
  data: TeammateReportPartData
  metadata?: unknown
  joined?: boolean
  /**
   * A question's report whose run no longer waits on it (P13, chat-ask-card.tsx
   * RunQuestionInline): 'answered' when its held row went on, else the row's
   * own state now. Absent: what the report said.
   */
  now?: 'answered' | TeammateReportStatus
}) {
  const openOutput = useOpenOutput()
  const output = teammateReportOutput(data, metadata)

  const onClick = () => {
    void openOutput({
      workItemId: data.work_item_id,
      workspaceId: data.workspace_id || null,
      title: data.title,
      output,
    })
  }

  const icon = output ? deliverableIcon(output.type) : null
  const Icon = icon ? SENTENCE_ICON_GLYPHS[icon] : Activity
  const title = output?.label && output.label !== 'Deliverable' ? output.label : data.title
  const kind = output ? capitalize(deliverableNoun(output.type, 1)) : now === 'answered' ? 'Answered' : statusLine(now ?? data.status)
  return (
    <button
      type="button"
      onClick={onClick}
      data-teammate-report-opens={output ? output.type : 'item'}
      data-chat-panel="deliverable"
      data-joined={joined ? '' : undefined}
      className={cn(
        'group relative w-1/2 min-w-[15rem] max-w-[calc(100%-2.25rem)] self-start rounded-[24px] border border-border/60 bg-black/[0.04] p-1.5 text-left shadow-sm transition-shadow hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none dark:border-white/10 dark:bg-white/[0.06]',
        joined ? 'ml-9' : null,
      )}
    >
      <span className="flex min-w-0 items-center gap-3 rounded-[18px] bg-background px-3 py-2.5">
        <span aria-hidden className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] bg-foreground/[0.05] text-foreground/75">
          <Icon className="h-[18px] w-[18px]" />
        </span>
        <span className="flex min-w-0 flex-col">
          <span data-deliverable-title="" className="line-clamp-2 text-[15px] font-medium leading-5 text-foreground">
            {title}
          </span>
          <span data-deliverable-kind="" className="mt-0.5 text-[12px] leading-4 text-muted-foreground">
            {kind}
          </span>
        </span>
      </span>
      {joined && <ThreadHook shape="into-left" />}
    </button>
  )
}
