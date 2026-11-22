'use client'

/**
 * The spreadsheet's links, as a panel at the grid's right (phase 6): the
 * records that reference this workbook — a document or team-chat message that
 * @-mentions it, a task about it — newest first, each opening its own card.
 * The same data and rows as every other kind's "Referenced in"
 * (src/components/entity-links/referenced-in.tsx): the spreadsheet card has no
 * properties panel to hold that section, so it gets its own toggle panel
 * beside Comments and Version history. Private spreadsheets stay fenced by the
 * viewer's RLS (675's restrictive entity_link policies) — a source they cannot
 * read never arrives.
 */
import { Link2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FLOATING_CARD_CLASS } from '@/components/attention/card-skin'
import { ReferencedInList, useEntityReferences } from '@/components/entity-links/referenced-in'

export function LinksPanel({ spreadsheetId, onClose }: { spreadsheetId: string; onClose: () => void }) {
  const refs = useEntityReferences('spreadsheet', spreadsheetId)
  return (
    <aside aria-label="Links" className={cn(FLOATING_CARD_CLASS, 'absolute bottom-3 right-3 top-3 z-40 flex w-[300px] max-w-[calc(100%-1.5rem)] max-[480px]:!w-[calc(100%-1.5rem)] flex-col shadow-lg')}>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <Link2 className="h-3.5 w-3.5 text-muted-foreground" />
        <h2 className="flex-1 text-sm font-medium text-foreground">Links</h2>
        <button type="button" aria-label="Close links" className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {refs === null ? (
          <p className="p-3 text-sm text-muted-foreground">Loading…</p>
        ) : refs.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">
            Nothing links to this spreadsheet yet. Mention it in a document, a task or a chat and it shows up here.
          </p>
        ) : (
          <ReferencedInList references={refs} />
        )}
      </div>
    </aside>
  )
}
