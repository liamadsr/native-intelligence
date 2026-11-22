/**
 * Edits that have not reached the server yet, kept in the browser so a reload,
 * a crash or a closed laptop does not lose them. The save queue writes what is
 * waiting here after every change and clears it once everything is sent; the
 * editor reads it when a canvas opens and puts what it finds back on the
 * canvas and in the queue.
 *
 * Kept per canvas AND per person: what one person left unsent is never put on
 * the canvas as someone else who signs in on the same browser. An entry older
 * than two weeks is dropped (the canvas has moved on). Storage that is full,
 * off or broken just means nothing is kept, as before.
 */
import { itemToRow, rowToItem, type CanvasItem, type CanvasItemRow } from '@/lib/canvas/types'

export const OUTBOX = { version: 1, maxAgeMs: 14 * 24 * 60 * 60 * 1000, maxChars: 3_000_000 } as const

export type OutboxStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export interface Unsent {
  upsert: CanvasItem[]
  remove: string[]
}

interface Stored {
  v: number
  at: number
  upsert: Array<Omit<CanvasItemRow, 'canvas_id'>>
  remove: string[]
}

export const outboxKey = (canvasId: string, userId: string): string => `ni.canvas.outbox.${userId}.${canvasId}`

export class Outbox {
  private key: string
  constructor(
    private storage: OutboxStorage | null,
    private canvasId: string,
    userId: string,
    private now: () => number = Date.now,
  ) {
    this.key = outboxKey(canvasId, userId)
  }

  /** Keep what is unsent (nothing unsent clears it). Never throws. */
  write(unsent: Unsent): void {
    if (!this.storage) return
    try {
      if (!unsent.upsert.length && !unsent.remove.length) return this.storage.removeItem(this.key)
      const stored: Stored = {
        v: OUTBOX.version,
        at: this.now(),
        // As rows: the same shape the server takes, without a local preview's address.
        upsert: unsent.upsert.map((it) => {
          const { canvas_id: _c, ...row } = itemToRow(this.canvasId, it)
          return row
        }),
        remove: unsent.remove,
      }
      const text = JSON.stringify(stored)
      // Too big to keep: keep nothing rather than part of it.
      if (text.length > OUTBOX.maxChars) return this.storage.removeItem(this.key)
      this.storage.setItem(this.key, text)
    } catch {
      try {
        this.storage.removeItem(this.key)
      } catch {
        // Storage is off: nothing is kept.
      }
    }
  }

  /** What was left unsent, if anything usable was. */
  read(): Unsent | null {
    if (!this.storage) return null
    try {
      const text = this.storage.getItem(this.key)
      if (!text) return null
      const stored = JSON.parse(text) as Partial<Stored> | null
      if (!stored || stored.v !== OUTBOX.version || typeof stored.at !== 'number' || this.now() - stored.at > OUTBOX.maxAgeMs || this.now() < stored.at - 60_000) {
        this.storage.removeItem(this.key)
        return null
      }
      const upsert: CanvasItem[] = []
      for (const row of Array.isArray(stored.upsert) ? stored.upsert : []) {
        const it = row && typeof row === 'object' ? rowToItem(row as CanvasItemRow) : null
        if (!it) continue
        // An image or video whose file never finished uploading has nothing to show.
        if ((it.kind === 'image' || it.kind === 'video') && !it.path) continue
        upsert.push(it)
      }
      const remove = (Array.isArray(stored.remove) ? stored.remove : []).filter((id): id is string => typeof id === 'string' && !!id && id.length <= 64)
      if (!upsert.length && !remove.length) {
        this.storage.removeItem(this.key)
        return null
      }
      return { upsert, remove }
    } catch {
      return null
    }
  }

  clear(): void {
    try {
      this.storage?.removeItem(this.key)
    } catch {
      // Nothing to clear.
    }
  }
}

/** The browser's storage, or null where there is none (a private window, a test). */
export function browserStorage(): OutboxStorage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}

/** The server's items with what was left unsent laid over them. */
export function withUnsent(items: readonly CanvasItem[], unsent: Unsent | null): CanvasItem[] {
  if (!unsent) return [...items]
  const gone = new Set(unsent.remove)
  const put = new Map(unsent.upsert.map((it) => [it.id, it]))
  const out = items.filter((it) => !gone.has(it.id) && !put.has(it.id))
  // A kept item whose group or parent is gone stands on its own.
  const ids = new Set([...out.map((it) => it.id), ...put.keys()])
  for (const it of put.values()) out.push(it.parentId && !ids.has(it.parentId) ? { ...it, parentId: null } : it)
  return out
}
