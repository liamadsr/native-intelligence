// @vitest-environment jsdom
/**
 * The handles a selected layer gets on the preview (../PreviewLayerControls.tsx; Liam, 11-24: "make sure I can do all
 * this on the screen like rotate and move and resize and no need for these controls"): a box has four corners, four
 * sides and a turn knob; a text layer has no top or bottom side (its height is its lines); an arrow has a knob on each
 * end instead. A drag on the knob turns the layer, inside one undo step.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { EditorProject } from '@/lib/studio/engine/contracts'
import { PreviewLayerControls } from '../PreviewLayerControls'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null, host: HTMLElement | null = null
afterEach(() => { act(() => root?.unmount()); host?.remove(); root = null; host = null })

type Layer = NonNullable<EditorProject['layers']>[number]
const layer = (over: Partial<Layer>) => ({ id: 'l', kind: 'box', name: 'Box', x: 0.5, y: 0.5, width: 0.3, height: 0.3, rotate: 0, opacity: 1, style: {}, startFrame: 0, endFrame: 100,
  enter: { preset: 'none', frames: 1 }, exit: { preset: 'none', frames: 1 }, automation: [], ...over }) as unknown as Layer

function render(l: Layer, change = vi.fn(), edits = { begin: vi.fn(), end: vi.fn() }) {
  const project = { id: 'p', output: { width: 1920, height: 1080, fps: 30 }, layers: [l], assets: [] } as unknown as EditorProject
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
  act(() => root!.render(<PreviewLayerControls project={project} frame={10} previewWidth={960} enabled disabled={false} selectedLayerId={l.id}
    select={() => {}} change={change} beginEdit={edits.begin} endEdit={edits.end} />))
  return host
}
const labels = (el: HTMLElement) => [...el.querySelectorAll('button')].map(b => b.getAttribute('aria-label'))

describe('PreviewLayerControls handles', () => {
  it('a selected box: four corners, four sides and a turn knob', () => {
    const el = render(layer({}))
    expect(labels(el).filter(l => l === 'Resize')).toHaveLength(4)
    expect(labels(el).filter(l => l === 'Change the width')).toHaveLength(2)
    expect(labels(el).filter(l => l === 'Change the height')).toHaveLength(2)
    expect(labels(el)).toContain('Rotate')
  })

  it('the box on the preview is turned like the layer', () => {
    const el = render(layer({ rotate: 30 }))
    expect((el.querySelector('.layer-hit') as HTMLElement).style.transform).toBe('rotate(30deg)')
  })

  it('a text layer: no top or bottom side', () => {
    const el = render(layer({ kind: 'text', style: { text: 'Hi', size: 0.06 } } as Partial<Layer>))
    expect(labels(el)).not.toContain('Change the height')
    expect(labels(el).filter(l => l === 'Change the width')).toHaveLength(2)
  })

  it('an arrow: a knob on each end, no box handles', () => {
    const el = render(layer({ kind: 'arrow', x: 0.6, y: 0.5, style: { fromX: 0.4, fromY: 0.5 } } as Partial<Layer>))
    expect(labels(el)).toEqual(expect.arrayContaining(['Move the start', 'Move the tip']))
    expect(labels(el)).not.toContain('Resize'); expect(labels(el)).not.toContain('Rotate')
  })

  it('dragging the knob a quarter turn round the centre turns the layer 90°, as one edit', () => {
    HTMLElement.prototype.setPointerCapture ??= () => {}
    const change = vi.fn(), edits = { begin: vi.fn(), end: vi.fn() }
    const el = render(layer({}), change, edits)
    const knob = el.querySelector('[aria-label="Rotate"]') as HTMLElement
    // The frame sits at the page's origin (jsdom), so the layer's centre is (480, 270): start straight below it, end to its left.
    const at = (type: string, x: number, y: number) => knob.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX: x, clientY: y }))
    act(() => { at('pointerdown', 480, 400); at('pointermove', 350, 270); at('pointerup', 350, 270) })
    expect(edits.begin).toHaveBeenCalledTimes(1); expect(edits.end).toHaveBeenCalledWith(false)
    const turned = change.mock.calls.at(-1)![0]({ layers: [layer({})] } as unknown as EditorProject)
    expect(turned.layers[0].rotate).toBe(90)
  })
})
