// @vitest-environment jsdom
/**
 * A panel that renders a loading state first must still take drops once its
 * element is there. The capture panel's listeners used to attach in a mount
 * effect that read a ref: while the capture loaded the element wasn't there,
 * the effect returned early and never ran again, and a dropped screenshot did
 * nothing (it did work when the capture came from the cache, hence "sometimes").
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, useState } from 'react'
import { useElementFileDrop } from '../use-element-file-drop'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function fire(
  target: EventTarget,
  type: string,
  files: File[],
  prop: 'dataTransfer' | 'clipboardData' = 'dataTransfer',
  types: string[] = files.length ? ['Files'] : ['text/plain'],
): Event {
  const e = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(e, prop, { value: { types, files, items: [], dropEffect: 'none' } })
  act(() => {
    target.dispatchEvent(e)
  })
  return e
}

let container: HTMLDivElement
let root: Root
let setLoading: (loading: boolean) => void = () => {}
const onFiles = vi.fn()
const onDragging = vi.fn()

function Panel({ paste = true }: { paste?: boolean }) {
  const [loading, set] = useState(true)
  setLoading = set
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  useElementFileDrop(el, onFiles, onDragging, { paste })
  if (loading) return h('div', { 'data-loading': '' }, 'Loading...')
  return h(
    'div',
    { ref: setEl, 'data-panel': '', 'data-file-drop-zone': '' },
    h('p', null, 'notes'),
    h('div', { 'data-editor': '', contentEditable: true, suppressContentEditableWarning: true }, 'text'),
    // A chat box inside the panel: a zone of its own.
    h('div', { 'data-file-drop-zone': '', 'data-composer': '' }, h('textarea')),
  )
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  onFiles.mockReset()
  onDragging.mockReset()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('useElementFileDrop', () => {
  it('takes a drop on a panel that rendered a loading state first', () => {
    act(() => root.render(h(Panel)))
    act(() => setLoading(false))
    const shot = new File(['x'], 'shot.png', { type: 'image/png' })
    const e = fire(container.querySelector('p')!, 'drop', [shot])
    expect(onFiles).toHaveBeenCalledWith([shot])
    expect(e.defaultPrevented).toBe(true)
  })

  it('stops the drop at the panel, so nothing above attaches it again', () => {
    act(() => root.render(h(Panel)))
    act(() => setLoading(false))
    const above = vi.fn()
    container.addEventListener('drop', above)
    fire(container.querySelector('p')!, 'drop', [new File(['x'], 'a.pdf')])
    expect(above).not.toHaveBeenCalled()
  })

  it('says when files are over it, and when they leave or land', () => {
    act(() => root.render(h(Panel)))
    act(() => setLoading(false))
    const panel = container.querySelector('[data-panel]')!
    fire(panel, 'dragenter', [new File(['x'], 'a.png')])
    expect(onDragging).toHaveBeenLastCalledWith(true)
    fire(panel, 'dragleave', [new File(['x'], 'a.png')])
    expect(onDragging).toHaveBeenLastCalledWith(false)
  })

  it('attaches pasted files and leaves a text paste alone', () => {
    act(() => root.render(h(Panel)))
    act(() => setLoading(false))
    const panel = container.querySelector('[data-panel]')!
    const text = fire(panel, 'paste', [], 'clipboardData')
    expect(text.defaultPrevented).toBe(false)
    expect(onFiles).not.toHaveBeenCalled()
    const pasted = new File(['x'], '', { type: 'image/png' })
    fire(panel, 'paste', [pasted], 'clipboardData')
    expect(onFiles).toHaveBeenCalledTimes(1)
    expect(onFiles.mock.calls[0][0][0].name).toMatch(/^screenshot-\d+\.png$/)
  })

  it('leaves a drop on a zone inside it (a chat box) to that zone', () => {
    act(() => root.render(h(Panel)))
    act(() => setLoading(false))
    const composer = container.querySelector('[data-composer]')!
    const inner = vi.fn()
    composer.addEventListener('drop', inner)
    const e = fire(composer.querySelector('textarea')!, 'drop', [new File(['x'], 'a.png')])
    expect(onFiles).not.toHaveBeenCalled()
    expect(inner).toHaveBeenCalled()
    expect(e.defaultPrevented).toBe(false)
  })

  it('lets a rich paste into a field be text (Office puts a picture of it on the clipboard too)', () => {
    act(() => root.render(h(Panel)))
    act(() => setLoading(false))
    const editor = container.querySelector('[data-editor]')!
    const picture = new File(['x'], 'image.png', { type: 'image/png' })
    const rich = fire(editor, 'paste', [picture], 'clipboardData', ['text/plain', 'text/html', 'Files'])
    expect(rich.defaultPrevented).toBe(false)
    expect(onFiles).not.toHaveBeenCalled()
    // A screenshot alone, pasted into the same field, attaches.
    fire(editor, 'paste', [picture], 'clipboardData', ['Files'])
    expect(onFiles).toHaveBeenCalledWith([picture])
  })

  it('without paste, takes drops only', () => {
    act(() => root.render(h(Panel, { paste: false })))
    act(() => setLoading(false))
    fire(container.querySelector('p')!, 'paste', [new File(['x'], 'a.png')], 'clipboardData')
    expect(onFiles).not.toHaveBeenCalled()
    fire(container.querySelector('p')!, 'drop', [new File(['x'], 'a.png')])
    expect(onFiles).toHaveBeenCalledTimes(1)
  })

  it('takes nothing while the panel is loading', () => {
    act(() => root.render(h(Panel)))
    fire(container.querySelector('[data-loading]')!, 'drop', [new File(['x'], 'a.png')])
    expect(onFiles).not.toHaveBeenCalled()
  })
})
