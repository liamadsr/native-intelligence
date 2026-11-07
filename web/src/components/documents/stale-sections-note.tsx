'use client'

/**
 * A canon document's quiet "not checked since" marker (canon D3,
 * canon-freshness.ts): one line per section nobody has changed or checked in
 * 90 days, under the title. It replaces the "still true?" card (decision 16:
 * nothing waits on a card), so it asks nothing: editing the section clears
 * it, and "Mark checked" stamps it checked today for someone who may edit
 * the document. Renders nothing while every section is fresh.
 */
import { useState } from 'react'
import { Clock } from 'lucide-react'
import { toast } from 'sonner'

export interface StaleSectionMark {
  heading: string
  lastVerifiedAt: string
}

/** "Jul 3" this year, "Jul 3, 2025" before it. */
function shortDate(iso: string, now = new Date()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) })
}

export function StaleSectionsNote({
  documentId,
  sections,
  canMark,
  onMarked,
}: {
  documentId: string
  sections: readonly StaleSectionMark[] | undefined
  canMark: boolean
  onMarked: (heading: string) => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  if (!sections || sections.length === 0) return null

  async function mark(heading: string) {
    setBusy(heading)
    try {
      const res = await fetch(`/api/account/documents/${documentId}/section-check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ section: heading }),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok) throw new Error(json?.error || 'Couldn’t mark it checked')
      onMarked(heading)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Couldn’t mark it checked')
    } finally {
      setBusy(null)
    }
  }

  return (
    <ul className="space-y-0.5" data-testid="stale-sections">
      {sections.map((s) => (
        <li key={s.heading} className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Clock className="h-3 w-3 shrink-0" />
          <span className="min-w-0 truncate">
            {s.heading} not checked since {shortDate(s.lastVerifiedAt)}
          </span>
          {canMark && (
            <button
              type="button"
              onClick={() => void mark(s.heading)}
              disabled={busy !== null}
              className="shrink-0 rounded px-1 underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
            >
              Mark checked
            </button>
          )}
        </li>
      ))}
    </ul>
  )
}
