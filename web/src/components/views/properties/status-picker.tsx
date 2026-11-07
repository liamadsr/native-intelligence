'use client'

import * as React from 'react'
import { Circle } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command'
import { cn } from '@/lib/utils'
import { STATUS_DOT_COLORS, cellTriggerClass } from '@/lib/views/property-options'
import type { WorkflowStateOption } from './types'

// ── Shared content ─────────────────────────────────────────

interface StatusPickerContentProps {
  value: string | null | undefined
  /** Workflow states for the row's team. Empty = enum-only statuses. */
  workflowStates: WorkflowStateOption[]
  onChange: (stateId: string) => void
  onSelected?: () => void
  /** When true, shows a loading indicator instead of "no states". */
  loading?: boolean
}

function StatusPickerContent({ value, workflowStates, onChange, onSelected, loading }: StatusPickerContentProps) {
  return (
    <Command>
      <CommandList>
        <CommandGroup>
          {workflowStates.map(state => {
            const dot = state.color
              ? undefined
              : STATUS_DOT_COLORS[state.category] || 'bg-gray-400'
            return (
              <CommandItem
                key={state.id}
                value={state.id}
                onSelect={() => {
                  onChange(state.id)
                  onSelected?.()
                }}
                className={cn(value === state.id && 'bg-accent')}
              >
                {state.color ? (
                  <Circle
                    className="mr-2 h-3.5 w-3.5 shrink-0"
                    style={{ color: state.color }}
                    fill={state.color}
                  />
                ) : (
                  <span className={cn('mr-2 h-2 w-2 rounded-full shrink-0', dot)} />
                )}
                {state.name}
              </CommandItem>
            )
          })}
          {workflowStates.length === 0 && (
            <div className="px-2 py-3 text-xs text-muted-foreground">
              {loading ? 'Loading…' : 'No workflow states available'}
            </div>
          )}
        </CommandGroup>
      </CommandList>
    </Command>
  )
}

// ── Cell trigger ───────────────────────────────────────────

interface StatusCellTriggerProps {
  value: string | null | undefined
  workflowStates: WorkflowStateOption[]
  /** Fallback display when `value` doesn't resolve in workflowStates (e.g. row hydrated from projection). */
  displayName?: string | null
  displayColor?: string | null
  displayCategory?: string | null
  onChange: (stateId: string) => void
  /** When true, the picker shows "Loading…" instead of "No workflow states". */
  loading?: boolean
}

export function StatusCellTrigger({
  value, workflowStates, displayName, displayColor, displayCategory, onChange, loading,
}: StatusCellTriggerProps) {
  const [open, setOpen] = React.useState(false)
  const state = workflowStates.find(s => s.id === value)
  const name = state?.name ?? displayName ?? '—'
  const color = state?.color ?? displayColor ?? null
  const category = state?.category ?? displayCategory ?? 'backlog'
  const dotClass = color ? undefined : (STATUS_DOT_COLORS[category] || 'bg-gray-400')

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          onClick={e => e.stopPropagation()}
          className={cn(cellTriggerClass, 'capitalize')}
        >
          {color ? (
            <Circle className="h-3 w-3 shrink-0" style={{ color }} fill={color} />
          ) : (
            <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', dotClass)} />
          )}
          {name.replace(/_/g, ' ')}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-1" align="start" onClick={e => e.stopPropagation()}>
        <StatusPickerContent
          value={value}
          workflowStates={workflowStates}
          onChange={onChange}
          onSelected={() => setOpen(false)}
          loading={loading}
        />
      </PopoverContent>
    </Popover>
  )
}

// ── Panel field ────────────────────────────────────────────

interface StatusPanelFieldProps {
  value: string | null | undefined
  workflowStates: WorkflowStateOption[]
  onChange: (stateId: string) => void
}

export function StatusPanelField({ value, workflowStates, onChange }: StatusPanelFieldProps) {
  const [open, setOpen] = React.useState(false)
  const state = workflowStates.find(s => s.id === value)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm transition-colors hover:bg-muted/50">
          {state?.color ? (
            <Circle className="h-4 w-4 shrink-0" style={{ color: state.color }} fill={state.color} />
          ) : (
            <span className={cn('h-2 w-2 rounded-full shrink-0', STATUS_DOT_COLORS[state?.category ?? 'backlog'] || 'bg-gray-400')} />
          )}
          <span className={cn('truncate', !state && 'text-muted-foreground')}>
            {state?.name ?? 'Set status'}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-1" align="start">
        <StatusPickerContent
          value={value}
          workflowStates={workflowStates}
          onChange={onChange}
          onSelected={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  )
}
