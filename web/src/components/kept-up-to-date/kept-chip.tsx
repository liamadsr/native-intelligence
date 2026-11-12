'use client'

/**
 * A record an email, a meeting or a text kept up to date, in the home thread
 * (src/lib/kept-up-to-date/engine.ts, migration 539): "Updated from your
 * mail · Acme renewal · Stage: Proposal → Won · Undo", and under it the
 * sentence that said it. Undo goes through
 * /api/account/kept-up-to-date/[id]/undo, which also keeps it from being
 * changed that way again, and rewrites the message so a reload says so.
 *
 * The same pill as the to-do closer's (../email/action-done-chip.tsx).
 */
import { useCallback, useState } from 'react'
import { CircleCheck, RefreshCw, Undo2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { keptSourceWords, type KeptPartData } from '@/lib/kept-up-to-date/part'

type UndoState = 'idle' | 'undoing' | 'reverted' | 'changed' | 'gone' | 'failed'

/** Undo one. What happened, or null when it didn't go through. */
export async function undoKept(recordId: string): Promise<'reverted' | 'changed' | 'gone' | null> {
  try {
    const res = await fetch(`/api/account/kept-up-to-date/${encodeURIComponent(recordId)}/undo`, { method: 'POST' })
    if (res.status === 404) return 'gone'
    if (!res.ok) return null
    const body = (await res.json()) as { status?: unknown }
    if (body.status === 'changed' || body.status === 'gone') return body.status
    return body.status === 'reverted' || body.status === 'already' ? 'reverted' : null
  } catch {
    return null
  }
}

/** "Stage: Proposal → Won", or "Done" for a to-do. */
export function keptChangeText(data: Pick<KeptPartData, 'record_type' | 'field' | 'from' | 'to'>): string {
  if (data.record_type === 'action') return 'Done'
  return `${data.field ? `${data.field}: ` : ''}${data.from ? `${data.from} → ` : ''}${data.to}`
}

export function KeptChip({ data }: { data: KeptPartData }) {
  const [clicked, setUndo] = useState<UndoState>('idle')
  // The message rewritten as undone (a reload, or Undo on another device) wins.
  const undo: UndoState = data.undone ? (data.changed ? 'changed' : 'reverted') : clicked

  const onUndo = useCallback(async () => {
    setUndo('undoing')
    setUndo((await undoKept(data.record_id)) ?? 'failed')
  }, [data.record_id])

  const record = (
    <>
      {data.identifier ? <span className="shrink-0 font-mono text-xs text-muted-foreground">{data.identifier}</span> : null}
      <span className="min-w-0 truncate" title={data.table ? `${data.title} · ${data.table}` : data.title}>
        {data.title}
      </span>
    </>
  )
  const change = <span className="min-w-0 shrink-[2] truncate text-muted-foreground">{keptChangeText(data)}</span>

  if (undo === 'gone' || undo === 'reverted' || undo === 'changed') {
    return (
      <div data-testid="kept-chip" className="my-1 inline-flex max-w-full items-center gap-1.5 self-start rounded-full border border-border/60 px-3 py-1.5 text-sm text-muted-foreground">
        <Undo2 className="h-3.5 w-3.5 shrink-0" />
        <span className="shrink-0">{undo === 'gone' ? 'No longer there' : undo === 'changed' ? 'Left as it is now' : 'Undone'}</span>
        {record}
        {undo === 'reverted' ? <span className="shrink-0 text-xs">· won’t be changed that way again</span> : null}
      </div>
    )
  }

  return (
    <div data-testid="kept-chip" className="my-1 flex max-w-full flex-col gap-1 self-start">
      <div className="inline-flex max-w-full items-center gap-2 self-start rounded-full border border-border/60 bg-background/60 px-3 py-1.5 text-sm">
        {data.record_type === 'action' ? <CircleCheck className="h-3.5 w-3.5 shrink-0" /> : <RefreshCw className="h-3.5 w-3.5 shrink-0" />}
        <span className="shrink-0">Updated from {keptSourceWords(data.source)}</span>
        {record}
        {change}
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
      {data.evidence ? (
        <p className="line-clamp-2 max-w-prose pl-3 text-xs text-muted-foreground" title={data.source_label ?? undefined}>
          “{data.evidence}”{data.source_label ? ` · ${data.source_label}` : ''}
        </p>
      ) : null}
    </div>
  )
}
