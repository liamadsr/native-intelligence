'use client'

/**
 * Tables (phase 1, migration 520): the workspace's own databases. The list of
 * tables, a way to make one (it starts with a Name column and three blank
 * rows), and one table open as its editable grid (phase 3,
 * src/components/tables/table-detail.tsx). It owns its fetches against
 * /api/account/tables, like the Campaigns page.
 *
 * With `pipelines` (Tables, phase 7) it is the Deals page: the pipelines
 * only (a pipeline is a table whose rows are deals), and New pipeline makes
 * one with its stages and system columns (/api/account/pipelines).
 */
import { EntityIcon } from '@/components/entities/entity-icon'
import { useCallback, useEffect, useRef, useState } from 'react'
import { HandCoins, Lock, Plus, Table2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { TableDetail } from '@/components/tables/table-detail'
import { CardHeaderSlot, useCardHeaderSlots } from '@/components/chat-cards/card-header-slot'
import { CARD_HEADER_PILL_BUTTON } from '@/components/chat-cards/card-header-button'
import { relativeTime } from '@/lib/work/presentation'
import { cn } from '@/lib/utils'
import type { DataTable } from '@/lib/tables/types'
import { openCreateDialog } from '@/lib/create/open-create'
import { ViewHeader } from './view-header'

const NEW_TABLE_LABEL = 'New table'
const NEW_PIPELINE_LABEL = 'New pipeline'

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

export function TablesView({ onCount, card, pipelines = false }: { onCount?: (count: number) => void; card?: TablesCardState; pipelines?: boolean } = {}) {
  const [tables, setTables] = useState<DataTable[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ownOpenId, setOwnOpenId] = useState<string | null>(null)
  const openId = card ? card.openId : ownOpenId
  const setOpenId = (id: string | null) => {
    if (card) card.onOpen(id, tables?.find((t) => t.id === id)?.name)
    else setOwnOpenId(id)
  }
  const [creating, setCreating] = useState(false)
  const inCard = useCardHeaderSlots() !== null
  // How many there are, for a chat card's header (pages in the chat).
  const onCountRef = useRef(onCount)
  onCountRef.current = onCount
  useEffect(() => {
    if (tables) onCountRef.current?.(tables.length)
  }, [tables])

  const load = useCallback(async () => {
    try {
      // The Deals page makes the default pipeline on its first read.
      if (pipelines) await fetch('/api/account/pipelines').catch(() => null)
      const json = await readJson<{ tables: DataTable[] }>(await fetch('/api/account/tables'))
      const all = Array.isArray(json.tables) ? json.tables : []
      setTables(pipelines ? all.filter((t) => t.kind === 'pipeline') : all)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : pipelines ? 'Could not load pipelines' : 'Could not load tables')
      setTables([])
    }
  }, [pipelines])

  useEffect(() => {
    void load()
  }, [load])

  // A table made in the Create composer (its New table, C then T): the list
  // takes it in (the composer opens it on its own).
  useEffect(() => {
    const onCreated = (e: Event) => {
      if ((e as CustomEvent<{ entityType?: string }>).detail?.entityType === 'table') void load()
    }
    window.addEventListener('ni:entity-created', onCreated)
    return () => window.removeEventListener('ni:entity-created', onCreated)
  }, [load])

  // New table opens the one Create composer on Table, its starters a choice
  // in it (docs/plans/create-everything.md); New pipeline keeps its own form.
  const startCreate = () => (pipelines ? setCreating(true) : openCreateDialog({ type: 'table' }))

  if (openId) {
    return (
      <TableDetail
        key={openId}
        tableId={openId}
        initialLayout={card?.layout}
        initialRowId={card?.rowId ?? null}
        onBack={() => {
          setOpenId(null)
          void load()
        }}
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
      {/* In a card, a row's icon and name stand under the header's icon and
          title, as on Spreadsheets. */}
      <div className={cn('min-h-0 flex-1 overflow-y-auto pb-6', inCard ? 'pl-[18px] pr-5 pt-2' : 'px-5')}>
        {creating && pipelines && (
          <NewPipelineForm
            onCancel={() => setCreating(false)}
            onCreated={(table) => {
              setCreating(false)
              setTables((prev) => [...(prev ?? []), table])
              setOpenId(table.id)
            }}
          />
        )}
        {tables === null ? (
          <p className="py-10 text-center text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="py-10 text-center text-sm text-destructive">{error}</p>
        ) : tables.length === 0 ? (
          !creating && <EmptyState pipelines={pipelines} onCreate={startCreate} />
        ) : (
          <ul className="divide-y divide-border">
            {tables.map((t) => (
              <li key={t.id}>
                <button type="button" onClick={() => setOpenId(t.id)} className={cn('flex w-full items-center py-2.5 text-left hover:bg-muted/40', inCard ? 'gap-2' : 'gap-3')}>
                  {t.kind === 'pipeline' ? (
                    // A pipeline of companies or contacts (679) wears its record's icon.
                    <span role="img" aria-label={t.record_kind === 'company' ? 'Pipeline of companies' : t.record_kind === 'contact' ? 'Pipeline of contacts' : 'Pipeline'} className="flex shrink-0">
                      <EntityIcon kind={t.record_kind ?? 'deal'} size={inCard ? 'sm' : 'md'} />
                    </span>
                  ) : (
                    <EntityIcon kind="data_table" size={inCard ? 'sm' : 'md'} />
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{t.name}</span>
                  {t.is_default && <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">Default</span>}
                  {t.visibility === 'private' && <Lock className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="Private" />}
                  <span className="shrink-0 text-xs text-muted-foreground">{relativeTime(t.updated_at)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function EmptyState({ onCreate, pipelines }: { onCreate: () => void; pipelines: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
      {pipelines ? <HandCoins className="h-7 w-7 text-muted-foreground/60" /> : <Table2 className="h-7 w-7 text-muted-foreground/60" />}
      <div>
        <p className="text-sm font-medium text-foreground">{pipelines ? 'No pipelines yet' : 'No tables yet'}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {pipelines ? 'A pipeline follows deals through their stages, from lead to won.' : 'A table keeps a list of anything: orders, hires, suppliers, ideas.'}
        </p>
      </div>
      <Button size="sm" variant="outline" onClick={onCreate}>
        <Plus className="h-3.5 w-3.5" />
        {pipelines ? NEW_PIPELINE_LABEL : NEW_TABLE_LABEL}
      </Button>
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

