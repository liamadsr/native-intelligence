'use client'

/**
 * Tables (phase 1, migration 520): the workspace's own databases. The list is
 * a views list, as Docs is (docs/plans/views-everywhere.md): saved views and
 * their tabs, the filters (owner, visibility, kind, archived, dates), the
 * display settings, search, the shared rows (the table glyph or a pipeline's
 * record glyph, a private eye, Pipeline and Default, owner, when it changed)
 * and J/K/Enter. A row's right-click is the one entity actions menu (Copy ID,
 * Rename, Make a task). New table opens the Create composer (it starts with a
 * Name column and three blank rows); one table open is its editable grid
 * (phase 3, src/components/tables/table-detail.tsx).
 *
 * With `pipelines` (Tables, phase 7) it is the Deals page: the same list,
 * pinned to the pipelines (a pipeline is a table whose rows are deals), and New
 * pipeline makes one with its stages and system columns (/api/account/pipelines).
 */
import { useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { TableDetail } from '@/components/tables/table-detail'
import { CardHeaderSlot, useCardHeaderSlots } from '@/components/chat-cards/card-header-slot'
import { CARD_HEADER_PILL_BUTTON } from '@/components/chat-cards/card-header-button'
import { UnifiedViewLayout } from '@/components/views/unified-view-layout'
import { cn } from '@/lib/utils'
import type { ViewFilter } from '@/lib/views/types'
import type { DataTable } from '@/lib/tables/types'
import { openCreateDialog } from '@/lib/create/open-create'
import { ViewHeader } from './view-header'

const NEW_TABLE_LABEL = 'New table'
const NEW_PIPELINE_LABEL = 'New pipeline'

/** The Deals page's list: the pipelines only, a filter the person can't take off. */
const PIPELINES_ONLY: ViewFilter[] = [{ id: 'pipelines-only', field: 'table_kind', operator: 'is', value: 'pipeline' }]

async function readJson<T>(res: Response): Promise<T> {
  const json = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(json.error || 'Something went wrong')
  return json
}

/**
 * A chat card's hold on the page (pages in the chat): which table is open,
 * in which layout, with which row open, and how opening one moves the card.
 */
export interface TablesCardState {
  openId: string | null
  rowId?: string | null
  layout?: string
  onOpen: (id: string | null, name?: string) => void
}

export function TablesView({ card, pipelines = false }: { card?: TablesCardState; pipelines?: boolean } = {}) {
  const [ownOpenId, setOwnOpenId] = useState<string | null>(null)
  const openId = card ? card.openId : ownOpenId
  const setOpenId = (id: string | null, name?: string) => {
    if (card) card.onOpen(id, name)
    else setOwnOpenId(id)
  }
  const [creating, setCreating] = useState(false)
  const inCard = useCardHeaderSlots() !== null
  const scopeFilters = useMemo(() => (pipelines ? PIPELINES_ONLY : undefined), [pipelines])

  // New table opens the one Create composer on Table, its starters a choice
  // in it (docs/plans/create-everything.md); the list reads again on what is
  // made there. New pipeline keeps its own form.
  const startCreate = () => (pipelines ? setCreating(true) : openCreateDialog({ type: 'table' }))

  if (openId) {
    return (
      <TableDetail
        key={openId}
        tableId={openId}
        initialLayout={card?.layout}
        initialRowId={card?.rowId ?? null}
        onBack={() => setOpenId(null)}
      />
    )
  }

  return (
    <div className="flex h-full flex-col">
      {inCard ? (
        // In a card its header names the page (Tables, or Deals for the
        // pipelines), so the page draws no title of its own; New table or New
        // pipeline goes there (Liam, 11-22: every control in the header).
        <CardHeaderSlot side="right">
          <button type="button" onClick={startCreate} data-new-table="" className={CARD_HEADER_PILL_BUTTON}>
            <Plus className="size-3.5" strokeWidth={1.75} aria-hidden />
            {pipelines ? NEW_PIPELINE_LABEL : NEW_TABLE_LABEL}
          </button>
        </CardHeaderSlot>
      ) : (
        <ViewHeader
          title={pipelines ? 'Pipelines' : 'Tables'}
          actions={
            <Button size="sm" onClick={startCreate}>
              <Plus className="h-3.5 w-3.5" />
              {pipelines ? NEW_PIPELINE_LABEL : NEW_TABLE_LABEL}
            </Button>
          }
        />
      )}
      {creating && pipelines && (
        <div className={cn(inCard ? 'pl-[18px] pr-5' : 'px-5')}>
          <NewPipelineForm
            onCancel={() => setCreating(false)}
            onCreated={(table) => {
              setCreating(false)
              setOpenId(table.id, table.name)
            }}
          />
        </div>
      )}
      <div className="min-h-0 flex-1" data-table-list="">
        <UnifiedViewLayout entityType="data_table" scopeFilters={scopeFilters} onItemSelect={(id, title) => setOpenId(id, title)} />
      </div>
    </div>
  )
}

/** What a new pipeline tracks (679): deals as before, or companies or contacts (each row points to one). */
const PIPELINE_KINDS = [
  { value: 'deal', label: 'Deals' },
  { value: 'company', label: 'Companies' },
  { value: 'contact', label: 'Contacts' },
] as const
type PipelineKindChoice = (typeof PIPELINE_KINDS)[number]['value']

/**
 * A new pipeline: what it tracks and a name. A deal pipeline starts with
 * Lead, Qualified, Proposal, Won, Lost; a companies or contacts pipeline with
 * its kind's stages (Edit stages changes them).
 */
function NewPipelineForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: (table: DataTable) => void }) {
  const [name, setName] = useState('')
  const [kind, setKind] = useState<PipelineKindChoice>('deal')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || saving) return
    setSaving(true)
    setError(null)
    try {
      const made = await readJson<{ id: string }>(
        await fetch('/api/account/pipelines', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, ...(kind === 'deal' ? {} : { record_kind: kind }) }) }),
      )
      const json = await readJson<{ table: DataTable }>(await fetch(`/api/account/tables/${made.id}`))
      onCreated(json.table)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not make the pipeline')
      setSaving(false)
    }
  }
  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2 py-3" data-new-pipeline="">
      <div role="radiogroup" aria-label="What the pipeline tracks" className="flex h-8 items-center rounded-md border border-border p-0.5 text-xs">
        {PIPELINE_KINDS.map((k) => (
          <button
            key={k.value}
            type="button"
            role="radio"
            aria-checked={kind === k.value}
            data-pipeline-kind={k.value}
            onClick={() => setKind(k.value)}
            className={kind === k.value ? 'h-full rounded px-2.5 font-medium bg-foreground text-background' : 'h-full rounded px-2.5 text-muted-foreground hover:text-foreground'}
          >
            {k.label}
          </button>
        ))}
      </div>
      <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Name the pipeline" maxLength={200} className="h-8 max-w-xs" aria-label="Pipeline name" />
      <Button size="sm" type="submit" disabled={!name.trim() || saving}>
        {saving ? 'Making…' : 'Make pipeline'}
      </Button>
      <Button size="sm" type="button" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
      {error && <p className="w-full text-xs text-destructive">{error}</p>}
    </form>
  )
}

