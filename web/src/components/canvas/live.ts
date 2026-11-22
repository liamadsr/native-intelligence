/**
 * A canvas open in more than one place. Item rows arrive over Supabase
 * Realtime as other people (and agents) save them, and are taken in item by
 * item: the last write to an item wins, and two people changing different
 * items never touch each other. Cursors and selections travel on a broadcast
 * channel of their own and are never stored.
 *
 * The rules that keep this honest:
 *   - what this editor sent is not taken back in (an echo);
 *   - an item with a local change still waiting to be saved keeps the local
 *     change (it is about to be the last write);
 *   - while a drag is in progress, what arrives waits until the drag ends, so
 *     a gesture never commits over someone else's change by accident.
 */
import { rowToItem, type CanvasItem, type CanvasItemRow } from '@/lib/canvas/types'
import type { Point } from '@/lib/canvas/engine/geometry'
import { ACCESS_CHANGED_EVENT, presenceTopic } from '@/lib/canvas/presence'

export { ACCESS_CHANGED_EVENT, presenceTopic }

type Row = Partial<CanvasItemRow> & { canvas_id?: string; id?: string }

/** A stable text for "is this the same item": the saved fields, keys in order. */
export function rowSignature(row: Pick<CanvasItemRow, 'parent_id' | 'sort_key' | 'kind' | 'data'>): string {
  const ordered = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(ordered) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, ordered((v as Record<string, unknown>)[k])])) : v
  return JSON.stringify([row.parent_id ?? null, row.sort_key, row.kind, ordered(row.data ?? {})])
}

export interface LiveTarget {
  /** Is a drag or a stroke in progress? */
  busy(): boolean
  /** Does this item have a local change not yet saved? */
  pending(id: string): boolean
  apply(put: CanvasItem[], remove: string[]): void
}

export class RemoteChanges {
  private sent = new Map<string, string>()
  private put = new Map<string, CanvasItem>()
  private removed = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private canvasId: string,
    private target: LiveTarget,
    private retryMs = 120,
  ) {}

  /** What this editor just saved: its own echo is recognised by this. */
  noteSent(rows: readonly CanvasItemRow[], removed: readonly string[]): void {
    for (const row of rows) this.sent.set(row.id, rowSignature(row))
    for (const id of removed) this.sent.set(id, 'removed')
    if (this.sent.size > 6000) {
      // Old entries only matter for a late echo; drop the oldest half.
      const keep = [...this.sent.entries()].slice(-3000)
      this.sent = new Map(keep)
    }
  }

  /** A row changed in the database. */
  onRow(event: 'INSERT' | 'UPDATE' | 'DELETE', next: Row | null, old: Row | null): void {
    if (event === 'DELETE') {
      // A delete carries only the row's key, and comes unfiltered: check it is ours.
      if (!old || old.canvas_id !== this.canvasId || typeof old.id !== 'string') return
      if (this.sent.get(old.id) === 'removed') return
      if (this.target.pending(old.id)) return
      this.put.delete(old.id)
      this.removed.add(old.id)
    } else {
      if (!next || next.canvas_id !== this.canvasId || typeof next.id !== 'string') return
      const row = next as CanvasItemRow
      if (this.sent.get(row.id) === rowSignature(row)) return
      if (this.target.pending(row.id)) return
      const item = rowToItem(row)
      if (!item) return
      this.removed.delete(row.id)
      this.put.set(row.id, item)
    }
    this.flush()
  }

  /** Hand over what has arrived, unless a gesture is in progress (then soon after). */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.put.size && !this.removed.size) return
    if (this.target.busy()) {
      this.timer = setTimeout(() => this.flush(), this.retryMs)
      return
    }
    // A local change made while this waited still wins.
    const put = [...this.put.values()].filter((it) => !this.target.pending(it.id))
    const remove = [...this.removed].filter((id) => !this.target.pending(id))
    this.put.clear()
    this.removed.clear()
    if (put.length || remove.length) this.target.apply(put, remove)
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.put.clear()
    this.removed.clear()
  }
}

// ── Presence ────────────────────────────────────────────────────────────────

export interface Peer {
  /** One per open editor (a person with two tabs is two peers). */
  key: string
  userId: string
  name: string
  color: string
  cursor: Point | null
  selection: string[]
  /** When this was last heard from (ms). */
  at: number
}

export const PRESENCE = { minGap: 60, heartbeat: 3000, expire: 10_000 } as const
const PEER_COLORS = ['#e11d48', '#7c3aed', '#0891b2', '#ca8a04', '#16a34a', '#db2777', '#2563eb', '#ea580c']

/** A color for a person, the same every time for the same id. */
export function peerColor(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return PEER_COLORS[h % PEER_COLORS.length]
}

export class PeerList {
  private peers = new Map<string, Peer>()
  private listeners = new Set<() => void>()
  private snapshot: readonly Peer[] = []

  constructor(private selfKey: string) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  get = (): readonly Peer[] => this.snapshot
  private emit(): void {
    this.snapshot = [...this.peers.values()].sort((a, b) => (a.key < b.key ? -1 : 1))
    for (const fn of [...this.listeners]) fn()
  }

  /** Something another editor said about itself. Anything malformed is ignored. */
  hear(msg: unknown, now: number): void {
    const m = msg as Partial<Peer> & { gone?: boolean }
    if (!m || typeof m.key !== 'string' || m.key === this.selfKey || m.key.length > 80) return
    if (m.gone) {
      if (this.peers.delete(m.key)) this.emit()
      return
    }
    if (typeof m.userId !== 'string') return
    const cursor = m.cursor && Number.isFinite(m.cursor.x) && Number.isFinite(m.cursor.y) ? { x: m.cursor.x, y: m.cursor.y } : null
    this.peers.set(m.key, {
      key: m.key,
      userId: m.userId,
      name: typeof m.name === 'string' ? m.name.slice(0, 60) : 'Someone',
      color: typeof m.color === 'string' && /^#[0-9a-f]{6}$/i.test(m.color) ? m.color : peerColor(m.userId),
      cursor,
      selection: Array.isArray(m.selection) ? m.selection.filter((s): s is string => typeof s === 'string').slice(0, 200) : [],
      at: now,
    })
    this.emit()
  }

  /** Forget anyone not heard from for a while. */
  prune(now: number): void {
    let changed = false
    for (const [key, p] of this.peers) {
      if (now - p.at > PRESENCE.expire) {
        this.peers.delete(key)
        changed = true
      }
    }
    if (changed) this.emit()
  }
}

/** Sends this editor's cursor and selection: no more often than every 60 ms, and at least every 3 s. */
export class PresenceSender {
  private last = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private beat: ReturnType<typeof setInterval> | null = null
  private state: { cursor: Point | null; selection: string[] } = { cursor: null, selection: [] }

  constructor(
    private me: { key: string; userId: string; name: string; color: string },
    private send: (payload: Record<string, unknown>) => void,
    private now: () => number = Date.now,
  ) {}

  start(): void {
    this.beat = setInterval(() => this.push(true), PRESENCE.heartbeat)
    this.push(true)
  }

  update(patch: Partial<{ cursor: Point | null; selection: string[] }>): void {
    this.state = { ...this.state, ...patch }
    this.push(false)
  }

  private push(force: boolean): void {
    const wait = PRESENCE.minGap - (this.now() - this.last)
    if (!force && wait > 0) {
      if (!this.timer) this.timer = setTimeout(() => ((this.timer = null), this.push(true)), wait)
      return
    }
    this.last = this.now()
    const c = this.state.cursor
    this.send({ ...this.me, cursor: c ? { x: Math.round(c.x), y: Math.round(c.y) } : null, selection: this.state.selection.slice(0, 200) })
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    if (this.beat) clearInterval(this.beat)
    this.timer = null
    this.beat = null
    this.send({ key: this.me.key, gone: true })
  }
}

// ── The presence room ───────────────────────────────────────────────────────

/** What the room needs of the Supabase client, small enough to stand in for in a test. */
export interface RoomChannel {
  on(type: 'broadcast', filter: { event: string }, cb: (m: { payload?: unknown }) => void): RoomChannel
  subscribe(cb: (status: string) => void): unknown
  send(msg: { type: 'broadcast'; event: string; payload: Record<string, unknown> }): unknown
}
export interface RoomClient {
  realtime: { setAuth(): Promise<unknown> }
  channel(topic: string, opts: { config: { private: boolean; broadcast: { self: boolean } } }): RoomChannel
  removeChannel(channel: RoomChannel): unknown
}

export const ROOM = { firstRetry: 1000, retryCap: 30_000, attempts: 6 } as const

/**
 * This editor's place in a canvas's presence room.
 *
 * The room is a PRIVATE channel: the server lets in only whoever may open the
 * canvas (682's realtime.messages policies), judged from the person's own
 * token, so the token is attached (`setAuth`) before every join, and again
 * before every retry, because a drop often comes with an expired one. A join
 * that is refused or times out is retried with a growing wait, a handful of
 * times; after that the room stays shut and the editor simply shows nobody
 * else. Nothing but cursors depends on it: saving and other people's saved
 * changes travel elsewhere.
 */
export class PresenceRoom {
  private channel: RoomChannel | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private wait: number = ROOM.firstRetry
  private failures = 0
  private stopped = false
  /** 'joining' until the first answer; 'open' while joined; 'shut' once it gave up. */
  state: 'joining' | 'open' | 'shut' = 'joining'

  constructor(
    private client: RoomClient,
    private canvasId: string,
    private hooks: {
      hear: (payload: unknown) => void
      open: () => void
      closed: () => void
      /** The server said the canvas's sharing changed (lib/canvas/access-notice.ts): ask again whether this person may still open it. */
      accessChanged?: () => void
    },
  ) {}

  start(): void {
    void this.join()
  }

  /** Say something to the room; dropped unless joined. */
  send(payload: Record<string, unknown>): void {
    if (this.state !== 'open' || !this.channel) return
    try {
      void Promise.resolve(this.channel.send({ type: 'broadcast', event: 'peer', payload })).catch(() => {})
    } catch {
      // A socket that closed under us: the status callback will hear of it.
    }
  }

  private async join(): Promise<void> {
    try {
      await this.client.realtime.setAuth()
    } catch {
      // No token to attach: the join below is refused, and counted like any other.
    }
    if (this.stopped) return
    const channel = this.client.channel(presenceTopic(this.canvasId), { config: { private: true, broadcast: { self: false } } })
    this.channel = channel
    channel.on('broadcast', { event: 'peer' }, (m) => {
      if (channel === this.channel) this.hooks.hear(m.payload)
    })
    channel.on('broadcast', { event: ACCESS_CHANGED_EVENT }, () => {
      if (channel === this.channel && !this.stopped) this.hooks.accessChanged?.()
    })
    channel.subscribe((status) => {
      // A replaced channel has nothing more to say.
      if (channel !== this.channel || this.stopped) return
      if (status === 'SUBSCRIBED') {
        this.failures = 0
        this.wait = ROOM.firstRetry
        if (this.state !== 'open') {
          this.state = 'open'
          this.hooks.open()
        }
        return
      }
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') this.lost()
    })
  }

  private lost(): void {
    const dead = this.channel
    this.channel = null
    if (this.state === 'open') this.hooks.closed()
    if (dead) void Promise.resolve(this.client.removeChannel(dead)).catch(() => {})
    this.failures += 1
    if (this.failures >= ROOM.attempts) {
      this.state = 'shut'
      return
    }
    this.state = 'joining'
    if (this.timer) return
    const delay = this.wait
    this.wait = Math.min(this.wait * 2, ROOM.retryCap)
    this.timer = setTimeout(() => {
      this.timer = null
      if (!this.stopped) void this.join()
    }, delay)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const c = this.channel
    this.channel = null
    if (c) void Promise.resolve(this.client.removeChannel(c)).catch(() => {})
  }
}
