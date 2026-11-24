// @vitest-environment jsdom
/**
 * A scroll area with no bar drawn still scrolls (../scroll-area.tsx; Liam,
 * 11-23: "you can't scroll on the page like here on contacts"): Radix leaves
 * its viewport `overflow-y: hidden` unless a scrollbar is mounted, so without
 * one the overviews of a contact, a project and the rest could not scroll.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { ScrollArea } from '../scroll-area'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const viewport = () => container.querySelector<HTMLElement>('[data-radix-scroll-area-viewport]')!

describe('ScrollArea', () => {
  it('with no bar drawn, its viewport still scrolls up and down', async () => {
    await act(async () => root.render(<ScrollArea scrollbar={false} className="h-40"><div style={{ height: 1000 }} /></ScrollArea>))
    expect(viewport().style.overflowY).toBe('auto')
  })

  it('with its bar, Radix scrolls it as before', async () => {
    await act(async () => root.render(<ScrollArea className="h-40"><div style={{ height: 1000 }} /></ScrollArea>))
    await act(async () => {})
    expect(viewport().style.overflowY).toBe('scroll')
  })
})
