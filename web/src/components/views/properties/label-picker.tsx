'use client'

import * as React from 'react'
import { Tag, X } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { LabelPickerContent } from '@/components/labels/label-picker-content'
import { useScopedLabels } from '@/lib/labels/use-scoped-labels'
import type { LabelScope } from '@/lib/labels/utils'
import { cn } from '@/lib/utils'
import { chipClass, cellTriggerClass } from '@/lib/views/property-options'

export interface AttachedLabel {
  id: string
  name: string
  color: string
}

// ── Cell trigger ───────────────────────────────────────────

interface LabelCellTriggerProps {
  /** Currently-attached labels (display) */
  attached: AttachedLabel[]
  /** The label scope used to fetch selectable labels */
  scope: LabelScope
  onToggle: (labelId: string, isAttached: boolean) => void
}

export function LabelCellTrigger({ attached, scope, onToggle }: LabelCellTriggerProps) {
  const [open, setOpen] = React.useState(false)
  const { grouped } = useScopedLabels(scope)
  const selectedIds = attached.map(l => l.id)

  if (!attached.length) {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            onClick={e => e.stopPropagation()}
            className="w-6 h-5 rounded-full opacity-0 group-hover:opacity-60 hover:opacity-100 hover:bg-muted/40 transition-opacity flex items-center justify-center"
            aria-label="Add label"
          >
            <Tag className="h-3 w-3 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-2" align="start" onClick={e => e.stopPropagation()}>
          <LabelPickerContent grouped={grouped} selectedIds={selectedIds} onToggle={onToggle} />
        </PopoverContent>
      </Popover>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          onClick={e => e.stopPropagation()}
          className={cn(cellTriggerClass, 'flex gap-1 items-center')}
          aria-label="Edit labels"
        >
          {attached.slice(0, 2).map(l => (
            <span key={l.id} className={chipClass}>
              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: l.color }} />
              {l.name}
            </span>
          ))}
          {attached.length > 2 && (
            <span className="text-[10px] text-muted-foreground">+{attached.length - 2}</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-2" align="start" onClick={e => e.stopPropagation()}>
        <LabelPickerContent grouped={grouped} selectedIds={selectedIds} onToggle={onToggle} />
      </PopoverContent>
    </Popover>
  )
}

// ── Panel field ────────────────────────────────────────────

interface LabelPanelFieldProps {
  attached: AttachedLabel[]
  scope: LabelScope
  onToggle: (labelId: string, isAttached: boolean) => void
}

function LabelPanelField({ attached, scope, onToggle }: LabelPanelFieldProps) {
  const { grouped } = useScopedLabels(scope)
  const selectedIds = attached.map(l => l.id)

  return (
    <div className="space-y-1">
      {attached.length > 0 && (
        <div className="space-y-1 px-2">
          {attached.map(l => (
            <div key={l.id} className="flex items-center gap-2 text-sm">
              <span className="inline-block h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: l.color }} />
              <span className="truncate">{l.name}</span>
              <button
                onClick={() => onToggle(l.id, true)}
                className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
                aria-label={`Remove ${l.name}`}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      <Popover>
        <PopoverTrigger asChild>
          <button className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-muted/50">
            <Tag className="h-4 w-4 shrink-0" />
            <span>Add label</span>
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-56 p-2" align="start">
          <LabelPickerContent grouped={grouped} selectedIds={selectedIds} onToggle={onToggle} />
        </PopoverContent>
      </Popover>
    </div>
  )
}
