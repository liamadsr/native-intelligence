import { beforeEach, describe, expect, it } from 'vitest'
import type { CanvasItem, ConnectorItem, TextItem } from '@/lib/canvas/types'
import { painted } from '@/lib/canvas/engine/scene'
import { Interaction, type PointerInput } from '../interaction'
import { CanvasStore } from '../store'
import { CanvasSync } from '../sync'

const P = (x: number, y: number, extra: Partial<PointerInput> = {}): PointerInput => ({ x, y, button: 0, shift: false, alt: false, mod: false, pressure: 0.5, pointerType: 'mouse', ...extra })
const key = (k: string, extra: Partial<{ shift: boolean; alt: boolean; mod: boolean }> = {}) => ({ key: k, shift: false, alt: false, mod: false, ...extra })

let store: CanvasStore
let ix: Interaction

function drag(from: [number, number], to: [number, number], extra: Partial<PointerInput> = {}, steps = 4) {
  ix.pointerDown(P(from[0], from[1], extra))
  for (let i = 1; i <= steps; i++) ix.pointerMove(P(from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps, extra))
  ix.pointerUp(P(to[0], to[1], extra))
}
const click = (x: number, y: number, extra: Partial<PointerInput> = {}) => {
  ix.pointerDown(P(x, y, extra))
  ix.pointerUp(P(x, y, extra))
}
const items = () => painted(store.getState().scene)
const drawRect = (from: [number, number], to: [number, number]) => {
  store.setTool('rectangle')
  drag(from, to)
  return store.getState().selection[0]
}

beforeEach(() => {
  store = new CanvasStore('canvas-1')
  store.setViewport(1000, 800)
  ix = new Interaction(store)
  // Fill new shapes so a click anywhere on them picks them.
  store.setDefaults({ shape: { ...store.getState().defaults.shape, fill: '#ffffff' } })
})

describe('drawing', () => {
  it('draws a rectangle, selects it and hands back to Select', () => {
    const id = drawRect([100, 100], [300, 200])
    expect(store.getState().tool).toBe('select')
    expect(store.getState().scene.items[id]).toMatchObject({ kind: 'rectangle', x: 100, y: 100, w: 200, h: 100 })
    expect(store.getState().history.past).toHaveLength(1)
  })

  it('keeps the tool when asked to, with nothing left selected', () => {
    store.setToolLock(true)
    store.setTool('ellipse')
    drag([0, 0], [50, 50])
    drag([100, 0], [150, 50])
    expect(store.getState().tool).toBe('ellipse')
    expect(store.getState().selection).toEqual([])
    expect(items()).toHaveLength(2)
  })

  it('makes a square with Shift and throws away a speck', () => {
    store.setTool('rectangle')
    drag([0, 0], [100, 40], { shift: true })
    expect(items()[0]).toMatchObject({ w: 100, h: 100 })
    store.setTool('rectangle')
    drag([500, 500], [502, 501])
    expect(items()).toHaveLength(1)
    expect(store.getState().history.past).toHaveLength(1)
  })

  it('draws in world units under a moved, zoomed camera', () => {
    store.setCamera({ x: 100, y: 50, scale: 2 })
    const id = drawRect([100, 50], [300, 250])
    expect(store.getState().scene.items[id]).toMatchObject({ x: 0, y: 0, w: 100, h: 100 })
  })

  it('draws ink that stays in hand, one step a stroke', () => {
    store.setTool('pencil')
    drag([10, 10], [100, 60], {}, 8)
    drag([10, 100], [100, 160], {}, 8)
    expect(store.getState().tool).toBe('pencil')
    expect(items().map((i) => i.kind)).toEqual(['pencil', 'pencil'])
    expect(store.getState().history.past).toHaveLength(2)
    // A tap is a dot.
    click(300, 300)
    expect(items()).toHaveLength(3)
  })

  it('erases what the stroke crosses, as one step', () => {
    drawRect([0, 0], [50, 50])
    drawRect([100, 0], [150, 50])
    drawRect([300, 300], [350, 350])
    store.setTool('eraser')
    drag([-20, 25], [170, 25], {}, 20)
    expect(items()).toHaveLength(1)
    store.undo()
    expect(items()).toHaveLength(3)
  })
})

describe('selecting and moving', () => {
  it('clicks, shift-clicks and marquees', () => {
    const a = drawRect([0, 0], [50, 50])
    const b = drawRect([100, 0], [150, 50])
    click(25, 25)
    expect(store.getState().selection).toEqual([a])
    click(125, 25, { shift: true })
    expect(store.getState().selection).toEqual([a, b])
    click(125, 25, { shift: true })
    expect(store.getState().selection).toEqual([a])
    click(500, 500)
    expect(store.getState().selection).toEqual([])
    drag([-10, -10], [160, 60])
    expect([...store.getState().selection].sort()).toEqual([a, b].sort())
    expect(store.getState().overlay.marquee).toBeNull()
  })

  it('moves by dragging, as one undo step, and Escape puts a drag back', () => {
    const a = drawRect([0, 0], [50, 50])
    drag([25, 25], [125, 75])
    expect(store.getState().scene.items[a]).toMatchObject({ x: 100, y: 50 })
    expect(store.getState().history.past).toHaveLength(2)
    ix.pointerDown(P(125, 75))
    ix.pointerMove(P(300, 300))
    expect(store.getState().scene.items[a]).toMatchObject({ x: 275, y: 275 })
    ix.keyDown(key('Escape'))
    expect(store.getState().scene.items[a]).toMatchObject({ x: 100, y: 50 })
    ix.pointerUp(P(300, 300))
    expect(store.getState().history.past).toHaveLength(2)
  })

  it('keeps a drag on one axis with Shift, even when Shift goes down mid-drag', () => {
    const a = drawRect([0, 0], [50, 50])
    ix.pointerDown(P(25, 25))
    ix.pointerMove(P(125, 45))
    expect(store.getState().scene.items[a]).toMatchObject({ x: 100, y: 20 })
    ix.keyDown(key('Shift', { shift: true }))
    expect(store.getState().scene.items[a]).toMatchObject({ x: 100, y: 0 })
    ix.pointerUp(P(125, 45, { shift: true }))
  })

  it('snaps to a neighbour and shows the guide while it does', () => {
    drawRect([0, 0], [50, 50])
    const b = drawRect([200, 200], [250, 250])
    ix.pointerDown(P(225, 225))
    ix.pointerMove(P(28, 165))
    expect(store.getState().scene.items[b].x).toBe(0)
    expect(store.getState().overlay.guides.length).toBeGreaterThan(0)
    ix.pointerUp(P(28, 165))
    expect(store.getState().overlay.guides).toEqual([])
    // Too far off across the axis to catch (the reach is 160 px).
    drag([25, 165], [28, 600])
    expect(store.getState().scene.items[b].x).toBe(3)
    store.setPrefs({ snapObjects: false })
    drag([28, 600], [34, 165])
    expect(store.getState().scene.items[b].x).toBe(9)
  })

  it('duplicates with an Alt-drag in one step, and leaves nothing on a click', () => {
    const a = drawRect([0, 0], [50, 50])
    drag([25, 25], [225, 25], { alt: true })
    expect(items()).toHaveLength(2)
    const copy = store.getState().selection[0]
    expect(copy).not.toBe(a)
    expect(store.getState().scene.items[copy].x).toBe(200)
    expect(store.getState().scene.items[a].x).toBe(0)
    store.undo()
    expect(items()).toHaveLength(1)
    click(25, 25, { alt: true })
    expect(items()).toHaveLength(1)
  })

  it('resizes from a corner and turns from the knob', () => {
    const a = drawRect([100, 100], [200, 200])
    drag([200, 200], [300, 250])
    expect(store.getState().scene.items[a]).toMatchObject({ x: 100, y: 100, w: 200, h: 150 })
    // The knob sits above the top edge's middle.
    drag([200, 74], [326, 175], { shift: true }, 6)
    expect(store.getState().scene.items[a].rotation).toBeCloseTo(Math.PI / 2, 1)
  })

  it('nudges, restacks and deletes from the keyboard', () => {
    const a = drawRect([0, 0], [50, 50])
    const b = drawRect([20, 20], [70, 70])
    click(60, 60)
    ix.keyDown(key('ArrowRight'))
    ix.keyDown(key('ArrowDown', { shift: true }))
    expect(store.getState().scene.items[b]).toMatchObject({ x: 21, y: 30 })
    ix.keyDown(key('['))
    expect(items().map((i) => i.id)).toEqual([b, a])
    ix.keyDown(key('Backspace'))
    expect(items().map((i) => i.id)).toEqual([a])
    ix.keyDown(key('z', { mod: true }))
    expect(items()).toHaveLength(2)
    ix.keyDown(key('z', { mod: true, shift: true }))
    expect(items()).toHaveLength(1)
  })

  it('groups, moves the group from one of its members, and reaches inside with Cmd', () => {
    const a = drawRect([0, 0], [50, 50])
    const b = drawRect([100, 0], [150, 50])
    ix.keyDown(key('a', { mod: true }))
    ix.keyDown(key('g', { mod: true }))
    const g = store.getState().selection[0]
    expect(store.getState().scene.items[g].kind).toBe('group')
    click(500, 500)
    drag([25, 25], [25, 125])
    expect(store.getState().selection).toEqual([g])
    expect(store.getState().scene.items[b].y).toBe(100)
    click(500, 500)
    click(125, 125, { mod: true })
    expect(store.getState().selection).toEqual([b])
    ix.keyDown(key('Escape'))
    click(25, 125)
    ix.keyDown(key('g', { mod: true, shift: true }))
    expect([...store.getState().selection].sort()).toEqual([a, b].sort())
  })

  it('does not edit when the canvas is view-only', () => {
    const a = drawRect([0, 0], [50, 50])
    store.setReadOnly(true)
    drag([25, 25], [200, 200])
    expect(store.getState().scene.items[a]).toMatchObject({ x: 0, y: 0 })
    ix.keyDown(key('r'))
    expect(store.getState().tool).toBe('select')
    ix.keyDown(key('Backspace'))
    expect(items()).toHaveLength(1)
    click(25, 25)
    expect(store.getState().selection).toEqual([a])
  })
})

describe('connectors', () => {
  it('ties an arrow to the shapes it is drawn between and follows them', () => {
    const a = drawRect([0, 0], [100, 100])
    const b = drawRect([300, 0], [400, 100])
    store.setTool('arrow')
    // From a's right edge middle to anywhere on b: an edge tie and a center tie.
    ix.pointerDown(P(98, 50))
    ix.pointerMove(P(200, 50))
    ix.pointerMove(P(360, 30))
    expect(store.getState().overlay.bind).toEqual({ id: b, anchor: 'center' })
    ix.pointerUp(P(360, 30))
    const k = items().find((i) => i.kind === 'connector') as ConnectorItem
    expect(k.start.bind).toEqual({ id: a, anchor: 'right' })
    expect(k.end.bind).toEqual({ id: b, anchor: 'center' })
    expect(k.endHead).toBe('arrow')
    expect(k.end).toMatchObject({ x: 300, y: 50 })
    click(350, 50)
    drag([350, 50], [350, 250])
    const after = store.getState().scene.items[k.id] as ConnectorItem
    expect(after.start).toMatchObject({ x: 100, y: 50 })
    expect(after.end.y).toBeGreaterThan(200)
  })

  it('draws a plain line with L, snapped to 45 degrees with Shift, and drops a click', () => {
    ix.keyDown(key('l'))
    drag([100, 100], [300, 110], { shift: true })
    const k = items()[0] as ConnectorItem
    expect(k.endHead).toBe('none')
    expect(k.end.y).toBeCloseTo(100)
    store.setTool('line')
    click(500, 500)
    expect(items()).toHaveLength(1)
  })

  it('re-ties an end by dragging it, and lets it go on empty canvas', () => {
    const a = drawRect([300, 0], [400, 100])
    store.setTool('line')
    drag([0, 300], [200, 300])
    const id = store.getState().selection[0]
    drag([200, 300], [350, 50])
    expect((store.getState().scene.items[id] as ConnectorItem).end.bind).toEqual({ id: a, anchor: 'center' })
    const end = (store.getState().scene.items[id] as ConnectorItem).end
    drag([end.x, end.y], [600, 600])
    expect((store.getState().scene.items[id] as ConnectorItem).end.bind).toBeUndefined()
  })
})

describe('text', () => {
  it('leaves nothing behind when a new text box is left empty', () => {
    store.setTool('text')
    click(100, 100)
    const id = store.getState().editing!
    expect(store.getState().scene.items[id].kind).toBe('text')
    ix.finishEditing('   ')
    expect(items()).toHaveLength(0)
    expect(store.getState().history.past).toHaveLength(0)
    expect(store.getState().tool).toBe('select')
  })

  it('commits typed words as one step; a dragged box wraps', () => {
    store.setTool('text')
    click(100, 100)
    ix.finishEditing('Hello')
    const t = items()[0] as TextItem
    expect(t).toMatchObject({ content: { plain: 'Hello' }, autoWidth: true, x: 100, y: 100 })
    expect(store.getState().history.past).toHaveLength(1)
    expect(store.getState().selection).toEqual([t.id])
    store.setTool('text')
    drag([100, 300], [400, 305])
    ix.finishEditing('Wraps')
    expect(items()[1]).toMatchObject({ autoWidth: false, w: 300 })
  })

  it('double-click types on empty canvas, labels a shape, and Enter edits the selection', () => {
    ix.doubleClick(P(600, 600))
    ix.finishEditing('Note')
    expect(items()).toHaveLength(1)
    const a = drawRect([0, 0], [100, 100])
    ix.doubleClick(P(50, 50))
    expect(store.getState().editing).toBe(a)
    ix.finishEditing('Start')
    expect((store.getState().scene.items[a] as Extract<CanvasItem, { kind: 'rectangle' }>).label).toEqual({ plain: 'Start' })
    ix.keyDown(key('Enter'))
    expect(store.getState().editing).toBe(a)
    ix.finishEditing('')
    expect((store.getState().scene.items[a] as Extract<CanvasItem, { kind: 'rectangle' }>).label).toBeUndefined()
  })

  it('removes an old text box that is emptied', () => {
    store.setTool('text')
    click(100, 100)
    ix.finishEditing('Hello')
    const id = items()[0].id
    store.setEditing(id)
    ix.finishEditing('')
    expect(items()).toHaveLength(0)
    store.undo()
    expect(items()).toHaveLength(1)
  })
})

describe('clipboard and view', () => {
  it('steps each paste on the same canvas, and pastes in place', () => {
    const a = drawRect([0, 0], [50, 50])
    const f = store.copyFragment()!
    store.pasteFragment(f)
    store.pasteFragment(f)
    const xs = items().map((i) => i.x)
    expect(xs).toEqual([0, 24, 48])
    store.pasteFragment(f, true)
    expect(items()[3]).toMatchObject({ x: 0, y: 0 })
    expect(items()[3].id).not.toBe(a)
  })

  it('centers a paste from another canvas in the view', () => {
    const other = new CanvasStore('canvas-2')
    other.setViewport(1000, 800)
    const oix = new Interaction(other)
    other.setTool('rectangle')
    oix.pointerDown(P(5000, 5000))
    oix.pointerMove(P(5100, 5100))
    oix.pointerUp(P(5100, 5100))
    store.pasteFragment(other.copyFragment()!)
    expect(items()[0]).toMatchObject({ x: 450, y: 350, w: 100, h: 100 })
  })

  it('fits everything and zooms with the keys', () => {
    drawRect([0, 0], [4000, 2000])
    ix.keyDown(key('Escape'))
    ix.keyDown(key('.'))
    expect(store.camera.scale).toBeCloseTo(0.2)
    ix.keyDown(key('=', { mod: true }))
    expect(store.camera.scale).toBeCloseTo(0.24)
    // What is mounted covers the view.
    expect(store.getState().cull).not.toBeNull()
  })

  it('takes in what someone else changed without an undo step', () => {
    const a = drawRect([0, 0], [50, 50])
    const mine = store.getState().history.past.length
    store.applyRemote([{ ...store.getState().scene.items[a], x: 500 }], [])
    expect(store.getState().scene.items[a].x).toBe(500)
    expect(store.getState().history.past).toHaveLength(mine)
    store.applyRemote([], [a])
    expect(store.getState().selection).toEqual([])
    expect(items()).toHaveLength(0)
  })
})

describe('saving', () => {
  it('sends only what changed, the last state of each item, and retries a failure', async () => {
    const sent: Array<{ upsert: string[]; remove: string[] }> = []
    let fail = true
    const sync = new CanvasSync(
      'canvas-1',
      async (body) => {
        if (fail) return false
        sent.push({ upsert: body.upsert.map((r) => `${r.id}@${(r.data as { x: number }).x}`), remove: body.remove })
        return true
      },
      10_000,
    )
    store.onChange((step) => sync.push(step))
    const a = drawRect([0, 0], [50, 50])
    drag([25, 25], [125, 25])
    const b = drawRect([300, 300], [350, 350])
    click(325, 325)
    store.deleteSelection()
    expect(sync.state).toBe('unsaved')
    await sync.flush()
    expect(sync.state).toBe('error')
    expect(sync.pending).toBe(true)
    fail = false
    await sync.flush()
    expect(sent).toEqual([{ upsert: [`${a}@100`], remove: [b] }])
    expect(sync.state).toBe('saved')
    expect(sync.pending).toBe(false)
    sync.stop()
  })
})
