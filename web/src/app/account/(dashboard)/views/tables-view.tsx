'use client'

/**
 * Tables (phase 1, migration 520): the workspace's own databases. The list of
 * tables, a way to make one (it starts with a Name column and three blank
 * rows), and one table open as its editable grid (phase 3,
 * src/components/tables/table-detail.tsx). It owns its fetches against
 * /api/account/tables, like the Campaigns page.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { KanbanSquare, ListChecks, Lock, Package, Plus, Table2, Users, Wrench, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { TableDetail } from '@/components/tables/table-detail'
import { relativeTime } from '@/lib/work/presentation'
import type { DataTable } from '@/lib/tables/types'
import { tableTemplates, type TemplateId } from '@/lib/tables/templates'
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

export function TablesView({ onCount, card }: { onCount?: (count: number) => void; card?: TablesCardState } = {}) {
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
      const json = await readJson<{ tables: DataTable[] }>(await fetch('/api/account/tables'))
      setTables(Array.isArray(json.tables) ? json.tables : [])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load tables')
      setTables([])
    }
  }, [])

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
        title="Tables"
        actions={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="h-3.5 w-3.5" />
            {NEW_TABLE_LABEL}
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {creating && (
          <NewTableForm
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
          !creating && <EmptyState onCreate={() => setCreating(true)} />
        ) : (
          <ul className="divide-y divide-border">
            {tables.map((t) => (
              <li key={t.id}>
                <button type="button" onClick={() => setOpenId(t.id)} className="flex w-full items-center gap-3 py-2.5 text-left hover:bg-muted/40">
                  <Table2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{t.name}</span>
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

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
      <Table2 className="h-7 w-7 text-muted-foreground/60" />
      <div>
        <p className="text-sm font-medium text-foreground">No tables yet</p>
        <p className="mt-1 text-sm text-muted-foreground">A table keeps a list of anything: orders, hires, suppliers, ideas.</p>
      </div>
      <Button size="sm" variant="outline" onClick={onCreate}>
        <Plus className="h-3.5 w-3.5" />
        {NEW_TABLE_LABEL}
      </Button>
    </div>
  )
}

/** What each starter's card shows (lib/tables/templates.ts). */
const TEMPLATE_ICONS: Record<TemplateId | 'blank', LucideIcon> = {
  blank: Table2,
  list: ListChecks,
  pipeline: KanbanSquare,
  inventory: Package,
  jobs: Wrench,
  contacts: Users,
}

/**
 * A new table: a name (optional for a starter, which has its own), then a
 * blank table or one of the starters (phase 6): columns, views and example
 * rows to delete. Nothing to set beyond that.
 */
export function NewTableForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: (table: DataTable) => void }) {
  const [name, setName] = useState('')
  const [saving, setSaving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const templates = useMemo(() => tableTemplates(), [])

  const make = async (template: TemplateId | null) => {
    if (saving) return
    if (!template && !name.trim()) return setError('Name the table, or start from one below.')
    setSaving(template ?? 'blank')
    setError(null)
    try {
      const json = await readJson<{ table: DataTable }>(
        await fetch('/api/account/tables', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name.trim() || undefined, ...(template ? { template } : {}) }),
        }),
      )
      onCreated(json.table)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not make the table')
      setSaving(null)
    }
  }

  return (
    <div className="space-y-3 py-3" data-new-table="">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void make(null)
        }}
        className="flex flex-wrap items-center gap-2"
      >
        <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Name the table" maxLength={200} className="h-8 max-w-xs" aria-label="Table name" />
        <Button size="sm" type="submit" disabled={!name.trim() || !!saving}>
          {saving === 'blank' ? 'Making…' : 'Make table'}
        </Button>
        <Button size="sm" type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </form>
      <div>
        <p className="mb-2 text-xs text-muted-foreground">Or start from</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((t) => {
            const Icon = TEMPLATE_ICONS[t.id]
            return (
              <button
                key={t.id}
                type="button"
                disabled={!!saving}
                onClick={() => void make(t.id)}
                className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border bg-background p-3 text-left transition-colors hover:border-foreground/25 hover:bg-muted/30 disabled:opacity-60"
                data-template={t.id}
              >
                <span className="flex items-center gap-2">
                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="truncate text-sm font-medium text-foreground">{saving === t.id ? 'Making…' : t.name}</span>
                </span>
                <span className="line-clamp-2 text-xs text-muted-foreground">{t.description}</span>
                <span className="flex flex-wrap items-center gap-1 pt-0.5">
                  {t.columns.slice(0, 4).map((c) => (
                    <span key={c.key} className="rounded-full border border-border/70 px-1.5 py-px text-[10px] text-muted-foreground">
                      {c.label}
                    </span>
                  ))}
                  {t.columns.length > 4 && <span className="px-1 text-[10px] text-muted-foreground">+{t.columns.length - 4}</span>}
                </span>
              </button>
            )
          })}
        </div>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
