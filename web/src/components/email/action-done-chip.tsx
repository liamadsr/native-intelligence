'use client'

/**
 * A to-do arriving mail marked done, in the home thread
 * (src/lib/email/action-done-from-mail.ts, migration 450): "Done from your
 * mail · GEN-42 Look into renting a car · enterprise.com · Undo" (the sender
 * domain gives way first on a narrow column, then the title). Undo reopens it
 * through /api/account/email/action-done/[id]/undo, which also keeps mail from
 * closing it again, and rewrites the message so a reload says so.
 *
 * The same pill as the inbox chips (./email-triage-chip.tsx).
 */
import { useCallback, useState } from 'react'
import { CircleCheck, Undo2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ActionDonePartData } from '@/lib/email/action-done-part'

type UndoState = 'idle' | 'undoing' | 'reopened' | 'changed' | 'gone' | 'failed'

/** Reopen one. What happened, or null when it didn't go through. */
export async function undoActionDone(recordId: string): Promise<'reopened' | 'changed' | 'gone' | null> {
  try {
    const res = await fetch(`/api/account/email/action-done/${encodeURIComponent(recordId)}/undo`, { method: 'POST' })
    // Its record goes with a deleted to-do: nothing left to reopen.
    if (res.status === 404) return 'gone'
    if (!res.ok) return null
    const body = (await res.json()) as { status?: unknown }
    if (body.status === 'changed' || body.status === 'gone') return body.status
    return body.status === 'reopened' || body.status === 'already' ? 'reopened' : null
  } catch {
    return null
  }
}

export function ActionDoneChip({ data }: { data: ActionDonePartData }) {
  const [clicked, setUndo] = useState<UndoState>('idle')
  // The message rewritten as undone (a reload, or Undo on another device) wins.
  const undo: UndoState = data.undone ? (data.changed ? 'changed' : 'reopened') : clicked

  const onUndo = useCallback(async () => {
    setUndo('undoing')
    setUndo((await undoActionDone(data.record_id)) ?? 'failed')
  }, [data.record_id])

  const todo = (
    <>
      {data.identifier ? <span className="shrink-0 font-mono text-xs text-muted-foreground">{data.identifier}</span> : null}
      <span className="min-w-0 truncate" title={data.title}>
        {data.title}
      </span>
    </>
  )

  if (undo === 'gone') {
    return (
      <div data-testid="action-done-chip" className="my-1 inline-flex max-w-full items-center gap-1.5 self-start rounded-full border border-border/60 px-3 py-1.5 text-sm text-muted-foreground">
        <CircleCheck className="h-3.5 w-3.5 shrink-0" />
        <span className="shrink-0">No longer on your board</span>
        {todo}
      </div>
    )
  }

  if (undo === 'reopened' || undo === 'changed') {
    return (
      <div data-testid="action-done-chip" className="my-1 inline-flex max-w-full items-center gap-1.5 self-start rounded-full border border-border/60 px-3 py-1.5 text-sm text-muted-foreground">
        <Undo2 className="h-3.5 w-3.5 shrink-0" />
        <span className="shrink-0">{undo === 'changed' ? 'Left as you set it' : 'Reopened'}</span>
        {todo}
        <span className="shrink-0 text-xs">· mail won’t close it again</span>
      </div>
    )
  }

  return (
    <div
      data-testid="action-done-chip"
      className="my-1 inline-flex max-w-full items-center gap-2 self-start rounded-full border border-border/60 bg-background/60 px-3 py-1.5 text-sm"
    >
      <CircleCheck className="h-3.5 w-3.5 shrink-0" />
      <span className="shrink-0">Done from your mail</span>
      {todo}
      {data.sender_domain ? (
        // Gives way well before the title does.
        <span className="hidden min-w-0 shrink-[8] truncate text-xs text-muted-foreground sm:inline" title={`A confirmation from ${data.sender_domain}`}>
          {data.sender_domain}
        </span>
      ) : null}
      <button
        type="button"
        onClick={onUndo}
        disabled={undo === 'undoing'}
        className={cn(
          'shrink-0 rounded-full px-2 py-0.5 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground',
          undo === 'undoing' && 'opacity-60',
        )}
      >
        {undo === 'failed' ? 'Undo failed, retry' : undo === 'undoing' ? 'Undoing…' : 'Undo'}
      </button>
    </div>
  )
}
