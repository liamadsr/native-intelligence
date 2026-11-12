'use client'

/**
 * One table in the page (Tables, phase 3): its columns, its rows (read 200 at
 * a time, the rest in the background up to BACKGROUND_ROWS), the names its
 * person and relation values show as, its history, and every write.
 *
 * Writes are optimistic: an edit shows at once in its stored form
 * (planEdits coerces as the server does) and goes through the write queue
 * (src/lib/tables/write-queue.ts), one batch in flight. A refused batch puts
 * its cells back and says why on the cell. A 409 catches up first (the
 * changes since our version, applied here) and sends the rest again.
 *
 * Realtime: the registry marks data_table realtime, so every batch anyone
 * writes bumps the table's version and arrives as an entity update; a newer
 * version than ours catches up the same way (after our own batch settles).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { onEntityUpdated } from '@/lib/entity-events'
import { referencedIds } from '@/lib/crm/custom-field-types'
import { applyChanges, applyOpsToRows, mergeRows, planEdits, TITLE_KEY, type CellEdit, type CellError } from '@/lib/tables/grid-edits'
import { validateOps } from '@/lib/tables/ops'
import { createWriteQueue, type CellChange, type QueuedBatch, type SendResult, type WriteQueue } from '@/lib/tables/write-queue'
import type { DataChange, DataColumn, DataOp, DataRow, DataTableWithColumns } from '@/lib/tables/types'
import type { Member } from './cells'

const PAGE = 200
/** Rows read without being scrolled to (sort and paste see them all); past this, more load on scroll. */
export const BACKGROUND_ROWS = 10_000
const CATCH_UP_LIMIT = 200

const COLUMN_OPS = new Set<DataOp['op']>(['create_column', 'update_column', 'delete_column', 'restore_column', 'reorder_columns', 'change_column_type'])

async function readJson<T>(res: Response): Promise<T> {
  const json = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw Object.assign(new Error(json.error || 'Something went wrong'), { status: res.status, body: json })
  return json
}

export const cellId = (rowId: string, key: string) => `${rowId}:${key}`

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

function valueOf(row: DataRow, key: string): unknown {
  return key === TITLE_KEY ? row.title ?? '' : row.custom_fields?.[key] ?? null
}

export interface TableNotice {
  text: string
  /** A change to offer Undo on. */
  changeId?: string | null
  tone?: 'error'
}

export function useTableData(tableId: string, opts: { onNotice?: (n: TableNotice) => void } = {}) {
  const base = `/api/account/tables/${encodeURIComponent(tableId)}`
  const [table, setTable] = useState<DataTableWithColumns | null>(null)
  const [rows, setRowsState] = useState<DataRow[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [labels, setLabels] = useState<Record<string, string>>({})
  const [members, setMembers] = useState<Member[]>([])
  const [changes, setChanges] = useState<DataChange[]>([])
  const [error, setError] = useState<string | null>(null)
  const [cellErrors, setCellErrors] = useState<ReadonlyMap<string, string>>(new Map())

  const rowsRef = useRef<DataRow[]>([])
  const tableRef = useRef<DataTableWithColumns | null>(null)
  const version = useRef(0)
  const labelsRef = useRef<Record<string, string>>({})
  labelsRef.current = labels
  const mine = useRef<string[]>([])
  const syncWanted = useRef(false)
  const loadingMore = useRef(false)
  const serverRows = useRef(0)
  const historyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const noticeRef = useRef(opts.onNotice)
  noticeRef.current = opts.onNotice
  const notice = (n: TableNotice) => noticeRef.current?.(n)

  const setRows = useCallback((next: DataRow[]) => {
    rowsRef.current = next
    setRowsState(next)
  }, [])
  const columns = useMemo<DataColumn[]>(() => table?.columns ?? [], [table])

  const addLabels = (more: Record<string, string> | undefined) => {
    if (more && Object.keys(more).length) setLabels((prev) => ({ ...prev, ...more }))
  }

  const loadTable = useCallback(async () => {
    const t = await readJson<{ table: DataTableWithColumns }>(await fetch(base))
    tableRef.current = t.table
    setTable(t.table)
    return t.table
  }, [base])

  const loadChanges = useCallback(async () => {
    try {
      const c = await readJson<{ changes: DataChange[] }>(await fetch(`${base}/changes?limit=30`))
      setChanges(c.changes ?? [])
    } catch {
      // The history is a side panel: a failed read leaves the last one.
    }
  }, [base])
  const loadChangesSoon = useCallback(() => {
    if (historyTimer.current) clearTimeout(historyTimer.current)
    historyTimer.current = setTimeout(() => void loadChanges(), 400)
  }, [loadChanges])

  const loadMembers = useCallback(async () => {
    try {
      const json = await readJson<{ members: Array<{ id: string; display_name: string | null; role?: string }> }>(await fetch('/api/account/workspace/members'))
      const list = (json.members ?? []).filter((m) => m.role !== 'guest').map((m) => ({ id: m.id, name: m.display_name?.trim() || 'Member' }))
      setMembers(list)
      addLabels(Object.fromEntries(list.map((m) => [m.id, m.name])))
    } catch {
      setMembers([])
    }
  }, [])

  const loadPage = useCallback(
    async (offset: number) => {
      const json = await readJson<{ rows: DataRow[]; has_more: boolean; labels?: Record<string, string> }>(await fetch(`${base}/rows?limit=${PAGE}&offset=${offset}`))
      const page = (json.rows ?? []).map((r) => ({ ...r, custom_fields: r.custom_fields ?? {} }))
      serverRows.current = offset + page.length
      setRows(offset === 0 ? page : mergeRows(rowsRef.current, page))
      setHasMore(!!json.has_more)
      addLabels(json.labels)
      return !!json.has_more
    },
    [base, setRows],
  )

  const loadMore = useCallback(async () => {
    if (loadingMore.current) return
    loadingMore.current = true
    try {
      await loadPage(serverRows.current)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load more rows')
    } finally {
      loadingMore.current = false
    }
  }, [loadPage])

  /** Pages after the first, in the background, up to BACKGROUND_ROWS. */
  const loadRest = useCallback(
    async (more: boolean) => {
      let keepGoing = more
      while (keepGoing && serverRows.current < BACKGROUND_ROWS) {
        loadingMore.current = true
        try {
          keepGoing = await loadPage(serverRows.current)
        } finally {
          loadingMore.current = false
        }
      }
    },
    [loadPage],
  )

  /** Everything, from the top: the first page, then the rest in the background. */
  const reload = useCallback(async () => {
    try {
      const [t, more] = await Promise.all([loadTable(), loadPage(0), loadChanges()])
      version.current = t.version
      setError(null)
      if (t.columns.some((c) => c.field_type === 'person')) void loadMembers()
      await loadRest(more)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the table')
    }
  }, [loadTable, loadPage, loadChanges, loadMembers, loadRest])

  /** Rows read by id: a teammate's new or moved ones, or ones whose names we lack. */
  const readRows = useCallback(
    async (ids: string[]) => {
      for (let i = 0; i < ids.length; i += PAGE) {
        const chunk = ids.slice(i, i + PAGE)
        const json = await readJson<{ rows: DataRow[]; labels?: Record<string, string> }>(await fetch(`${base}/rows?ids=${chunk.join(',')}`))
        setRows(mergeRows(rowsRef.current, (json.rows ?? []).map((r) => ({ ...r, custom_fields: r.custom_fields ?? {} }))))
        addLabels(json.labels)
      }
    },
    [base, setRows],
  )

  /** The changes after `from`, applied here. Null when there are too many (reload instead). */
  const catchUp = useCallback(
    async (from: number): Promise<{ version: number; changes: DataChange[] } | null> => {
      const json = await readJson<{ changes: DataChange[] }>(await fetch(`${base}/changes?after_version=${from}&limit=${CATCH_UP_LIMIT}`))
      const list = json.changes ?? []
      if (list.length >= CATCH_UP_LIMIT) return null
      if (!list.length) return { version: from, changes: [] }
      const { rows: next, needs } = applyChanges(rowsRef.current, list)
      setRows(next)
      if (needs.columns || needs.table) await loadTable()
      if (needs.allRows) {
        await loadRest(await loadPage(0))
        return { version: Math.max(from, ...list.map((c) => c.version)), changes: list }
      }
      // Values naming people or records we have no name for: read those rows' names.
      const cols = tableRef.current?.columns ?? []
      const unnamed = new Set(needs.rowIds)
      for (const ch of list)
        for (const e of ch.changes ?? [])
          if (e?.op === 'update_row') {
            const row = next.find((r) => r.id === e.row_id)
            if (row && cols.some((c) => referencedIds(c.field_type, row.custom_fields?.[c.key]).some((id) => !(id in labelsRef.current)))) unnamed.add(row.id)
          }
      if (unnamed.size) await readRows([...unnamed])
      const reached = Math.max(from, ...list.map((c) => c.version))
      return { version: reached, changes: list }
    },
    [base, setRows, loadTable, readRows, loadPage, loadRest],
  )

  const putBack = useCallback(
    (cells: CellChange[]) => {
      let next = rowsRef.current
      for (const c of cells) {
        if (c.key === '__insert') next = next.filter((r) => r.id !== c.rowId)
        else if (c.key === '__archive' && c.from) next = mergeRows(next, [c.from as DataRow])
      }
      const at = new Map(next.map((r, i) => [r.id, i]))
      for (const c of cells) {
        if (c.key === '__insert' || c.key === '__archive') continue
        const i = at.get(c.rowId)
        if (i === undefined) continue
        const row = next[i]
        if (!same(valueOf(row, c.key), c.to)) continue
        if (next === rowsRef.current) next = [...next]
        if (c.key === TITLE_KEY) next[i] = { ...row, title: String(c.from ?? '') }
        else {
          const custom = { ...(row.custom_fields ?? {}) }
          if (c.from === null || c.from === undefined) delete custom[c.key]
          else custom[c.key] = c.from as never
          next[i] = { ...row, custom_fields: custom }
        }
      }
      setRows(next)
    },
    [setRows],
  )

  const queue = useRef<WriteQueue | null>(null)
  const sync = useRef<() => Promise<void>>(async () => {})
  if (!queue.current) {
    queue.current = createWriteQueue({
      send: async (baseVersion, ops): Promise<SendResult> => {
        const res = await fetch(`${base}/ops`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base_version: baseVersion, ops }) })
        const json = (await res.json().catch(() => ({}))) as { version?: number; change_id?: string | null; error?: string; details?: { version?: number } }
        if (!res.ok) return { ok: false, status: res.status, error: json.error || 'Could not save', version: json.details?.version }
        return { ok: true, version: Number(json.version ?? 0), change_id: json.change_id ?? null }
      },
      version: () => version.current,
      setVersion: (v) => {
        version.current = v
      },
      catchUp: (from) => catchUp(from),
      onApplied: (changeId, batch) => {
        if (changeId) mine.current.push(changeId)
        if (batch.ops.some((o) => COLUMN_OPS.has(o.op))) void loadTable()
        loadChangesSoon()
      },
      onRefused: (err, batch) => {
        putBack(batch.cells)
        const first = batch.cells.find((c) => !c.key.startsWith('__'))
        if (first) setCellErrors((prev) => new Map(prev).set(cellId(first.rowId, first.key), err))
        if (batch.ops.some((o) => COLUMN_OPS.has(o.op))) void loadTable()
        notice({ text: err, tone: 'error' })
      },
      onDropped: (n) => notice({ text: `${n === 1 ? 'A cell was' : `${n} cells were`} changed by someone else at the same time. Their ${n === 1 ? 'value is' : 'values are'} kept.` }),
      onIdle: () => {
        if (syncWanted.current) {
          syncWanted.current = false
          void sync.current()
        }
      },
    })
  }

  sync.current = async () => {
    if (queue.current?.busy()) {
      syncWanted.current = true
      return
    }
    try {
      const caught = await catchUp(version.current)
      if (!caught) return void reload()
      version.current = Math.max(version.current, caught.version)
      if (caught.changes.length) loadChangesSoon()
    } catch {
      // The next event tries again.
    }
  }

  useEffect(() => {
    void reload()
    return () => {
      if (historyTimer.current) clearTimeout(historyTimer.current)
    }
  }, [reload])

  // Someone's batch (or our own, already applied): a newer version catches up.
  useEffect(
    () =>
      onEntityUpdated((d) => {
        if ((d.entityType as string) !== 'data_table' || d.id !== tableId) return
        const v = Number(d.fields?.version)
        if (Number.isFinite(v) && v <= version.current) return
        void sync.current()
      }),
    [tableId],
  )

  /** Cell edits and new rows, shown now and saved in one batch. The cells that don't fit come back. */
  const edit = useCallback(
    (edits: readonly CellEdit[], newRows: ReadonlyArray<{ id: string; title?: string; values?: Record<string, unknown> }> = [], names?: Record<string, string>): CellError[] => {
      const t = tableRef.current
      if (!t) return []
      const byId = new Map(rowsRef.current.map((r) => [r.id, r]))
      const plan = planEdits(t.columns, byId, edits, newRows)
      setCellErrors((prev) => {
        const next = new Map(prev)
        for (const e of edits) next.delete(cellId(e.rowId, e.key))
        for (const r of newRows) for (const k of [TITLE_KEY, ...Object.keys(r.values ?? {})]) next.delete(cellId(r.id, k))
        for (const e of plan.errors) if (e.rowId) next.set(cellId(e.rowId, e.key), e.error)
        return next
      })
      const general = plan.errors.find((e) => !e.rowId)
      if (general) notice({ text: general.error, tone: 'error' })
      if (!plan.ops.length) return plan.errors
      if (names) addLabels(names)
      const cells: CellChange[] = []
      for (const op of plan.ops) {
        if (op.op === 'update_row') {
          const row = byId.get(op.row_id)!
          if (op.title !== undefined) cells.push({ rowId: op.row_id, key: TITLE_KEY, from: row.title ?? '', to: op.title })
          for (const [k, v] of Object.entries(op.values ?? {})) cells.push({ rowId: op.row_id, key: k, from: row.custom_fields?.[k] ?? null, to: v })
        } else if (op.op === 'insert_rows') {
          for (const r of op.rows) if (r.id) cells.push({ rowId: r.id, key: '__insert', from: null, to: true })
        }
      }
      setRows(applyOpsToRows(rowsRef.current, plan.ops, tableId))
      queue.current!.push({ ops: plan.ops, cells })
      return plan.errors
    },
    [setRows, tableId],
  )

  const archiveRows = useCallback(
    (ids: readonly string[]) => {
      const gone = rowsRef.current.filter((r) => ids.includes(r.id))
      if (!gone.length) return
      const ops: DataOp[] = [{ op: 'archive_rows', row_ids: gone.map((r) => r.id) }]
      setRows(applyOpsToRows(rowsRef.current, ops, tableId))
      queue.current!.push({ ops, cells: gone.map((r) => ({ rowId: r.id, key: '__archive', from: r, to: null })) })
    },
    [setRows, tableId],
  )

  /**
   * Column changes (add, rename, hide is the viewer's own, delete, reorder):
   * checked as the server will, shown at once, saved through the queue; the
   * table is read again once saved.
   */
  const columnOps = useCallback(
    (raw: unknown[]): string | null => {
      const t = tableRef.current
      if (!t) return 'The table is still loading.'
      const checked = validateOps(t.columns, raw)
      if (!checked.ok) return checked.error
      let cols = [...t.columns]
      for (const op of checked.value) {
        if (op.op === 'create_column') {
          cols.push({ id: `local-${op.key}`, table_id: t.id, key: op.key, label: op.label, field_type: op.field_type, options: op.options ?? [], config: op.config ?? {}, position: cols.length, deleted_at: null })
        } else if (op.op === 'update_column') {
          cols = cols.map((c) => (c.key === op.key ? { ...c, ...(op.label !== undefined ? { label: op.label } : {}), ...(op.options ? { options: op.options } : {}), ...(op.config ? { config: op.config } : {}) } : c))
        } else if (op.op === 'delete_column') {
          cols = cols.filter((c) => c.key !== op.key)
        } else if (op.op === 'reorder_columns') {
          const order = new Map(op.keys.map((k, i) => [k, i]))
          cols = [...cols].sort((a, b) => (order.get(a.key) ?? 1e6 + a.position) - (order.get(b.key) ?? 1e6 + b.position))
        }
      }
      const next = { ...t, columns: cols }
      tableRef.current = next
      setTable(next)
      if (checked.value.some((o) => o.op === 'create_column' && o.field_type === 'person')) void loadMembers()
      // A new column's key is made by the server, which also knows the keys deleted columns keep.
      const ops = checked.value.map((o) => (o.op === 'create_column' ? ({ ...o, key: undefined } as unknown as DataOp) : o))
      queue.current!.push({ ops, cells: [] })
      return null
    },
    [loadMembers],
  )

  /**
   * A batch whose answer the person waits for (a column's type change, whose
   * refusal says how many values don't fit): after the queue settles, sent on
   * our version, caught up and sent once more on a 409.
   */
  const sendNow = useCallback(
    async (ops: DataOp[]): Promise<{ ok: true; changeId: string | null } | { ok: false; error: string }> => {
      await queue.current!.settled()
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await fetch(`${base}/ops`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base_version: version.current, ops }) })
        const json = (await res.json().catch(() => ({}))) as { version?: number; change_id?: string | null; error?: string }
        if (res.ok) {
          // Its effects (every converted value) come back through the log.
          await sync.current()
          if (json.change_id) mine.current.push(json.change_id)
          loadChangesSoon()
          return { ok: true, changeId: json.change_id ?? null }
        }
        if (res.status !== 409) return { ok: false, error: json.error || 'Could not change that' }
        await sync.current()
      }
      return { ok: false, error: 'This table keeps changing. Try again.' }
    },
    [base, loadChangesSoon],
  )

  /** Takes one change back: the one named, else our own latest this visit, else the table's latest. */
  const undo = useCallback(
    async (changeId?: string | null) => {
      await queue.current!.settled()
      const id = changeId ?? mine.current.pop() ?? null
      try {
        const json = await readJson<{ kept?: string[] }>(
          await fetch(`${base}/undo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(id ? { change_id: id } : {}) }),
        )
        if (changeId) mine.current = mine.current.filter((x) => x !== changeId)
        await sync.current()
        loadChangesSoon()
        notice({ text: json.kept?.length ? `Undone. Kept, because it changed since: ${json.kept.join('; ')}.` : 'Undone.' })
      } catch (err) {
        notice({ text: err instanceof Error ? err.message : 'Could not undo that', tone: 'error' })
      }
    },
    [base, loadChangesSoon],
  )

  /** The latest change this visit made (for a toast's Undo). */
  const lastChangeId = useCallback(async () => {
    await queue.current!.settled()
    return mine.current[mine.current.length - 1] ?? null
  }, [])

  const clearCellError = useCallback((rowId: string, key: string) => {
    setCellErrors((prev) => {
      if (!prev.has(cellId(rowId, key))) return prev
      const next = new Map(prev)
      next.delete(cellId(rowId, key))
      return next
    })
  }, [])

  return {
    table,
    columns,
    rows,
    hasMore,
    labels,
    members,
    changes,
    error,
    cellErrors,
    canEdit: table?.can_edit === true,
    reload,
    loadMore,
    loadMembers,
    edit,
    archiveRows,
    columnOps,
    sendNow,
    undo,
    lastChangeId,
    clearCellError,
    addLabels,
    settled: () => queue.current!.settled(),
  }
}

export type TableData = ReturnType<typeof useTableData>
export type { QueuedBatch }
