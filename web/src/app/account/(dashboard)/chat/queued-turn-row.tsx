'use client'

import { memo } from 'react'
import { Clock, Paperclip } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { QueuedTurn } from './queued-turn'

/**
 * A message sent while the reply runs (queued-turn.ts), just above the composer
 * like the note-taker's rows: what will be sent, that it hasn't been yet, a
 * plain-text "Send now" under it (stops the reply, then it goes) and "Edit"
 * (back into the composer). Hidden for a spoken turn, which goes the moment
 * voice mode's stop settles.
 *
 * What it says (UI-2, docs/plans/always-on-agent.md §2b):
 *  - steering, held: "Waiting for a good moment…" — Edit and Send now;
 *  - steering, on its way to eve (posting / posted): the same words, Send now
 *    only (eve can't take a message back); "Already on its way" after an Edit
 *    that came too late;
 *  - waiting for the end (not plain words, another page, or the steer was
 *    refused): "Sends when this reply finishes" — Edit and Send now;
 *  - `after`: a message sent while one is already on its way waits behind it
 *    ("Sends after that one") with Edit only, and steers the next reply.
 *
 * `relative`: the dock's blur layer is absolutely positioned, so an unpositioned
 * row after it would paint beneath it and read blurred.
 */
export const QueuedTurnRow = memo(function QueuedTurnRow({
  turn,
  onSendNow,
  onEdit,
  after = false,
}: {
  turn: QueuedTurn | null
  onSendNow?: () => void
  onEdit: () => void
  after?: boolean
}) {
  if (!turn || turn.spokenOnly) return null
  const fileCount = turn.files.length
  const steer = turn.steer
  const onItsWay = !!steer && steer.state !== 'held'
  const status = after
    ? 'Sends after that one'
    : steer?.onItsWay
      ? 'Already on its way — waiting for a good moment…'
      : steer
        ? 'Waiting for a good moment…'
        : 'Sends when this reply finishes'
  return (
    <div className="relative px-2 pb-1" data-queued-turn={after ? 'after' : steer ? steer.state : 'waiting'}>
      <div className="flex items-start gap-2 rounded-xl border border-border/60 bg-muted/40 px-3 py-2 text-xs">
        <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="text-muted-foreground" role="status" aria-live="polite">
            {status}
          </div>
          {turn.text && (
            <div className="line-clamp-3 whitespace-pre-wrap break-words text-foreground" data-queued-turn-text>
              {turn.text}
            </div>
          )}
          {fileCount > 0 && (
            <div className="mt-0.5 flex items-center gap-1 text-muted-foreground">
              <Paperclip className="h-3 w-3" aria-hidden />
              {fileCount === 1 ? turn.files[0].file.name : `${fileCount} files`}
            </div>
          )}
          {!after && onSendNow && (
            <button
              type="button"
              className="mt-0.5 rounded-sm text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:text-foreground focus-visible:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
              onClick={onSendNow}
            >
              Send now
            </button>
          )}
        </div>
        {!onItsWay && (
          <Button variant="ghost" size="sm" className="h-7 shrink-0 px-2 text-xs" onClick={onEdit}>
            Edit
          </Button>
        )}
      </div>
    </div>
  )
})
