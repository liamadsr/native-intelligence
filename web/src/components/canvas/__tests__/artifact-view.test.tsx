// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ArtifactItem } from '@/lib/canvas/types'
import { ARTIFACT_CSP } from '@/lib/canvas/engine/artifact'
import { ArtifactEditor, ArtifactFrame, ArtifactView, PresentArtifacts } from '../artifact-view'

const art = (id: string, extra: Partial<ArtifactItem> = {}): ArtifactItem => ({ id, kind: 'artifact', parentId: null, sortKey: `a${id}`, x: 0, y: 0, w: 400, h: 300, rotation: 0, style: { opacity: 1 }, html: `<p>Page ${id}</p>`, ...extra }) as ArtifactItem

/** The browser's own events, as React hears them. */
const fireEvent = {
  load: (el: Element) => el.dispatchEvent(new Event('load')),
  click: (el: Element) => (el as HTMLElement).click(),
  keyDown: (el: Element, init: { key: string }) => el.dispatchEvent(new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true })),
  change: (el: Element, init: { target: { value: string } }) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, init.target.value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  },
}

let root: Root | null = null
let host: HTMLElement
function draw(node: React.ReactNode) {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(node))
}

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

const frame = () => document.querySelector('iframe') as HTMLIFrameElement | null

describe('an artifact\'s frame', () => {
  it('has no origin and no powers but script, and is given the document with the policy first', () => {
    draw(<ArtifactFrame html="<p>Hi</p>" interactive={false} />)
    const f = frame()!
    expect(f.getAttribute('sandbox')).toBe('allow-scripts')
    expect(f.getAttribute('src')).toBeNull()
    const doc = f.getAttribute('srcdoc')!
    expect(doc).toContain(`content="${ARTIFACT_CSP}"`)
    expect(doc.indexOf('Content-Security-Policy')).toBeLessThan(doc.indexOf('<p>Hi</p>'))
    expect(f.getAttribute('referrerpolicy')).toBe('no-referrer')
  })

  it('takes no pointer and no tab stop until it is opened', () => {
    draw(<ArtifactView item={art('a', { title: 'Chart' })} frame={{}} open={false} />)
    expect(frame()!.style.pointerEvents).toBe('none')
    expect(frame()!.tabIndex).toBe(-1)
    expect(document.querySelector('[data-canvas-artifact]')!.getAttribute('data-canvas-artifact')).toBe('closed')
    expect(document.body.textContent).toContain('Chart')
    act(() => root!.render(<ArtifactView item={art('a', { title: 'Chart' })} frame={{}} open />))
    expect(frame()!.style.pointerEvents).toBe('auto')
  })

  it('is taken down when it loads a second time (it sent itself somewhere), and comes back when its page changes', () => {
    draw(<ArtifactFrame html="<p>one</p>" interactive />)
    act(() => void fireEvent.load(frame()!))
    expect(frame()).not.toBeNull()
    act(() => void fireEvent.load(frame()!))
    expect(frame()).toBeNull()
    expect(document.body.textContent).toContain('tried to open another page')
    act(() => root!.render(<ArtifactFrame html="<p>two</p>" interactive />))
    expect(frame()).not.toBeNull()
  })

  it('draws no frame for an empty artifact', () => {
    draw(<ArtifactView item={art('a', { html: '  ' })} frame={{}} open={false} />)
    expect(frame()).toBeNull()
    expect(document.body.textContent).toContain('An empty artifact')
  })
})

describe('presenting', () => {
  const list = [art('a', { title: 'One' }), art('b', { title: 'Two' }), art('c')]
  const count = () => document.querySelector('[data-canvas-present-count]')!.textContent
  const stage = () => document.querySelector('[data-canvas-present]') as HTMLElement

  it('starts from the one asked for and steps with the keys and the buttons, stopping at the ends', () => {
    draw(<PresentArtifacts artifacts={list} start="b" onClose={() => {}} />)
    expect(count()).toBe('2 / 3')
    expect(frame()!.getAttribute('srcdoc')).toContain('Page b')
    act(() => void fireEvent.keyDown(document.body, { key: 'ArrowRight' }))
    act(() => void fireEvent.keyDown(document.body, { key: 'ArrowRight' }))
    expect(count()).toBe('3 / 3')
    expect((document.querySelector('[aria-label="Next"]') as HTMLButtonElement).disabled).toBe(true)
    act(() => void fireEvent.click(document.querySelector('[aria-label="Previous"]')!))
    expect(count()).toBe('2 / 3')
    act(() => void fireEvent.keyDown(document.body, { key: 'Home' }))
    expect(count()).toBe('1 / 3')
    expect(frame()!.style.pointerEvents).toBe('auto')
  })

  it('stops on Escape and on the button, and when the last artifact is deleted under it', () => {
    const onClose = vi.fn()
    draw(<PresentArtifacts artifacts={list} onClose={onClose} />)
    expect(count()).toBe('1 / 3')
    act(() => void fireEvent.keyDown(document.body, { key: 'Escape' }))
    act(() => void fireEvent.click(document.querySelector('[aria-label="Stop presenting"]')!))
    expect(onClose).toHaveBeenCalledTimes(2)
    act(() => root!.render(<PresentArtifacts artifacts={[]} onClose={onClose} />))
    expect(onClose).toHaveBeenCalledTimes(3)
    expect(stage()).toBeNull()
  })
})

describe('editing an artifact\'s page', () => {
  it('saves the words typed, and refuses a page that is too long', () => {
    const onSave = vi.fn()
    draw(<ArtifactEditor item={art('a', { title: 'Old' })} onSave={onSave} onClose={() => {}} />)
    const page = document.querySelector('textarea')!
    const title = document.querySelector('input')!
    act(() => {
      fireEvent.change(title, { target: { value: 'New' } })
      fireEvent.change(page, { target: { value: '<p>changed</p>' } })
    })
    const save = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Save')!
    act(() => void fireEvent.click(save))
    expect(onSave).toHaveBeenCalledWith({ html: '<p>changed</p>', title: 'New' })
    act(() => void fireEvent.change(page, { target: { value: 'x'.repeat(200_001) } }))
    expect(save.disabled).toBe(true)
  })
})
