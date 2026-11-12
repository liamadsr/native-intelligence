/**
 * One session's deliveries to the app, in the order they were made: who
 * joined and left, and what they said. One request at a time; a request
 * that fails is sent again (the same items: the app takes a repeat as a
 * repeat), with backoff, until it is taken or the app says it never will be
 * (the capture is finished, the session is another producer's). A roster
 * event always goes before words said after it, so the app knows a speaker
 * before their first segment. Items of one kind in a row go in one request.
 *
 * With `everyMs`, what is pushed waits for the next send, at most that long:
 * a call's words reach the app in one request every few seconds, not one per
 * sentence (each request rewrites the capture's transcript once, so this is
 * what keeps a long call's writes few). `flush` sends at once.
 */
import { AppError, type RosterEvent, type Segment } from './app-client.ts'
import { backoffMs, sleep } from './backoff.ts'

export type Item = { kind: 'roster'; event: RosterEvent } | { kind: 'segment'; segment: Segment }

export interface DeliveryTarget {
  roster(events: readonly RosterEvent[]): Promise<unknown>
  segments(segments: readonly Segment[]): Promise<unknown>
}

/** The most items in one request (the app takes up to 200). */
export const DELIVERY_BATCH = 100

/** The next request: the items of one kind at the head of the queue. Pure. */
export function nextBatch(queue: readonly Item[], max = DELIVERY_BATCH): Item[] {
  if (queue.length === 0) return []
  const kind = queue[0].kind
  const out: Item[] = []
  for (const item of queue) {
    if (item.kind !== kind || out.length >= max) break
    out.push(item)
  }
  return out
}

export class Delivery {
  private readonly queue: Item[] = []
  private running: Promise<void> | null = null
  private failures = 0
  private dead: string | null = null
  private readonly target: DeliveryTarget
  private readonly onDead: (why: string) => void
  private readonly backoff: { baseMs: number; maxMs: number }
  private readonly everyMs: number
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(target: DeliveryTarget, opts: { onDead?: (why: string) => void; backoff?: { baseMs: number; maxMs: number }; everyMs?: number } = {}) {
    this.target = target
    this.onDead = opts.onDead ?? (() => undefined)
    this.backoff = opts.backoff ?? { baseMs: 500, maxMs: 30_000 }
    this.everyMs = Math.max(0, opts.everyMs ?? 0)
  }

  /** Items not yet taken by the app. */
  get pending(): number {
    return this.queue.length
  }

  /** Why the app will take nothing more (null while it does). */
  get deadReason(): string | null {
    return this.dead
  }

  push(item: Item): void {
    if (this.dead) return
    this.queue.push(item)
    if (this.everyMs === 0) this.kick()
    else this.later()
  }

  /** The next send, at most everyMs from now (one already due stays due). */
  private later(): void {
    if (this.timer || this.running) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.kick()
    }, this.everyMs)
  }

  private kick(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.running)
      this.running = this.drain().finally(() => {
        this.running = null
        // Pushed while that request was out: the next send.
        if (this.queue.length > 0 && !this.dead && this.everyMs > 0) this.later()
      })
  }

  private async drain(): Promise<void> {
    // Batched: only what was waiting when this send began (what comes meanwhile waits for the next).
    let budget = this.everyMs > 0 ? this.queue.length : Infinity
    while (budget > 0 && this.queue.length > 0 && !this.dead) {
      const batch = nextBatch(this.queue, Math.min(DELIVERY_BATCH, budget))
      try {
        if (batch[0].kind === 'roster') await this.target.roster(batch.map((i) => (i as Extract<Item, { kind: 'roster' }>).event))
        else await this.target.segments(batch.map((i) => (i as Extract<Item, { kind: 'segment' }>).segment))
        this.queue.splice(0, batch.length)
        budget -= batch.length
        this.failures = 0
      } catch (err) {
        if (err instanceof AppError && err.status === 400) {
          // This request is malformed (a fault here, not the app's): it is dropped, the rest go on.
          console.warn(`[recorder] a ${batch[0].kind} batch of ${batch.length} was refused as malformed and dropped`)
          this.queue.splice(0, batch.length)
          budget -= batch.length
          continue
        }
        if (err instanceof AppError && !err.retry) {
          // 409 (finished, or another producer's), 404, 401: sending it again changes nothing.
          this.dead = err.code ?? `status ${err.status}`
          this.queue.length = 0
          this.onDead(this.dead)
          return
        }
        this.failures++
        await sleep(backoffMs(this.failures - 1, this.backoff))
      }
    }
  }

  /** Wait until everything pushed so far is taken (or never will be), at most `timeoutMs`. True when nothing is left. */
  async flush(timeoutMs: number): Promise<boolean> {
    const until = Date.now() + timeoutMs
    while ((this.queue.length > 0 && !this.dead) && Date.now() < until) {
      this.kick()
      await Promise.race([this.running ?? Promise.resolve(), sleep(Math.max(0, Math.min(250, until - Date.now())))])
    }
    return this.queue.length === 0
  }
}
