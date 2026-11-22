'use client'

/**
 * A company's own stage, owner and revenue (migration 679), on its page and
 * in the Companies list.
 *
 * Stages are the workspace's (Settings › CRM edits them); every surface reads
 * them through `useCompanyStages`, one fetch shared by the whole page and
 * refreshed when the settings change them (`invalidateCompanyStages`).
 */
import * as React from 'react'
import { CircleDot, DollarSign } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command'
import { MemberPanelField } from '@/components/views/properties/member-picker'
import { usePickerContext } from '@/components/views/hooks/use-picker-context'
import { useCurrentMemberId, useWorkspaces } from '@/app/account/workspace-switcher'
import type { MemberOption } from '@/components/views/properties/types'
import { chipClass, cellTriggerClass } from '@/lib/views/property-options'
import { cn } from '@/lib/utils'
import { coerceRevenue, formatRevenue, NO_STAGE_LABEL, type CompanyStage } from '@/lib/crm/company-stages'

// ── The workspace's stages, one fetch per page ──────────────────────────────

let cached: CompanyStage[] | null = null
let inflight: Promise<CompanyStage[]> | null = null
const listeners = new Set<(s: CompanyStage[]) => void>()

async function fetchStages(): Promise<CompanyStage[]> {
  if (!inflight) {
    inflight = fetch('/api/account/company-stages')
      .then((r) => (r.ok ? r.json() : { stages: [] }))
      .then((j: { stages?: CompanyStage[] }) => {
        cached = Array.isArray(j.stages) ? j.stages : []
        listeners.forEach((l) => l(cached!))
        return cached
      })
      .catch(() => cached ?? [])
      .finally(() => {
        inflight = null
      })
  }
  return inflight
}

/** Read the stages again (after Settings changed them), for every surface on the page. */
export function invalidateCompanyStages(next?: CompanyStage[]) {
  if (next) {
    cached = next
    listeners.forEach((l) => l(next))
    return
  }
  cached = null
  void fetchStages()
}

export function useCompanyStages(): CompanyStage[] | null {
  const [stages, setStages] = React.useState<CompanyStage[] | null>(cached)
  React.useEffect(() => {
    listeners.add(setStages)
    if (!cached) void fetchStages()
    else setStages(cached)
    return () => {
      listeners.delete(setStages)
    }
  }, [])
  return stages
}

// ── The stage picker ────────────────────────────────────────────────────────

function StageList({
  stages,
  value,
  onPick,
}: {
  stages: readonly CompanyStage[]
  value: string | null | undefined
  onPick: (id: string | null) => void
}) {
  return (
    <Command>
      <CommandList>
        <CommandGroup>
          {stages.map((s) => (
            <CommandItem key={s.id} value={s.name} onSelect={() => onPick(s.id)} data-stage-option={s.name}>
              <CircleDot className={cn('mr-2 h-3.5 w-3.5', s.id === value ? 'text-foreground' : 'text-muted-foreground/50')} />
              <span className={cn(s.id === value && 'font-medium')}>{s.name}</span>
            </CommandItem>
          ))}
          <CommandItem value={NO_STAGE_LABEL} onSelect={() => onPick(null)}>
            <CircleDot className={cn('mr-2 h-3.5 w-3.5', !value ? 'text-foreground' : 'text-muted-foreground/30')} />
            <span className="text-muted-foreground">{NO_STAGE_LABEL}</span>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </Command>
  )
}

/** The stage on the company page's properties. */
export function CompanyStageField({ value, onChange }: { value: string | null | undefined; onChange: (id: string | null) => void }) {
  const stages = useCompanyStages()
  const [open, setOpen] = React.useState(false)
  const current = stages?.find((s) => s.id === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" data-company-stage="" className="flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-sm transition-colors hover:bg-muted/50">
          <CircleDot className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className={cn('min-w-0 truncate', !current && 'text-muted-foreground')}>{current?.name ?? NO_STAGE_LABEL}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="start">
        <StageList
          stages={stages ?? []}
          value={value}
          onPick={(id) => {
            setOpen(false)
            if (id !== (value ?? null)) onChange(id)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

/** The stage in a Companies list row: its name, a click picks another. */
export function CompanyStageCell({
  item,
  onPatch,
}: {
  item: Record<string, unknown>
  onPatch?: (id: string, updates: Record<string, unknown>) => void
}) {
  const stages = useCompanyStages()
  const [open, setOpen] = React.useState(false)
  const value = (item.stage_id as string | null | undefined) ?? null
  const name = (item.stage as { name?: string } | null | undefined)?.name ?? stages?.find((s) => s.id === value)?.name
  const chip = name ? <span className={cn(chipClass, 'max-w-[120px] truncate')}>{name}</span> : null
  if (!onPatch) return chip
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" onClick={(e) => e.stopPropagation()} className={cn(cellTriggerClass, !name && 'opacity-0 group-hover:opacity-60')} aria-label="Stage">
          {name ?? <CircleDot className="h-3.5 w-3.5" />}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="start" onClick={(e) => e.stopPropagation()}>
        <StageList
          stages={stages ?? []}
          value={value}
          onPick={(id) => {
            setOpen(false)
            if (id !== value) onPatch(item.id as string, { stage_id: id })
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

/** Revenue in a Companies list row. */
export function CompanyRevenueCell({ item }: { item: Record<string, unknown> }) {
  const text = formatRevenue(item.revenue)
  return text ? <span className={cn(chipClass, 'tabular-nums')}>{text}</span> : null
}

/** A Companies-list cell this file owns, or undefined for one it doesn't. */
export function companyCrmCell(
  property: string,
  item: Record<string, unknown>,
  onPatch?: (id: string, updates: Record<string, unknown>) => void,
): React.ReactNode | undefined {
  if (property === 'stage') return <CompanyStageCell item={item} onPatch={onPatch} />
  if (property === 'revenue') return <CompanyRevenueCell item={item} />
  return undefined
}

// ── Revenue on the company page ─────────────────────────────────────────────

export function CompanyRevenueField({
  value,
  onChange,
}: {
  value: unknown
  onChange: (v: { amount: number; currency: string } | null) => void
}) {
  const shown = formatRevenue(value)
  const [draft, setDraft] = React.useState(shown)
  const [error, setError] = React.useState<string | null>(null)
  React.useEffect(() => setDraft(shown), [shown])
  const commit = () => {
    if (draft.trim() === shown) return
    const fallback = (value as { currency?: string } | null)?.currency ?? 'USD'
    const r = coerceRevenue(draft, fallback)
    if (!r.ok) {
      setError(r.error)
      return
    }
    setError(null)
    onChange(r.value)
  }
  return (
    <div className="flex flex-col">
      <div className="flex h-8 items-center gap-2 px-2">
        <DollarSign className="h-4 w-4 shrink-0 text-muted-foreground" />
        <input
          data-company-revenue=""
          className="min-w-0 flex-1 bg-transparent text-sm tabular-nums outline-none placeholder:text-muted-foreground"
          value={draft}
          placeholder="Revenue"
          aria-label="Revenue"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') {
              setDraft(shown)
              setError(null)
            }
          }}
        />
      </div>
      {error && <p className="px-8 text-[11px] text-destructive">{error}</p>}
    </div>
  )
}

/** Stage, owner and revenue: the three rows the company page's properties lead with. */
export function CompanyCrmFields({
  company,
  members,
  currentMemberId,
  onPatch,
}: {
  company: { stage_id?: string | null; owner_member_id?: string | null; revenue?: unknown }
  members: MemberOption[]
  currentMemberId?: string | null
  onPatch: (updates: Record<string, unknown>) => void
}) {
  return (
    <div data-company-crm-fields="" className="space-y-0.5">
      <CompanyStageField value={company.stage_id} onChange={(id) => onPatch({ stage_id: id })} />
      <MemberPanelField
        value={company.owner_member_id ?? null}
        members={members.filter((m) => m.kind !== 'ai')}
        onChange={(id) => onPatch({ owner_member_id: id })}
        placeholder="Owner"
        emptyLabel="No owner"
        currentMemberId={currentMemberId}
      />
      <CompanyRevenueField value={company.revenue ?? null} onChange={(v) => onPatch({ revenue: v })} />
    </div>
  )
}

/** CompanyCrmFields with the workspace's members read for it (the company page). */
export function CompanyCrmPanelFields({
  company,
  onPatch,
}: {
  company: { stage_id?: string | null; owner_member_id?: string | null; revenue?: unknown }
  onPatch: (updates: Record<string, unknown>) => void
}) {
  const { currentId } = useWorkspaces()
  const currentMemberId = useCurrentMemberId()
  const ctx = usePickerContext('company', NO_TEAMS, currentId ?? null)
  return <CompanyCrmFields company={company} members={ctx.members} currentMemberId={currentMemberId} onPatch={onPatch} />
}
const NO_TEAMS: string[] = []
