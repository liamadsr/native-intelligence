/**
 * Tables, phase 3: the grid's writes, one batch in flight at a time. Edits
 * are shown at once (the caller applies them before pushing) and queue here;
 * whatever queued while a batch was in flight goes as the next one, merged,
 * so a burst of typing or a paste is one batch (split only past the server's
 * limits, ./grid-edits.ts chunkOps).
 *
 * A batch names the version it read. On a 409 the queue asks the caller to
 * catch up (read and apply what changed since), drops from the batch what
 * someone else changed meanwhile (rebaseOps: their value stays, and the
 * caller is told how many cells), and sends the rest again on the new
 * version, a few times at most. Any other refusal hands the batch's cells
 * back to the caller to put back as they were.
 *
 * Client-safe: no React, no fetch (both are the caller's).
 */
import { chunkOps, opRowIds, rebaseOps } from './grid-edits'
import type { DataChange, DataOp } from './types'

export type SendResult =
  | { ok: true; version: number; change_id: string | null }
  | { ok: false; status: number; error: string; version?: number }

/** One cell a batch changed: what it was, what the batch made it (to put back on a refusal). */
export interface CellChange {
  rowId: string
  key: string
  from: unknown
  to: unknown
}

export interface QueuedBatch {
  ops: DataOp[]
  /** The cells it changed, and rows it added (key '' from null) or archived. */
  cells: CellChange[]
}

export interface WriteQueueDeps {
  send: (baseVersion: number, ops: DataOp[]) => Promise<SendResult>
  version: () => number
  setVersion: (v: number) => void
  /**
   * After a 409: read and apply the changes after `fromVersion`, and give
   * them, oldest first, with the version they reach. Null when that can't be
   * done (too many, or the read failed): the batch is refused.
   */
  catchUp: (fromVersion: number) => Promise<{ version: number; changes: Pick<DataChange, 'changes'>[] } | null>
  onApplied?: (changeId: string | null, batch: QueuedBatch) => void
  onRefused?: (error: string, batch: QueuedBatch) => void
  /** Cells left out because someone else changed them at the same time. */
  onDropped?: (cells: number) => void
  /** Nothing in flight and nothing queued. */
  onIdle?: () => void
}

const MAX_TRIES = 3

export interface WriteQueue {
  push: (batch: QueuedBatch) => void
  /** Resolves when everything queued so far has settled. */
  settled: () => Promise<void>
  busy: () => boolean
}

export function createWriteQueue(deps: WriteQueueDeps): WriteQueue {
  let pending: QueuedBatch[] = []
  let running: Promise<void> | null = null
  let scheduled = false

  const sendOne = async (batch: QueuedBatch) => {
    let ops = batch.ops
    for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
      const result = await deps.send(deps.version(), ops).catch((e: unknown) => ({ ok: false as const, status: 0, error: e instanceof Error ? e.message : 'Could not save' }))
      if (result.ok) {
        deps.setVersion(Math.max(deps.version(), result.version))
        deps.onApplied?.(result.change_id, { ...batch, ops })
        return
      }
      if (result.status !== 409) {
        deps.onRefused?.(result.error, batch)
        return
      }
      const caught = await deps.catchUp(deps.version()).catch(() => null)
      if (!caught) {
        deps.onRefused?.('This table changed while you were editing it. Your last change was not saved.', batch)
        return
      }
      deps.setVersion(Math.max(deps.version(), caught.version))
      const rebased = rebaseOps(ops, caught.changes)
      if (rebased.dropped) deps.onDropped?.(rebased.dropped)
      if (!rebased.ops.length) return
      ops = rebased.ops
    }
    deps.onRefused?.('This table keeps changing. Your last change was not saved; try again.', batch)
  }

  const run = async () => {
    while (pending.length) {
      const queued = pending
      pending = []
      const merged: QueuedBatch = { ops: queued.flatMap((b) => b.ops), cells: queued.flatMap((b) => b.cells) }
      const chunks = chunkOps(merged.ops)
      for (const ops of chunks) {
        const ids = chunks.length === 1 ? null : opRowIds(ops)
        await sendOne({ ops, cells: ids ? merged.cells.filter((c) => ids.has(c.rowId)) : merged.cells })
      }
    }
    running = null
    deps.onIdle?.()
  }

  const kick = () => {
    if (running || scheduled) return
    scheduled = true
    // Edits pushed in the same task go together.
    void Promise.resolve().then(() => {
      scheduled = false
      if (!running && pending.length) running = run()
    })
  }

  return {
    push(batch) {
      if (!batch.ops.length) return
      pending.push(batch)
      kick()
    },
    async settled() {
      while (scheduled || running) {
        await Promise.resolve()
        if (running) await running
      }
    },
    busy: () => scheduled || !!running || pending.length > 0,
  }
}
