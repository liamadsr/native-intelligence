'use client'

/**
 * The row under an `update_now` call in the chat (docs/plans/now-file.md):
 * "Now file updated", and Open puts the note in the chat as a card the person
 * opened (the document panel, full screen), the way a chip opens any record.
 * It is the one way into the note in the app: search, the wiki and the
 * document lists leave it out, and `show` refuses it.
 *
 * A call still running, or one refused, falls through to the generic chip,
 * which says why.
 */
import { NotebookPen } from 'lucide-react'
import { openTarget } from '@/lib/chat-cards/open-card'

export interface NowFileData {
  /** The note's document id (update_now's `document_id`: what this row opens). */
  documentId: string
  /** This call made the note. */
  created: boolean
  /** This call changed nothing (its edits were already there). */
  unchanged: boolean
}

/** The chip's data off an `update_now` result, or null when it wrote nothing it can open (a result is data). */
export function nowFileFromToolOutput(output: unknown): NowFileData | null {
  if (!output || typeof output !== 'object') return null
  const o = output as { success?: unknown; document_id?: unknown; created?: unknown; unchanged?: unknown }
  if (o.success !== true || typeof o.document_id !== 'string' || !o.document_id) return null
  return { documentId: o.document_id, created: o.created === true, unchanged: o.unchanged === true }
}

/** The chip's sentence. */
export function nowFileLabel(data: NowFileData): string {
  if (data.created) return 'Now file started'
  return data.unchanged ? 'Now file unchanged' : 'Now file updated'
}

/** Open the note as a card. False when no chat can take it (no window). */
export function openNowFile(documentId: string): boolean {
  return openTarget({ type: 'document', id: documentId, title: 'Now' }, { from: 'chip', reuse: true })
}

export function NowFileChip({ data }: { data: NowFileData }) {
  return (
    <div
      data-testid="now-file-chip"
      className="my-1 inline-flex max-w-full items-center gap-2 self-start rounded-full border border-border/60 bg-background/60 px-3 py-1.5 text-sm"
    >
      <NotebookPen className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 truncate">{nowFileLabel(data)}</span>
      <button
        type="button"
        onClick={() => openNowFile(data.documentId)}
        className="shrink-0 rounded-full px-2 py-0.5 text-xs font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground"
      >
        Open
      </button>
    </div>
  )
}
