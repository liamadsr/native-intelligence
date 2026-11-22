import { describe, expect, it } from 'vitest'
import type { CanvasItem, ConnectorItem, RectangleItem, TextItem } from '../types'
import { agentColor, applyAgentOps, describeCanvas, estimateText, type AgentOp } from '../agent'
import { ordered } from '../engine/scene'

const run = (items: readonly CanvasItem[], ops: AgentOp[]) => applyAgentOps(items, ops)
const list = (r: ReturnType<typeof run>) => ordered(r.scene) as CanvasItem[]

describe('an agent edits a canvas', () => {
  it('draws a small flow in one batch, tying arrows to what it just made', () => {
    const r = run([], [
      { op: 'create_shape', key: 'a', shape: 'rectangle', x: 0, y: 0, text: 'Research', fill: 'soft-blue' },
      { op: 'create_shape', key: 'b', shape: 'ellipse', x: 480, y: 0, w: 200, h: 100, text: 'Launch' },
      { op: 'connect', from: 'a', to: 'b', label: 'then', route: 'elbow' },
      { op: 'create_text', x: 0, y: 200, text: 'Ship by Friday', font_size: 24 },
    ])
    expect(r.errors).toEqual([])
    expect(r.done).toBe(4)
    const [a, b, k, t] = list(r)
    expect(a).toMatchObject({ kind: 'rectangle', x: 0, y: 0, w: 320, h: 80, label: { plain: 'Research' }, style: { fill: 'theme:blue-soft' } })
    expect(r.created.a).toBe(a.id)
    const c = k as ConnectorItem
    expect(c.start.bind).toEqual({ id: a.id, anchor: 'center' })
    expect(c.end.bind).toEqual({ id: b.id, anchor: 'center' })
    expect(c).toMatchObject({ route: 'elbow', endHead: 'arrow', label: { plain: 'then' } })
    // Settled: the arrow starts on the rectangle's edge, not its middle.
    expect(c.start.x).toBe(320)
    expect((t as TextItem).text.fontSize).toBe(24)
    expect(t.w).toBeGreaterThan(100)
    // Everything is a change to save.
    expect(r.step).toHaveLength(4)
    expect(r.step.every((ch) => ch.before === null && ch.after)).toBe(true)
  })

  it('grows a box to hold its words', () => {
    const long = 'A sentence long enough that it cannot sit on one line of a narrow box and has to wrap several times over.'
    const r = run([], [{ op: 'create_shape', shape: 'rectangle', x: 0, y: 0, w: 160, h: 40, text: long }])
    expect(list(r)[0].w).toBe(160)
    expect(list(r)[0].h).toBeGreaterThan(100)
    expect(estimateText('ab\ncd', 20)).toEqual({ w: 23, h: 56 })
  })

  it('moves, resizes, styles, retitles, groups, restacks and deletes what is there', () => {
    const first = run([], [
      { op: 'create_shape', key: 'a', shape: 'rectangle', x: 0, y: 0, w: 100, h: 50 },
      { op: 'create_shape', key: 'b', shape: 'rectangle', x: 200, y: 0, w: 100, h: 50 },
      { op: 'connect', key: 'k', from: 'a', to: 'b' },
    ])
    const [a, b, k] = list(first)
    const r = run(list(first), [
      { op: 'move', ids: [b.id], dx: 0, dy: 100 },
      { op: 'move', ids: [a.id], x: 10, y: 10 },
      { op: 'resize', id: a.id, w: 200 },
      { op: 'style', ids: [a.id, b.id], fill: '#FF0000', stroke_style: 'dashed', stroke_width: 4, opacity: 0.5 },
      { op: 'set_text', id: a.id, text: 'Start' },
      { op: 'group', key: 'g', ids: [a.id, b.id] },
      { op: 'order', ids: [k.id], to: 'back' },
    ])
    expect(r.errors).toEqual([])
    const items = r.scene.items
    expect(items[b.id]).toMatchObject({ x: 200, y: 100 })
    expect(items[a.id]).toMatchObject({ x: 10, y: 10, w: 200, h: 50, label: { plain: 'Start' } })
    expect((items[a.id] as RectangleItem).style).toMatchObject({ fill: '#ff0000', strokeStyle: 'dashed', strokeWidth: 4, opacity: 0.5 })
    expect(items[a.id].parentId).toBe(r.created.g)
    // The arrow followed both moves, and went to the back.
    const c = items[k.id] as ConnectorItem
    expect(c.end.y).toBeGreaterThan(90)
    expect(ordered(r.scene)[0].id).toBe(k.id)
    const del = run(Object.values(items), [{ op: 'delete', ids: [r.created.g] }])
    expect(Object.values(del.scene.items).map((i) => i.kind)).toEqual(['connector'])
    expect(del.step.filter((ch) => ch.after === null)).toHaveLength(3)
  })

  it('refuses a bad operation with a reason and still applies the rest', () => {
    const r = run([], [
      { op: 'create_shape', key: 'a', shape: 'rectangle', x: 0, y: 0 },
      { op: 'connect', from: 'a', to: 'nowhere' },
      { op: 'style', ids: ['a'], fill: 'chartreuse-ish' },
      { op: 'connect', from: 'a', to: 'a' },
      { op: 'move', ids: ['a'] },
      { op: 'resize', id: 'ghost', w: 10 },
      { op: 'group', ids: ['a'] },
      { op: 'explode' } as unknown as AgentOp,
      { op: 'create_text', x: 0, y: 300, text: '   ' },
      { op: 'create_shape', shape: 'rectangle', x: Number.NaN, y: 0 },
      { op: 'create_text', x: 0, y: 300, text: 'Still here' },
    ])
    expect(r.done).toBe(2)
    expect(r.errors.map((e) => e.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(r.errors[0].error).toContain('no item "nowhere"')
    expect(r.errors[1].error).toContain('a color is one of')
    expect(r.errors[2].error).toBe('from and to are the same item')
    expect(list(r).map((i) => i.kind)).toEqual(['rectangle', 'text'])
  })

  it('stops at a hundred operations and says so', () => {
    const ops: AgentOp[] = Array.from({ length: 130 }, (_, i) => ({ op: 'create_shape', shape: 'rectangle', x: i * 10, y: 0, w: 8, h: 8 }))
    const r = run([], ops)
    expect(r.done).toBe(100)
    expect(r.errors).toEqual([{ index: 100, op: 'batch', error: 'only the first 100 operations were applied' }])
  })

  it('names colors the way the palette does', () => {
    expect(agentColor('Blue')).toBe('theme:blue')
    expect(agentColor('Soft blue')).toBe('theme:blue-soft')
    expect(agentColor('blue-soft')).toBe('theme:blue-soft')
    expect(agentColor('theme:ink')).toBe('theme:ink')
    expect(agentColor('none')).toBe('transparent')
    expect(agentColor('#abc')).toBe('#aabbcc')
    expect(agentColor('not a color')).toBeNull()
    expect(agentColor(undefined)).toBeUndefined()
  })
})

describe('an agent reads a canvas', () => {
  it('lists items back to front with their words, ties and groups', () => {
    const made = run([], [
      { op: 'create_shape', key: 'a', shape: 'rectangle', x: 0, y: 0, w: 100, h: 50, text: 'Start', fill: 'green' },
      { op: 'create_shape', key: 'b', shape: 'ellipse', x: 300, y: 0, w: 100, h: 50 },
      { op: 'connect', key: 'k', from: 'a', to: { x: 500, y: 500 } },
      { op: 'group', key: 'g', ids: ['a', 'b'] },
    ])
    const read = describeCanvas(list(made))
    expect(read.total).toBe(4)
    expect(read.omitted).toBe(0)
    expect(read.kinds).toEqual({ rectangle: 1, ellipse: 1, connector: 1, group: 1 })
    expect(read.bounds).toMatchObject({ x: 0, y: 0 })
    const a = read.items.find((i) => i.id === made.created.a)!
    expect(a).toMatchObject({ kind: 'rectangle', x: 0, y: 0, w: 100, h: 50, text: 'Start', fill: 'green', group: made.created.g })
    expect(a.stroke).toBeUndefined()
    const k = read.items.find((i) => i.kind === 'connector')!
    expect(k.from).toBe(made.created.a)
    expect(k.to).toEqual({ x: 500, y: 500 })
    expect(k.heads).toBe('none>arrow')
    // A group reports the box around what is in it.
    expect(read.items.find((i) => i.kind === 'group')).toMatchObject({ x: 0, y: 0, w: 400, h: 50 })
  })

  it('caps a big canvas and counts what it left out', () => {
    const ops: AgentOp[] = Array.from({ length: 100 }, (_, i) => ({ op: 'create_shape', shape: 'rectangle', x: i * 10, y: 0, w: 8, h: 8 }))
    let items: CanvasItem[] = []
    for (let i = 0; i < 4; i++) items = list(run(items, ops))
    const read = describeCanvas(items)
    expect(read.total).toBe(400)
    expect(read.items).toHaveLength(300)
    expect(read.omitted).toBe(100)
  })
})
