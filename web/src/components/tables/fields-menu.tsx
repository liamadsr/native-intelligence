'use client'

/**
 * A view's fields (Tables, phase 4): every column in the view's order, each
 * shown or hidden, dragged to another place. The grid shows the shown ones in
 * this order; a card shows the first three. Changes are the view's draft,
 * like a filter.
 */
import { useState } from 'react'
import { Eye, EyeOff, GripVertical, SlidersHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { CARD_FIELDS, viewColumns } from '@/lib/tables/views'
import type { DataColumn } from '@/lib/tables/types'
import { TYPE_ICONS } from './cells'

export function FieldsMenu({
  columns,
  order,
  hidden,
  cards,
  onChange,
}: {
  columns: readonly DataColumn[]
  order: readonly string[]
  hidden: readonly string[]
  /** A board, calendar or gallery: say how many fields a card shows. */
  cards: boolean
  onChange: (next: { order?: string[]; hidden?: string[] }) => void
}) {
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  if (!columns.length) return null
  const all = viewColumns(columns, order)
  const hide = new Set(hidden)
  const keys = all.map((c) => c.key)

  const toggle = (key: string) => onChange({ hidden: hide.has(key) ? hidden.filter((k) => k !== key) : [...hidden, key] })
  const drop = (target: string) => {
    if (!dragging || dragging === target) return
    const next = keys.filter((k) => k !== dragging)
    next.splice(next.indexOf(target), 0, dragging)
    onChange({ order: next })
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" className="h-8 gap-1.5 px-2 text-xs text-muted-foreground">
          <SlidersHorizontal className="h-3.5 w-3.5" />
          Fields
          {hidden.length > 0 && <span className="tabular-nums">· {hidden.length} hidden</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-1.5">
        <p className="px-2 pb-1.5 pt-1 text-xs text-muted-foreground">
          {cards ? `Cards show the first ${CARD_FIELDS} shown fields.` : 'Drag to reorder.'}
        </p>
        <ul role="list" className="flex max-h-80 flex-col overflow-y-auto">
          {all.map((c) => {
            const Icon = TYPE_ICONS[c.field_type]
            const off = hide.has(c.key)
            return (
              <li
                key={c.key}
                draggable
                onDragStart={(e) => {
                  setDragging(c.key)
                  e.dataTransfer.effectAllowed = 'move'
                }}
                onDragOver={(e) => {
                  e.preventDefault()
                  setOver(c.key)
                }}
                onDragLeave={() => setOver((k) => (k === c.key ? null : k))}
                onDrop={(e) => {
                  e.preventDefault()
                  drop(c.key)
                  setDragging(null)
                  setOver(null)
                }}
                onDragEnd={() => {
                  setDragging(null)
                  setOver(null)
                }}
                className={cn('flex h-8 items-center gap-1.5 rounded-md px-1.5 text-sm', over === c.key && dragging !== c.key && 'bg-muted', dragging === c.key && 'opacity-50')}
              >
                <GripVertical className="h-3.5 w-3.5 shrink-0 cursor-grab text-muted-foreground/60" aria-hidden />
                <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className={cn('min-w-0 flex-1 truncate', off && 'text-muted-foreground')}>{c.label}</span>
                <button
                  type="button"
                  aria-label={off ? `Show ${c.label}` : `Hide ${c.label}`}
                  aria-pressed={!off}
                  onClick={() => toggle(c.key)}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  {off ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
              </li>
            )
          })}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
