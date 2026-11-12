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
import { useCallback, useEffect, useRef, useState } from 'react'
import { HandCoins, Lock, Plus, Table2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { TableDetail } from '@/components/tables/table-detail'
import { relativeTime } from '@/lib/work/presentation'
import type { DataTable } from '@/lib/tables/types'
import { ViewHeader } from './view-header'

const NEW_TABLE_LABEL = 'New table'

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
  const noun = pipelines ? 'pipeline' : 'table'
  const [tables, setTables] = useState<DataTable[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ownOpenId, setOwnOpenId] = useState<string | null>(null)
  const openId = card ? card.openId : ownOpenId
  const setOpenId = (id: string | null) => {
    if (card) card.onOpen(id, tables?.find((t) => t.id === id)?.name)
    else setOwnOpenId(id)
  }
  const [creating, setCreating] = useState(false)
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
      setError(err instanceof Error ? err.message : `Could not load ${noun}s`)
      setTables([])
    }
  }, [pipelines, noun])

  useEffect(() => {
    void load()
  }, [load])

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
      <ViewHeader
        title={pipelines ? 'Pipelines' : 'Tables'}
        actions={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="h-3.5 w-3.5" />
            {pipelines ? NEW_PIPELINE_LABEL : NEW_TABLE_LABEL}
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {creating && (
          <NewTableForm
            pipelines={pipelines}
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
          !creating && <EmptyState pipelines={pipelines} onCreate={() => setCreating(true)} />
        ) : (
          <ul className="divide-y divide-border">
            {tables.map((t) => (
              <li key={t.id}>
                <button type="button" onClick={() => setOpenId(t.id)} className="flex w-full items-center gap-3 py-2.5 text-left hover:bg-muted/40">
                  {t.kind === 'pipeline' ? (
                    <HandCoins className="h-4 w-4 shrink-0 text-muted-foreground" aria-label="Pipeline" />
                  ) : (
                    <Table2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
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

const NEW_PIPELINE_LABEL = 'New pipeline'

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

function NewTableForm({ onCancel, onCreated, pipelines = false }: { onCancel: () => void; onCreated: (table: DataTable) => void; pipelines?: boolean }) {
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || saving) return
    setSaving(true)
    setError(null)
    try {
      if (pipelines) {
        // A new pipeline starts with Lead, Qualified, Proposal, Won, Lost: Edit stages changes them.
        const made = await readJson<{ id: string }>(
          await fetch('/api/account/pipelines', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }),
        )
        const json = await readJson<{ table: DataTable }>(await fetch(`/api/account/tables/${made.id}`))
        onCreated(json.table)
        return
      }
      const json = await readJson<{ table: DataTable }>(
        await fetch('/api/account/tables', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }),
      )
      onCreated(json.table)
    } catch (err) {
      setError(err instanceof Error ? err.message : pipelines ? 'Could not make the pipeline' : 'Could not make the table')
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2 py-3">
      <Input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={pipelines ? 'Name the pipeline' : 'Name the table'}
        maxLength={200}
        className="h-8 max-w-xs"
        aria-label={pipelines ? 'Pipeline name' : 'Table name'}
      />
      <Button size="sm" type="submit" disabled={!name.trim() || saving}>
        {saving ? 'Making…' : pipelines ? 'Make pipeline' : 'Make table'}
      </Button>
      <Button size="sm" type="button" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
      {error && <p className="w-full text-xs text-destructive">{error}</p>}
    </form>
  )
}
