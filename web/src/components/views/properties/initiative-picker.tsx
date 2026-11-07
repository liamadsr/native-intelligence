'use client'

import * as React from 'react'
import { ArrowUpRight, Target } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command'
import { isEmoji } from '@/components/ui/emoji-icon-picker'
import { cn } from '@/lib/utils'
import { cellTriggerClass } from '@/lib/views/property-options'
import type { InitiativeOption } from './types'

function InitiativeGlyph({ icon }: { icon: string | null }) {
  if (icon && isEmoji(icon)) return <span className="text-sm shrink-0">{icon}</span>
  return <Target className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
}

// ── Shared content ─────────────────────────────────────────

interface InitiativePickerContentProps {
  value: string | null | undefined
  initiatives: InitiativeOption[]
  onChange: (initiativeId: string | null) => void
  onSelected?: () => void
  allowEmpty?: boolean
}

function InitiativePickerContent({
  value, initiatives, onChange, onSelected, allowEmpty = true,
}: InitiativePickerContentProps) {
  return (
    <Command>
      <CommandInput placeholder="Search initiatives..." className="h-9" />
      <CommandList>
        <CommandEmpty>No initiatives found</CommandEmpty>
        <CommandGroup>
          {allowEmpty && (
            <CommandItem
              value="__no_initiative__"
              onSelect={() => { onChange(null); onSelected?.() }}
              className={cn(!value && 'bg-accent')}
            >
              <Target className="mr-2 h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">No initiative</span>
            </CommandItem>
          )}
          {initiatives.map(i => (
            <CommandItem
              key={i.id}
              value={i.name}
              onSelect={() => { onChange(i.id); onSelected?.() }}
              className={cn(value === i.id && 'bg-accent')}
            >
              <span className="mr-2"><InitiativeGlyph icon={i.icon} /></span>
              {i.name}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </Command>
  )
}

// ── Cell trigger ───────────────────────────────────────────

interface InitiativeCellTriggerProps {
  value: string | null | undefined
  initiatives: InitiativeOption[]
  displayName?: string | null
  onChange: (initiativeId: string | null) => void
}

export function InitiativeCellTrigger({ value, initiatives, displayName, onChange }: InitiativeCellTriggerProps) {
  const [open, setOpen] = React.useState(false)
  const i = initiatives.find(x => x.id === value)
  const name = i?.name ?? displayName ?? null

  if (!name) {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            onClick={e => e.stopPropagation()}
            className="w-6 h-5 rounded-full opacity-0 group-hover:opacity-60 hover:opacity-100 hover:bg-muted/40 transition-opacity flex items-center justify-center"
            aria-label="Set initiative"
          >
            <Target className="h-3 w-3 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-0" align="start" onClick={e => e.stopPropagation()}>
          <InitiativePickerContent value={value} initiatives={initiatives} onChange={onChange} onSelected={() => setOpen(false)} />
        </PopoverContent>
      </Popover>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          onClick={e => e.stopPropagation()}
          className={cn(cellTriggerClass, 'max-w-[120px]')}
        >
          {i && <InitiativeGlyph icon={i.icon} />}
          <span className="truncate">{name}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start" onClick={e => e.stopPropagation()}>
        <InitiativePickerContent value={value} initiatives={initiatives} onChange={onChange} onSelected={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  )
}

// ── Panel field ────────────────────────────────────────────

interface InitiativePanelFieldProps {
  value: string | null | undefined
  initiatives: InitiativeOption[]
  onChange: (initiativeId: string | null) => void
  placeholder?: string
  allowEmpty?: boolean
  /**
   * Opens the linked initiative. When provided AND an initiative is set, the row
   * grows a trailing open button — the same shape as the Participants and
   * Attachments rows, where the row body edits and a sibling button acts.
   */
  onOpen?: (initiativeId: string, name: string, event?: React.MouseEvent) => void
  /**
   * Horizontal padding of the row, so this field lines up with the sibling rows
   * of whichever panel mounts it. The panels use two conventions: `px-3`
   * (capture, document) and `px-2` (action, initiative, contact).
   */
  padding?: 'px-2' | 'px-3'
}

export function InitiativePanelField({
  value, initiatives, onChange, placeholder = 'Add to initiative', allowEmpty = true, onOpen,
  padding = 'px-2',
}: InitiativePanelFieldProps) {
  const [open, setOpen] = React.useState(false)
  const i = initiatives.find(x => x.id === value)
  const canOpen = Boolean(onOpen && i)

  const trigger = (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            'flex h-8 min-w-0 items-center gap-2 rounded-md text-sm transition-colors hover:bg-muted/50',
            padding,
            canOpen ? 'flex-1' : 'w-full',
          )}
        >
          {i ? (
            <>
              <InitiativeGlyph icon={i.icon} />
              <span className="min-w-0 truncate">{i.name}</span>
            </>
          ) : (
            <>
              <Target className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="text-muted-foreground">{placeholder}</span>
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <InitiativePickerContent
          value={value}
          initiatives={initiatives}
          onChange={onChange}
          onSelected={() => setOpen(false)}
          allowEmpty={allowEmpty}
        />
      </PopoverContent>
    </Popover>
  )

  if (!canOpen) return trigger

  return (
    <div className="flex items-center">
      {trigger}
      <button
        onClick={(e) => onOpen!(i!.id, i!.name, e)}
        className="mr-1.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-muted/50 hover:text-foreground/80"
        title={`Open ${i!.name}`}
        aria-label={`Open initiative ${i!.name}`}
      >
        <ArrowUpRight className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
