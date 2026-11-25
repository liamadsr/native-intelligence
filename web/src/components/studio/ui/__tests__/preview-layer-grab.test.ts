/**
 * Which layers the preview lets you grab (../PreviewLayerControls.tsx grabbableLayers; Liam, 11-24: "when you add
 * background … you can't resize it via the screen"): a full-frame one only while selected, and then under the rest.
 */
import { describe, expect, it } from 'vitest'
import type { EditorProject } from '@/lib/studio/engine/contracts'
import { grabbableLayers } from '../PreviewLayerControls'

const layer = (id: string, kind: string, width: number, height: number) => ({ id, kind, name: id, x: 0.5, y: 0.5, width, height, startFrame: 0, endFrame: 100 })
const project = { layers: [layer('text', 'text', 0.4, 0.1), layer('bg', 'background', 1, 1), layer('scene', 'code', 1, 1)] } as unknown as EditorProject

describe('grabbableLayers', () => {
  it('a background or a full-frame scene is not grabbable unless selected, so it never covers the others', () => {
    expect(grabbableLayers(project, 10).map((l) => l.id)).toEqual(['text'])
  })

  it('selected, the background moves and resizes on the screen, drawn under the others however late it was added', () => {
    expect(grabbableLayers(project, 10, 'bg').map((l) => l.id)).toEqual(['bg', 'text'])
    expect(grabbableLayers(project, 10, 'scene').map((l) => l.id)).toEqual(['scene', 'text'])
  })

  it('nothing outside its time', () => {
    expect(grabbableLayers(project, 200, 'bg')).toEqual([])
  })
})
