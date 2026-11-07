'use client'

import * as React from 'react'
import { ArrowUpRight, FolderOpen } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command'
import { ProjectIcon } from '@/components/ui/emoji-icon-picker'
import { cn } from '@/lib/utils'
import { cellTriggerClass } from '@/lib/views/property-options'
import type { ProjectOption } from './types'

// ── Shared content ─────────────────────────────────────────

interface ProjectPickerContentProps {
  value: string | null | undefined
  projects: ProjectOption[]
  onChange: (projectId: string | null) => void
  onSelected?: () => void
  allowEmpty?: boolean
}

function ProjectPickerContent({
  value, projects, onChange, onSelected, allowEmpty = true,
}: ProjectPickerContentProps) {
  return (
    <Command>
      <CommandInput placeholder="Search projects..." className="h-9" />
      <CommandList>
        <CommandEmpty>No projects found</CommandEmpty>
        <CommandGroup>
          {allowEmpty && (
            <CommandItem
              value="__no_project__"
              onSelect={() => { onChange(null); onSelected?.() }}
              className={cn(!value && 'bg-accent')}
            >
              <FolderOpen className="mr-2 h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">No project</span>
            </CommandItem>
          )}
          {projects.map(p => (
            <CommandItem
              key={p.id}
              value={p.name}
              onSelect={() => { onChange(p.id); onSelected?.() }}
              className={cn(value === p.id && 'bg-accent')}
            >
              <span className="mr-2"><ProjectIcon icon={p.icon} size="sm" /></span>
              {p.name}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </Command>
  )
}

// ── Cell trigger ───────────────────────────────────────────

interface ProjectCellTriggerProps {
  value: string | null | undefined
  projects: ProjectOption[]
  displayName?: string | null
  onChange: (projectId: string | null) => void
}

export function ProjectCellTrigger({ value, projects, displayName, onChange }: ProjectCellTriggerProps) {
  const [open, setOpen] = React.useState(false)
  const p = projects.find(x => x.id === value)
  const name = p?.name ?? displayName ?? null

  if (!name) {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            onClick={e => e.stopPropagation()}
            className="w-6 h-5 rounded-full opacity-0 group-hover:opacity-60 hover:opacity-100 hover:bg-muted/40 transition-opacity flex items-center justify-center"
            aria-label="Set project"
          >
            <FolderOpen className="h-3 w-3 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-0" align="start" onClick={e => e.stopPropagation()}>
          <ProjectPickerContent value={value} projects={projects} onChange={onChange} onSelected={() => setOpen(false)} />
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
          {p && <span className="shrink-0"><ProjectIcon icon={p.icon} size="sm" /></span>}
          <span className="truncate">{name}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start" onClick={e => e.stopPropagation()}>
        <ProjectPickerContent value={value} projects={projects} onChange={onChange} onSelected={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  )
}

// ── Panel field ────────────────────────────────────────────

interface ProjectPanelFieldProps {
  value: string | null | undefined
  projects: ProjectOption[]
  onChange: (projectId: string | null) => void
  placeholder?: string
  allowEmpty?: boolean
  /**
   * Opens the linked project. When provided AND a project is set, the row grows
   * a trailing open button — the same shape as the Participants and Attachments
   * rows, where the row body edits and a sibling button acts.
   */
  onOpen?: (projectId: string, name: string, event?: React.MouseEvent) => void
  /**
   * Horizontal padding of the row, so this field lines up with the sibling rows
   * of whichever panel mounts it. The panels use two conventions: `px-3`
   * (capture, document) and `px-2` (action, initiative, contact).
   */
  padding?: 'px-2' | 'px-3'
}

export function ProjectPanelField({
  value, projects, onChange, placeholder = 'Add to project', allowEmpty = true, onOpen,
  padding = 'px-2',
}: ProjectPanelFieldProps) {
  const [open, setOpen] = React.useState(false)
  const p = projects.find(x => x.id === value)
  const canOpen = Boolean(onOpen && p)

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
          {p ? (
            <>
              <span className="shrink-0"><ProjectIcon icon={p.icon} size="sm" /></span>
              <span className="min-w-0 truncate">{p.name}</span>
            </>
          ) : (
            <>
              <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="text-muted-foreground">{placeholder}</span>
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <ProjectPickerContent
          value={value}
          projects={projects}
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
        onClick={(e) => onOpen!(p!.id, p!.name, e)}
        className="mr-1.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-muted/50 hover:text-foreground/80"
        title={`Open ${p!.name}`}
        aria-label={`Open project ${p!.name}`}
      >
        <ArrowUpRight className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
