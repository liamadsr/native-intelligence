import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasItem, CanvasItemRow } from '@/lib/canvas/types'
import { PeerList, PresenceSender, RemoteChanges, peerColor, rowSignature } from '../live'

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
