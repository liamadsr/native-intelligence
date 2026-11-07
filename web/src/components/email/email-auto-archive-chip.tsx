'use client'

/**
 * The morning tidy's message in the home thread (src/lib/email/auto-archive.ts,
 * migration 446): "Inbox tidied · 14 threads · amazon.com, gusto.com +3 ·
 * Undo" (the sender domains give way first on a narrow column). Undo puts the batch back through
 * /api/account/email/auto-archive/[id]/undo, which also keeps mail from those
 * senders in the inbox from then on, and rewrites the message so a reload
 * says so.
 */
import { useCallback } from 'react'
import { EmailTriageChip } from './email-triage-chip'
import { autoArchiveDomainsLine, type EmailAutoArchivePartData } from '@/lib/email/auto-archive-part'

/** Put a batch back. True when every thread went back (a retry of one already back counts). */
export async function undoAutoArchiveBatch(batchId: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/account/email/auto-archive/${encodeURIComponent(batchId)}/undo`, { method: 'POST' })
    if (!res.ok) return false
    const body = (await res.json()) as { failed?: unknown }
    return body.failed === 0
  } catch {
    return false
  }
}

export function EmailAutoArchiveChip({ data }: { data: EmailAutoArchivePartData }) {
  const undoWith = useCallback(() => undoAutoArchiveBatch(data.batch_id), [data.batch_id])
  return (
    <EmailTriageChip
      data={{ label: 'Inbox tidied', count: data.count, undo: [] }}
      undoWith={undoWith}
      undone={data.undone === true}
      detail={autoArchiveDomainsLine(data)}
      undoneNote="their senders stay in your inbox"
    />
  )
}
