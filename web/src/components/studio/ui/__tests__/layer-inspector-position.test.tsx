// @vitest-environment jsdom
/**
 * Where a layer sits, its size and its turn (../LayerInspector.tsx; Liam, 11-24: "make sure I can do all this on the
 * screen like rotate and move and resize and no need for these controls"): in Original they are done on the picture
 * (PreviewLayerControls), so the panel has no sliders for them; in a platform format the picture's handles step aside,
 * so the panel sets them there. Opacity is in the panel either way.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { EditorProject } from '@/lib/studio/engine/contracts'
import { LayerInspector } from '../LayerInspector'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null, host: HTMLElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null })

const box = { id: 'box-1', kind: 'box', name: 'Box', x: 0.5, y: 0.5, width: 0.3, height: 0.3, rotate: 0, opacity: 1, style: {}, startFrame: 0, endFrame: 60,
  enter: { preset: 'none', frames: 1 }, exit: { preset: 'none', frames: 1 }, automation: [] }
function render(format?: string) {
  const project = { id: 'p', output: { width: 1920, height: 1080, fps: 30 }, layers: [box], assets: [], ...(format ? { delivery: { format } } : {}) } as unknown as EditorProject
  host = document.body.appendChild(document.createElement('div')); root = createRoot(host)
  act(() => root!.render(<LayerInspector project={project} layerId="box-1" change={vi.fn()} close={vi.fn()} />))
  return [...host.querySelectorAll('h3')].map(h => h.textContent)
}
const sliders = () => [...host!.querySelectorAll('input[type=range]')].map(i => i.getAttribute('aria-label'))

describe('the layer panel’s position', () => {
  it('in Original: no position, size or rotation sliders (the picture does those), Opacity stays', () => {
    expect(render()).not.toContain('Position')
    expect(sliders()).not.toEqual(expect.arrayContaining(['Width']))
    expect(sliders()).not.toContain('Rotation')
    expect(sliders()).toContain('Opacity')
  })

  it('in a platform format, where the picture’s handles step aside: the panel sets them', () => {
    expect(render('vertical')).toContain('Position')
    expect(sliders()).toEqual(expect.arrayContaining(['←→', '↑↓', 'Width', 'Height', 'Rotation', 'Opacity']))
  })
})
