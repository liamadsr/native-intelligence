'use client'

/**
 * "4 suggestions · Apply all" on a review card whose deliverable is a document
 * (a brief): the person can clear a brief's suggestions from the bot's page or
 * bubble without opening it (docs/plans/suggestions-everywhere.md, Phase 7).
 * Shows nothing while none are pending.
 */
import { useState } from 'react'
import { toast } from 'sonner'
import { Check, Loader2, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useSuggestionHome, useSuggestionStore } from './suggestions-store'

export function DocumentSuggestionsChip({ documentId, className }: { documentId: string; className?: string }) {
  const store = useSuggestionStore()
  // Load-only: a chip shares the dashboard store, so a settle anywhere in the
  // app shows here; it doesn't need a Realtime channel of its own per card.
  const rows = useSuggestionHome(`document:${documentId}`, { live: false })
  const pending = rows.filter((r) => r.status === 'pending')
  const [applying, setApplying] = useState(false)

  if (pending.length === 0) return null

  const applyAll = async () => {
    setApplying(true)
    try {
      const r = await store.applyMany(pending.map((p) => p.id))
      if (r.applied) toast.success(`Applied ${r.applied} suggestion${r.applied === 1 ? '' : 's'}${r.skipped ? `, ${r.skipped} skipped` : ''}`)
      else if (r.skipped) toast.info(`${r.skipped} skipped: already done or changed since`)
      if (r.failed) toast.error(`${r.failed} could not be applied`)
    } finally {
      setApplying(false)
    }
  }

  return (
    <span
      data-document-suggestions={documentId}
      className={cn(
        'flex h-5 shrink-0 items-center gap-1 rounded-full border border-primary/30 bg-primary/5 pl-1.5 text-[10px] font-medium text-foreground/80',
        className,
      )}
      title={pending.map((p) => `• ${p.display_text}`).join('\n')}
    >
      <Sparkles className="h-2.5 w-2.5 shrink-0 text-primary" />
      {pending.length} suggestion{pending.length === 1 ? '' : 's'}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          void applyAll()
        }}
        disabled={applying}
        className="ml-0.5 flex h-5 items-center gap-0.5 rounded-r-full border-l border-primary/20 px-1.5 hover:bg-primary/10 disabled:opacity-60"
      >
        {applying ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Check className="h-2.5 w-2.5" />}
        Apply all
      </button>
    </span>
  )
}
