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
    // c is in the last lane; b has c to its right; a has b to its right while they last,
    // and runs on long after both: its own lane at the top, the full width underneath them (rule 3b).
    expect(box(boxes, 'a').width * box(boxes, 'a').clear).toBeCloseTo(1 / 3)
    expect(box(boxes, 'a').width).toBeCloseTo(1)
    expect(box(boxes, 'b').width).toBeCloseTo(1 / 3)
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
          // Each one's own part at the top (its lane) is apart from the other's...
          const own = (x: typeof ba) => ({ left: x.left, width: x.width * x.clear })
          const apart = right(own(ba)) <= own(bb).left + 1e-9 || right(own(bb)) <= own(ba).left + 1e-9
          expect(apart).toBe(true)
          // ...and where one runs on under the other (rule 3b), the one on top is the later in paint order and did not start before it.
          const overlapping = !(right(ba) <= bb.left + 1e-9 || right(bb) <= ba.left + 1e-9)
          if (overlapping) {
            const [under, top, eu, et] = ba.clear < 1 && ba.left <= bb.left ? [ba, bb, a, b] : [bb, ba, b, a]
            expect(under.clear).toBeLessThan(1)
            expect(top.order).toBeGreaterThan(under.order)
            expect(et.start).toBeGreaterThanOrEqual(eu.start)
          }
        }
      }
    }
  })

  // Owner's report (11-21): short events inside a long one's time were hard to select.
  describe('an event is never buried under a longer one', () => {
    const horizontallyOver = (top: { left: number; width: number }, under: { left: number; width: number }) => top.left < right(under) - 1e-9 && under.left < right(top) - 1e-9

    it('draws short events inside a long one on top of it, indented, with a strip of the long one clear on the left', () => {
      const boxes = layoutDayEvents([ev('long', at(6), at(14)), ev('a', at(8), at(9)), ev('b', at(11), at(11, 30))])
      const long = box(boxes, 'long')
      for (const id of ['a', 'b']) {
        const short = box(boxes, id)
        expect(short.zIndex).toBeGreaterThan(long.zIndex)
        expect(short.order).toBeGreaterThan(long.order)
        // The long event's left edge stays its own: visible and clickable.
        expect(short.left).toBeGreaterThanOrEqual(long.left + LAYER_INDENT - 1e-9)
        expect(right(short)).toBeLessThanOrEqual(1 + 1e-9)
      }
      expect(long).toMatchObject({ left: 0, width: 1, depth: 0 })
    })

    it('lays a short event that starts with the long one on top of it, in its own lane; the long one takes the full width underneath', () => {
      const boxes = layoutDayEvents([ev('long', at(6), at(14)), ev('short', at(6), at(7))])
      const long = box(boxes, 'long')
      const short = box(boxes, 'short')
      // Same start: the shorter is the later in paint order, so it is the one on top.
      expect(short.order).toBeGreaterThan(long.order)
      // The long one is the whole column wide: a sliver only while the short one lasts.
      expect(long).toMatchObject({ left: 0, width: 1 })
      // Its own part at the top is the left half, exactly where the short one isn't.
      expect(long.clear).toBeCloseTo(0.5)
      expect(short.left).toBeCloseTo(long.left + long.width * long.clear)
      expect(right(short)).toBeCloseTo(1)
      expect(short.clear).toBe(1)
    })

    it('widens the long one under several short ones, and leaves equals and near-equals side by side', () => {
      const three = layoutDayEvents([ev('long', at(9), at(17)), ev('a', at(9), at(10)), ev('b', at(9), at(9, 45))])
      expect(box(three, 'long')).toMatchObject({ left: 0, width: 1 })
      expect(box(three, 'long').clear).toBeCloseTo(1 / 3)
      // The middle one doesn't outlast its neighbour by enough to be worth running under it.
      expect(box(three, 'a').clear).toBe(1)

      const equals = layoutDayEvents([ev('a', at(13), at(14)), ev('b', at(13), at(14))])
      expect(box(equals, 'a')).toMatchObject({ left: 0, width: 0.5, clear: 1 })
      const nearly = layoutDayEvents([ev('a', at(13), at(14, 15)), ev('b', at(13), at(14))])
      expect(box(nearly, 'a')).toMatchObject({ left: 0, width: 0.5, clear: 1 })
    })

    it('never widens an event under one that started before it', () => {
      // 'late' takes lane 0 again after 'first' ends, while 'other' (started earlier) still runs in lane 1.
      const boxes = layoutDayEvents([ev('first', at(9), at(9, 20)), ev('other', at(9, 5), at(10)), ev('late', at(9, 25), at(13))])
      const late = box(boxes, 'late')
      const other = box(boxes, 'other')
      if (late.lanes === other.lanes && late.lane < other.lane) expect(late.clear).toBe(1)
      const over = late.left < right(other) - 1e-9 && other.left < right(late) - 1e-9
      if (over) expect(late.order).toBeGreaterThan(other.order)
    })

    it('puts a short event beside a longer one that starts later and would cover most of it', () => {
      // 5:30-7:00 and 6:00-14:00: layered, the long one would hide an hour of the ninety minutes.
      const boxes = layoutDayEvents([ev('short', at(5, 30), at(7)), ev('long', at(6), at(14))])
      expect(horizontallyOver(box(boxes, 'long'), box(boxes, 'short'))).toBe(false)
      expect(box(boxes, 'short').lanes).toBe(2)
    })

    it('still layers the usual stagger: the earlier one keeps half of itself clear', () => {
      const boxes = layoutDayEvents([ev('first', at(9), at(11)), ev('second', at(10), at(12))])
      expect(box(boxes, 'first')).toMatchObject({ left: 0, width: 1, depth: 0 })
      expect(box(boxes, 'second').depth).toBe(1)
      expect(box(boxes, 'second').order).toBeGreaterThan(box(boxes, 'first').order)
    })

    it('holds for any day: whatever is drawn over an event started later, and leaves at least half of it clear', () => {
      let seed = 4242
      const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647
      for (let round = 0; round < 40; round++) {
        const inputs: LayoutInput[] = []
        for (let i = 0; i < 14; i++) {
          const start = 360 + Math.floor(rand() * 40) * 15
          const length = rand() < 0.25 ? 240 + Math.floor(rand() * 16) * 15 : 15 + Math.floor(rand() * 8) * 15
          inputs.push(ev(`e${i}`, start, Math.min(1440, start + length)))
        }
        const boxes = layoutDayEvents(inputs)
        for (const under of inputs) {
          for (const top of inputs) {
            if (under.id === top.id) continue
            const bu = box(boxes, under.id)
            const bt = box(boxes, top.id)
            const inTime = under.start < top.end && top.start < under.end
            if (!inTime || !horizontallyOver(bt, bu) || bt.order <= bu.order) continue
            // `top` is painted over part of `under`.
            // Later start on top; started together, the shorter one (the long one runs on underneath).
            expect(top.start).toBeGreaterThanOrEqual(under.start)
            if (top.start === under.start) expect(top.end).toBeLessThan(under.end)
            const clear = top.start - under.start
            const covered = under.end - top.start
            // Either it keeps half its height above the one on top, or the one on top is no longer than it (a short one over a long one).
            expect(covered <= clear || top.end - top.start <= under.end - under.start).toBe(true)
          }
        }
      }
    })
  })
})
