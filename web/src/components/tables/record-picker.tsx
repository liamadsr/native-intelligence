'use client'

/**
 * Pick the company or contact a row of a record pipeline points to
 * (migration 679): "Add company" / "Add contact" on its board and grid.
 * Searches the same menu search a relation cell does; records already in the
 * pipeline are marked and can't be picked again (the database refuses a
 * second row for one record too).
 */
import * as React from 'react'
import { Building2, Plus, User } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { findTargets } from '@/components/crm/custom-fields-group'
import type { PipelineRecordKind } from '@/lib/tables/types'

export const addRecordLabel = (kind: PipelineRecordKind) => (kind === 'company' ? 'Add company' : 'Add contact')

export function RecordPicker({
  kind,
  taken,
  onPick,
  className,
  label,
}: {
  kind: PipelineRecordKind
  /** Record ids already in the pipeline. */
  taken: ReadonlySet<string>
  onPick: (record: { id: string; title: string }) => void
  className?: string
  label?: string
}) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const [results, setResults] = React.useState<Array<{ id: string; title: string }>>([])
  const [loading, setLoading] = React.useState(false)

  React.useEffect(() => {
    if (!open) return
    let current = true
    setLoading(true)
    const t = setTimeout(() => {
      void findTargets({ config: { target: { kind } } }, query)
        .then((r) => current && setResults(r))
        .finally(() => current && setLoading(false))
    }, 150)
    return () => {
      current = false
      clearTimeout(t)
    }
  }, [open, query, kind])

  const Icon = kind === 'company' ? Building2 : User
  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQuery('') }}>
      <PopoverTrigger asChild>
        <button type="button" data-add-record={kind} className={className}>
          <Plus className="h-3.5 w-3.5" />
          {label ?? addRecordLabel(kind)}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput value={query} onValueChange={setQuery} placeholder={kind === 'company' ? 'Find a company…' : 'Find a contact…'} />
          <CommandList>
            <CommandEmpty>{loading ? 'Searching…' : 'Nothing found'}</CommandEmpty>
            <CommandGroup>
              {results.map((r) => {
                const already = taken.has(r.id)
                return (
                  <CommandItem
                    key={r.id}
                    value={r.id}
                    disabled={already}
                    onSelect={() => {
                      if (already) return
                      setOpen(false)
                      setQuery('')
                      onPick(r)
                    }}
                  >
                    <Icon className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{r.title}</span>
                    {already && <span className="ml-2 text-[10px] text-muted-foreground">In pipeline</span>}
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** The record ids a pipeline's rows already point to. */
export function takenRecords(rows: ReadonlyArray<{ custom_fields?: Record<string, unknown> | null; values?: Record<string, unknown> }>, key: string): Set<string> {
  const out = new Set<string>()
  for (const r of rows) {
    const v = (r.custom_fields ?? r.values ?? {})[key]
    if (Array.isArray(v)) for (const id of v) if (typeof id === 'string') out.add(id)
  }
  return out
}
