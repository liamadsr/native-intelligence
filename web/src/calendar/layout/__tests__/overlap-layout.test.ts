import { describe, it, expect } from 'vitest'
import { layoutDayEvents, LAYER_INDENT, MAX_TOTAL_INDENT, type LayoutInput } from '../overlap-layout'

const at = (h: number, m = 0) => h * 60 + m
const ev = (id: string, start: number, end: number): LayoutInput => ({ id, start, end })
const box = (boxes: ReturnType<typeof layoutDayEvents>, id: string) => {
  const b = boxes.get(id)
  if (!b) throw new Error(`no box for ${id}`)
  return b
}
const right = (b: { left: number; width: number }) => b.left + b.width

describe('layoutDayEvents', () => {
  it('gives a lone event the whole column', () => {
    const boxes = layoutDayEvents([ev('a', at(9), at(10))])
    expect(box(boxes, 'a')).toMatchObject({ left: 0, width: 1, depth: 0, lanes: 1 })
  })

  it('leaves events that only touch at full width', () => {
    const boxes = layoutDayEvents([ev('a', at(9), at(10)), ev('b', at(10), at(11))])
    expect(box(boxes, 'a')).toMatchObject({ left: 0, width: 1 })
    expect(box(boxes, 'b')).toMatchObject({ left: 0, width: 1, depth: 0 })
  })

  it('puts two events with the same start side by side', () => {
    const boxes = layoutDayEvents([ev('a', at(13), at(14)), ev('b', at(13), at(14))])
    expect(box(boxes, 'a')).toMatchObject({ left: 0, width: 0.5, lanes: 2 })
    expect(box(boxes, 'b')).toMatchObject({ left: 0.5, width: 0.5, lanes: 2 })
  })

  it('gives the longer of two same-start events the left lane', () => {
    const boxes = layoutDayEvents([ev('short', at(9), at(9, 30)), ev('long', at(9), at(11))])
    expect(box(boxes, 'long').lane).toBe(0)
    expect(box(boxes, 'short').lane).toBe(1)
  })

  it('layers a later event on top of the earlier one, which keeps its full width', () => {
    const boxes = layoutDayEvents([ev('early', at(10), at(11, 30)), ev('late', at(10, 30), at(11))])
    const early = box(boxes, 'early')
    const late = box(boxes, 'late')
    expect(early).toMatchObject({ left: 0, width: 1, depth: 0 })
    expect(late.depth).toBe(1)
    expect(late.left).toBeCloseTo(LAYER_INDENT)
    expect(right(late)).toBeCloseTo(1)
    expect(late.zIndex).toBeGreaterThan(early.zIndex)
  })

  it('cascades a staircase of staggered meetings instead of cutting the column into slivers', () => {
    // The Friday from the screenshot: five meetings, each starting 15 minutes into the last.
    const boxes = layoutDayEvents([
      ev('qbr', at(10), at(12)),
      ev('contract', at(10, 15), at(11, 15)),
      ev('legal', at(10, 30), at(11)),
      ev('vendor', at(10, 45), at(11, 45)),
      ev('pickup', at(11), at(11, 30)),
    ])
    const order = ['qbr', 'contract', 'legal', 'vendor', 'pickup']
    order.forEach((id, i) => {
      const b = box(boxes, id)
      expect(b.depth).toBe(i)
      expect(right(b)).toBeCloseTo(1)
      // Every block stays well over half the column wide.
      expect(b.width).toBeGreaterThanOrEqual(1 - MAX_TOTAL_INDENT - 1e-9)
    })
    // Deeper is further right and painted later.
    for (let i = 1; i < order.length; i++) {
      expect(box(boxes, order[i]).left).toBeGreaterThan(box(boxes, order[i - 1]).left)
      expect(box(boxes, order[i]).zIndex).toBeGreaterThan(box(boxes, order[i - 1]).zIndex)
    }
  })

  it('never indents past its cap, however deep the stack', () => {
    const inputs = Array.from({ length: 9 }, (_, i) => ev(`e${i}`, at(9) + i * 15, at(15)))
    const boxes = layoutDayEvents(inputs)
    expect(box(boxes, 'e8').depth).toBe(8)
    expect(box(boxes, 'e8').left).toBeCloseTo(MAX_TOTAL_INDENT)
    expect(box(boxes, 'e8').width).toBeCloseTo(1 - MAX_TOTAL_INDENT)
  })

  it('layers a later event over a side-by-side pair', () => {
    const boxes = layoutDayEvents([ev('a', at(13), at(14)), ev('b', at(13), at(14)), ev('c', at(13, 30), at(14, 30))])
    expect(box(boxes, 'a').width).toBeCloseTo(0.5)
    expect(box(boxes, 'b').left).toBeCloseTo(0.5)
    const c = box(boxes, 'c')
    expect(c.depth).toBe(1)
    expect(c.left).toBeCloseTo(LAYER_INDENT)
    expect(right(c)).toBeCloseTo(1)
  })

  it('puts a side-by-side pair that starts later on top of a long block, sharing what is left', () => {
    const boxes = layoutDayEvents([ev('focus', at(9), at(12)), ev('x', at(10), at(11)), ev('y', at(10, 5), at(11))])
    expect(box(boxes, 'focus')).toMatchObject({ left: 0, width: 1, depth: 0 })
    const x = box(boxes, 'x')
    const y = box(boxes, 'y')
    expect(x.depth).toBe(1)
    expect(y.depth).toBe(1)
    expect(x.left).toBeCloseTo(LAYER_INDENT)
    expect(x.width).toBeCloseTo((1 - LAYER_INDENT) / 2)
    expect(y.left).toBeCloseTo(right(x))
    expect(right(y)).toBeCloseTo(1)
  })

  it('chains near starts into one side group (a, b close; b, c close)', () => {
    const boxes = layoutDayEvents([ev('a', at(10), at(11)), ev('b', at(10, 10), at(11)), ev('c', at(10, 20), at(11))])
    expect(['a', 'b', 'c'].map((id) => box(boxes, id).lane)).toEqual([0, 1, 2])
    expect(['a', 'b', 'c'].map((id) => box(boxes, id).depth)).toEqual([0, 0, 0])
    expect(box(boxes, 'c').width).toBeCloseTo(1 / 3)
  })

  it('widens an event over a lane that is free during its time', () => {
    // a and b start together; c starts close to b's end... a | b, then c chained to nothing: only a,b,c where c shares a's lane group.
    const boxes = layoutDayEvents([ev('a', at(9), at(9, 20)), ev('b', at(9, 10), at(10)), ev('c', at(9, 20), at(10))])
    // a: lane 0, b: lane 1, c: lane 0 again (a is over). All three are one side group of two lanes.
    expect(box(boxes, 'a')).toMatchObject({ lane: 0, lanes: 2 })
    expect(box(boxes, 'b')).toMatchObject({ lane: 1, lanes: 2 })
    expect(box(boxes, 'c')).toMatchObject({ lane: 0, lanes: 2 })
    expect(box(boxes, 'c').width).toBeCloseTo(0.5)
  })

  it('lets an event take the free lane to its right', () => {
    // a 9:00-9:15 and b 9:05-9:15 side by side; c 9:14-10:00 joins the group in lane 2... make lane 1 free for a later one.
    const boxes = layoutDayEvents([ev('a', at(9), at(10)), ev('b', at(9, 5), at(9, 20)), ev('c', at(9, 10), at(9, 25))])
    expect(box(boxes, 'a').lanes).toBe(3)
    // c is in the last lane; b has c to its right; a has b to its right.
    expect(box(boxes, 'a').width).toBeCloseTo(1 / 3)
    expect(right(box(boxes, 'c'))).toBeCloseTo(1)
  })

  it('counts a very short event as its drawn height, so back-to-back ones do not draw over each other', () => {
    // Two five-minute events five minutes apart: drawn 15 minutes tall, so they overlap on screen.
    const boxes = layoutDayEvents([ev('a', at(9), at(9, 5)), ev('b', at(9, 5), at(9, 10))])
    expect(box(boxes, 'a').lanes).toBe(2)
    expect(box(boxes, 'b').left).toBeCloseTo(0.5)
  })

  it('treats a zero-length event (a timed task) as drawable', () => {
    const boxes = layoutDayEvents([ev('task', at(17), at(17)), ev('meeting', at(17), at(18))])
    expect(box(boxes, 'meeting').lane).toBe(0)
    expect(box(boxes, 'task').lane).toBe(1)
  })

  it('starts over after a gap: a later cluster is not indented by an earlier one', () => {
    const boxes = layoutDayEvents([
      ev('a', at(9), at(10)),
      ev('b', at(9, 30), at(10)),
      ev('c', at(14), at(15)),
    ])
    expect(box(boxes, 'b').depth).toBe(1)
    expect(box(boxes, 'c')).toMatchObject({ left: 0, width: 1, depth: 0 })
  })

  it('does not depend on the order events arrive in', () => {
    const list = [ev('qbr', at(10), at(12)), ev('contract', at(10, 15), at(11, 15)), ev('legal', at(10, 30), at(11)), ev('twin', at(10, 30), at(11))]
    const forward = layoutDayEvents(list)
    const backward = layoutDayEvents([...list].reverse())
    for (const e of list) expect(backward.get(e.id)).toEqual(forward.get(e.id))
  })

  it('keeps every box inside the column', () => {
    const inputs: LayoutInput[] = []
    let seed = 7
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    for (let i = 0; i < 60; i++) {
      const start = Math.floor(rand() * 600) + 480
      inputs.push(ev(`r${i}`, start, start + Math.floor(rand() * 120)))
    }
    const boxes = layoutDayEvents(inputs)
    expect(boxes.size).toBe(60)
    for (const b of boxes.values()) {
      expect(b.left).toBeGreaterThanOrEqual(0)
      expect(b.width).toBeGreaterThan(0)
      expect(right(b)).toBeLessThanOrEqual(1 + 1e-9)
    }
  })

  it('never lets two events in the same layer and lane overlap in time', () => {
    const inputs: LayoutInput[] = []
    let seed = 99
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    for (let i = 0; i < 40; i++) {
      const start = Math.floor(rand() * 300) + 540
      inputs.push(ev(`r${i}`, start, start + 15 + Math.floor(rand() * 90)))
    }
    const boxes = layoutDayEvents(inputs)
    for (const a of inputs) {
      for (const b of inputs) {
        if (a.id >= b.id) continue
        const timeOverlap = a.start < b.end && b.start < a.end
        if (!timeOverlap) continue
        const ba = box(boxes, a.id)
        const bb = box(boxes, b.id)
        // Overlapping in time: either on different layers, or apart horizontally.
        if (ba.depth === bb.depth) {
          const apart = right(ba) <= bb.left + 1e-9 || right(bb) <= ba.left + 1e-9
          expect(apart).toBe(true)
        }
      }
    }
  })
})
