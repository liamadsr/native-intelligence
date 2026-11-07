// @vitest-environment jsdom
/**
 * The fading blur (Phase 7 of docs/plans/chat-ui-polish.md): stacked layers
 * of falling strength, each masked to its own stretch, so the blur steps down
 * from the strong edge to nothing; `up` mirrors `down`; every layer runs from
 * the strong edge to where its mask has faded it out, so no layer has an edge
 * inside the blur (a backdrop-filter's edge draws a line in what's behind).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import { FADE_LAYERS, FadingBlur, fadeMask, layerPlace } from '../fading-blur'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const layers = () => [...container.querySelectorAll<HTMLElement>('[data-fading-blur-layer]')]

describe('FadingBlur', () => {
  it('falls in strength layer by layer, each fading out further from the strong edge', () => {
    const blurs = FADE_LAYERS.map((l) => l.blur)
    expect([...blurs].sort((a, b) => b - a)).toEqual(blurs)
    for (let i = 1; i < FADE_LAYERS.length; i++) {
      expect(FADE_LAYERS[i].from).toBeGreaterThan(FADE_LAYERS[i - 1].from)
      expect(FADE_LAYERS[i].to).toBeGreaterThan(FADE_LAYERS[i - 1].to)
      // Overlapping ends: the next is on before the last is gone, so no seam.
      expect(FADE_LAYERS[i].from).toBeLessThan(FADE_LAYERS[i - 1].to)
    }
    expect(FADE_LAYERS[FADE_LAYERS.length - 1].to).toBe(1)
  })

  it('down: each layer runs from the top to where it is gone', () => {
    act(() => root.render(h(FadingBlur, { direction: 'down' })))
    expect(layers()).toHaveLength(FADE_LAYERS.length)
    expect(layers().map((l) => l.getAttribute('data-fading-blur-layer'))).toEqual(FADE_LAYERS.map((l) => String(l.blur)))
    expect(layers().map((l) => [l.style.top, l.style.height])).toEqual(FADE_LAYERS.map((l) => ['0px', `${l.to * 100}%`]))
    expect(fadeMask('down', 0.2, 0.6)).toBe('linear-gradient(to bottom, #000 20%, transparent 60%)')
  })

  it('up: each layer runs from the bottom, so nothing has an edge inside the blur', () => {
    act(() => root.render(h(FadingBlur, { direction: 'up' })))
    expect(layers().every((l) => l.style.bottom === '0px' && l.style.top === '')).toBe(true)
    expect(container.querySelector('[data-fading-blur-solid]')).toBeNull()
  })

  it("a layer's mask, scaled to its box, fades it out where the whole's would", () => {
    // 5px: opaque to 20% of the whole, gone by 60%; its box is 60% tall, so 1/3 of it, then gone at its end.
    expect(layerPlace('up', { from: 0.2, to: 0.6 })).toEqual({
      box: { bottom: 0, height: '60%' },
      mask: 'linear-gradient(to top, #000 33.3%, transparent 100%)',
    })
    expect(layerPlace('down', { from: 0, to: 0.35 }).mask).toBe('linear-gradient(to bottom, #000 0%, transparent 100%)')
  })
})
