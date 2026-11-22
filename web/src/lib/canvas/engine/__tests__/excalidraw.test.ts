import { describe, expect, it } from 'vitest'
import type { ConnectorItem, GroupItem, RectangleItem } from '../../types'
import { fromExcalidraw, parseExcalidraw } from '../excalidraw'

const base = { angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', strokeWidth: 2, strokeStyle: 'solid', opacity: 100, groupIds: [], isDeleted: false }
const clip = (elements: unknown[]) => JSON.stringify({ type: 'excalidraw/clipboard', elements })

describe('pasting from Excalidraw', () => {
  it('only reads its own JSON', () => {
    expect(parseExcalidraw('hello')).toBeNull()
    expect(parseExcalidraw('{"type":"excalidraw","elements":"no"}')).toBeNull()
    expect(parseExcalidraw('{"type":"other excalidraw thing","elements":[]}')).toBeNull()
    expect(parseExcalidraw(clip([]))).toEqual([])
  })

  it('brings shapes, text, ink and arrows across, with labels, ties and groups', () => {
    const elements = parseExcalidraw(
      clip([
        { ...base, id: 'r', type: 'rectangle', x: 0, y: 0, width: 100, height: 60, backgroundColor: '#FFC9C9', roundness: { type: 3 }, groupIds: ['inner', 'outer'] },
        { ...base, id: 'rt', type: 'text', x: 10, y: 20, width: 80, height: 20, text: 'Start', fontSize: 16, fontFamily: 1, containerId: 'r' },
        { ...base, id: 'd', type: 'diamond', x: 300, y: 0, width: 80, height: 80, strokeStyle: 'dashed', groupIds: ['outer'] },
        { ...base, id: 'e', type: 'ellipse', x: 0, y: 200, width: 50, height: 50, opacity: 50, angle: 0.5 },
        { ...base, id: 't', type: 'text', x: 0, y: 300, width: 120, height: 25, text: 'Loose words', fontSize: 20, fontFamily: 3, textAlign: 'center', strokeColor: '#e03131' },
        { ...base, id: 'f', type: 'freedraw', x: 400, y: 400, width: 20, height: 10, points: [[0, 0], [10, 10], [20, 0]], pressures: [0.2, 0.8, 0.4], simulatePressure: false },
        { ...base, id: 'a', type: 'arrow', x: 100, y: 30, width: 200, height: 10, points: [[0, 0], [100, 40], [200, 10]], startBinding: { elementId: 'r' }, endBinding: { elementId: 'gone' }, endArrowhead: 'triangle' },
        { ...base, id: 'l', type: 'line', x: 0, y: 500, width: 50, height: 0, points: [[0, 0], [50, 0]], strokeStyle: 'dotted' },
        { ...base, id: 'img', type: 'image', x: 0, y: 0, width: 10, height: 10 },
        { ...base, id: 'x', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, isDeleted: true },
      ]),
    )!
    const items = fromExcalidraw(elements)
    const byKind = (kind: string) => items.filter((i) => i.kind === kind)
    expect(byKind('rectangle')).toHaveLength(2)
    expect(byKind('ellipse')).toHaveLength(1)
    expect(byKind('text')).toHaveLength(1)
    expect(byKind('pencil')).toHaveLength(1)
    expect(byKind('connector')).toHaveLength(2)
    expect(byKind('image')).toHaveLength(0)

    const r = byKind('rectangle')[0] as RectangleItem
    expect(r).toMatchObject({ x: 0, y: 0, w: 100, h: 60, label: { plain: 'Start' } })
    expect(r.style).toMatchObject({ fill: '#ffc9c9', stroke: 'theme:ink', radius: 15 })
    expect((byKind('rectangle')[1] as RectangleItem).style.strokeStyle).toBe('dashed')
    expect(byKind('ellipse')[0]).toMatchObject({ rotation: 0.5, style: { opacity: 0.5 } })
    expect(byKind('text')[0]).toMatchObject({ content: { plain: 'Loose words' }, text: { fontFamily: 'mono', align: 'center', color: '#e03131' } })
    expect(byKind('pencil')[0]).toMatchObject({ x: 400, y: 400, pen: true })

    const [arrow, line] = byKind('connector') as ConnectorItem[]
    expect(arrow.start.bind).toEqual({ id: r.id, anchor: 'center' })
    expect(arrow.end.bind).toBeUndefined()
    expect(arrow).toMatchObject({ endHead: 'filled', startHead: 'none', end: { x: 300, y: 40 } })
    expect(line).toMatchObject({ endHead: 'none', style: { strokeStyle: 'dotted' } })

    // inner is inside outer; the diamond is in outer directly.
    const groups = byKind('group') as GroupItem[]
    expect(groups).toHaveLength(2)
    const outer = groups.find((g) => g.parentId === null)!
    const inner = groups.find((g) => g.parentId === outer.id)!
    expect(r.parentId).toBe(inner.id)
    expect(byKind('rectangle')[1].parentId).toBe(outer.id)
    // Fresh ids, in order.
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length)
    expect(items.every((i) => !['r', 'd', 'e'].includes(i.id))).toBe(true)
  })
})
