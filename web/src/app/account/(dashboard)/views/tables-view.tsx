'use client'

/**
 * Tables (phase 1, migration 520): the workspace's own databases. The list of
 * tables, a way to make one (it starts with a Name column and three blank
 * rows), and one table as a plain read-only list of its rows under its
 * columns, with its change history and Undo on each change.
 *
 * Deliberately plain: the editable grid is phase 3. It owns its fetches
 * against /api/account/tables, like the Campaigns page.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Lock, Plus, Table2, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { relativeTime } from '@/lib/work/presentation'
import { canOfferUndo, cellText, describeChange } from '@/lib/tables/describe'
import type { DataChange, DataRow, DataTable, DataTableWithColumns } from '@/lib/tables/types'
import { ViewHeader } from './view-header'

const NEW_TABLE_LABEL = 'New table'

async function readJson<T>(res: Response): Promise<T> {
  const json = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(json.error || 'Something went wrong')
  return json
}

export function TablesView({ onCount }: { onCount?: (count: number) => void } = {}) {
  const [tables, setTables] = useState<DataTable[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
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
        tableId={openId}
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

function NewTableForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: (table: DataTable) => void }) {
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || saving) return
    setSaving(true)
    setError(null)
    try {
      const json = await readJson<{ table: DataTable }>(
        await fetch('/api/account/tables', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }),
      )
      onCreated(json.table)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not make the table')
      setSaving(false)
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2 py-3">
      <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Name the table" maxLength={200} className="h-8 max-w-xs" aria-label="Table name" />
      <Button size="sm" type="submit" disabled={!name.trim() || saving}>
        {saving ? 'Making…' : 'Make table'}
      </Button>
      <Button size="sm" type="button" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
      {error && <p className="w-full text-xs text-destructive">{error}</p>}
    </form>
  )
}

function TableDetail({ tableId, onBack }: { tableId: string; onBack: () => void }) {
  const [table, setTable] = useState<DataTableWithColumns | null>(null)
  const [rows, setRows] = useState<DataRow[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [changes, setChanges] = useState<DataChange[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [undoing, setUndoing] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const base = `/api/account/tables/${encodeURIComponent(tableId)}`
      const [t, r, c] = await Promise.all([
        fetch(base).then((res) => readJson<{ table: DataTableWithColumns }>(res)),
        fetch(`${base}/rows?limit=100`).then((res) => readJson<{ rows: DataRow[]; has_more: boolean }>(res)),
        fetch(`${base}/changes?limit=30`).then((res) => readJson<{ changes: DataChange[] }>(res)),
      ])
      setTable(t.table)
      setRows(r.rows ?? [])
      setHasMore(!!r.has_more)
      setChanges(c.changes ?? [])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the table')
    }
  }, [tableId])

  useEffect(() => {
    void load()
  }, [load])

  const loadMore = async () => {
    try {
      const json = await readJson<{ rows: DataRow[]; has_more: boolean }>(
        await fetch(`/api/account/tables/${encodeURIComponent(tableId)}/rows?limit=100&offset=${rows.length}`),
      )
      setRows((prev) => [...prev, ...(json.rows ?? [])])
      setHasMore(!!json.has_more)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load more rows')
    }
  }

  const undo = async (changeId: string) => {
    setUndoing(changeId)
    setNotice(null)
    try {
      const json = await readJson<{ kept: string[] }>(
        await fetch(`/api/account/tables/${encodeURIComponent(tableId)}/undo`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ change_id: changeId }),
        }),
      )
      setNotice(json.kept?.length ? `Undone. Kept, because it changed since: ${json.kept.join('; ')}.` : 'Undone.')
      await load()
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Could not undo that')
    } finally {
      setUndoing(null)
    }
  }

  const columns = table?.columns ?? []

  return (
    <div className="flex h-full flex-col">
      <ViewHeader
        title={
          <span className="flex min-w-0 items-center gap-2">
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onBack} aria-label="All tables">
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <span className="truncate">{table?.name ?? 'Table'}</span>
            {table?.visibility === 'private' && <Lock className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="Private" />}
          </span>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {error && <p className="py-4 text-sm text-destructive">{error}</p>}
        {!table && !error && <p className="py-10 text-center text-sm text-muted-foreground">Loading…</p>}
        {table && (
          <>
            <div className="overflow-x-auto rounded-md border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="min-w-[12rem]">Name</TableHead>
                    {columns.map((c) => (
                      <TableHead key={c.id} className="min-w-[8rem]">
                        {c.label}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={columns.length + 1} className="text-center text-sm text-muted-foreground">
                        No rows yet
                      </TableCell>
                    </TableRow>
                  ) : (
                    rows.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="font-medium">{r.title || <span className="text-muted-foreground/60">Untitled</span>}</TableCell>
                        {columns.map((c) => (
                          <TableCell key={c.id} className="text-sm text-muted-foreground">
                            {cellText(r.custom_fields?.[c.key])}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
            {hasMore && (
              <div className="pt-2">
                <Button size="sm" variant="ghost" onClick={() => void loadMore()}>
                  Show more rows
                </Button>
              </div>
            )}

            <h3 className="mt-6 text-xs font-medium uppercase tracking-wide text-muted-foreground">History</h3>
            {notice && <p className="mt-2 text-xs text-muted-foreground">{notice}</p>}
            <ul className="mt-2 divide-y divide-border">
              {changes.map((ch) => (
                <li key={ch.id} className="flex items-center gap-3 py-2">
                  <span className="min-w-0 flex-1">
                    <span className={ch.undone_at ? 'block truncate text-sm text-muted-foreground line-through' : 'block truncate text-sm text-foreground'}>
                      {describeChange(ch, table.columns)}
                    </span>
                    {ch.reason && <span className="block truncate text-xs text-muted-foreground">{ch.reason}</span>}
                  </span>
                  {ch.source !== 'person' && <span className="shrink-0 text-xs text-muted-foreground">{ch.source === 'agent' ? 'Agent' : ch.source}</span>}
                  <span className="shrink-0 text-xs text-muted-foreground">{relativeTime(ch.created_at)}</span>
                  {canOfferUndo(ch) && (
                    <Button size="sm" variant="ghost" className="h-7 shrink-0 px-2" disabled={undoing !== null} onClick={() => void undo(ch.id)}>
                      <Undo2 className="h-3.5 w-3.5" />
                      Undo
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}
