/**
 * Sizing, turning and arrow ends on the preview (../PreviewLayerControls.tsx; Liam, 11-24: "make sure I can do all
 * this on the screen like rotate and move and resize and no need for these controls"): the layer panel no longer has
 * position, size or rotation sliders, so these gestures are the only way a person sets them.
 */
import { describe, expect, it } from 'vitest'
import type { EditorProject } from '@/lib/studio/engine/contracts'
import { arrowEnds, handlePlaces, resizeLayer, rotationFrom } from '../PreviewLayerControls'

type Layer = NonNullable<EditorProject['layers']>[number]
// A 1000×500 preview of the frame; the box is 200×100 preview pixels, centred.
const FW = 1000, FH = 500
const box = (over: Partial<Layer> = {}) => ({ id: 'b', kind: 'box', name: 'Box', x: 0.5, y: 0.5, width: 0.2, height: 0.2, rotate: 0, opacity: 1, style: {}, ...over }) as unknown as Layer

describe('resizeLayer', () => {
  it('a corner keeps the shape, the opposite corner staying put', () => {
    // bottom-right pulled out along its diagonal by (100, 50): 1.5× the size
    const out = resizeLayer(box(), 1, 1, 100, 50, FW, FH)
    expect(out.width).toBeCloseTo(0.3); expect(out.height).toBeCloseTo(0.3)
    // the top-left corner was at (0.4, 0.4) and is still there
    expect(out.x! - out.width! / 2).toBeCloseTo(0.4); expect(out.y! - out.height! / 2).toBeCloseTo(0.4)
  })

  it('a side changes one dimension and leaves the other side where it was', () => {
    const out = resizeLayer(box(), 1, 0, 100, 40, FW, FH)
    expect(out.width).toBeCloseTo(0.3); expect(out.height).toBeCloseTo(0.2)
    expect(out.x! - out.width! / 2).toBeCloseTo(0.4); expect(out.y).toBeCloseTo(0.5)
    const top = resizeLayer(box(), 0, -1, 0, -50, FW, FH)
    expect(top.height).toBeCloseTo(0.3); expect(top.y! + top.height! / 2).toBeCloseTo(0.6); expect(top.width).toBeCloseTo(0.2)
  })

  it('Alt grows from the centre', () => {
    const out = resizeLayer(box(), 1, 0, 50, 0, FW, FH, true)
    expect(out.width).toBeCloseTo(0.3); expect(out.x).toBeCloseTo(0.5)
  })

  it('a turned box stretches along its own axis: the right side of a box turned 90° points down', () => {
    const out = resizeLayer(box({ rotate: 90 }), 1, 0, 0, 100, FW, FH)
    expect(out.width).toBeCloseTo(0.3)
    // its far side stays put, so the centre moves down the screen by half the growth
    expect(out.x).toBeCloseTo(0.5); expect(out.y).toBeCloseTo(0.5 + 50 / FH)
    // a pull across the axis does nothing
    expect(resizeLayer(box({ rotate: 90 }), 1, 0, 100, 0, FW, FH).width).toBeCloseTo(0.2)
  })

  it("a text layer's size follows a corner, not a side", () => {
    const text = box({ kind: 'text', style: { size: 0.06 } } as Partial<Layer>)
    expect(resizeLayer(text, 1, 1, 100, 50, FW, FH).style?.size).toBeCloseTo(0.09)
    expect(resizeLayer(text, 1, 0, 100, 0, FW, FH).style).toBeUndefined()
  })

  it('never collapses or runs away', () => {
    expect(resizeLayer(box(), 1, 1, -5000, -5000, FW, FH).width).toBeGreaterThanOrEqual(0.02)
    expect(resizeLayer(box(), 1, 0, 9000, 0, FW, FH).width).toBeLessThanOrEqual(1.5)
  })
})

describe('rotationFrom', () => {
  it('turns by how far the pointer went round the centre, within ±180', () => {
    expect(rotationFrom(0, 0, 30)).toBe(30)
    expect(rotationFrom(170, 0, 30)).toBe(-160)
  })

  it('settles on straight within 4°, and Shift steps by 15°', () => {
    expect(rotationFrom(0, 0, 87)).toBe(90)
    expect(rotationFrom(0, 0, 3)).toBe(0)
    expect(rotationFrom(0, 0, 80)).toBe(80)
    expect(rotationFrom(0, 0, 37, true)).toBe(30)
    expect(rotationFrom(0, 0, 179)).toBe(180)
  })
})

describe('arrowEnds', () => {
  const arrow = (over: Partial<Layer> = {}) => box({ kind: 'arrow', x: 0.6, y: 0.5, style: { fromX: 0.4, fromY: 0.5 }, ...over } as Partial<Layer>)
  it('the tip is the layer position and the start its own', () => {
    expect(arrowEnds(arrow(), FW, FH)).toEqual({ tip: { x: 0.6, y: 0.5 }, tail: { x: 0.4, y: 0.5 } })
  })
  it('a turned arrow has its start turned round the tip, as it is drawn', () => {
    // 200 px to the left of the tip, turned 90° clockwise: 200 px above it
    const { tail } = arrowEnds(arrow({ rotate: 90 }), FW, FH)
    expect(tail.x).toBeCloseTo(0.6); expect(tail.y).toBeCloseTo(0.5 - 200 / FH)
  })
  it('an arrow without a start of its own starts up and to the left of the tip', () => {
    expect(arrowEnds(box({ kind: 'arrow', x: 0.6, y: 0.5 } as Partial<Layer>), FW, FH).tail).toEqual({ x: 0.4, y: 0.3 })
  })
})

describe('handlePlaces', () => {
  // The frame clips what leaves it, so the knob and the tag go where they stay on the picture.
  it('the knob under the box and the tag over it, when there is room', () => {
    expect(handlePlaces(box(), FW, FH)).toEqual({ knob: 'below', tag: 'above' })
  })
  it('a box on the bottom edge: the knob over it, the tag inside', () => {
    expect(handlePlaces(box({ y: 0.9 }), FW, FH)).toEqual({ knob: 'above', tag: 'inside' })
  })
  it('a box on the top edge: the knob under it, the tag inside', () => {
    expect(handlePlaces(box({ y: 0.1 }), FW, FH)).toEqual({ knob: 'below', tag: 'inside' })
  })
  it('a box filling the frame: both inside', () => {
    expect(handlePlaces(box({ width: 1, height: 1 }), FW, FH)).toEqual({ knob: 'inside', tag: 'inside' })
  })
  it('a turned box: the knob goes the way the box points', () => {
    // turned 90°, "under" the box is to its left on the screen: a box at the left edge has no room there
    expect(handlePlaces(box({ x: 0.05, rotate: 90 }), FW, FH).knob).toBe('above')
    expect(handlePlaces(box({ x: 0.05 }), FW, FH).knob).toBe('below')
  })
})
