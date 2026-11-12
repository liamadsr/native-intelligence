/**
 * Where code scenes are off, the editor's preview draws each code layer as a labelled box: no frame, and neither the
 * frame's runtime nor the scene's code is fetched. The editor picks that from the server's word (studio-env.ts
 * previewCodeScenes: the box until the server says scenes run). A made-up scene.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { renderToString } from 'react-dom/server'
import { previewCodeScenes, setStudioCapabilities } from '@/components/studio/studio-env'
import { CodeLayer, CodeScenesContext } from '../../scene-layer'
import type { EditorLayer } from '../../layers'
import type { EditorProject } from '../../contracts'

const layer = { id: 'scene-1', kind: 'code', startFrame: 0, endFrame: 60, x: 0.5, y: 0.5, width: 1, height: 1, style: { scene: { id: '0123456789abcdef', name: 'Bar' } } } as unknown as EditorLayer
const project = { assets: [] } as unknown as EditorProject

afterEach(() => {
  vi.unstubAllGlobals()
  setStudioCapabilities({})
})

describe('a code layer where scenes are off', () => {
  it('draws a labelled box and fetches nothing', () => {
    const fetched = vi.fn()
    vi.stubGlobal('fetch', fetched)
    const html = renderToString(<CodeScenesContext.Provider value={{ mode: 'placeholder' }}>
      <CodeLayer layer={layer} project={project} assetPath={(f) => `/files/${f}`} common={{}} width={1280} height={720} fps={30} />
    </CodeScenesContext.Provider>)
    // React's server render splits the text around the name with a comment.
    expect(html).toMatch(/Code scene · (<!-- -->)?Bar/)
    expect(html).not.toContain('<iframe')
    expect(fetched).not.toHaveBeenCalled()
  })

  it('the editor runs scenes only once the server says they run', () => {
    expect(previewCodeScenes()).toBe('placeholder')
    setStudioCapabilities({ codeScenes: false, sound: true })
    expect(previewCodeScenes()).toBe('placeholder')
    setStudioCapabilities({ codeScenes: true })
    expect(previewCodeScenes()).toBe('run')
  })
})
