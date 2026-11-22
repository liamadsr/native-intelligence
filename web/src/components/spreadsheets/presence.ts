/**
 * One spreadsheet open in more than one place: who else is here and, for each
 * of them, the cell or range they have selected, on the sheet they are on.
 *
 * It copies the canvas's presence (src/components/canvas/live.ts) exactly in
 * shape and rules — a PRIVATE Realtime channel the server lets in only whoever
 * may open the spreadsheet (migration 689's policies), the token attached before
 * every join and retry, a handful of growing retries and then quiet — but
 * travels the spreadsheet's own selection instead of a cursor. Nothing but
 * presence depends on it: saving and other people's saved changes travel
 * elsewhere (the editor's PATCH and poll).
 *
 * `peerColor`, `PRESENCE`, `ROOM` and the room's client types are the canvas's,
 * reused read-only; the classes here are the spreadsheet's own.
 */
import { MAX_COLUMNS, MAX_ROWS, type CellRange } from '@/lib/spreadsheets/a1'
import { PRESENCE, ROOM, peerColor, type RoomChannel, type RoomClient } from '@/components/canvas/live'

export { peerColor }

/** Where a peer is: the sheet (by its stable engine id), its range and its active cell. */
export interface SheetSelection {
  sheetId: number
  range: CellRange
  active: { row: number; column: number }
}

export interface SheetPeer extends SheetSelection {
  /** One per open editor (a person with two tabs is two peers). */
  key: string
  userId: string
  name: string
  color: string
  /** When this was last heard from (ms). */
  at: number
}

/** A person for the wire: who they are and the colour drawn for them. */
export interface SheetMe {
  key: string
  userId: string
  name: string
  color: string
}

// ── Who else is here ──────────────────────────────────────────────────────────

/** A 1-based cell within the grid, or null if the numbers are not that. */
function cell(row: unknown, column: unknown): { row: number; column: number } | null {
  if (!Number.isInteger(row) || !Number.isInteger(column)) return null
  const r = row as number
  const c = column as number
  if (r < 1 || r > MAX_ROWS || c < 1 || c > MAX_COLUMNS) return null
  return { row: r, column: c }
}

/** A range with every corner a cell in the grid, re-ordered (r1 <= r2, c1 <= c2), or null. */
function cleanRange(v: unknown): CellRange | null {
  if (!v || typeof v !== 'object') return null
  const { r1, c1, r2, c2 } = v as Record<string, unknown>
  const a = cell(r1, c1)
  const b = cell(r2, c2)
  if (!a || !b) return null
  return { r1: Math.min(a.row, b.row), c1: Math.min(a.column, b.column), r2: Math.max(a.row, b.row), c2: Math.max(a.column, b.column) }
}

export class SheetPeerList {
  private peers = new Map<string, SheetPeer>()
  private listeners = new Set<() => void>()
  private snapshot: readonly SheetPeer[] = []

  constructor(private selfKey: string) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  get = (): readonly SheetPeer[] => this.snapshot
  private emit(): void {
    this.snapshot = [...this.peers.values()].sort((a, b) => (a.key < b.key ? -1 : 1))
    for (const fn of [...this.listeners]) fn()
  }

  /** Something another editor said about itself. Anything malformed is ignored. */
  hear(msg: unknown, now: number): void {
    const m = msg as Partial<SheetPeer> & { gone?: boolean }
    if (!m || typeof m.key !== 'string' || m.key === this.selfKey || m.key.length > 80) return
    if (m.gone) {
      if (this.peers.delete(m.key)) this.emit()
      return
    }
    if (typeof m.userId !== 'string') return
    if (!Number.isInteger(m.sheetId) || (m.sheetId as number) < 0) return
    const range = cleanRange(m.range)
    const active = cell((m.active as { row?: unknown } | undefined)?.row, (m.active as { column?: unknown } | undefined)?.column)
    if (!range || !active) return
    this.peers.set(m.key, {
      key: m.key,
      userId: m.userId,
      name: typeof m.name === 'string' ? m.name.slice(0, 60) : 'Someone',
      color: typeof m.color === 'string' && /^#[0-9a-f]{6}$/i.test(m.color) ? m.color : peerColor(m.userId),
      sheetId: m.sheetId as number,
      range,
      active,
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

// ── The presence room ───────────────────────────────────────────────────────

/** The Realtime topic of a spreadsheet's presence room. Migration 689's policies read the id back out of it. */
export function presenceTopic(spreadsheetId: string): string {
  return `spreadsheet-presence:${spreadsheetId.toLowerCase()}`
}

/**
 * This editor's place in a spreadsheet's presence room — the canvas's
 * PresenceRoom, with the spreadsheet's topic. A PRIVATE channel: the server lets
 * in only whoever may open the spreadsheet (689's realtime.messages policies),
 * judged from the person's own token, so the token is attached (`setAuth`)
 * before every join, and again before every retry. A join that is refused or
 * times out is retried with a growing wait, a handful of times; after that the
 * room stays shut and the editor simply shows nobody else — which is what a
 * database without migration 689 does, and it must stay quiet.
 */
export class SheetPresenceRoom {
  private channel: RoomChannel | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private wait: number = ROOM.firstRetry
  private failures = 0
  private stopped = false
  /** 'joining' until the first answer; 'open' while joined; 'shut' once it gave up. */
  state: 'joining' | 'open' | 'shut' = 'joining'

  constructor(
    private client: RoomClient,
    private spreadsheetId: string,
    private hooks: { hear: (payload: unknown) => void; open: () => void; closed: () => void },
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
    const channel = this.client.channel(presenceTopic(this.spreadsheetId), { config: { private: true, broadcast: { self: false } } })
    this.channel = channel
    channel.on('broadcast', { event: 'peer' }, (m) => {
      if (channel === this.channel) this.hooks.hear(m.payload)
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

// ── The controller ────────────────────────────────────────────────────────────

/**
 * This editor's presence: it keeps the room, throttles what it sends (like the
 * canvas's PresenceSender — no more often than PRESENCE.minGap, and at least
 * every PRESENCE.heartbeat), prunes the silent, and handles a hidden tab.
 *
 * Hidden tab: when the tab is hidden it says `gone` and LEAVES the room (the
 * channel is removed, every timer stopped, no heartbeat while hidden). When it
 * is shown again it rejoins from scratch — a fresh room, so a fresh `setAuth`,
 * a fresh join and the retry counters reset — and says where it is.
 */
export class SpreadsheetPresence {
  readonly peers: SheetPeerList
  private room: SheetPresenceRoom | null = null
  private prune: ReturnType<typeof setInterval> | null = null
  private beat: ReturnType<typeof setInterval> | null = null
  private throttle: ReturnType<typeof setTimeout> | null = null
  private last = 0
  private joined = false
  private visible = true
  private started = false
  private stopped = false
  private here: SheetSelection

  constructor(
    private client: RoomClient,
    private spreadsheetId: string,
    private me: SheetMe,
    initial: SheetSelection,
    private now: () => number = Date.now,
  ) {
    this.peers = new SheetPeerList(me.key)
    this.here = initial
  }

  start(): void {
    if (this.started || this.stopped) return
    this.started = true
    this.prune = setInterval(() => this.peers.prune(this.now()), 2000)
    if (this.visible) this.join()
  }

  /** Where I am now; sent (throttled) once the room is open. */
  update(where: SheetSelection): void {
    this.here = where
    this.push(false)
  }

  /** The tab became hidden or shown. Hidden: say goodbye and leave. Shown: rejoin and re-say. */
  setVisible(visible: boolean): void {
    if (this.stopped || visible === this.visible) return
    this.visible = visible
    if (!this.started) return
    if (visible) this.join()
    else this.leave(true)
  }

  stop(): void {
    this.stopped = true
    if (this.prune) clearInterval(this.prune)
    this.prune = null
    this.leave(true)
  }

  private join(): void {
    if (this.room || this.stopped) return
    const room = new SheetPresenceRoom(this.client, this.spreadsheetId, {
      hear: (payload) => this.peers.hear(payload, this.now()),
      open: () => {
        this.joined = true
        this.beat = setInterval(() => this.push(true), PRESENCE.heartbeat)
        this.push(true)
      },
      closed: () => {
        this.joined = false
        if (this.beat) clearInterval(this.beat)
        this.beat = null
      },
    })
    this.room = room
    room.start()
  }

  private leave(sayGone: boolean): void {
    if (this.throttle) clearTimeout(this.throttle)
    this.throttle = null
    if (this.beat) clearInterval(this.beat)
    this.beat = null
    if (this.room) {
      if (sayGone && this.joined) this.room.send({ key: this.me.key, gone: true })
      this.room.stop()
      this.room = null
    }
    this.joined = false
  }

  private push(force: boolean): void {
    if (!this.room || !this.joined) return
    const wait = PRESENCE.minGap - (this.now() - this.last)
    if (!force && wait > 0) {
      if (!this.throttle) this.throttle = setTimeout(() => ((this.throttle = null), this.push(true)), wait)
      return
    }
    this.last = this.now()
    this.room.send({ ...this.me, sheetId: this.here.sheetId, range: this.here.range, active: this.here.active })
  }
}
