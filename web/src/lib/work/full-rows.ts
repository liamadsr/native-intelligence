'use client'

/**
 * Whole rows for light ones, read once per session, one cache for whoever
 * shows them (the chat's For you column): a row read once is never read
 * again.
 *
 * Light rows (the shell's always-on answer, AgentWorkProvider) carry no
 * progress, result or deliverables, so a row that has to show them is read
 * once from its item route, the detail panel's (GET
 * /api/account/activity/[id]), and kept per row, status and last beat: a row
 * that moves on, or comes back for another review after a revision (a new
 * beat), is read again. A whole row (a pushed one, or a page's own) is itself
 * and is never read.
 *
 * The read's run comes with it (the route's `run`: its id, status and parked
 * question), so a question can be answered where it's shown (useFullReads:
 * whole rows are read for it too, as a pushed row carries no run).
 *
 * Bounded: one entry per row (a row's new key drops its old one),
 * pruneFullRows drops what no longer waits on you, and at most FULL_ROWS_MAX entries
 * stay (the least recently shown go first). A failed read is remembered for
 * FULL_ROW_RETRY_MS, so it isn't asked again on every render that changes the
 * rows on show.
 */
import { useEffect, useMemo, useState } from 'react'
import type { LightWorkRow } from '@/lib/work/queries'
import { workNeedsYou, type WorkItem } from '@/lib/work/types'

/** At most this many rows are held (a session rarely shows more). */
export const FULL_ROWS_MAX = 200
/** A failed read is asked again only after this long. */
export const FULL_ROW_RETRY_MS = 60_000

/** What a read is keyed on: a light row's id, status and last beat. */
type KeyedRow = { id: string; status: string; last_beat_at?: string | null }

const fullRows = new Map<string, Promise<WorkItem | null>>()
/** What has landed, by the same key: read as it renders (null: it failed). */
const fullRowsLanded = new Map<string, WorkItem | null>()
/** The run behind a landed read, as the item route gives it (`run`). */
export interface FullRun {
  id: string
  status: string
  /** Its parked question (agent_run.pending_input), null when none. */
  pending_input: unknown
}

/** A landed read: the whole row, and the run behind it (null: no run). */
export interface FullRead {
  item: WorkItem
  run: FullRun | null
}

/** The run behind each landed full read (null: no run), by the same key. */
const fullRuns = new Map<string, FullRun | null>()
/** When each failed read failed (epoch ms), by the same key. */
const fullRowsFailedAt = new Map<string, number>()
/** Each row's current key and its status, least recently shown first: one entry per row (the LRU order). */
const keyOfRow = new Map<string, { key: string; status: string }>()

/** A row's read key: its id, status and last beat (a row that moves on, or waits again, is read again). */
export function fullRowKey(row: KeyedRow): string {
  return `${row.id}:${row.status}:${row.last_beat_at ?? ''}`
}

/**
 * A light row: no result or deliverables, so its whole row has to be read.
 * Not the title: light reads carry one since the Agents widget (LIGHT_COLUMNS),
 * and testing it made every light review look whole, so its card never saw
 * its deliverable and opened the run's chat instead of the output.
 */
export function isLightRow(row: WorkItem | LightWorkRow): row is LightWorkRow {
  return !('deliverables' in row) || !('result_summary' in row)
}

/** Whether a read for `key` has landed (a failed one too: it landed as null). */
export function hasLandedFullRow(key: string): boolean {
  return fullRowsLanded.has(key)
}

/** The whole row a landed read for `key` gave; null when it failed or hasn't landed. */
export function landedFullRow(key: string): WorkItem | null {
  return fullRowsLanded.get(key) ?? null
}

/** Whether `row`'s read failed and isn't due to be asked again yet. */
export function fullRowFailed(row: KeyedRow, now: number = Date.now()): boolean {
  const at = fullRowsFailedAt.get(fullRowKey(row))
  return at !== undefined && now - at < FULL_ROW_RETRY_MS
}

/** Drop everything held for `key`. */
function forget(key: string): void {
  fullRows.delete(key)
  fullRowsLanded.delete(key)
  fullRuns.delete(key)
  fullRowsFailedAt.delete(key)
}

/** `row` is on show under `key`: its older key goes, and it becomes the most recently shown. */
function touch(id: string, key: string, status: string): void {
  const was = keyOfRow.get(id)
  if (was && was.key !== key) forget(was.key)
  keyOfRow.delete(id)
  keyOfRow.set(id, { key, status })
  // Over the cap: the least recently shown rows go.
  while (keyOfRow.size > FULL_ROWS_MAX) {
    const [oldId, oldest] = keyOfRow.entries().next().value as [string, { key: string }]
    keyOfRow.delete(oldId)
    forget(oldest.key)
  }
}

/**
 * Drop the rows that no longer wait on you: every held review or question
 * whose row, in the shell's open rows, no longer waits in that episode (it
 * moved on, or is gone). Only once the open rows are known (null: still loading).
 */
export function pruneFullRows(open: readonly KeyedRow[] | null | undefined): void {
  if (!open) return
  const current = new Map(open.map((row) => [row.id, fullRowKey(row)]))
  for (const [id, held] of [...keyOfRow]) {
    if (!workNeedsYou(held.status) || current.get(id) === held.key) continue
    keyOfRow.delete(id)
    forget(held.key)
  }
}

/** Reads `row`'s whole row, once per key (a failed read is asked again after FULL_ROW_RETRY_MS). */
export function loadFullRow(row: KeyedRow): Promise<WorkItem | null> {
  const key = fullRowKey(row)
  touch(row.id, key, row.status)
  if (fullRowFailed(row)) return Promise.resolve(null)
  let pending = fullRows.get(key)
  if (!pending) {
    fullRowsFailedAt.delete(key)
    pending = fetch(`/api/account/activity/${encodeURIComponent(row.id)}`, { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) return null
        const body = (await res.json()) as { item?: WorkItem; run?: Partial<FullRun> | null }
        const run = body.run
        if (body.item) {
          fullRuns.set(
            key,
            run && typeof run.id === 'string' && typeof run.status === 'string'
              ? { id: run.id, status: run.status, pending_input: run.pending_input ?? null }
              : null,
          )
        }
        return body.item ?? null
      })
      .catch(() => null)
      .then((item) => {
        // Dropped meanwhile (pruned, evicted, or the row moved on): nothing to keep.
        if (fullRows.get(key) !== pending) return item
        if (!item) {
          fullRows.delete(key)
          fullRowsFailedAt.set(key, Date.now())
        }
        fullRowsLanded.set(key, item)
        return item
      })
    fullRows.set(key, pending)
  }
  return pending
}

/** Whether `row` still needs reading: nothing whole landed, and no recent failure. */
function needsRead(row: KeyedRow): boolean {
  return !fullRowsLanded.get(fullRowKey(row)) && !fullRowFailed(row)
}

/**
 * The status of the run behind a light row, once its full read (useFullRow)
 * has landed: null for no run, undefined until known (or for a full row,
 * which isn't read again).
 */
export function useFullRunStatus(row: WorkItem | LightWorkRow | null): string | null | undefined {
  const light = row && isLightRow(row) ? row : null
  if (!light) return undefined
  const key = fullRowKey(light)
  return fullRowsLanded.get(key) ? (fullRuns.get(key)?.status ?? null) : undefined
}

/** `row` whole: itself when it is, else its read once landed (null until then, or when it failed). */
export function useFullRow(row: WorkItem | LightWorkRow | null): WorkItem | null {
  const light = row && isLightRow(row) ? row : null
  const key = light ? fullRowKey(light) : null
  const [, landed] = useState(0)
  useEffect(() => {
    if (!light || !key) return
    if (!needsRead(light)) {
      touch(light.id, key, light.status)
      return
    }
    let live = true
    void loadFullRow(light).then(() => {
      if (live) landed((n) => n + 1)
    })
    return () => {
      live = false
    }
    // The row's id, status and beat are what's read; the object changes with every push.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  if (!row) return null
  if (!light || !key) return row as WorkItem
  return fullRowsLanded.get(key) ?? null
}

/**
 * Several rows whole, by id: each whole row itself, each light one's read
 * once it lands (absent until then, or when it failed). Reads only what
 * hasn't landed and hasn't just failed; one re-render as a batch of reads
 * lands.
 */
export function useFullRows(rows: readonly (WorkItem | LightWorkRow)[]): ReadonlyMap<string, WorkItem> {
  const light = rows.filter(isLightRow)
  const keys = light.map(fullRowKey).join(' ')
  const [tick, landed] = useState(0)
  useEffect(() => {
    const missing: LightWorkRow[] = []
    for (const row of light) {
      if (needsRead(row)) missing.push(row)
      else touch(row.id, fullRowKey(row), row.status)
    }
    if (missing.length === 0) return
    let live = true
    void Promise.all(missing.map((row) => loadFullRow(row))).then(() => {
      if (live) landed((n) => n + 1)
    })
    return () => {
      live = false
    }
    // `keys` names the rows read (id, status, beat); the array changes with every push.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys])
  return useMemo(() => {
    const out = new Map<string, WorkItem>()
    for (const row of rows) {
      // (A whole row is a light one too, as far as types go: so test, then cast.)
      const whole = isLightRow(row) ? fullRowsLanded.get(fullRowKey(row)) : (row as WorkItem)
      if (whole) out.set(row.id, whole)
    }
    return out
    // `tick`: a batch of reads landed (the maps are module state).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, tick])
}

/**
 * Several rows' reads, by id, WHOLE rows too: each row's whole row and the run
 * behind it once its read lands (absent until then, or when it failed). For
 * what only the item route has, a run's parked question (the For you column's
 * questions): a pushed whole row carries no run. Each key is read once, shared
 * with useFullRow and useFullRows; one re-render as a batch of reads lands.
 */
export function useFullReads(rows: readonly KeyedRow[]): ReadonlyMap<string, FullRead> {
  const keys = rows.map(fullRowKey).join(' ')
  const [tick, landed] = useState(0)
  useEffect(() => {
    const missing: KeyedRow[] = []
    for (const row of rows) {
      if (needsRead(row)) missing.push(row)
      else touch(row.id, fullRowKey(row), row.status)
    }
    if (missing.length === 0) return
    let live = true
    void Promise.all(missing.map((row) => loadFullRow(row))).then(() => {
      if (live) landed((n) => n + 1)
    })
    return () => {
      live = false
    }
    // `keys` names the rows read (id, status, beat); the array changes with every push.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys])
  return useMemo(() => {
    const out = new Map<string, FullRead>()
    for (const row of rows) {
      const key = fullRowKey(row)
      const item = fullRowsLanded.get(key)
      if (item) out.set(row.id, { item, run: fullRuns.get(key) ?? null })
    }
    return out
    // `tick`: a batch of reads landed (the maps are module state).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, tick])
}

/** Tests only: forget every row read. */
export function __resetFullRowsForTests(): void {
  fullRows.clear()
  fullRowsLanded.clear()
  fullRuns.clear()
  fullRowsFailedAt.clear()
  keyOfRow.clear()
}
