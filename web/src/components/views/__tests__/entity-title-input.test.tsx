// @vitest-environment jsdom
/**
 * Detail-panel titles wrap instead of scrolling out of view.
 *
 * The panels previously used a plain <input>, which cannot wrap — a long title
 * scrolled sideways and the tail was unreadable without selecting through it.
 * The fix swaps in a textarea, so the two things worth pinning are that it
 * really is a wrapping element (an <input> regression would be invisible to a
 * text-content assertion) and that it did not become a *multi-line editor* in
 * the process: a title is still a single-line value, so Enter must not inject a
 * newline and a pasted newline must not survive.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { EntityTitleInput } from '../entity-title-input'

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

function field() {
  const el = container.querySelector('textarea')
  if (!el) throw new Error('title field not found')
  return el
}

describe('EntityTitleInput', () => {
  it('renders a wrapping textarea, not a single-line input', () => {
    act(() => {
      root.render(<EntityTitleInput value="A very long title" onChange={() => {}} />)
    })

    // The whole point of the change: an <input> here would clip the title.
    expect(container.querySelector('input')).toBeNull()
    expect(field().value).toBe('A very long title')
  })

  it('hides the scrollbar and resize handle so it still reads as a heading', () => {
    act(() => {
      root.render(<EntityTitleInput value="Title" onChange={() => {}} />)
    })

    const cls = field().className
    expect(cls).toContain('resize-none')
    expect(cls).toContain('overflow-hidden')
  })

  it('starts at one row so a short title is not a tall box', () => {
    act(() => {
      root.render(<EntityTitleInput value="Short" onChange={() => {}} />)
    })

    expect(field().rows).toBe(1)
  })

  it('strips newlines from a pasted value — a title stays single-line', () => {
    const seen: string[] = []
    act(() => {
      root.render(<EntityTitleInput value="" onChange={(v) => seen.push(v)} />)
    })

    const el = field()
    act(() => {
      // Bypass React's value tracker the way a real paste would land.
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )!.set!
      setter.call(el, 'Line one\nLine two')
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(seen).toEqual(['Line one Line two'])
  })

  it('commits on Enter rather than inserting a newline', () => {
    let commits = 0
    act(() => {
      root.render(
        <EntityTitleInput value="Title" onChange={() => {}} onCommit={() => (commits += 1)} />,
      )
    })

    let defaultPrevented = false
    act(() => {
      const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      field().dispatchEvent(ev)
      defaultPrevented = ev.defaultPrevented
    })

    expect(commits).toBe(1)
    // Without preventDefault the textarea would also gain a line break.
    expect(defaultPrevented).toBe(true)
  })

  it('cancels on Escape so click-to-edit panels can back out', () => {
    let cancels = 0
    act(() => {
      root.render(
        <EntityTitleInput value="Title" onChange={() => {}} onCancel={() => (cancels += 1)} />,
      )
    })

    act(() => {
      field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    expect(cancels).toBe(1)
  })

  it('exposes the element via inputRef so panels can focus and select it', () => {
    const ref = { current: null as HTMLTextAreaElement | null }
    act(() => {
      root.render(<EntityTitleInput value="Title" onChange={() => {}} inputRef={ref} />)
    })

    // The click-to-edit panels call .select() on this ref when opening edit mode.
    expect(ref.current).toBe(field())
    expect(typeof ref.current?.select).toBe('function')
  })
})
