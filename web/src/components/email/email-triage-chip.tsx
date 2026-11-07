'use client'

/**
 * The chip under an update_email_thread call in the chat (GEN-1166): what the
 * agent did to the person's inbox ("Archived and marked read · 4 threads")
 * and Undo, which runs each of the result's `undo` calls through
 * /api/account/email/threads/triage. An undo is safe to retry: a thread
 * already put back changes nothing.
 *
 * A result that changed nothing (or was refused, or is still running) has no
 * chip: the generic one says what happened.
 */
import { useCallback, useState } from 'react'
import { MailCheck, Undo2 } from 'lucide-react'
import { cn } from '@/lib/utils'

/** One undo call, as update_email_thread arguments. */
export interface TriageUndoCall {
  thread_ids: string[]
  change: {
    archive?: boolean
    read?: boolean
    star?: boolean
    add_labels?: string[]
    remove_labels?: string[]
    mute?: boolean
  }
}

export interface EmailTriageData {
  /** "Archived and marked read". */
  label: string
  /** Threads changed. */
  count: number
  undo: TriageUndoCall[]
}

type Change = TriageUndoCall['change']

const isBool = (v: unknown): v is boolean => typeof v === 'boolean'
const strings = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((s) => typeof s === 'string') && v.length ? (v as string[]) : undefined

/** The change fields off one record (a thread's `applied`, or an undo call), dropping anything else. */
function changeOf(record: Record<string, unknown>): Change {
  const add = strings(record.add_labels)
  const remove = strings(record.remove_labels)
  return {
    ...(isBool(record.archive) ? { archive: record.archive } : {}),
    ...(isBool(record.read) ? { read: record.read } : {}),
    ...(isBool(record.star) ? { star: record.star } : {}),
    ...(add ? { add_labels: add } : {}),
    ...(remove ? { remove_labels: remove } : {}),
    ...(isBool(record.mute) ? { mute: record.mute } : {}),
  }
}

/** What the change did, in a few words. Pure. */
export function triageLabel(change: Change): string {
  const parts: string[] = []
  if (change.mute === true) parts.push('muted')
  else if (change.archive === true) parts.push('archived')
  if (change.archive === false) parts.push('moved to the inbox')
  if (change.mute === false) parts.push('unmuted')
  if (change.read !== undefined) parts.push(change.read ? 'marked read' : 'marked unread')
  if (change.star !== undefined) parts.push(change.star ? 'starred' : 'unstarred')
  if (change.add_labels) parts.push(`labeled ${change.add_labels.join(', ')}`)
  if (change.remove_labels) parts.push(`took off ${change.remove_labels.join(', ')}`)
  if (!parts.length) return 'Updated'
  const said = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
  return said.charAt(0).toUpperCase() + said.slice(1)
}

/** The chip's data off an update_email_thread result, or null when it changed nothing (a result is data). */
export function emailTriageFromToolOutput(output: unknown): EmailTriageData | null {
  if (!output || typeof output !== 'object') return null
  const o = output as { success?: unknown; changed?: unknown; threads?: unknown; undo?: unknown }
  if (o.success !== true || typeof o.changed !== 'number' || o.changed < 1 || !Array.isArray(o.undo)) return null
  const undo: TriageUndoCall[] = []
  for (const call of o.undo) {
    if (!call || typeof call !== 'object') continue
    const ids = strings((call as Record<string, unknown>).thread_ids)
    const change = changeOf(call as Record<string, unknown>)
    if (ids && Object.keys(change).length) undo.push({ thread_ids: ids, change })
  }
  if (!undo.length) return null
  // The label: every change any thread took (the union of their `applied`).
  const applied: Record<string, unknown> = {}
  for (const thread of Array.isArray(o.threads) ? o.threads : []) {
    const a = thread && typeof thread === 'object' ? (thread as { status?: unknown; applied?: unknown }) : null
    if (a?.status !== 'changed' || !a.applied || typeof a.applied !== 'object') continue
    for (const [key, value] of Object.entries(changeOf(a.applied as Record<string, unknown>))) {
      if (Array.isArray(value)) applied[key] = [...new Set([...((applied[key] as string[] | undefined) ?? []), ...value])]
      else applied[key] ??= value
    }
  }
  return { label: triageLabel(changeOf(applied)), count: o.changed, undo }
}

/** Run every undo call. True when each one went through with no thread failing. */
export async function undoEmailTriage(calls: readonly TriageUndoCall[]): Promise<boolean> {
  let ok = true
  for (const call of calls) {
    try {
      const res = await fetch('/api/account/email/threads/triage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(call),
      })
      if (!res.ok) {
        ok = false
        continue
      }
      const body = (await res.json()) as { threads?: Array<{ status?: unknown }> }
      if ((body.threads ?? []).some((t) => t.status === 'failed' || t.status === 'not_found')) ok = false
    } catch {
      ok = false
    }
  }
  return ok
}

type UndoState = 'idle' | 'undoing' | 'undone' | 'failed'

export function EmailTriageChip({
  data,
  undoWith,
  undone = false,
  detail,
  undoneNote,
}: {
  data: EmailTriageData
  /** Undo some other way than the result's own calls (the morning tidy's batch). True when it all went back. */
  undoWith?: () => Promise<boolean>
  /** Already put back (a reload of a tidy the person undid). */
  undone?: boolean
  /** A few more words beside the count ("amazon.com, gusto.com +3"). */
  detail?: string | null
  /** What Undo also did, said once it has. */
  undoneNote?: string
}) {
  const [undo, setUndo] = useState<UndoState>(undone ? 'undone' : 'idle')

  const onUndo = useCallback(async () => {
    setUndo('undoing')
    setUndo((await (undoWith ? undoWith() : undoEmailTriage(data.undo))) ? 'undone' : 'failed')
  }, [data, undoWith])

  const threads = `${data.count} thread${data.count === 1 ? '' : 's'}`

  if (undo === 'undone') {
    return (
      <div data-testid="email-triage-chip" className="my-1 inline-flex max-w-full items-center gap-1.5 self-start rounded-full border border-border/60 px-3 py-1.5 text-sm text-muted-foreground">
        <Undo2 className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 truncate">
          Put back · {threads}
          {undoneNote ? ` · ${undoneNote}` : ''}
        </span>
      </div>
    )
  }

  return (
    <div
      data-testid="email-triage-chip"
      className="my-1 inline-flex max-w-full items-center gap-2 self-start rounded-full border border-border/60 bg-background/60 px-3 py-1.5 text-sm"
    >
      <MailCheck className="h-3.5 w-3.5 shrink-0" />
      {/* With a detail beside it, the detail gives way first: the label says what happened. */}
      <span className={cn('min-w-0 truncate', detail && 'shrink-0')} title={`${data.label} · ${threads}`}>
        {data.label}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">{threads}</span>
      {detail ? (
        <span className="min-w-0 truncate text-xs text-muted-foreground" title={detail}>
          {detail}
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
