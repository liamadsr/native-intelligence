'use client'

/**
 * A table's rows as a gallery (Tables, phase 4): cards in a grid that fills
 * the width, each with up to three of the view's fields and, when the view
 * picks a URL column, its image as the cover (a link that isn't an image
 * shows no cover). A click opens the row panel; + New adds a row and opens it.
 */
import { useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import { cardColumns, coverUrl } from '@/lib/tables/views'
import type { DataColumn } from '@/lib/tables/types'
import { RowCard } from './row-card'
import { newId } from './table-grid'
import type { TableData } from './use-table-data'

/** Cards mounted before "Show more". */
const PAGE_CARDS = 120

export function TableGallery({
  data,
  shown,
  cover,
  onOpenRow,
}: {
  data: TableData
  shown: readonly DataColumn[]
  cover: DataColumn | null
  onOpenRow: (rowId: string) => void
}) {
  const { rows, labels, canEdit } = data
  const [limit, setLimit] = useState(PAGE_CARDS)
  const fields = useMemo(() => cardColumns(shown, [cover?.key]), [shown, cover?.key])
  const add = () => {
    const id = newId()
    data.edit([], [{ id, title: '' }])
    onOpenRow(id)
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto border-t border-border p-4" data-table-gallery="">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
        {rows.slice(0, limit).map((row) => (
          <RowCard
            key={row.id}
            row={row}
            fields={fields}
            labels={labels}
            onOpen={onOpenRow}
            cover={cover ? <Cover url={coverUrl(row.custom_fields?.[cover.key])} /> : undefined}
          />
        ))}
        {canEdit && (
          <button
            type="button"
            onClick={add}
            className="flex min-h-20 items-center justify-center gap-1.5 rounded-md border border-dashed border-border text-sm text-muted-foreground hover:bg-muted/40 hover:text-foreground"
          >
            <Plus className="h-3.5 w-3.5" />
            New
          </button>
        )}
      </div>
      {rows.length > limit && (
        <div className="flex justify-center pt-4">
          <button type="button" onClick={() => setLimit((n) => n + PAGE_CARDS)} className="rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
            Show {Math.min(PAGE_CARDS, rows.length - limit)} more
          </button>
        </div>
      )}
    </div>
  )
}

/** A card's cover: the image, or a quiet band when there is none (or it doesn't load). */
function Cover({ url }: { url: string | null }) {
  const [failed, setFailed] = useState(false)
  return (
    <div className="-mx-2.5 -mt-2 aspect-[16/9] overflow-hidden border-b border-border bg-muted/50">
      {url && !failed && (
        // Loaded straight from the link a teammate put in the view's cover column (no proxy): its host
        // can see the viewer's IP fetch it, as with any linked image, so https only, lazy, no referrer.
        <img src={url} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} className="h-full w-full object-cover" />
      )}
    </div>
  )
}
