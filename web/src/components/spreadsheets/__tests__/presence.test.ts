import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PRESENCE, ROOM, peerColor, type RoomChannel, type RoomClient } from '@/components/canvas/live'
import { SheetPeerList, SheetPresenceRoom, SpreadsheetPresence, presenceTopic, type SheetSelection } from '../presence'

type Chan = RoomChannel
type Client = RoomClient

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const rng = (r1: number, c1: number, r2: number, c2: number) => ({ r1, c1, r2, c2 })

describe('who else is here', () => {
  it('lists the others, ignores itself and nonsense, keeps the valid, and forgets the silent', () => {
    const peers = new SheetPeerList('me')
    let seen = 0
    peers.subscribe(() => seen++)
    peers.hear({ key: 'me', userId: 'u1', sheetId: 1, range: rng(1, 1, 1, 1), active: { row: 1, column: 1 } }, 0) // itself
    peers.hear(
      { key: 'tab-2', userId: 'u2', name: 'Mara Quill', color: '#112233', sheetId: 2, range: rng(4, 1, 2, 3), active: { row: 2, column: 1 } },
      1000,
    )
    peers.hear('nonsense', 1000)
    peers.hear({ key: 'tab-x' }, 1000) // no userId / sheet / range
    expect(peers.get().map((p) => p.key)).toEqual(['tab-2'])
    // The range came in unordered (r1 > r2); it is stored ordered.
    expect(peers.get()[0]).toMatchObject({ name: 'Mara Quill', color: '#112233', sheetId: 2, range: rng(2, 1, 4, 3), active: { row: 2, column: 1 } })
    peers.prune(12_000)
    expect(peers.get()).toEqual([])
    peers.hear({ key: 'tab-2', userId: 'u2', sheetId: 2, range: rng(1, 1, 1, 1), active: { row: 1, column: 1 } }, 13_000)
    expect(peers.get()).toHaveLength(1)
    peers.hear({ key: 'tab-2', gone: true }, 13_100)
    expect(peers.get()).toEqual([])
    expect(seen).toBeGreaterThan(3)
  })

  it('ignores malformed numbers and falls back for a bad colour, cutting an overlong name', () => {
    const peers = new SheetPeerList('me')
    const base = { key: 'k', userId: 'u9', sheetId: 0, active: { row: 1, column: 1 } }
    peers.hear({ ...base, range: { r1: 1.5, c1: 1, r2: 1, c2: 1 } }, 1) // non-integer row
    peers.hear({ ...base, range: rng(1, 20_000, 1, 20_001) }, 1) // column past MAX_COLUMNS (16384)
    peers.hear({ ...base, range: rng(0, 1, 1, 1) }, 1) // row below 1
    peers.hear({ ...base, range: rng(1, 1, 1, 1), active: { row: 0, column: 1 } }, 1) // bad active cell
    expect(peers.get()).toEqual([])
    peers.hear({ ...base, range: rng(1, 1, 1, 1), color: 'red', name: 'x'.repeat(200) }, 1)
    const p = peers.get()[0]
    expect(p.color).toBe(peerColor('u9'))
    expect(p.name).toHaveLength(60)
  })
})

// A fake Supabase client that records joins, auth calls, channels and sends.
function client(opts: { auth?: () => Promise<unknown> } = {}) {
  const log: string[] = []
  const channels: Array<{ topic: string; config: unknown; status: (s: string) => void; hear: (p: unknown) => void; sent: unknown[]; removed: boolean }> = []
  const c: Client = {
    realtime: {
      setAuth: () => {
        log.push('auth')
        return opts.auth ? opts.auth() : Promise.resolve()
      },
    },
    channel(topic, o) {
      log.push('join')
      const entry = { topic, config: o.config, status: (_s: string) => {}, hear: (_p: unknown) => {}, sent: [] as unknown[], removed: false }
      channels.push(entry)
      const ch: Chan & { entry: typeof entry } = {
        entry,
        on(_t, _f, cb) {
          entry.hear = (p) => cb({ payload: p })
          return ch
        },
        subscribe(cb) {
          entry.status = cb
        },
        send(m) {
          entry.sent.push(m.payload)
        },
      }
      return ch
    },
    removeChannel(ch) {
      ;(ch as unknown as { entry: { removed: boolean } }).entry.removed = true
    },
  }
  return { c, log, channels }
}
const ID = '3f2b8c1e-5a4d-4e6f-9a7b-0c1d2e3f4a5b'

describe('the presence room', () => {
  const hooks = () => {
    const seen = { heard: [] as unknown[], open: 0, closed: 0 }
    return { seen, h: { hear: (p: unknown) => void seen.heard.push(p), open: () => void seen.open++, closed: () => void seen.closed++ } }
  }

  it("joins a spreadsheet's private channel after attaching the token", async () => {
    const { c, log, channels } = client()
    const { h } = hooks()
    const room = new SheetPresenceRoom(c, ID, h)
    room.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(log).toEqual(['auth', 'join'])
    expect(channels[0].topic).toBe(`spreadsheet-presence:${ID}`)
    expect(presenceTopic('ABC-123')).toBe('spreadsheet-presence:abc-123')
    expect(channels[0].config).toEqual({ private: true, broadcast: { self: false } })
  })

  it('re-attaches the token before every retry, waits longer each time, then stays shut and quiet', async () => {
    const { c, log, channels } = client()
    const { seen, h } = hooks()
    const room = new SheetPresenceRoom(c, ID, h)
    room.start()
    await vi.advanceTimersByTimeAsync(0)
    let wait: number = ROOM.firstRetry
    for (let i = 1; i < ROOM.attempts; i++) {
      channels[channels.length - 1].status('CHANNEL_ERROR')
      expect(channels[channels.length - 1].removed).toBe(true)
      await vi.advanceTimersByTimeAsync(wait - 1)
      expect(channels).toHaveLength(i)
      await vi.advanceTimersByTimeAsync(1)
      expect(channels).toHaveLength(i + 1)
      wait = Math.min(wait * 2, ROOM.retryCap)
    }
    expect(log.filter((l) => l === 'auth')).toHaveLength(ROOM.attempts)
    channels[channels.length - 1].status('CHANNEL_ERROR')
    await vi.advanceTimersByTimeAsync(ROOM.retryCap * 4)
    expect(channels).toHaveLength(ROOM.attempts)
    expect(room.state).toBe('shut')
    expect(seen.open).toBe(0)
    room.send({ a: 1 })
    expect(channels.every((ch) => ch.sent.length === 0)).toBe(true)
  })

  it('still tries to join when no token can be attached, and throws nothing', async () => {
    const { c, channels } = client({ auth: () => Promise.reject(new Error('no session')) })
    const room = new SheetPresenceRoom(c, ID, hooks().h)
    room.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(channels).toHaveLength(1)
    channels[0].status('TIMED_OUT')
    room.stop()
    await vi.advanceTimersByTimeAsync(ROOM.retryCap)
    expect(channels).toHaveLength(1)
  })
})

describe('the presence controller', () => {
  const me = { key: 'me', userId: 'u1', name: 'Me', color: '#000000' }
  const here = (sheetId: number): SheetSelection => ({ sheetId, range: rng(1, 1, 1, 1), active: { row: 1, column: 1 } })

  it('once open it says where it is, throttles, heartbeats, and says the new selection', async () => {
    const { c, channels } = client()
    let clock = 1_000_000
    const p = new SpreadsheetPresence(c, ID, me, here(5), () => clock)
    p.start()
    await vi.advanceTimersByTimeAsync(0)
    channels[0].status('SUBSCRIBED')
    expect(channels[0].sent).toEqual([{ ...me, sheetId: 5, range: rng(1, 1, 1, 1), active: { row: 1, column: 1 } }])
    // Three quick moves inside one minGap go out as one, latest only.
    for (let r = 2; r <= 4; r++) {
      clock += 5
      p.update({ sheetId: 5, range: rng(r, 1, r, 1), active: { row: r, column: 1 } })
    }
    expect(channels[0].sent).toHaveLength(1)
    clock += PRESENCE.minGap
    await vi.advanceTimersByTimeAsync(PRESENCE.minGap)
    expect(channels[0].sent).toHaveLength(2)
    expect(channels[0].sent[1]).toMatchObject({ range: rng(4, 1, 4, 1), active: { row: 4, column: 1 } })
    // The heartbeat re-sends on its own.
    const n = channels[0].sent.length
    clock += 3000
    await vi.advanceTimersByTimeAsync(3000)
    expect(channels[0].sent.length).toBeGreaterThan(n)
  })

  it('on a hidden tab it says goodbye and leaves; shown again it rejoins and re-says', async () => {
    const { c, channels } = client()
    let clock = 1_000_000
    const p = new SpreadsheetPresence(c, ID, me, here(7), () => clock)
    p.start()
    await vi.advanceTimersByTimeAsync(0)
    channels[0].status('SUBSCRIBED')
    expect(channels[0].sent).toHaveLength(1)

    p.setVisible(false)
    expect(channels[0].sent.at(-1)).toEqual({ key: 'me', gone: true })
    expect(channels[0].removed).toBe(true)
    // No heartbeat while hidden.
    const sentWhileHidden = channels[0].sent.length
    clock += 10_000
    await vi.advanceTimersByTimeAsync(10_000)
    expect(channels[0].sent).toHaveLength(sentWhileHidden)
    expect(channels).toHaveLength(1)

    p.setVisible(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(channels).toHaveLength(2) // a fresh join
    expect(channels[1].config).toEqual({ private: true, broadcast: { self: false } })
    channels[1].status('SUBSCRIBED')
    expect(channels[1].sent).toEqual([{ ...me, sheetId: 7, range: rng(1, 1, 1, 1), active: { row: 1, column: 1 } }])
    p.stop()
    expect(channels[1].sent.at(-1)).toEqual({ key: 'me', gone: true })
    expect(channels[1].removed).toBe(true)
  })

  it('stays quiet when the room never opens (no 689): nothing sent, nothing thrown', async () => {
    const { c, channels } = client()
    const p = new SpreadsheetPresence(c, ID, me, here(1))
    p.start()
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < ROOM.attempts + 2; i++) {
      channels[channels.length - 1]?.status('CHANNEL_ERROR')
      await vi.advanceTimersByTimeAsync(ROOM.retryCap)
    }
    p.update(here(1))
    expect(channels.every((ch) => ch.sent.length === 0)).toBe(true)
    p.stop()
  })

  it('prunes peers it stops hearing from', async () => {
    const { c } = client()
    let clock = 0
    const p = new SpreadsheetPresence(c, ID, me, here(1), () => clock)
    p.peers.hear({ key: 'other', userId: 'u2', sheetId: 1, range: rng(1, 1, 1, 1), active: { row: 1, column: 1 } }, clock)
    p.start()
    expect(p.peers.get()).toHaveLength(1)
    clock = 20_000
    await vi.advanceTimersByTimeAsync(2100) // the prune interval
    expect(p.peers.get()).toEqual([])
    p.stop()
  })
})
