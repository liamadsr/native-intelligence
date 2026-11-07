'use client'

import * as React from 'react'
import { Building2 } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command'
import { cn } from '@/lib/utils'
import { cellTriggerClass } from '@/lib/views/property-options'
import type { CompanyOption } from './types'

// ── Shared content ─────────────────────────────────────────

interface CompanyPickerContentProps {
  value: string | null | undefined
  companies: CompanyOption[]
  onChange: (companyId: string | null) => void
  onSelected?: () => void
  allowEmpty?: boolean
}

function CompanyPickerContent({
  value, companies, onChange, onSelected, allowEmpty = true,
}: CompanyPickerContentProps) {
  return (
    <Command>
      <CommandInput placeholder="Search companies..." className="h-9" />
      <CommandList>
        <CommandEmpty>No companies found</CommandEmpty>
        <CommandGroup>
          {allowEmpty && (
            <CommandItem
              value="__no_company__"
              onSelect={() => { onChange(null); onSelected?.() }}
              className={cn(!value && 'bg-accent')}
            >
              <Building2 className="mr-2 h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">No company</span>
            </CommandItem>
          )}
          {companies.map(c => (
            <CommandItem
              key={c.id}
              value={c.name}
              onSelect={() => { onChange(c.id); onSelected?.() }}
              className={cn(value === c.id && 'bg-accent')}
            >
              {c.logo_url ? (
                <img src={c.logo_url} alt="" className="mr-2 h-4 w-4 rounded" />
              ) : (
                <Building2 className="mr-2 h-4 w-4 text-muted-foreground" />
              )}
              {c.name}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </Command>
  )
}

// ── Cell trigger ───────────────────────────────────────────

interface CompanyCellTriggerProps {
  value: string | null | undefined
  companies: CompanyOption[]
  displayName?: string | null
  displayLogo?: string | null
  onChange: (companyId: string | null) => void
}

export function CompanyCellTrigger({
  value, companies, displayName, displayLogo, onChange,
}: CompanyCellTriggerProps) {
  const [open, setOpen] = React.useState(false)
  const c = companies.find(x => x.id === value)
  const name = c?.name ?? displayName ?? null
  const logo = c?.logo_url ?? displayLogo ?? null

  if (!name) {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            onClick={e => e.stopPropagation()}
            className="w-6 h-5 rounded-full opacity-0 group-hover:opacity-60 hover:opacity-100 hover:bg-muted/40 transition-opacity flex items-center justify-center"
            aria-label="Set company"
          >
            <Building2 className="h-3 w-3 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-0" align="start" onClick={e => e.stopPropagation()}>
          <CompanyPickerContent value={value} companies={companies} onChange={onChange} onSelected={() => setOpen(false)} />
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
          {logo ? <img src={logo} alt="" className="h-3 w-3 rounded" /> : <Building2 className="h-3 w-3 shrink-0" />}
          <span className="truncate">{name}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start" onClick={e => e.stopPropagation()}>
        <CompanyPickerContent value={value} companies={companies} onChange={onChange} onSelected={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  )
}

// ── Panel field ────────────────────────────────────────────

interface CompanyPanelFieldProps {
  value: string | null | undefined
  companies: CompanyOption[]
  onChange: (companyId: string | null) => void
  placeholder?: string
  allowEmpty?: boolean
}

export function CompanyPanelField({
  value, companies, onChange, placeholder = 'Set company', allowEmpty = true,
}: CompanyPanelFieldProps) {
  const [open, setOpen] = React.useState(false)
  const c = companies.find(x => x.id === value)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-sm transition-colors hover:bg-muted/50">
          {c ? (
            <>
              {c.logo_url ? (
                <img src={c.logo_url} alt="" className="h-4 w-4 rounded" />
              ) : (
                <Building2 className="h-4 w-4 shrink-0" />
              )}
              <span className="min-w-0 truncate">{c.name}</span>
            </>
          ) : (
            <>
              <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="text-muted-foreground">{placeholder}</span>
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <CompanyPickerContent
          value={value}
          companies={companies}
          onChange={onChange}
          onSelected={() => setOpen(false)}
          allowEmpty={allowEmpty}
        />
      </PopoverContent>
    </Popover>
  )
}
