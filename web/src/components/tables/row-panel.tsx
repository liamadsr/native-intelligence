'use client'

/**
 * A table row opened as a record (Tables, phase 3): its title, every field
 * (the grid's own cells and editors), what references it, and its history,
 * with Archive. A viewer who can't change the table reads it all as text.
 */
import { useEffect, useState } from 'react'
import { Archive, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { PropertyGroup } from '@/components/views/property-group'
import { ReferencedIn } from '@/components/entity-links/referenced-in'
import { relativeTime } from '@/lib/work/presentation'
import { cn } from '@/lib/utils'
import { canOfferUndo, describeChange } from '@/lib/tables/describe'
import { touchedBy } from '@/lib/tables/ops'
import type { DataChange, DataColumn, DataRow } from '@/lib/tables/types'
import { CellDisplay, CellEditor, ColumnLabel, type CellColumn, type Member } from './cells'

export function RowPanel({
  row,
  columns,
  labels,
  members,
  changes,
  canEdit,
  cellErrors,
  onEdit,
  onArchive,
  onUndo,
  onClose,
}: {
  row: DataRow
  columns: readonly DataColumn[]
  labels: Readonly<Record<string, string>>
  members: readonly Member[]
  changes: readonly DataChange[]
  canEdit: boolean
  cellErrors: ReadonlyMap<string, string>
  onEdit: (key: string, raw: unknown, names?: Record<string, string>) => void
  onArchive: () => void
  onUndo: (changeId: string) => void
  onClose: () => void
}) {
  const [title, setTitle] = useState(row.title ?? '')
  useEffect(() => setTitle(row.title ?? ''), [row.title])
  const [editing, setEditing] = useState<string | null>(null)
  const history = changes.filter((c) => touchedBy(c).rowIds.includes(row.id))

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-md">
        <SheetHeader className="space-y-1 border-b border-border px-5 py-4 text-left">
          <SheetTitle className="sr-only">{row.title || 'Untitled'}</SheetTitle>
          <SheetDescription className="sr-only">A row of the table, every field</SheetDescription>
          {canEdit ? (
            <input
              aria-label="Name"
              className="w-full bg-transparent text-lg font-semibold outline-none placeholder:text-muted-foreground/60"
              placeholder="Untitled"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => title !== (row.title ?? '') && onEdit('title', title)}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
          ) : (
            <p className="text-lg font-semibold">{row.title || 'Untitled'}</p>
          )}
          {cellErrors.get(`${row.id}:title`) && <p className="text-xs text-destructive">{cellErrors.get(`${row.id}:title`)}</p>}
        </SheetHeader>
        <div className="space-y-2 px-2 py-3">
          <PropertyGroup>
            <div className="space-y-0.5">
              {columns.map((c) => {
                const col: CellColumn = { key: c.key, label: c.label, field_type: c.field_type, options: c.options, config: c.config }
                const value = row.custom_fields?.[c.key] ?? null
                const error = cellErrors.get(`${row.id}:${c.key}`)
                const isEditing = editing === c.key
                return (
                  <div key={c.key} className="grid grid-cols-[132px_1fr] items-start gap-2 px-3" data-row-field={c.key}>
                    <span className="flex h-8 items-center text-xs text-muted-foreground">
                      <ColumnLabel type={c.field_type} label={c.label} />
                    </span>
                    <div>
                      <div
                        role={canEdit && c.field_type !== 'checkbox' ? 'button' : undefined}
                        tabIndex={canEdit && c.field_type !== 'checkbox' ? 0 : undefined}
                        className={cn('relative flex h-8 items-center rounded-md', canEdit && !isEditing && 'cursor-pointer hover:bg-muted/50', error && 'ring-1 ring-inset ring-destructive')}
                        onClick={(e) => {
                          // A picker's click (portaled, but bubbling through React) is not a click here.
                          if (!e.currentTarget.contains(e.target as Node)) return
                          if (canEdit && c.field_type !== 'checkbox' && !isEditing) setEditing(c.key)
                        }}
                        onKeyDown={(e) => e.target === e.currentTarget && canEdit && e.key === 'Enter' && c.field_type !== 'checkbox' && setEditing(c.key)}
                      >
                        {isEditing ? (
                          <CellEditor
                            column={col}
                            value={value}
                            labels={labels}
                            members={members}
                            onCommit={(raw, names) => onEdit(c.key, raw, names)}
                            done={() => setEditing(null)}
                            cancel={() => setEditing(null)}
                          />
                        ) : (
                          <CellDisplay column={col} value={value} labels={labels} onToggle={canEdit ? () => onEdit(c.key, value !== true) : undefined} />
                        )}
                        {!isEditing && value === null && c.field_type !== 'checkbox' && <span className="px-2 text-sm text-muted-foreground/60">Empty</span>}
                      </div>
                      {error && <p className="px-2 pt-0.5 text-xs text-destructive">{error}</p>}
                    </div>
                  </div>
                )
              })}
            </div>
          </PropertyGroup>
          <ReferencedIn entityType="data_row" entityId={row.id} />
          {history.length > 0 && (
            <PropertyGroup title="History">
              <ul className="space-y-0.5 px-3">
                {history.map((ch) => (
                  <li key={ch.id} className="flex items-center gap-2 py-1">
                    <span className={cn('min-w-0 flex-1 truncate text-sm', ch.undone_at ? 'text-muted-foreground line-through' : 'text-foreground')}>{describeChange(ch, columns)}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{relativeTime(ch.created_at)}</span>
                    {canEdit && canOfferUndo(ch) && (
                      <Button size="sm" variant="ghost" className="h-7 shrink-0 px-2" onClick={() => onUndo(ch.id)}>
                        <Undo2 className="h-3.5 w-3.5" />
                        Undo
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </PropertyGroup>
          )}
          {canEdit && (
            <div className="px-3 pt-2">
              <Button size="sm" variant="outline" onClick={onArchive}>
                <Archive className="h-3.5 w-3.5" />
                Archive row
              </Button>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
