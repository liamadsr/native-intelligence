'use client'

/**
 * A row as a card (Tables, phase 4): its title and up to three of the view's
 * fields (lib/tables/views cardColumns), each as its cell reads, with the
 * column's type icon and its name on hover. The board, the calendar and the
 * gallery draw rows with it; a click opens the row panel.
 */
import type { ReactNode, Ref } from 'react'
import { cn } from '@/lib/utils'
import { formatFieldValue } from '@/lib/crm/custom-field-types'
import { hasCardValue, type LaneTotal } from '@/lib/tables/views'
import type { DataColumn, DataRow } from '@/lib/tables/types'
import { CellDisplay, TYPE_ICONS } from './cells'
import { asCell } from './table-grid'

export function RowCard({
  row,
  fields,
  labels,
  onOpen,
  cardRef,
  dragging,
  cover,
  compact,
}: {
  row: DataRow
  fields: readonly DataColumn[]
  labels: Readonly<Record<string, string>>
  onOpen: (rowId: string) => void
  /** The drag source, when the card can move. */
  cardRef?: Ref<HTMLDivElement>
  dragging?: boolean
  cover?: ReactNode
  /** A calendar day's card: the title only. */
  compact?: boolean
}) {
  const shown = compact ? [] : fields.filter((c) => hasCardValue(row.custom_fields?.[c.key]))
  return (
    <div
      ref={cardRef}
      role="button"
      tabIndex={0}
      data-row-card={row.id}
      onClick={() => onOpen(row.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen(row.id)
        }
      }}
      className={cn(
        'block w-full min-w-0 shrink-0 cursor-pointer overflow-hidden rounded-md border border-border bg-background text-left transition-colors hover:border-foreground/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        compact ? 'px-1.5 py-0.5' : 'px-2.5 py-2',
        dragging && 'opacity-40',
      )}
    >
      {cover}
      <p className={cn('truncate font-medium text-foreground', compact ? 'text-xs' : 'text-sm', cover ? 'mt-2' : undefined)}>{row.title || 'Untitled'}</p>
      {shown.length > 0 && (
        <div className="mt-1.5 flex flex-col gap-1">
          {shown.map((c) => {
            // A person and a linked record draw their own mark; the rest take their type's icon.
            const Icon = c.field_type === 'person' || c.field_type === 'relation' ? null : TYPE_ICONS[c.field_type]
            return (
              <div key={c.key} className="flex h-5 min-w-0 items-center gap-1.5 text-muted-foreground" title={c.label}>
                {Icon && <Icon className="h-3 w-3 shrink-0" aria-label={c.label} />}
                <div className="flex min-w-0 flex-1 items-center overflow-hidden [&>span]:h-auto [&>span]:px-0 [&>span]:text-left [&>span]:text-xs">
                  <CellDisplay column={asCell(c)} value={row.custom_fields?.[c.key]} labels={labels} />
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** A lane's totals as they read: "1,250" for a number, "$1,200 · €300" for a currency. */
export function formatTotals(totals: readonly LaneTotal[], column: Pick<DataColumn, 'field_type'> | null | undefined): string {
  if (!column) return ''
  return totals
    .map((t) => (column.field_type === 'currency' && t.currency ? formatFieldValue('currency', { amount: t.amount, currency: t.currency }) : formatFieldValue('number', t.amount)))
    .filter(Boolean)
    .join(' · ')
}
