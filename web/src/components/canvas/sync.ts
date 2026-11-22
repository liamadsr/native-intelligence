/**
 * Saving. Every committed step names the items it changed; they wait here and
 * go out together, a moment after the last edit, as one write of the rows
 * that changed. A write that fails is kept and tried again. Nothing is lost
 * by closing the tab mid-edit: what is still waiting is sent as the page goes,
 * and kept in the browser (outbox.ts) in case that send does not arrive.
 */
import { itemToRow, type CanvasItem, type CanvasItemRow } from '@/lib/canvas/types'
import type { Step } from '@/lib/canvas/engine/history'
import type { Outbox, Unsent } from './outbox'

export type SaveState = 'saved' | 'unsaved' | 'saving' | 'error'
export type Send = (body: { upsert: CanvasItemRow[]; remove: string[] }, opts: { keepalive: boolean }) => Promise<boolean>

const BATCH = 1500

export class CanvasSync {
  private upserts = new Map<string, CanvasItem>()
  private removes = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private inFlight = false
  private failures = 0
  private stopped = false
  private listeners = new Set<(state: SaveState) => void>()
  state: SaveState = 'saved'

  /** Told what was written, once it has been (so its echo can be recognised). */
  onSent: ((rows: CanvasItemRow[], removed: string[]) => void) | null = null
  setOnSent(fn: ((rows: CanvasItemRow[], removed: string[]) => void) | null): void {
    this.onSent = fn
  }
  private flying = new Set<string>()
  /** The batch that is out, until the server has it. */
  private out: { items: CanvasItem[]; remove: string[] } = { items: [], remove: [] }

  constructor(
    private canvasId: string,
    private send: Send,
    private delay = 500,
    private outbox: Outbox | null = null,
  ) {}

  /** Everything the server does not have yet: what waits, under what is on its way. */
  private keep(): void {
    if (!this.outbox) return
    const upsert = new Map<string, CanvasItem>()
    const remove = new Set<string>(this.out.remove)
    for (const it of this.out.items) upsert.set(it.id, it)
    for (const [id, it] of this.upserts) {
      upsert.set(id, it)
      remove.delete(id)
    }
    for (const id of this.removes) {
      upsert.delete(id)
      remove.add(id)
    }
    this.outbox.write({ upsert: [...upsert.values()], remove: [...remove] })
  }

  /** What an earlier visit left unsent (already back on the canvas): queue it to go now. */
  restore(unsent: Unsent): void {
    if (this.stopped) return
    for (const it of unsent.upsert) if (!this.upserts.has(it.id) && !this.removes.has(it.id)) this.upserts.set(it.id, it)
    for (const id of unsent.remove) if (!this.upserts.has(id)) this.removes.add(id)
    if (!this.upserts.size && !this.removes.size) return
    this.setState('unsaved')
    this.schedule(0)
  }

  /** Does this item have a change waiting to go, or on its way? */
  isPending = (id: string): boolean => this.upserts.has(id) || this.removes.has(id) || this.flying.has(id)

  subscribe = (fn: (state: SaveState) => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  getState = (): SaveState => this.state
  private setState(state: SaveState): void {
    if (state === this.state) return
    this.state = state
    for (const fn of [...this.listeners]) fn(state)
  }

  get pending(): boolean {
    return this.upserts.size > 0 || this.removes.size > 0 || this.inFlight
  }

  /** A committed step: remember what to write. A later change to the same item replaces the earlier one. */
  push(step: Step): void {
    if (this.stopped) return
    for (const ch of step) {
      if (ch.after) {
        this.upserts.set(ch.id, ch.after)
        this.removes.delete(ch.id)
      } else {
        this.upserts.delete(ch.id)
        this.removes.add(ch.id)
      }
    }
    this.keep()
    if (!this.pending) return
    if (this.state !== 'saving') this.setState('unsaved')
    this.schedule(this.delay)
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flush(), ms)
  }

  /** Send what is waiting now. */
  async flush(keepalive = false): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.inFlight || (!this.upserts.size && !this.removes.size)) return
    this.inFlight = true
    this.setState('saving')
    // Take a batch; what arrives while it is out waits for the next one.
    const items = [...this.upserts.values()].slice(0, BATCH)
    const remove = [...this.removes].slice(0, BATCH)
    for (const it of items) this.upserts.delete(it.id)
    for (const id of remove) this.removes.delete(id)
    let ok = false
    const rows = items.map((it) => itemToRow(this.canvasId, it))
    this.flying = new Set([...items.map((it) => it.id), ...remove])
    this.out = { items, remove }
    // Said before it is sent: the echo can come back before the request does.
    this.onSent?.(rows, remove)
    try {
      ok = await this.send({ upsert: rows, remove }, { keepalive })
    } catch {
      ok = false
    }
    this.flying = new Set()
    this.out = { items: [], remove: [] }
    this.inFlight = false
    if (!ok) {
      // Put the batch back, under anything newer.
      for (const it of items) if (!this.upserts.has(it.id) && !this.removes.has(it.id)) this.upserts.set(it.id, it)
      for (const id of remove) if (!this.upserts.has(id)) this.removes.add(id)
      this.failures++
      this.keep()
      this.setState('error')
      if (!this.stopped) this.schedule(Math.min(30_000, 1000 * 2 ** Math.min(this.failures, 5)))
      return
    }
    this.failures = 0
    this.keep()
    if (this.upserts.size || this.removes.size) {
      this.setState('unsaved')
      this.schedule(0)
    } else this.setState('saved')
  }

  /** The editor is closing: send what is left and take no more. */
  stop(): void {
    void this.flush(true)
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
  }
}
