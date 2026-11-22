import { describe, expect, it } from 'vitest'
import type { CanvasItem } from '@/lib/canvas/types'
import { settleConnectors } from '@/lib/canvas/engine/connectors'
import { sceneFromItems } from '@/lib/canvas/engine/scene'
import { paintFar } from '../far-layer'

/** A 2D context that only counts what is asked of it. */
function fakeContext() {
  const calls: Record<string, number> = {}
  const fills: string[] = []
  const target = { calls, fills, fillStyle: '', strokeStyle: '', globalAlpha: 1, lineWidth: 1, lineCap: 'butt', lineJoin: 'miter' }
  return new Proxy(target, {
    get(t, key: string) {
      if (key in t) return (t as Record<string, unknown>)[key]
      return () => {
        calls[key] = (calls[key] ?? 0) + 1
        if (key === 'fill' || key === 'fillRect') fills.push(String(t.fillStyle))
      }
    },
    set(t, key: string, value) {
      ;(t as Record<string, unknown>)[key] = value
      return true
    },
  }) as unknown as CanvasRenderingContext2D & { calls: Record<string, number>; fills: string[] }
}

class FakePath2D {
  constructor(public d: string) {}
}
;(globalThis as { Path2D?: unknown }).Path2D ??= FakePath2D

const base = { parentId: null, rotation: 0 }
const items: CanvasItem[] = [
  { ...base, id: 'a', sortKey: 'a1', kind: 'rectangle', x: 0, y: 0, w: 100, h: 50, style: { fill: 'theme:blue-soft', stroke: 'theme:ink', strokeWidth: 2, radius: 8 } },
  { ...base, id: 'b', sortKey: 'a2', kind: 'ellipse', x: 300, y: 0, w: 100, h: 50, style: { fill: 'transparent', stroke: '#ff0000', strokeWidth: 2, strokeStyle: 'dashed' } },
  { ...base, id: 'k', sortKey: 'a3', kind: 'connector', x: 0, y: 0, w: 0, h: 0, style: { stroke: 'theme:ink', strokeWidth: 2 }, start: { x: 0, y: 0, bind: { id: 'a', anchor: 'right' } }, end: { x: 0, y: 0, bind: { id: 'b', anchor: 'left' } }, route: 'straight', startHead: 'none', endHead: 'arrow' },
  { ...base, id: 't', sortKey: 'a4', kind: 'text', x: 0, y: 100, w: 80, h: 20, style: {}, content: { plain: 'words' }, text: { color: 'theme:ink' }, autoWidth: true },
  { ...base, id: 'far', sortKey: 'a5', kind: 'rectangle', x: 90000, y: 90000, w: 100, h: 50, style: { fill: '#00ff00' } },
]

describe('a big board painted from far away', () => {
  it('paints what is in view, in order, in the theme\'s colors, and skips what is not', () => {
    const scene = settleConnectors(sceneFromItems(items))
    const light = fakeContext()
    const drawn = paintFar(light, scene, { x: 100, y: 100, scale: 0.1 }, { w: 800, h: 600 }, 1, 'light', new Set())
    expect(drawn).toBe(4)
    expect(light.calls.clearRect).toBe(1)
    expect(light.calls.roundRect).toBe(1)
    expect(light.calls.ellipse).toBe(1)
    // The rectangle's fill, the text's bar; the ellipse has no fill; the far rectangle is never reached.
    expect(light.fills).toEqual(['#dbeafe', '#18181b'])
    const dark = fakeContext()
    paintFar(dark, scene, { x: 100, y: 100, scale: 0.1 }, { w: 800, h: 600 }, 1, 'dark', new Set())
    expect(dark.fills).toEqual(['#1e3a8a', '#f4f4f5'])
    // The connector: its path stroked once, its arrowhead once more.
    expect(light.calls.stroke).toBe(4)
  })

  it('paints nothing for a view over empty canvas', () => {
    const ctx = fakeContext()
    expect(paintFar(ctx, settleConnectors(sceneFromItems(items)), { x: -500000, y: 0, scale: 0.1 }, { w: 800, h: 600 }, 1, 'light', new Set())).toBe(0)
  })
})
