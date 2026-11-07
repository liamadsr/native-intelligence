'use client'

import * as React from 'react'
import { User, Boxes } from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command'
import { cn } from '@/lib/utils'
import { cellTriggerClass } from '@/lib/views/property-options'
import type { MemberOption } from './types'

function getInitials(name: string): string {
  return name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)
}

// ── Shared content ─────────────────────────────────────────

interface MemberPickerContentProps {
  value: string | null | undefined
  members: MemberOption[]
  /** Receives the selected id plus its kind ('member' default, 'ai' for agents). */
  onChange: (memberId: string | null, kind?: 'member' | 'ai') => void
  onSelected?: () => void
  /** Labels for the empty option — e.g. "Unassigned", "No owner" */
  emptyLabel?: string
  /** Current user's member ID — shows "(Me)" badge next to their name */
  currentMemberId?: string | null
  /** The agent working the row as its delegate (decision 9): marked selected beside the person. */
  delegateId?: string | null
}

function MemberPickerContent({
  value, members, onChange, onSelected, emptyLabel = 'Unassigned', currentMemberId, delegateId,
}: MemberPickerContentProps) {
  const humans = members.filter(m => m.kind !== 'ai')
  const agents = members.filter(m => m.kind === 'ai')
  return (
    <Command>
      <CommandInput placeholder="Search people..." className="h-9" />
      <CommandList>
        <CommandEmpty>No people found</CommandEmpty>
        <CommandGroup>
          <CommandItem
            value={emptyLabel}
            onSelect={() => { onChange(null); onSelected?.() }}
            className={cn(!value && 'bg-accent')}
          >
            <User className="mr-2 h-4 w-4 text-muted-foreground" />
            <span className="text-muted-foreground">{emptyLabel}</span>
          </CommandItem>
          {humans.map(m => (
            <CommandItem
              key={m.id}
              value={m.display_name}
              onSelect={() => { onChange(m.id, 'member'); onSelected?.() }}
              className={cn(value === m.id && 'bg-accent')}
            >
              <Avatar className="mr-2 h-5 w-5">
                {m.avatar_url && <AvatarImage src={m.avatar_url} />}
                <AvatarFallback className="text-[9px]">{getInitials(m.display_name)}</AvatarFallback>
              </Avatar>
              {m.display_name}
              {currentMemberId === m.id && (
                <span className="ml-1 text-xs text-muted-foreground">(Me)</span>
              )}
            </CommandItem>
          ))}
        </CommandGroup>
        {agents.length > 0 && (
          <CommandGroup heading="Agents">
            {agents.map(m => (
              <CommandItem
                key={m.id}
                value={`agent-${m.display_name}`}
                onSelect={() => { onChange(m.id, 'ai'); onSelected?.() }}
                className={cn((value === m.id || delegateId === m.id) && 'bg-accent')}
              >
                <Avatar className="mr-2 h-5 w-5">
                  {m.avatar_url && <AvatarImage src={m.avatar_url} />}
                  <AvatarFallback className="text-[9px] bg-primary/10 text-primary">
                    {getInitials(m.display_name)}
                  </AvatarFallback>
                </Avatar>
                <span className="truncate">{m.display_name}</span>
                <Boxes className="ml-auto h-3 w-3 text-primary" />
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </Command>
  )
}

// ── Cell trigger ───────────────────────────────────────────

interface MemberCellTriggerProps {
  value: string | null | undefined
  members: MemberOption[]
  /** Fallback name/avatar when members hasn't loaded yet but the row already has this info. */
  displayName?: string | null
  displayAvatar?: string | null
  onChange: (memberId: string | null, kind?: 'member' | 'ai') => void
  emptyLabel?: string
  currentMemberId?: string | null
  /**
   * The agent working the row as its delegate (decision 9, actions only): a
   * small chip on the person's avatar, and marked selected in the picker. When
   * no person holds the row, the agent's avatar stands alone.
   */
  delegate?: { id: string; name: string | null; avatar: string | null } | null
}

export function MemberCellTrigger({
  value, members, displayName, displayAvatar, onChange, emptyLabel, currentMemberId, delegate,
}: MemberCellTriggerProps) {
  const [open, setOpen] = React.useState(false)
  const m = members.find(x => x.id === value)
  const person = m?.display_name ?? displayName ?? null
  const agent = delegate ? (members.find(x => x.id === delegate.id) ?? null) : null
  const agentName = agent?.display_name ?? delegate?.name ?? (delegate ? 'Agent' : null)
  const agentAvatar = agent?.avatar_url ?? delegate?.avatar ?? null
  // The person leads; with nobody responsible the agent's avatar stands alone.
  const name = person ?? agentName
  const avatar = person ? (m?.avatar_url ?? displayAvatar ?? null) : agentAvatar
  const isAgent = person ? m?.kind === 'ai' : !!agentName
  const chip = person && agentName ? { name: agentName, avatar: agentAvatar } : null
  const label = name
    ? chip
      ? `Assigned to ${person}, delegated to ${chip.name}`
      : `Assigned to ${name}`
    : emptyLabel ?? 'Unassigned'

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          onClick={e => e.stopPropagation()}
          className={cn(
            'relative inline-flex items-center justify-center rounded-full h-5 w-5 transition-colors',
            !name && 'opacity-0 group-hover:opacity-60 hover:opacity-100 hover:bg-muted/40',
          )}
          aria-label={label}
          title={chip ? label : undefined}
        >
          {name ? (
            <Avatar className="h-5 w-5 border border-border/60">
              {avatar && <AvatarImage src={avatar} />}
              <AvatarFallback className={cn('text-[9px]', isAgent ? 'bg-primary/10 text-primary' : 'bg-muted/40')}>
                {getInitials(name)}
              </AvatarFallback>
            </Avatar>
          ) : (
            <User className="h-3.5 w-3.5 text-muted-foreground" />
          )}
          {chip && (
            <span data-delegate-chip="" className="absolute -bottom-1 -right-1 rounded-full ring-1 ring-background">
              <Avatar className="h-3 w-3">
                {chip.avatar && <AvatarImage src={chip.avatar} />}
                <AvatarFallback className="bg-primary/15 text-primary">
                  <Boxes className="h-2 w-2" />
                </AvatarFallback>
              </Avatar>
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start" onClick={e => e.stopPropagation()}>
        <MemberPickerContent
          value={value}
          members={members}
          onChange={onChange}
          onSelected={() => setOpen(false)}
          emptyLabel={emptyLabel}
          currentMemberId={currentMemberId}
          delegateId={delegate?.id ?? null}
        />
      </PopoverContent>
    </Popover>
  )
}

// ── Panel field ────────────────────────────────────────────

interface MemberPanelFieldProps {
  value: string | null | undefined
  members: MemberOption[]
  onChange: (memberId: string | null, kind?: 'member' | 'ai') => void
  /** Label when nothing is set — e.g. "Assignee", "Lead", "Owner" */
  placeholder?: string
  emptyLabel?: string
  currentMemberId?: string | null
}

export function MemberPanelField({
  value, members, onChange, placeholder = 'Assignee', emptyLabel = 'Unassigned', currentMemberId,
}: MemberPanelFieldProps) {
  const [open, setOpen] = React.useState(false)
  const m = members.find(x => x.id === value)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-sm transition-colors hover:bg-muted/50">
          {m ? (
            <>
              <Avatar className="h-4 w-4">
                {m.avatar_url && <AvatarImage src={m.avatar_url} />}
                <AvatarFallback className="text-[8px]">{getInitials(m.display_name)}</AvatarFallback>
              </Avatar>
              <span className="min-w-0 truncate">{m.display_name}</span>
            </>
          ) : (
            <>
              <User className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="text-muted-foreground">{placeholder}</span>
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <MemberPickerContent
          value={value}
          members={members}
          onChange={onChange}
          onSelected={() => setOpen(false)}
          emptyLabel={emptyLabel}
          currentMemberId={currentMemberId}
        />
      </PopoverContent>
    </Popover>
  )
}
