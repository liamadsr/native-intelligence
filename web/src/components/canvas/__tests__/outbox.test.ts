import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasItem } from '@/lib/canvas/types'
import { diffScenes } from '@/lib/canvas/engine/history'
import { sceneFromItems } from '@/lib/canvas/engine/scene'
import { OUTBOX, Outbox, outboxKey, withUnsent, type OutboxStorage } from '../outbox'
import { CanvasSync, type Send } from '../sync'

const C = 'canvas-1'
const box = (id: string, x = 0, extra: Record<string, unknown> = {}): CanvasItem => ({ id, kind: 'rectangle', parentId: null, sortKey: `a${id}`, x, y: 0, w: 10, h: 10, rotation: 0, style: {}, ...extra }) as unknown as CanvasItem

function storage(opts: { full?: boolean } = {}) {
  const data = new Map<string, string>()
  const s: OutboxStorage = {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      if (opts.full) throw new Error('QuotaExceededError')
      data.set(k, v)
    },
    removeItem: (k) => void data.delete(k),
  }
  return { s, data }
}

describe('the outbox', () => {
  it('keeps what is unsent and gives it back as items', () => {
    const { s, data } = storage()
    const out = new Outbox(s, C, 'user-1')
    out.write({ upsert: [box('a', 5)], remove: ['gone'] })
    expect([...data.keys()]).toEqual([outboxKey(C, 'user-1')])
    const back = new Outbox(s, C, 'user-1').read()
    expect(back?.upsert.map((i) => [i.id, i.x])).toEqual([['a', 5]])
    expect(back?.remove).toEqual(['gone'])
  })

  it('is one person\'s on one canvas: nobody else, and no other canvas, reads it', () => {
    const { s } = storage()
    new Outbox(s, C, 'user-1').write({ upsert: [box('a')], remove: [] })
    expect(new Outbox(s, C, 'user-2').read()).toBeNull()
    expect(new Outbox(s, 'canvas-2', 'user-1').read()).toBeNull()
  })

  it('clears itself when nothing is unsent', () => {
    const { s, data } = storage()
    const out = new Outbox(s, C, 'u')
    out.write({ upsert: [box('a')], remove: [] })
    out.write({ upsert: [], remove: [] })
    expect(data.size).toBe(0)
  })

  it('drops an entry that is too old, from the future, of another version, or not JSON', () => {
    const { s, data } = storage()
    let now = 1_000_000_000_000
    const out = new Outbox(s, C, 'u', () => now)
    out.write({ upsert: [box('a')], remove: [] })
    now += OUTBOX.maxAgeMs + 1
    expect(out.read()).toBeNull()
    expect(data.size).toBe(0)
    out.write({ upsert: [box('a')], remove: [] })
    now -= 3_600_000
    expect(out.read()).toBeNull()
    data.set(outboxKey(C, 'u'), JSON.stringify({ v: 99, at: now, upsert: [], remove: ['x'] }))
    expect(out.read()).toBeNull()
    data.set(outboxKey(C, 'u'), '{not json')
    expect(out.read()).toBeNull()
  })

  it('never keeps a local preview\'s address, and drops media whose file never arrived', () => {
    const { s, data } = storage()
    const out = new Outbox(s, C, 'u')
    out.write({
      upsert: [
        box('img', 0, { kind: 'image', src: 'blob:http://x/1', naturalW: 1, naturalH: 1 }),
        box('ok', 0, { kind: 'image', path: 'canvas/w/c/f.png', src: 'blob:http://x/2', naturalW: 1, naturalH: 1 }),
      ],
      remove: [],
    })
    expect([...data.values()][0]).not.toContain('blob:')
    expect(out.read()?.upsert.map((i) => i.id)).toEqual(['ok'])
  })

  it('keeps nothing rather than part of it when it is too big, and survives storage that refuses', () => {
    const { s, data } = storage()
    const out = new Outbox(s, C, 'u')
    out.write({ upsert: [box('a')], remove: [] })
    out.write({ upsert: [box('big', 0, { label: { plain: 'x'.repeat(OUTBOX.maxChars) } })], remove: [] })
    expect(data.size).toBe(0)
    const full = new Outbox(storage({ full: true }).s, C, 'u')
    expect(() => full.write({ upsert: [box('a')], remove: [] })).not.toThrow()
    expect(new Outbox(null, C, 'u').read()).toBeNull()
    expect(() => new Outbox(null, C, 'u').write({ upsert: [box('a')], remove: [] })).not.toThrow()
  })

  it('lays what was unsent over what the server has', () => {
    const merged = withUnsent([box('a', 1), box('b', 1), box('c', 1)], { upsert: [box('b', 9), box('new', 3, { parentId: 'no-such-group' })], remove: ['c'] })
    expect(merged.map((i) => [i.id, i.x, i.parentId])).toEqual([
      ['a', 1, null],
      ['b', 9, null],
      ['new', 3, null],
    ])
    expect(withUnsent([box('a')], null)).toHaveLength(1)
  })
})

describe('the save queue keeps what the server does not have', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const step = (before: CanvasItem[], after: CanvasItem[]) => diffScenes(sceneFromItems(before), sceneFromItems(after))

  function rig(answers: boolean[]) {
    const { s, data } = storage()
    const sent: Array<{ upsert: string[]; remove: string[] }> = []
    let hold: (() => void) | null = null
    const send: Send = async (body) => {
      sent.push({ upsert: body.upsert.map((r) => r.id), remove: body.remove })
      await new Promise<void>((r) => (hold = r))
      return answers.shift() ?? true
    }
    const outbox = new Outbox(s, C, 'u')
    const sync = new CanvasSync(C, send, 500, outbox)
    return { sync, outbox, data, sent, release: async () => { hold?.(); await vi.advanceTimersByTimeAsync(0) } }
  }

  it('holds an edit from the moment it is made until the server has it', async () => {
    const r = rig([true])
    r.sync.push(step([], [box('a', 1)]))
    expect(r.outbox.read()?.upsert.map((i) => i.id)).toEqual(['a'])
    await vi.advanceTimersByTimeAsync(500)
    // On its way, and still kept: the tab could die before the answer.
    expect(r.sent).toHaveLength(1)
    expect(r.outbox.read()?.upsert.map((i) => i.id)).toEqual(['a'])
    await r.release()
    expect(r.outbox.read()).toBeNull()
    expect(r.data.size).toBe(0)
  })

  it('keeps a failed batch together with what was edited while it was out', async () => {
    const r = rig([false])
    r.sync.push(step([], [box('a', 1)]))
    await vi.advanceTimersByTimeAsync(500)
    r.sync.push(step([box('b', 1)], []))
    expect(r.outbox.read()).toMatchObject({ remove: ['b'] })
    expect(r.outbox.read()?.upsert.map((i) => i.id)).toEqual(['a'])
    await r.release()
    expect(r.sync.getState()).toBe('error')
    expect(r.outbox.read()?.upsert.map((i) => i.id)).toEqual(['a'])
    expect(r.outbox.read()?.remove).toEqual(['b'])
  })

  it('sends what an earlier visit left, at once, under anything newer', async () => {
    const r = rig([true])
    r.sync.push(step([], [box('a', 7)]))
    r.sync.restore({ upsert: [box('a', 1), box('old', 2)], remove: ['dead'] })
    expect(r.sync.getState()).toBe('unsaved')
    await vi.advanceTimersByTimeAsync(0)
    expect(r.sent[0].upsert.sort()).toEqual(['a', 'old'])
    expect(r.sent[0].remove).toEqual(['dead'])
    await r.release()
    expect(r.sync.getState()).toBe('saved')
  })
})
