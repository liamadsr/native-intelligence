import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasItem, CanvasItemRow } from '@/lib/canvas/types'
import { PeerList, PresenceRoom, PresenceSender, ROOM, RemoteChanges, peerColor, rowSignature, type RoomChannel, type RoomClient } from '../live'

const row = (id: string, x: number, extra: Partial<CanvasItemRow> = {}): CanvasItemRow => ({ canvas_id: 'c1', id, parent_id: null, sort_key: 'a1', kind: 'rectangle', data: { x, y: 0, w: 10, h: 10, rotation: 0, style: {} }, ...extra })

function target() {
  const state = { busy: false, pending: new Set<string>(), applied: [] as Array<{ put: string[]; remove: string[] }> }
  return {
    state,
    live: {
      busy: () => state.busy,
      pending: (id: string) => state.pending.has(id),
      apply: (put: CanvasItem[], remove: string[]) => void state.applied.push({ put: put.map((p) => `${p.id}@${p.x}`), remove }),
    },
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('taking in what other people saved', () => {
  it('applies another editor\'s rows and deletes, for this canvas only', () => {
    const t = target()
    const rc = new RemoteChanges('c1', t.live)
    rc.onRow('INSERT', row('a', 5), null)
    rc.onRow('UPDATE', row('a', 9), row('a', 5))
    rc.onRow('INSERT', row('z', 1, { canvas_id: 'other' }), null)
    rc.onRow('DELETE', null, { canvas_id: 'c1', id: 'a' })
    rc.onRow('DELETE', null, { canvas_id: 'other', id: 'a' })
    rc.onRow('DELETE', null, { id: 'a' })
    expect(t.state.applied).toEqual([
      { put: ['a@5'], remove: [] },
      { put: ['a@9'], remove: [] },
      { put: [], remove: ['a'] },
    ])
  })

  it('does not take its own save back in, whatever order the keys come back in', () => {
    const t = target()
    const rc = new RemoteChanges('c1', t.live)
    rc.noteSent([row('a', 5)], ['gone'])
    rc.onRow('UPDATE', { ...row('a', 5), data: { style: {}, rotation: 0, h: 10, w: 10, y: 0, x: 5 }, updated_at: 'now' }, null)
    rc.onRow('DELETE', null, { canvas_id: 'c1', id: 'gone' })
    expect(t.state.applied).toEqual([])
    // The same item, changed by someone else since: that is taken.
    rc.onRow('UPDATE', row('a', 6), null)
    expect(t.state.applied).toEqual([{ put: ['a@6'], remove: [] }])
    expect(rowSignature(row('a', 5))).toBe(rowSignature({ ...row('a', 5), data: { style: {}, rotation: 0, h: 10, w: 10, y: 0, x: 5 } }))
  })

  it('keeps a local change that is still waiting to be saved', () => {
    const t = target()
    const rc = new RemoteChanges('c1', t.live)
    t.state.pending.add('a')
    rc.onRow('UPDATE', row('a', 50), null)
    rc.onRow('DELETE', null, { canvas_id: 'c1', id: 'a' })
    rc.onRow('UPDATE', row('b', 7), null)
    expect(t.state.applied).toEqual([{ put: ['b@7'], remove: [] }])
  })

  it('holds what arrives during a drag and hands it over, latest state only, when the drag ends', () => {
    const t = target()
    const rc = new RemoteChanges('c1', t.live, 100)
    t.state.busy = true
    rc.onRow('UPDATE', row('a', 1), null)
    rc.onRow('UPDATE', row('a', 2), null)
    rc.onRow('INSERT', row('b', 3), null)
    rc.onRow('DELETE', null, { canvas_id: 'c1', id: 'b' })
    vi.advanceTimersByTime(350)
    expect(t.state.applied).toEqual([])
    t.state.busy = false
    vi.advanceTimersByTime(100)
    expect(t.state.applied).toEqual([{ put: ['a@2'], remove: ['b'] }])
    rc.stop()
  })
})

describe('who else is here', () => {
  it('lists the others, ignores itself and nonsense, and forgets the silent', () => {
    const peers = new PeerList('me')
    let seen = 0
    peers.subscribe(() => seen++)
    peers.hear({ key: 'me', userId: 'u1', name: 'Me' }, 0)
    peers.hear({ key: 'tab-2', userId: 'u2', name: 'Mara Quill', color: '#112233', cursor: { x: 10, y: 20 }, selection: ['a', 7, 'b'] }, 1000)
    peers.hear({ key: 'tab-3', userId: 'u3', cursor: { x: 'left', y: 0 }, color: 'red' }, 1000)
    peers.hear('nonsense', 1000)
    peers.hear({ key: 'tab-4' }, 1000)
    expect(peers.get().map((p) => p.key)).toEqual(['tab-2', 'tab-3'])
    expect(peers.get()[0]).toMatchObject({ name: 'Mara Quill', color: '#112233', cursor: { x: 10, y: 20 }, selection: ['a', 'b'] })
    expect(peers.get()[1]).toMatchObject({ name: 'Someone', cursor: null, color: peerColor('u3') })
    peers.hear({ key: 'tab-2', userId: 'u2', name: 'Mara Quill', cursor: null }, 9000)
    peers.prune(11_500)
    expect(peers.get().map((p) => p.key)).toEqual(['tab-2'])
    peers.hear({ key: 'tab-2', gone: true }, 12_000)
    expect(peers.get()).toEqual([])
    expect(seen).toBeGreaterThan(3)
  })

  it('sends a cursor at most every 60 ms, the last position always, a heartbeat every 3 s, and a goodbye', () => {
    const sent: Array<Record<string, unknown>> = []
    let clock = 1_000_000
    const sender = new PresenceSender({ key: 'me', userId: 'u1', name: 'Me', color: '#000000' }, (p) => void sent.push(p), () => clock)
    sender.start()
    expect(sent).toHaveLength(1)
    for (let i = 1; i <= 10; i++) {
      clock += 5
      vi.advanceTimersByTime(5)
      sender.update({ cursor: { x: i, y: i } })
    }
    expect(sent).toHaveLength(1)
    clock += 20
    vi.advanceTimersByTime(20)
    expect(sent).toHaveLength(2)
    expect(sent[1]).toMatchObject({ key: 'me', cursor: { x: 10, y: 10 }, selection: [] })
    clock += 3000
    vi.advanceTimersByTime(3000)
    expect(sent.length).toBeGreaterThanOrEqual(3)
    sender.stop()
    expect(sent[sent.length - 1]).toEqual({ key: 'me', gone: true })
    const count = sent.length
    vi.advanceTimersByTime(10_000)
    expect(sent).toHaveLength(count)
  })
})

describe('the presence room', () => {
  function client(opts: { auth?: () => Promise<unknown> } = {}) {
    const log: string[] = []
    const channels: Array<{ topic: string; config: unknown; status: (s: string) => void; hear: (p: unknown) => void; on: Record<string, (m: { payload?: unknown }) => void>; sent: unknown[]; removed: boolean }> = []
    const c: RoomClient = {
      realtime: {
        setAuth: () => {
          log.push('auth')
          return opts.auth ? opts.auth() : Promise.resolve()
        },
      },
      channel(topic, o) {
        log.push('join')
        const on: Record<string, (m: { payload?: unknown }) => void> = {}
        const entry = { topic, config: o.config, status: (_s: string) => {}, hear: (p: unknown) => on.peer?.({ payload: p }), on, sent: [] as unknown[], removed: false }
        channels.push(entry)
        const ch: RoomChannel & { entry: typeof entry } = {
          entry,
          on(_t, f, cb) {
            on[f.event] = cb
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
  const hooks = () => {
    const seen = { heard: [] as unknown[], open: 0, closed: 0 }
    return { seen, h: { hear: (p: unknown) => void seen.heard.push(p), open: () => void seen.open++, closed: () => void seen.closed++ } }
  }
  const ID = '3f2b8c1e-5a4d-4e6f-9a7b-0c1d2e3f4a5b'

  it('passes on the server\'s word that the sharing changed (688), from the channel it is on only', async () => {
    const { c, channels } = client()
    let asked = 0
    const room = new PresenceRoom(c, ID, { ...hooks().h, accessChanged: () => void asked++ })
    room.start()
    await vi.advanceTimersByTimeAsync(0)
    channels[0].status('SUBSCRIBED')
    channels[0].on.access_changed({ payload: {} })
    expect(asked).toBe(1)
    // A replaced channel, or a stopped room, has nothing more to say.
    channels[0].status('CHANNEL_ERROR')
    channels[0].on.access_changed({ payload: {} })
    expect(asked).toBe(1)
    room.stop()
  })

  it('attaches the person\'s token, then joins a private channel that does not echo', async () => {
    const { c, log, channels } = client()
    const { seen, h } = hooks()
    const room = new PresenceRoom(c, ID, h)
    room.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(log).toEqual(['auth', 'join'])
    expect(channels[0].topic).toBe(`canvas-presence:${ID}`)
    expect(channels[0].config).toEqual({ private: true, broadcast: { self: false } })
    room.send({ a: 1 })
    expect(channels[0].sent).toEqual([])
    channels[0].status('SUBSCRIBED')
    expect(seen.open).toBe(1)
    room.send({ a: 2 })
    expect(channels[0].sent).toEqual([{ a: 2 }])
    channels[0].hear({ key: 'k' })
    expect(seen.heard).toEqual([{ key: 'k' }])
  })

  it('re-attaches the token before every retry, waits longer each time, and gives up quietly', async () => {
    const { c, log, channels } = client()
    const { seen, h } = hooks()
    const room = new PresenceRoom(c, ID, h)
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

  it('comes back after a drop, and a replaced channel is not listened to', async () => {
    const { c, channels } = client()
    const { seen, h } = hooks()
    const room = new PresenceRoom(c, ID, h)
    room.start()
    await vi.advanceTimersByTimeAsync(0)
    channels[0].status('SUBSCRIBED')
    channels[0].status('CLOSED')
    expect(seen.closed).toBe(1)
    channels[0].hear({ late: true })
    channels[0].status('SUBSCRIBED')
    expect(seen.heard).toEqual([])
    expect(seen.open).toBe(1)
    await vi.advanceTimersByTimeAsync(ROOM.firstRetry)
    channels[1].status('SUBSCRIBED')
    expect(seen.open).toBe(2)
    expect(room.state).toBe('open')
  })

  it('still tries to join when no token can be attached, and joins nothing once stopped', async () => {
    const { c, channels } = client({ auth: () => Promise.reject(new Error('no session')) })
    const room = new PresenceRoom(c, ID, hooks().h)
    room.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(channels).toHaveLength(1)
    channels[0].status('TIMED_OUT')
    room.stop()
    await vi.advanceTimersByTimeAsync(ROOM.retryCap)
    expect(channels).toHaveLength(1)

    const slow = client({ auth: () => new Promise((r) => setTimeout(r, 50)) })
    const second = new PresenceRoom(slow.c, ID, hooks().h)
    second.start()
    second.stop()
    await vi.advanceTimersByTimeAsync(100)
    expect(slow.channels).toHaveLength(0)
  })
})
