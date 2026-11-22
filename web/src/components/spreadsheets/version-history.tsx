'use client'

/**
 * The spreadsheet's history, as a panel at the grid's right: who changed it
 * and when, newest first. Restoring a version saves it as the current
 * workbook (so it is one more entry, and nothing is lost) and reloads the
 * editor on it.
 */
import { useEffect, useState } from 'react'
import { Bot, History, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { FLOATING_CARD_CLASS } from '@/components/attention/card-skin'
import { relativeTime } from '@/lib/work/presentation'
import type { RevisionSummary } from '@/lib/spreadsheets/revisions'

interface Props {
  spreadsheetId: string
  /** The revision the editor is at: what a restore is made from. */
  revision: number
  readOnly: boolean
  /** Unsaved changes would be lost by a restore. */
  dirty: boolean
  onClose: () => void
  /** A version was restored: load the spreadsheet again. */
  onRestored: () => void
  onMessage: (message: string) => void
}

export function VersionHistory({ spreadsheetId, revision, readOnly, dirty, onClose, onRestored, onMessage }: Props) {
  const [entries, setEntries] = useState<RevisionSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [restoring, setRestoring] = useState(false)

  useEffect(() => {
    let live = true
    void fetch(`/api/account/spreadsheets/${spreadsheetId}/revisions`)
      .then(async (res) => {
        const json = (await res.json().catch(() => ({}))) as { revisions?: RevisionSummary[]; error?: string }
        if (!res.ok) throw new Error(json.error || 'Could not load the history')
        if (live) setEntries(json.revisions ?? [])
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : 'Could not load the history'))
    return () => {
      live = false
    }
  }, [spreadsheetId, revision])

  const restore = async (entry: RevisionSummary) => {
    if (restoring) return
    setRestoring(true)
    try {
      const res = await fetch(`/api/account/spreadsheets/${spreadsheetId}/revisions/${entry.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base_revision: revision }),
      })
      const json = (await res.json().catch(() => ({}))) as { error?: string }
      if (!res.ok) throw new Error(res.status === 409 ? 'Someone changed this spreadsheet just now. Close the history and try again.' : json.error || 'Could not restore that version')
      onRestored()
    } catch (e) {
      onMessage(e instanceof Error ? e.message : 'Could not restore that version')
    } finally {
      setRestoring(false)
      setConfirming(null)
    }
  }

  return (
    <aside aria-label="Version history" className={cn(FLOATING_CARD_CLASS, 'absolute bottom-3 right-3 top-3 z-40 flex w-[300px] max-w-[calc(100%-1.5rem)] max-[480px]:!w-[calc(100%-1.5rem)] flex-col shadow-lg')}>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <History className="h-3.5 w-3.5 text-muted-foreground" />
        <h2 className="flex-1 text-sm font-medium text-foreground">Version history</h2>
        <button type="button" aria-label="Close version history" className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {error ? (
          <p className="p-3 text-sm text-destructive">{error}</p>
        ) : entries === null ? (
          <p className="p-3 text-sm text-muted-foreground">Loading…</p>
        ) : entries.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">No versions yet.</p>
        ) : (
          <ul>
            {entries.map((entry, index) => {
              const current = index === 0
              const who = entry.author_kind === 'agent' ? `${entry.author_name ?? 'Someone'}’s agent` : entry.author_kind === 'system' ? 'The app' : (entry.author_name ?? 'Someone')
              return (
                <li key={entry.id} className="rounded-lg px-2 py-2 hover:bg-accent/40">
                  <div className="flex items-baseline gap-2">
                    <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-[13px] font-medium text-foreground">
                      {entry.author_kind === 'agent' && <Bot className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="Agent" />}
                      <span className="truncate">{who}</span>
                    </span>
                    <time dateTime={entry.updated_at} className="shrink-0 text-[11.5px] text-muted-foreground">{relativeTime(entry.updated_at)}</time>
                  </div>
                  <p className="mt-0.5 truncate text-[12px] text-muted-foreground">
                    {current ? 'Current version' : entry.change_summary || `${entry.sheet_names.length} ${entry.sheet_names.length === 1 ? 'sheet' : 'sheets'}`}
                  </p>
                  {!current && !readOnly && (
                    confirming === entry.id ? (
                      <div className="mt-1.5 flex items-center gap-1.5">
                        <span className="flex-1 text-[12px] text-foreground">{dirty ? 'Your unsaved changes will be lost. Restore?' : 'Restore this version?'}</span>
                        <Button size="sm" className="h-6 px-2 text-xs" disabled={restoring} onClick={() => void restore(entry)}>Restore</Button>
                        <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setConfirming(null)}>Cancel</Button>
                      </div>
                    ) : (
                      <button type="button" className="mt-1 text-[12px] font-medium text-primary hover:underline" onClick={() => setConfirming(entry.id)}>
                        Restore this version
                      </button>
                    )
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </aside>
  )
}
